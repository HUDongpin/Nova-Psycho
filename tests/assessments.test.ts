import { describe,it,expect,beforeEach,afterEach,vi } from "vitest";

vi.mock("../src/lib/db",()=>({query:vi.fn(),transaction:vi.fn()}));
vi.mock("../src/lib/content",()=>({
  getScale:vi.fn(),
  currentContent:vi.fn(),
  lockContent:vi.fn()
}));
import { query,transaction } from "../src/lib/db";
import { currentContent,getScale,lockContent } from "../src/lib/content";
import { assessmentDetail,createAssessment,retryReport,saveDraft,submitAssessment } from "../src/lib/assessments";
import { demoAdvice,demoScale,demoTemplate } from "../src/domain/demo";
import { parseScale } from "../src/domain/validation";
import type { Actor,Role } from "../src/domain/types";

const mockQuery=vi.mocked(query);
const mockTransaction=vi.mocked(transaction);
const mockGetScale=vi.mocked(getScale);
const mockCurrentContent=vi.mocked(currentContent);

const ASSESSMENT_ID="11111111-2222-4333-8444-555555555555";
const FAMILY_ID="22222222-3333-4444-8555-666666666666";
const USER_ID="99999999-8888-4777-8666-555555555555";
const SCALE_ID=`${demoScale.id}@${demoScale.version}`;
const actor=(role:Role,over:Partial<Actor>={}):Actor=>({id:USER_ID,name:"Synthetic",role,region:"CN",...over});
const scale=parseScale(demoScale);

const clientCalls:string[]=[];
const client={
  query:vi.fn(async(sql:string)=>{
    clientCalls.push(String(sql));
    const text=String(sql);
    if(text.includes("SELECT id FROM families"))return {rows:[{id:FAMILY_ID}]};
    if(text.includes("SELECT status FROM scales"))return {rows:[{status:"active"}]};
    if(text.includes("SELECT id FROM assessments"))return {rows:[]};
    if(text.includes("SELECT submitted_at FROM assessments"))return {rows:[]};
    if(text.includes("SELECT a.*,r.id AS report_id"))return {rows:[{id:ASSESSMENT_ID,status:"pending",draft_revision:0,draft_answers:{},family_id:FAMILY_ID,respondent_role:"student",report_id:null}]};
    if(text.includes("SELECT scopes FROM consents"))return {rows:[{scopes:["assessment","parent_report","sensitive_data"]}]};
    if(text.includes("SELECT * FROM report_jobs"))return {rows:[{id:"job1",state:"failed"}]};
    if(text.includes("SELECT * FROM assessments WHERE id=$1 AND region=$2"))return {rows:[{id:ASSESSMENT_ID,status:"failed",family_id:FAMILY_ID,snapshot:{},answers:{},submitted_at:new Date()}]};
    if(text.includes("SELECT family_id FROM assessments"))return {rows:[{family_id:FAMILY_ID}]};
    return {rows:[]};
  })
};

beforeEach(()=>{
  vi.stubEnv("NOVA_REGION","CN");vi.stubEnv("NOVA_MODE","demo");
  vi.stubEnv("DATABASE_URL","postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR","work/test-private");
  vi.stubEnv("NOVA_REPORT_KEY","0".repeat(64));
  mockQuery.mockReset();mockTransaction.mockReset();client.query.mockClear();clientCalls.length=0;
  mockGetScale.mockReset();mockCurrentContent.mockReset();vi.mocked(lockContent).mockReset();
  mockTransaction.mockImplementation((async(fn:(c:unknown)=>Promise<unknown>)=>fn(client)) as never);
  mockGetScale.mockResolvedValue({id:SCALE_ID,definition:scale,status:"active"} as never);
  mockCurrentContent.mockImplementation((async(kind:string)=>kind==="advice"
    ? {id:"a",version:"1.0.0",content:demoAdvice}
    : {id:"t",version:"1.0.0",content:demoTemplate}) as never);
  mockQuery.mockImplementation((async(sql:string)=>{
    const text=String(sql);
    if(text.includes("FROM families f WHERE f.id=$1"))return [{id:FAMILY_ID,region:"CN",family_name:"Synthetic",child_name:"Synthetic child",birth_date:"2013-04-12",grade:"S2",guardian_label:"Mother",assigned_to:null,created_at:new Date()}];
    if(text.includes("SELECT m.role FROM memberships"))return [{role:"student"}];
    if(text.includes("SELECT id FROM consents"))return [{id:"c1"}];
    return [];
  }) as never);
});
afterEach(()=>vi.unstubAllEnvs());

const createInput={familyId:FAMILY_ID,respondentId:USER_ID,scaleVersionId:SCALE_ID,locale:"zh-CN" as const};

describe("creating an assessment",()=>{
  it("refuses a student or teacher creating one",async()=>{
    for(const role of ["student","teacher"] as const){
      await expect(createAssessment(actor(role),createInput)).rejects.toMatchObject({code:"ROLE_DENIED"});
    }
  });
  it("refuses a retired instrument version",async()=>{
    mockGetScale.mockResolvedValueOnce({id:SCALE_ID,definition:scale,status:"retired"} as never);
    await expect(createAssessment(actor("admin"),createInput)).rejects.toMatchObject({code:"SCALE_RETIRED"});
  });
  it("refuses a demo instrument in service mode",async()=>{
    vi.stubEnv("NOVA_MODE","service");vi.stubEnv("NOVA_PUBLIC_URL","https://nova.example.invalid");
    await expect(createAssessment(actor("admin"),createInput)).rejects.toMatchObject({code:"DEMO_INSTRUMENT"});
  });
  it("refuses a respondent who is not a member of the family",async()=>{
    // The family must resolve, otherwise the failure would come from the family lookup
    // rather than from the membership check this test is about.
    mockQuery.mockImplementation((async(sql:string)=>{
      if(String(sql).includes("FROM families f WHERE f.id=$1"))return [{id:FAMILY_ID,region:"CN",family_name:"Synthetic",child_name:"Synthetic child",birth_date:"2013-04-12",grade:"S2",guardian_label:"Mother",assigned_to:null,created_at:new Date()}];
      return [];
    }) as never);
    await expect(createAssessment(actor("admin"),createInput)).rejects.toMatchObject({code:"INVALID_RESPONDENT"});
  });
  it("refuses a respondent whose role the instrument does not support",async()=>{
    mockGetScale.mockResolvedValueOnce({id:SCALE_ID,definition:parseScale({...demoScale,roles:["teacher"]}),status:"active"} as never);
    await expect(createAssessment(actor("admin"),createInput)).rejects.toMatchObject({code:"INELIGIBLE"});
  });
  it("returns the existing task instead of creating a duplicate pending one",async()=>{
    client.query.mockImplementationOnce(async()=>({rows:[{id:FAMILY_ID}]}));
    client.query.mockImplementationOnce(async()=>({rows:[{status:"active"}]}));
    client.query.mockImplementationOnce(async()=>({rows:[{id:ASSESSMENT_ID}]}));
    await expect(createAssessment(actor("admin"),createInput)).resolves.toEqual({id:ASSESSMENT_ID});
  });
  it("enforces the retake interval for the same respondent and version",async()=>{
    const recent=new Date(Date.now()-2*86400000);
    client.query.mockImplementationOnce(async()=>({rows:[{id:FAMILY_ID}]}));
    client.query.mockImplementationOnce(async()=>({rows:[{status:"active"}]}));
    client.query.mockImplementationOnce(async()=>({rows:[]}));
    client.query.mockImplementationOnce(async()=>({rows:[{submitted_at:recent}]}));
    await expect(createAssessment(actor("admin"),createInput)).rejects.toMatchObject({code:"RETAKE_INTERVAL"});
  });
});

describe("reading an assessment",()=>{
  it("scopes the lookup to the respondent, region and their membership role",async()=>{
    mockQuery.mockImplementation((async(sql:string)=>{
      if(String(sql).includes("FROM assessments a JOIN scales s"))return [{id:ASSESSMENT_ID,status:"pending",definition:scale,draft_answers:{},draft_revision:0,family_id:FAMILY_ID,child_name:"Synthetic child",birth_date:"2013-04-12",respondent_role:"student",region:"CN"}];
      return [];
    }) as never);
    await assessmentDetail(actor("student"),ASSESSMENT_ID,"zh-CN");
    const [sql,values]=mockQuery.mock.calls[0];
    expect(String(sql)).toContain("a.respondent_id=$2");
    expect(String(sql)).toContain("a.region=$3");
    expect(String(sql)).toContain("m.role=$4");
    expect(values).toContain(USER_ID);
  });
  it("rejects a malformed id before querying",async()=>{
    await expect(assessmentDetail(actor("student"),"nope","zh-CN")).rejects.toMatchObject({code:"NOT_FOUND"});
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("saving a draft",()=>{
  const draft={answers:{q1:1},acknowledged:true as const,revision:0};
  const withOwn=()=>{
    mockQuery.mockImplementation((async(sql:string)=>{
      if(String(sql).includes("FROM assessments a JOIN scales s"))return [{id:ASSESSMENT_ID,status:"pending",definition:scale,draft_answers:{},draft_revision:0,family_id:FAMILY_ID,child_name:"c",birth_date:"2013-04-12",respondent_role:"student",region:"CN"}];
      if(String(sql).includes("SELECT id FROM consents"))return [{id:"c1"}];
      if(String(sql).includes("UPDATE assessments SET draft_answers"))return [{id:ASSESSMENT_ID,draft_revision:1}];
      return [];
    }) as never);
  };
  it("requires guardian consent before storing answers",async()=>{
    mockQuery.mockImplementation((async(sql:string)=>{
      if(String(sql).includes("FROM assessments a JOIN scales s"))return [{id:ASSESSMENT_ID,status:"pending",definition:scale,draft_answers:{},draft_revision:0,family_id:FAMILY_ID,child_name:"c",birth_date:"2013-04-12",respondent_role:"student",region:"CN"}];
      return [];
    }) as never);
    await expect(saveDraft(actor("student"),ASSESSMENT_ID,draft)).rejects.toMatchObject({code:"GUARDIAN_CONSENT_REQUIRED"});
  });
  it("rejects an answer that is not a valid choice for its item",async()=>{
    withOwn();
    await expect(saveDraft(actor("student"),ASSESSMENT_ID,{...draft,answers:{q1:99}})).rejects.toMatchObject({code:"INVALID_ANSWERS"});
    await expect(saveDraft(actor("student"),ASSESSMENT_ID,{...draft,answers:{nosuchitem:1}})).rejects.toMatchObject({code:"INVALID_ANSWERS"});
  });
  it("refuses a stale revision rather than overwriting a newer draft",async()=>{
    mockQuery.mockImplementation((async(sql:string)=>{
      if(String(sql).includes("FROM assessments a JOIN scales s"))return [{id:ASSESSMENT_ID,status:"pending",definition:scale,draft_answers:{},draft_revision:0,family_id:FAMILY_ID,child_name:"c",birth_date:"2013-04-12",respondent_role:"student",region:"CN"}];
      if(String(sql).includes("SELECT id FROM consents"))return [{id:"c1"}];
      return [];
    }) as never);
    await expect(saveDraft(actor("student"),ASSESSMENT_ID,draft)).rejects.toMatchObject({code:"DRAFT_CONFLICT"});
  });
  it("requires explicit acknowledgement",async()=>{
    withOwn();
    await expect(saveDraft(actor("student"),ASSESSMENT_ID,{...draft,acknowledged:false as never})).rejects.toThrow();
  });
});

describe("submitting",()=>{
  const submission={answers:{q1:1,q2:2,q3:1,q4:2,q5:1,q6:2,q7:1,q8:2,q9:0},acknowledged:true as const,revision:0};
  const withOwn=()=>{
    mockQuery.mockImplementation((async(sql:string)=>{
      const text=String(sql);
      if(text.includes("FROM assessments a JOIN scales s"))return [{id:ASSESSMENT_ID,status:"pending",definition:scale,draft_answers:{},draft_revision:0,family_id:FAMILY_ID,child_name:"Synthetic child",birth_date:"2013-04-12",respondent_role:"student",region:"CN"}];
      if(text.includes("FROM families f WHERE f.id=$1"))return [{id:FAMILY_ID,region:"CN",family_name:"Synthetic",child_name:"Synthetic child",birth_date:"2013-04-12",grade:"S2",guardian_label:"Mother",assigned_to:null,created_at:new Date()}];
      return [];
    }) as never);
  };
  it("refuses a stale revision",async()=>{
    withOwn();
    client.query.mockImplementationOnce(async()=>({rows:[{id:FAMILY_ID}]}));
    client.query.mockImplementationOnce(async()=>({rows:[{id:ASSESSMENT_ID,status:"pending",draft_revision:5,family_id:FAMILY_ID,respondent_id:USER_ID}]}));
    await expect(submitAssessment(actor("student"),ASSESSMENT_ID,submission)).rejects.toMatchObject({code:"DRAFT_CONFLICT"});
  });
  it("refuses to submit without the full consent scope set",async()=>{
    withOwn();
    client.query.mockImplementationOnce(async()=>({rows:[{id:FAMILY_ID}]}));
    client.query.mockImplementationOnce(async()=>({rows:[{id:ASSESSMENT_ID,status:"pending",draft_revision:0,family_id:FAMILY_ID,respondent_id:USER_ID}]}));
    client.query.mockImplementationOnce(async()=>({rows:[{scopes:["assessment"]}]}));
    await expect(submitAssessment(actor("student"),ASSESSMENT_ID,submission)).rejects.toMatchObject({code:"GUARDIAN_CONSENT_REQUIRED"});
  });
  it("returns the existing result for an already-submitted assessment instead of re-scoring",async()=>{
    withOwn();
    client.query.mockImplementationOnce(async()=>({rows:[{id:FAMILY_ID}]}));
    client.query.mockImplementationOnce(async()=>({rows:[{id:ASSESSMENT_ID,status:"published",draft_revision:0,family_id:FAMILY_ID,respondent_id:USER_ID,report_id:"r1"}]}));
    await expect(submitAssessment(actor("student"),ASSESSMENT_ID,submission)).resolves.toMatchObject({status:"published",reportId:"r1"});
  });
  it("refuses a demo submission in service mode",async()=>{
    vi.stubEnv("NOVA_MODE","service");vi.stubEnv("NOVA_PUBLIC_URL","https://nova.example.invalid");
    withOwn();
    await expect(submitAssessment(actor("student"),ASSESSMENT_ID,submission)).rejects.toMatchObject({code:"DEMO_INSTRUMENT"});
  });
});

describe("retrying a failed report",()=>{
  it("refuses parents, students and teachers",async()=>{
    for(const role of ["parent","student","teacher"] as const){
      await expect(retryReport(actor(role),ASSESSMENT_ID)).rejects.toMatchObject({code:"ROLE_DENIED"});
    }
  });
  it("rejects a malformed id before querying",async()=>{
    await expect(retryReport(actor("admin"),"nope")).rejects.toMatchObject({code:"NOT_FOUND"});
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it("refuses to retry something that did not fail",async()=>{
    mockQuery.mockImplementation((async(sql:string)=>{
      if(String(sql).includes("SELECT family_id FROM assessments"))return [{family_id:FAMILY_ID}];
      if(String(sql).includes("FROM families f WHERE f.id=$1"))return [{id:FAMILY_ID,region:"CN",family_name:"S",child_name:"c",birth_date:"2013-04-12",grade:"S2",guardian_label:"M",assigned_to:null,created_at:new Date()}];
      return [];
    }) as never);
    client.query.mockImplementationOnce(async()=>({rows:[{id:FAMILY_ID,assigned_to:null}]}));
    client.query.mockImplementationOnce(async()=>({rows:[{id:ASSESSMENT_ID,status:"published",family_id:FAMILY_ID,region:"CN"}]}));
    client.query.mockImplementationOnce(async()=>({rows:[{id:"job1",state:"done"}]}));
    client.query.mockImplementationOnce(async()=>({rows:[{scopes:["assessment","parent_report","sensitive_data"]}]}));
    await expect(retryReport(actor("admin"),ASSESSMENT_ID)).rejects.toMatchObject({code:"REPORT_NOT_FAILED"});
  });
});
