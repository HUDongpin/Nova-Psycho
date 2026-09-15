import { describe,it,expect,beforeEach,afterEach,vi } from "vitest";

vi.mock("../src/lib/db",()=>({query:vi.fn()}));
import { query } from "../src/lib/db";
import { reportDetail,reportFor,reportSummary } from "../src/lib/reports";
import { demoAdvice,demoScale,demoTemplate } from "../src/domain/demo";
import { scoreAssessment } from "../src/domain/scoring";
import type { Actor,ReportPayload,Role } from "../src/domain/types";

const mockQuery=vi.mocked(query);
const REPORT_ID="11111111-2222-4333-8444-555555555555";
const FAMILY_ID="22222222-3333-4444-8555-666666666666";
const actor=(role:Role,over:Partial<Actor>={}):Actor=>({id:"99999999-8888-4777-8666-555555555555",name:"Synthetic",role,region:"CN",...over});

const payload:ReportPayload={
  scale:demoScale,advice:{id:"a",version:"1.0.0",content:demoAdvice},template:{id:"t",version:"1.0.0",content:demoTemplate},
  score:scoreAssessment(demoScale,{q1:1,q2:2,q3:1,q4:2,q5:1,q6:2,q7:1,q8:2,q9:0},{age:12,region:"CN",role:"student"}),
  childName:"Synthetic child",grade:"S2",submittedAt:"2026-09-15T00:00:00.000Z",aiConsented:false,
  selectedAdviceIds:["listen"],generationMode:"template",fallbackReason:null,aiModel:null,
  comparison:{available:false,reason:"first_assessment"}
};
const row={id:REPORT_ID,family_id:FAMILY_ID,assessment_id:"33333333-4444-4555-8666-777777777777",region:"CN",payload,pdf_keys:{"zh-CN":"k.zh-CN.pdf.enc"},html_documents:{"zh-CN":"<html>cn</html>","zh-HK":"<html>hk</html>"},created_at:new Date("2026-09-15T00:00:00Z")};

beforeEach(()=>{
  vi.stubEnv("NOVA_REGION","CN");vi.stubEnv("NOVA_MODE","demo");
  vi.stubEnv("DATABASE_URL","postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR","work/test-private");
  vi.stubEnv("NOVA_REPORT_KEY","0".repeat(64));
  mockQuery.mockReset();
  mockQuery.mockImplementation((async(sql:string)=>{
    if(String(sql).includes("FROM reports WHERE id=$1"))return [row];
    if(String(sql).includes("FROM families f WHERE f.id=$1"))return [{id:FAMILY_ID,region:"CN",family_name:"Synthetic",child_name:"Synthetic child",birth_date:"2013-04-12",grade:"S2",guardian_label:"Mother",assigned_to:null,created_at:new Date()}];
    return [];
  }) as never);
});
afterEach(()=>vi.unstubAllEnvs());

describe("who may read a report",()=>{
  it("refuses students and teachers outright",async()=>{
    for(const role of ["student","teacher"] as const){
      await expect(reportFor(actor(role),REPORT_ID)).rejects.toMatchObject({code:"ROLE_DENIED"});
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it("allows administrators, staff and parents",async()=>{
    for(const role of ["admin","staff","parent"] as const){
      await expect(reportFor(actor(role),REPORT_ID)).resolves.toMatchObject({id:REPORT_ID});
    }
  });
  it("rejects a malformed id before it reaches a query",async()=>{
    await expect(reportFor(actor("admin"),"'; DROP TABLE reports; --")).rejects.toMatchObject({code:"NOT_FOUND"});
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it("scopes the lookup to the caller's region",async()=>{
    await reportFor(actor("admin"),REPORT_ID);
    const [sql,values]=mockQuery.mock.calls[0];
    expect(String(sql)).toContain("region=$2");
    expect(values).toContain("CN");
  });
  it("still applies family scoping, so a parent cannot read another family's report",async()=>{
    mockQuery.mockImplementation((async(sql:string)=>{
      if(String(sql).includes("FROM reports WHERE id=$1"))return [row];
      return []; // familyFor finds no family in scope
    }) as never);
    await expect(reportFor(actor("parent"),REPORT_ID)).rejects.toMatchObject({code:"NOT_FOUND"});
  });
  it("reports a missing report as NOT_FOUND",async()=>{
    mockQuery.mockResolvedValueOnce([]);
    await expect(reportFor(actor("admin"),REPORT_ID)).rejects.toMatchObject({code:"NOT_FOUND"});
  });
});

describe("report summaries",()=>{
  it("localises the title, dimension labels and band for the requested locale",async()=>{
    const cn=reportSummary(row,"zh-CN"),hk=reportSummary(row,"zh-HK");
    expect(cn.title).toBe(demoTemplate.title["zh-CN"]);
    expect(hk.title).toBe(demoTemplate.title["zh-HK"]);
    expect(cn.dimensions[0].label).toBe(demoScale.dimensions[0].label["zh-CN"]);
    expect(hk.dimensions[0].label).toBe(demoScale.dimensions[0].label["zh-HK"]);
  });
  it("does not leak the raw payload to the client",async()=>{
    const summary=reportSummary(row,"zh-CN");
    expect(JSON.stringify(summary)).not.toContain("snapshot");
    expect(Object.keys(summary)).not.toContain("pdf_keys");
    expect(Object.keys(summary)).not.toContain("html_documents");
  });
  it("carries the comparison through",async()=>{
    expect(reportSummary(row,"zh-CN").comparison.available).toBe(false);
  });
});

describe("report detail",()=>{
  it("serves the html for the requested locale and a download url",async()=>{
    const detail=reportDetail(row as never,"zh-HK");
    expect(detail.html).toBe("<html>hk</html>");
    expect(detail.downloadUrl).toContain(`/api/reports/${REPORT_ID}/pdf`);
    expect(detail.downloadUrl).toContain("locale=zh-HK");
  });
});
