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
import { childScale,parentScale,teacherScale } from "../src/domain/triad-scales";
import { childScale as oldChild } from "./fixtures/triad-scales-ed66f27";
import { parseScale } from "../src/domain/validation";
import { previewAnswers, TRIAD_BUNDLE } from "../src/domain/triad-report";
import { ACTIVE_CONSENT_ROWS_SQL } from "../src/lib/consent";
import type { Actor,Role,ScaleDefinition } from "../src/domain/types";

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
  // Declared with a params argument and a widened row type so each test can install its
  // own row shape without fighting the inferred return type.
  query:vi.fn(async(sql:string,_params?:unknown[]):Promise<{rows:unknown[]}>=>{
    clientCalls.push(String(sql));
    const text=String(sql);
    if(text.includes("SELECT id FROM families"))return {rows:[{id:FAMILY_ID}]};
    if(text.includes("SELECT status FROM scales"))return {rows:[{status:"active"}]};
    if(text.includes("SELECT id FROM assessments"))return {rows:[]};
    if(text.includes("SELECT submitted_at FROM assessments"))return {rows:[]};
    if(text.includes("SELECT a.*,r.id AS report_id"))return {rows:[{id:ASSESSMENT_ID,status:"pending",draft_revision:0,draft_answers:{},family_id:FAMILY_ID,respondent_role:"student",report_id:null}]};
    if(text.includes("AS scopes FROM consents WHERE family_id=$1"))return {rows:[{scopes:["assessment","parent_report","sensitive_data"]}]};
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
  it("refuses an unvalidated instrument in service mode",async()=>{
    vi.stubEnv("NOVA_MODE","service");vi.stubEnv("NOVA_PUBLIC_URL","https://nova.example.invalid");
    await expect(createAssessment(actor("admin"),createInput)).rejects.toMatchObject({status:409,code:"UNVALIDATED_INSTRUMENT"});
    expect(mockTransaction).not.toHaveBeenCalled();
  });
  it("refuses a validated demo instrument in service mode",async()=>{
    const validated=structuredClone(scale);validated.norm={...validated.norm,validated:true};
    mockGetScale.mockResolvedValueOnce({id:SCALE_ID,definition:validated,status:"active"} as never);
    vi.stubEnv("NOVA_MODE","service");vi.stubEnv("NOVA_PUBLIC_URL","https://nova.example.invalid");
    await expect(createAssessment(actor("admin"),createInput)).rejects.toMatchObject({status:409,code:"DEMO_INSTRUMENT"});
    expect(mockTransaction).not.toHaveBeenCalled();
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
  const familyRow={id:FAMILY_ID,region:"CN",family_name:"Synthetic",child_name:"Synthetic child",birth_date:"2013-04-12",grade:"S2",guardian_label:"Mother",assigned_to:null,created_at:new Date()};
  const withFamily=(extra:(sql:string)=>unknown[]|undefined)=>{
    mockQuery.mockImplementation((async(sql:string)=>{
      const text=String(sql);
      if(text.includes("FROM families f WHERE f.id=$1"))return [familyRow];
      if(text.includes("SELECT m.role FROM memberships"))return [{role:"parent"}];
      return extra(text)??[];
    }) as never);
  };
  it("assigns nova-family-demo for ages 8-17 when the triad scales are only demo-labelled",async()=>{
    mockQuery.mockImplementation((async(sql:string,values?:unknown[])=>{
      const text=String(sql);
      if(text.includes("FROM families f WHERE f.id=$1"))return [{id:FAMILY_ID,region:"CN",family_name:"Synthetic",child_name:"Synthetic child",birth_date:"2013-04-12",grade:"S2",guardian_label:"Mother",assigned_to:null,created_at:new Date()}];
      if(text.includes("SELECT m.role FROM memberships"))return [{role:"student"}];
      if(text.includes("FROM scales WHERE status='active'")){
        expect(text).toContain("norm'->>'validated'");
        const [region,role,age]=values as ["CN"|"HK","student",number];
        return [childScale,parentScale,teacherScale,oldChild].filter(item=>!item.demo&&item.norm.validated&&item.regions.includes(region)&&item.roles.includes(role)&&item.minAge<=age&&item.maxAge>=age).map(item=>({id:`${item.id}@${item.version}`}));
      }
      return [];
    }) as never);
    const created=await createAssessment(actor("admin"),createInput);
    expect(created.id).toEqual(expect.any(String));
    expect(clientCalls.some(sql=>sql.includes("INSERT INTO assessments"))).toBe(true);
    expect(childScale.demo&&parentScale.demo&&teacherScale.demo).toBe(true);
  });
  it("still assigns the demo instrument when no official questionnaire is available",async()=>{
    const created=await createAssessment(actor("admin"),createInput);
    expect(created.id).toEqual(expect.any(String));
    expect(clientCalls.some(sql=>sql.includes("INSERT INTO assessments"))).toBe(true);
  });
  it("does not treat a held unvalidated questionnaire as an official instrument",async()=>{
    withFamily(sql=>{
      if(!sql.includes("JOIN scales")||!sql.includes("definition->>'demo'"))return undefined;
      const blocks=!oldChild.demo&&(sql.includes("validated")?oldChild.norm.validated:true);
      return blocks?[{id:"legacy-task"}]:[];
    });
    const created=await createAssessment(actor("staff"),createInput);
    expect(created.id).toEqual(expect.any(String));
    expect(oldChild.demo).toBe(false);
    expect(oldChild.norm.validated).toBe(false);
  });
  it("refuses a demo instrument when this member already holds a validated official questionnaire",async()=>{
    withFamily(sql=>{
      if(!sql.includes("JOIN scales")||!sql.includes("definition->>'demo'"))return undefined;
      expect(sql).toContain("validated");
      return [{id:"official-task"}];
    });
    await expect(createAssessment(actor("staff"),createInput)).rejects.toMatchObject({status:409,code:"DEMO_NOT_ASSIGNABLE"});
    expect(mockTransaction).not.toHaveBeenCalled();
  });
  it("refuses a demo instrument when a validated official questionnaire already fits this member",async()=>{
    withFamily(sql=>{
      if(!sql.includes("FROM scales WHERE status='active'"))return undefined;
      expect(sql).toContain("norm'->>'validated'");
      return [{id:"official@1.0.0"}];
    });
    await expect(createAssessment(actor("admin"),createInput)).rejects.toMatchObject({status:409,code:"DEMO_NOT_ASSIGNABLE"});
    expect(mockTransaction).not.toHaveBeenCalled();
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
      if(String(sql).includes("AS scopes FROM consents WHERE family_id=$1"))return [{scopes:["assessment"]},{scopes:["sensitive_data"]}];
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
  it("does not store answers when only the parent report was consented",async()=>{
    mockQuery.mockImplementation((async(sql:string)=>{
      if(String(sql).includes("FROM assessments a JOIN scales s"))return [{id:ASSESSMENT_ID,status:"pending",definition:scale,draft_answers:{},draft_revision:0,family_id:FAMILY_ID,child_name:"c",birth_date:"2013-04-12",respondent_role:"student",region:"CN"}];
      if(String(sql).includes("AS scopes FROM consents WHERE family_id=$1"))return [{scopes:["parent_report"]}];
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
      if(String(sql).includes("AS scopes FROM consents WHERE family_id=$1"))return [{scopes:"[\"assessment\",\"sensitive_data\"]"}];
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
  it("refuses to submit without both participation consents",async()=>{
    withOwn();
    client.query.mockImplementationOnce(async()=>({rows:[{id:FAMILY_ID}]}));
    client.query.mockImplementationOnce(async()=>({rows:[{id:ASSESSMENT_ID,status:"pending",draft_revision:0,family_id:FAMILY_ID,respondent_id:USER_ID,respondent_role:"student"}]}));
    client.query.mockImplementationOnce(async()=>({rows:[{scopes:["assessment"]},{scopes:["parent_report"]}]}));
    await expect(submitAssessment(actor("student"),ASSESSMENT_ID,submission)).rejects.toMatchObject({code:"GUARDIAN_CONSENT_REQUIRED"});
  });
  it("submits without a parent report and does not queue one until that consent exists",async()=>{
    withOwn();
    client.query.mockImplementation(async(sql:string)=>{
      if(sql.includes("SELECT id FROM families"))return {rows:[{id:FAMILY_ID}]};
      if(sql.includes("SELECT a.*,r.id AS report_id"))return {rows:[{id:ASSESSMENT_ID,status:"pending",draft_revision:0,family_id:FAMILY_ID,respondent_id:USER_ID,respondent_role:"student"}]};
      if(sql.includes("AS scopes FROM consents WHERE family_id=$1"))return {rows:[{scopes:["assessment"]},{scopes:["sensitive_data"]}]};
      return {rows:[]};
    });
    await expect(submitAssessment(actor("student"),ASSESSMENT_ID,submission)).resolves.toMatchObject({status:"queued",reportId:null,phase:"consent"});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO report_jobs"))).toBe(false);
    const snapshot=JSON.parse(String(client.query.mock.calls.find(([sql])=>String(sql).includes("UPDATE assessments SET answers"))?.[1]?.[1]));
    expect(snapshot.aiConsented).toBe(false);
  });
  it("queues the parent report when that consent is a separate row or a legacy bundle",async()=>{
    for(const rows of [[{scopes:["assessment"]},{scopes:["sensitive_data"]},{scopes:["parent_report"]},{scopes:["ai_processing"]}],[{scopes:["assessment","parent_report","sensitive_data","ai_processing"]}]]){
      withOwn();
      client.query.mockReset();
      client.query.mockImplementation(async(sql:string)=>{
        if(sql.includes("SELECT id FROM families"))return {rows:[{id:FAMILY_ID}]};
        if(sql.includes("SELECT a.*,r.id AS report_id"))return {rows:[{id:ASSESSMENT_ID,status:"pending",draft_revision:0,family_id:FAMILY_ID,respondent_id:USER_ID,respondent_role:"student"}]};
        if(sql.includes("AS scopes FROM consents WHERE family_id=$1"))return {rows};
        if(sql.includes("SELECT id FROM report_jobs"))return {rows:[{id:"job"}]};
        return {rows:[]};
      });
      await expect(submitAssessment(actor("student"),ASSESSMENT_ID,submission)).resolves.toMatchObject({status:"queued",phase:"reporting"});
      expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO report_jobs"))).toBe(true);
      const snapshot=JSON.parse(String(client.query.mock.calls.find(([sql])=>String(sql).includes("UPDATE assessments SET answers"))?.[1]?.[1]));
      expect(snapshot.aiConsented).toBe(true);
    }
  });
  it("returns the existing result for an already-submitted assessment instead of re-scoring",async()=>{
    withOwn();
    client.query.mockImplementationOnce(async()=>({rows:[{id:FAMILY_ID}]}));
    client.query.mockImplementationOnce(async()=>({rows:[{id:ASSESSMENT_ID,status:"published",draft_revision:0,family_id:FAMILY_ID,respondent_id:USER_ID,report_id:"r1"}]}));
    await expect(submitAssessment(actor("student"),ASSESSMENT_ID,submission)).resolves.toMatchObject({status:"published",reportId:"r1",phase:null});
  });
  it("refuses an unvalidated submission in service mode",async()=>{
    vi.stubEnv("NOVA_MODE","service");vi.stubEnv("NOVA_PUBLIC_URL","https://nova.example.invalid");
    withOwn();
    await expect(submitAssessment(actor("student"),ASSESSMENT_ID,submission)).rejects.toMatchObject({status:409,code:"UNVALIDATED_INSTRUMENT"});
    expect(mockTransaction).not.toHaveBeenCalled();
  });
  it("refuses a validated demo submission in service mode",async()=>{
    const validated=structuredClone(scale);validated.norm={...validated.norm,validated:true};
    vi.stubEnv("NOVA_MODE","service");vi.stubEnv("NOVA_PUBLIC_URL","https://nova.example.invalid");
    mockQuery.mockImplementation((async(sql:string)=>{
      const text=String(sql);
      if(text.includes("FROM assessments a JOIN scales s"))return [{id:ASSESSMENT_ID,status:"pending",definition:validated,draft_answers:{},draft_revision:0,family_id:FAMILY_ID,child_name:"Synthetic child",birth_date:"2013-04-12",respondent_role:"student",region:"CN"}];
      return [];
    }) as never);
    await expect(submitAssessment(actor("student"),ASSESSMENT_ID,submission)).rejects.toMatchObject({status:409,code:"DEMO_INSTRUMENT"});
    expect(mockTransaction).not.toHaveBeenCalled();
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
    client.query.mockImplementationOnce(async()=>({rows:[{id:FAMILY_ID,region:"CN",assigned_to:null}]}));
    client.query.mockImplementationOnce(async()=>({rows:[{id:ASSESSMENT_ID,status:"published",family_id:FAMILY_ID,region:"CN"}]}));
    client.query.mockImplementationOnce(async()=>({rows:[{id:"job1",state:"done"}]}));
    client.query.mockImplementationOnce(async()=>({rows:[{scopes:["assessment","parent_report","sensitive_data"]}]}));
    await expect(retryReport(actor("admin"),ASSESSMENT_ID)).rejects.toMatchObject({code:"REPORT_NOT_FAILED"});
  });
});

describe("retry locks and shared eligibility",()=>{
  function setupRetry(options:{assignedTo?:string|null;assessment?:Record<string,unknown>;job?:Record<string,unknown>;consent?:boolean}={}){
    mockQuery.mockImplementation((async(sql:string)=>{
      if(String(sql).includes("SELECT family_id FROM assessments"))return [{family_id:FAMILY_ID}];
      if(String(sql).includes("FROM families f WHERE f.id=$1"))return [{id:FAMILY_ID,region:"CN",assigned_to:USER_ID}];
      return [];
    }) as never);
    client.query.mockReset();
    client.query.mockImplementation(async(sql:string)=>{
      if(sql.includes("FROM families"))return {rows:[{id:FAMILY_ID,region:"CN",assigned_to:options.assignedTo===undefined?USER_ID:options.assignedTo}]};
      if(sql.includes("SELECT * FROM assessments"))return {rows:[{id:ASSESSMENT_ID,family_id:FAMILY_ID,status:"failed",snapshot:{},answers:{},submitted_at:new Date(),...options.assessment}]};
      if(sql.includes("SELECT * FROM report_jobs"))return {rows:[{id:"job1",state:"failed",...options.job}]};
      if(sql.includes("AS scopes FROM consents WHERE family_id=$1"))return {rows:options.consent===false?[]:[{scopes:["assessment","parent_report","sensitive_data"]}]};
      return {rows:[]};
    });
  }
  it("rechecks the assignee after taking the family lock",async()=>{
    setupRetry({assignedTo:FAMILY_ID});
    await expect(retryReport(actor("staff"),ASSESSMENT_ID)).rejects.toMatchObject({code:"NOT_FOUND"});
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0][0]).toContain("FOR UPDATE");
  });
  it("lets the assigned staff queue a complete failed report",async()=>{
    setupRetry();
    await expect(retryReport(actor("staff"),ASSESSMENT_ID)).resolves.toEqual({id:ASSESSMENT_ID,status:"queued"});
    expect(client.query.mock.calls.some(([sql])=>sql.startsWith("UPDATE report_jobs"))).toBe(true);
  });
  it("refuses a triad snapshot whose round is absent even when source ids exist",async()=>{
    setupRetry({assessment:{snapshot:{scale:{bundle:TRIAD_BUNDLE}},triad_round_id:null},job:{source_assessment_ids:[ASSESSMENT_ID,FAMILY_ID,USER_ID]}});
    await expect(retryReport(actor("admin"),ASSESSMENT_ID)).rejects.toMatchObject({code:"TRIAD_LEGACY_REVIEW_REQUIRED"});
    expect(client.query.mock.calls.some(([sql])=>sql.startsWith("UPDATE"))).toBe(false);
  });
  it("keeps queued-ready retries idempotent",async()=>{
    setupRetry({assessment:{status:"queued"},job:{state:"ready"}});
    await expect(retryReport(actor("staff"),ASSESSMENT_ID)).resolves.toEqual({id:ASSESSMENT_ID,status:"queued"});
    expect(client.query.mock.calls.some(([sql])=>sql.startsWith("UPDATE"))).toBe(false);
  });
  it("still requires consent for a queued-ready replay",async()=>{
    setupRetry({assessment:{status:"queued"},job:{state:"ready"},consent:false});
    await expect(retryReport(actor("admin"),ASSESSMENT_ID)).rejects.toMatchObject({code:"GUARDIAN_CONSENT_REQUIRED"});
  });
});

describe("submission phase follows parent-report consent",()=>{
  const ROUND_ID="44444444-5555-4666-8777-888888888888";
  const participation=[{scopes:["assessment"]},{scopes:["sensitive_data"]}];
  const withReport=[...participation,{scopes:["parent_report"]}];
  const scalesByRole={parent:parentScale,student:childScale,teacher:teacherScale} as const;

  function install(options:{definition:ScaleDefinition;role:"parent"|"student"|"teacher";status?:string;scopes?:{scopes:string[]}[];submittedRoles?:string[];job?:boolean;reportId?:string|null;snapshot?:unknown}){
    const status=options.status??"pending";
    const triad=options.definition.bundle===TRIAD_BUNDLE;
    const row={
      id:ASSESSMENT_ID,status,definition:options.definition,draft_answers:{},draft_revision:0,family_id:FAMILY_ID,
      child_name:"Synthetic child",birth_date:"2013-04-12",respondent_role:options.role,respondent_id:USER_ID,region:"CN",
      triad_round_id:triad?ROUND_ID:null,snapshot:options.snapshot??null,report_id:options.reportId??null
    };
    const scopes=options.scopes??participation;
    const roles=options.submittedRoles??[];
    mockQuery.mockImplementation((async(sql:string)=>{
      const text=String(sql);
      if(text.includes("FROM assessments a JOIN scales"))return [row];
      if(text.includes("FROM families f WHERE"))return [{id:FAMILY_ID,region:"CN",family_name:"Synthetic",child_name:"Synthetic child",birth_date:"2013-04-12",grade:"S2",guardian_label:"Mother",assigned_to:null,created_at:new Date()}];
      if(text===ACTIVE_CONSENT_ROWS_SQL)return scopes;
      if(text.includes("SELECT id FROM report_jobs"))return options.job?[{id:"job"}]:[];
      if(text.includes("submitted_at IS NOT NULL")&&text.includes("triad_round_id=$3"))return roles.map((role,index)=>({id:`source-${index}`,respondent_role:role}));
      return [];
    }) as never);
    client.query.mockImplementation(async(sql:string)=>{
      const text=String(sql);
      if(text.includes("SELECT id FROM families"))return {rows:[{id:FAMILY_ID}]};
      if(text.includes("SELECT a.*,r.id AS report_id"))return {rows:[row]};
      if(text===ACTIVE_CONSENT_ROWS_SQL)return {rows:scopes};
      if(text.includes("SELECT id FROM report_jobs"))return {rows:options.job?[{id:"job"}]:[]};
      if(text.includes("submitted_at IS NOT NULL")&&text.includes("triad_round_id=$3"))return {rows:roles.map((role,index)=>({id:`source-${index}`,respondent_role:role}))};
      return {rows:[]};
    });
    return row;
  }

  it.each(["parent","student","teacher"] as const)("returns consent when the last %s submission finishes a round without parent-report consent",async role=>{
    const definition=scalesByRole[role];
    const row=install({definition,role,scopes:participation,submittedRoles:["parent","student","teacher"]});
    const submitted=await submitAssessment(actor(role),ASSESSMENT_ID,{answers:previewAnswers(definition,"calm"),acknowledged:true,revision:0});
    expect(submitted).toMatchObject({status:"queued",reportId:null,phase:"consent"});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO report_jobs"))).toBe(false);
    expect(client.query.mock.calls.some(([sql])=>sql===ACTIVE_CONSENT_ROWS_SQL)).toBe(true);
    expect(ACTIVE_CONSENT_ROWS_SQL).toContain("consent_scope_revocations");
    row.status="queued";
    await expect(assessmentDetail(actor(role),ASSESSMENT_ID,"zh-CN")).resolves.toMatchObject({status:"queued",phase:"consent"});
  });

  it("keeps waiting while another triad role is still out, even without parent-report consent",async()=>{
    const row=install({definition:childScale,role:"student",scopes:participation,submittedRoles:["student"]});
    await expect(submitAssessment(actor("student"),ASSESSMENT_ID,{answers:previewAnswers(childScale,"calm"),acknowledged:true,revision:0})).resolves.toMatchObject({status:"queued",phase:"waiting",reportId:null});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO report_jobs"))).toBe(false);
    row.status="queued";
    await expect(assessmentDetail(actor("student"),ASSESSMENT_ID,"zh-CN")).resolves.toMatchObject({phase:"waiting"});
  });

  it("replays a partial triad submission as waiting and does not score it again",async()=>{
    install({definition:childScale,role:"student",status:"queued",scopes:participation,submittedRoles:["student"],snapshot:{score:{risk:false}}});
    await expect(submitAssessment(actor("student"),ASSESSMENT_ID,{answers:previewAnswers(childScale,"calm"),acknowledged:true,revision:0})).resolves.toMatchObject({status:"queued",phase:"waiting",safetyGuidance:false});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("UPDATE assessments SET answers"))).toBe(false);
  });

  it("returns reporting when the finished triad has parent-report consent and a job",async()=>{
    const row=install({definition:teacherScale,role:"teacher",scopes:withReport,submittedRoles:["parent","student","teacher"],job:true});
    await expect(submitAssessment(actor("teacher"),ASSESSMENT_ID,{answers:previewAnswers(teacherScale,"calm"),acknowledged:true,revision:0})).resolves.toMatchObject({status:"queued",phase:"reporting",reportId:null});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO report_jobs"))).toBe(true);
    row.status="queued";
    await expect(assessmentDetail(actor("teacher"),ASSESSMENT_ID,"zh-HK")).resolves.toMatchObject({phase:"reporting"});
  });

  it("returns consent for the 9-item demo when parent-report consent is missing",async()=>{
    const row=install({definition:scale,role:"student",scopes:participation});
    await expect(submitAssessment(actor("student"),ASSESSMENT_ID,{answers:{q1:1,q2:2,q3:1,q4:2,q5:1,q6:2,q7:1,q8:2,q9:0},acknowledged:true,revision:0})).resolves.toMatchObject({status:"queued",phase:"consent",reportId:null});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO report_jobs"))).toBe(false);
    row.status="queued";
    await expect(assessmentDetail(actor("student"),ASSESSMENT_ID,"zh-CN")).resolves.toMatchObject({phase:"consent"});
  });

  it("returns reporting for the 9-item demo when parent-report consent created a job",async()=>{
    const row=install({definition:scale,role:"parent",scopes:withReport,job:true});
    await expect(submitAssessment(actor("parent"),ASSESSMENT_ID,{answers:{q1:1,q2:2,q3:1,q4:2,q5:1,q6:2,q7:1,q8:2,q9:0},acknowledged:true,revision:0})).resolves.toMatchObject({status:"queued",phase:"reporting"});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO report_jobs"))).toBe(true);
    row.status="queued";
    await expect(assessmentDetail(actor("parent"),ASSESSMENT_ID,"zh-CN")).resolves.toMatchObject({phase:"reporting"});
  });

  it("replays a submitted demo assessment without parent-report consent as consent",async()=>{
    install({definition:scale,role:"student",status:"queued",scopes:participation,snapshot:{score:{risk:false}}});
    await expect(submitAssessment(actor("student"),ASSESSMENT_ID,{answers:{q1:1,q2:2,q3:1,q4:2,q5:1,q6:2,q7:1,q8:2,q9:0},acknowledged:true,revision:0})).resolves.toMatchObject({status:"queued",phase:"consent",safetyGuidance:false});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("UPDATE assessments SET answers"))).toBe(false);
    await expect(assessmentDetail(actor("student"),ASSESSMENT_ID,"zh-HK")).resolves.toMatchObject({status:"queued",phase:"consent"});
  });

  it("replays the last triad role without parent-report consent as consent and does not score again",async()=>{
    install({definition:teacherScale,role:"teacher",status:"queued",scopes:participation,submittedRoles:["parent","student","teacher"],snapshot:{score:{risk:true}}});
    await expect(submitAssessment(actor("teacher"),ASSESSMENT_ID,{answers:previewAnswers(teacherScale,"risk"),acknowledged:true,revision:0})).resolves.toMatchObject({status:"queued",phase:"consent",safetyGuidance:true,reportId:null});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("UPDATE assessments SET answers"))).toBe(false);
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO report_jobs"))).toBe(false);
  });
});
