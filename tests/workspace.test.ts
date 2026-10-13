import { describe,it,expect,beforeEach,afterEach,vi } from "vitest";

vi.mock("../src/lib/db",()=>({query:vi.fn()}));
import { query } from "../src/lib/db";
import { workspaceFor } from "../src/lib/workspace";
import { demoScale } from "../src/domain/demo";
import type { Actor,Role } from "../src/domain/types";

// workspaceFor decides how much of each family a role gets to see. The interesting
// behaviour is what is withheld: a student must not receive the guardian label, another
// family's report ids, the staff list, or case observations.

const mockQuery=vi.mocked(query);
const FAMILY_ID="22222222-3333-4444-8555-666666666666";
const SELF="99999999-8888-4777-8666-555555555555";
const OTHER="77777777-6666-4555-8444-333333333333";
const actor=(role:Role,over:Partial<Actor>={}):Actor=>({id:SELF,name:"Synthetic",role,region:"CN",...over});

const familyRow={id:FAMILY_ID,region:"CN",family_name:"Synthetic family",child_name:"Synthetic child",birth_date:"2013-04-12",grade:"S2",guardian_label:"Mother",assigned_to:OTHER,assigned_name:"Historical case worker",created_at:new Date("2026-01-01T00:00:00Z")};
const assessmentRow={id:"a1",family_id:FAMILY_ID,respondent_id:SELF,respondent_role:"student",scale_version_id:"s1",status:"pending",created_at:new Date("2026-01-01T00:00:00Z"),submitted_at:null,child_name:"Synthetic child",respondent_name:"Synthetic",definition:demoScale,report_id:"r1"};

function stub(){
  mockQuery.mockReset();
  mockQuery.mockImplementation((async(sql:string)=>{
    const text=String(sql);
    if(text.includes("FROM families f WHERE"))return [familyRow];
    if(text.includes("FROM memberships m JOIN users u"))return [{family_id:FAMILY_ID,id:SELF,name:"Synthetic",role:"student"},{family_id:FAMILY_ID,id:OTHER,name:"Other",role:"parent"}];
    if(text.includes("DISTINCT family_id FROM consents"))return [{family_id:FAMILY_ID}];
    if(text.includes("FROM assessments a JOIN families f"))return [assessmentRow];
    if(text.includes("FROM reports WHERE family_id"))return [{id:"r1",family_id:FAMILY_ID,assessment_id:"a1",region:"CN",payload:{score:{risk:false,dimensions:[],respondentRole:"student",demo:true},template:{content:{title:{"zh-CN":"T","zh-HK":"T"}}},scale:{title:{"zh-CN":"S","zh-HK":"S"}},childName:"c",generationMode:"template",comparison:{available:false}},pdf_keys:{},html_documents:{},created_at:new Date()}];
    if(text.includes("FROM goals WHERE family_id"))return [{id:"g1",family_id:FAMILY_ID,title:"Goal",detail:"d",status:"active",created_at:new Date()}];
    if(text.includes("FROM observations o"))return [{id:"o1",family_id:FAMILY_ID,body:"note",created_at:new Date(),author_name:"Staff"}];
    if(text.includes("FROM scales ORDER BY"))return [{id:"s1",scale_id:"s",version:"1.0.0",definition:demoScale,status:"active"}];
    if(text.includes("SELECT id,name FROM users WHERE region=$1"))return [{id:OTHER,name:"Staff"}];
    if(text.includes("FROM content_versions ORDER BY"))return [{id:"c1",kind:"advice",version:"1.0.0",created_at:new Date()}];
    return [];
  }) as never);
}

beforeEach(()=>{
  vi.stubEnv("NOVA_REGION","CN");vi.stubEnv("NOVA_MODE","demo");
  vi.stubEnv("DATABASE_URL","postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR","work/test-private");
  vi.stubEnv("NOVA_REPORT_KEY","0".repeat(64));
  stub();
});
afterEach(()=>vi.unstubAllEnvs());

const sqls=()=>mockQuery.mock.calls.map(call=>String(call[0]));

describe("assessment scoping",()=>{
  it("restricts students and teachers to their own assessments in SQL",async()=>{
    await workspaceFor(actor("student"),"zh-CN");
    const [sql,values]=mockQuery.mock.calls.find(call=>String(call[0]).includes("FROM assessments a JOIN families f"))!;
    expect(String(sql)).toContain("($3::boolean OR a.respondent_id=$4)");
    expect(values).toContain(SELF);
    expect(values).toContain(false);
  });
  it("lets caring roles see every assessment in their families",async()=>{
    await workspaceFor(actor("parent"),"zh-CN");
    const [,values]=mockQuery.mock.calls.find(call=>String(call[0]).includes("FROM assessments a JOIN families f"))!;
    expect(values).toContain(true);
  });
  it("only marks the caller's own pending task as answerable",async()=>{
    // An assessment belonging to somebody else, as seen by a parent.
    mockQuery.mockImplementation((async(sql:string)=>{
      const text=String(sql);
      if(text.includes("FROM families f WHERE"))return [familyRow];
      if(text.includes("FROM assessments a JOIN families f"))return [{...assessmentRow,respondent_id:OTHER}];
      return [];
    }) as never);
    expect((await workspaceFor(actor("parent"),"zh-CN")).assessments[0].canRespond).toBe(false);

    // The same row seen by its own respondent.
    mockQuery.mockImplementation((async(sql:string)=>{
      const text=String(sql);
      if(text.includes("FROM families f WHERE"))return [familyRow];
      if(text.includes("FROM assessments a JOIN families f"))return [{...assessmentRow,respondent_id:SELF}];
      return [];
    }) as never);
    expect((await workspaceFor(actor("student"),"zh-CN")).assessments[0].canRespond).toBe(true);

    // Own, but already submitted.
    mockQuery.mockImplementation((async(sql:string)=>{
      const text=String(sql);
      if(text.includes("FROM families f WHERE"))return [familyRow];
      if(text.includes("FROM assessments a JOIN families f"))return [{...assessmentRow,respondent_id:SELF,status:"published"}];
      return [];
    }) as never);
    expect((await workspaceFor(actor("student"),"zh-CN")).assessments[0].canRespond).toBe(false);
  });
});

describe("retry capabilities",()=>{
  function withFailed(over:Record<string,unknown>={}){
    mockQuery.mockImplementation((async(sql:string)=>{
      const text=String(sql);
      if(text.includes("FROM families f WHERE"))return [familyRow];
      if(text.includes("FROM assessments a JOIN families f"))return [{...assessmentRow,status:"failed",job_state:"failed",has_snapshot:true,has_answers:true,has_submission:true,is_triad:false,has_round_sources:false,has_consent:true,...over}];
      return [];
    }) as never);
  }
  it("gives retry only to the admin and assigned staff, not safety-visible staff or parents",async()=>{
    withFailed();
    expect((await workspaceFor(actor("admin"),"zh-CN")).assessments[0].canRetryReport).toBe(true);
    expect((await workspaceFor(actor("staff",{id:OTHER}),"zh-CN")).assessments[0].canRetryReport).toBe(true);
    expect((await workspaceFor(actor("staff"),"zh-CN")).assessments[0].canRetryReport).toBe(false);
    expect((await workspaceFor(actor("parent"),"zh-CN")).assessments[0].canRetryReport).toBe(false);
  });
  it.each([
    {job_state:null},{has_snapshot:false},{has_answers:false},{has_submission:false},{has_consent:false},
    {is_triad:true,has_round_sources:false},{status:"queued",job_state:"ready"}
  ])("does not offer a blocked or already queued retry %o",async over=>{
    withFailed(over);
    expect((await workspaceFor(actor("admin"),"zh-CN")).assessments[0].canRetryReport).toBe(false);
  });
  it("returns no retry internals to the client",async()=>{
    withFailed();
    const item=(await workspaceFor(actor("admin"),"zh-CN")).assessments[0];
    for(const key of ["snapshot","answers","has_consent","has_snapshot","job_state"]){expect(item).not.toHaveProperty(key);}
  });
});

describe("assignee display and options",()=>{
  it("retains a historical assignee name separately from available candidates",async()=>{
    expect((await workspaceFor(actor("staff"),"zh-CN")).families[0].assignedName).toBe("Historical case worker");
    expect((await workspaceFor(actor("parent"),"zh-CN")).families[0].assignedName).toBeNull();
    expect((await workspaceFor(actor("student"),"zh-CN")).families[0].assignedName).toBeNull();
  });
  it("queries only enabled regional staff as assignment options",async()=>{
    await workspaceFor(actor("admin"),"zh-CN");
    const candidate=mockQuery.mock.calls.find(([sql])=>String(sql).includes("SELECT id,name FROM users WHERE region=$1"));
    expect(candidate?.[0]).toContain("role='staff' AND NOT disabled");
    expect(candidate?.[1]).toEqual(["CN"]);
  });
});

describe("family invitation capability",()=>{
  it("allows only administrators and the assigned staff member to invite",async()=>{
    expect((await workspaceFor(actor("admin"),"zh-CN")).families[0].canInviteMembers).toBe(true);
    expect((await workspaceFor(actor("staff",{id:OTHER}),"zh-CN")).families[0].canInviteMembers).toBe(true);
    for(const role of ["staff","parent","student","teacher"] as const){
      expect((await workspaceFor(actor(role),"zh-CN")).families[0].canInviteMembers).toBe(false);
    }
  });
  it("keeps the safety-visible family and observations when invitations are denied",async()=>{
    const workspace=await workspaceFor(actor("staff"),"zh-CN");
    expect(workspace.families).toHaveLength(1);
    expect(workspace.families[0]).toMatchObject({id:FAMILY_ID,canInviteMembers:false});
    expect(workspace.observations).toHaveLength(1);
  });
  it("shares the join code only with the parent, administrator and assigned staff",async()=>{
    const original=mockQuery.getMockImplementation()!;
    mockQuery.mockImplementation((async(sql:string,values:unknown[])=>String(sql).includes("FROM families f WHERE")?[{...familyRow,join_code:"TOPE-A2B3C4D5"}]:original(sql,values)) as never);
    expect((await workspaceFor(actor("admin"),"zh-CN")).families[0].joinCode).toBe("TOPE-A2B3C4D5");
    expect((await workspaceFor(actor("parent"),"zh-CN")).families[0].joinCode).toBe("TOPE-A2B3C4D5");
    expect((await workspaceFor(actor("staff",{id:OTHER}),"zh-CN")).families[0].joinCode).toBe("TOPE-A2B3C4D5");
    for(const role of ["staff","student","teacher"] as const){
      expect((await workspaceFor(actor(role),"zh-CN")).families[0].joinCode).toBeNull();
    }
  });
});

describe("what a student does not receive",()=>{
  it("withholds the guardian label",async()=>{
    expect((await workspaceFor(actor("student"),"zh-CN")).families[0].guardianLabel).toBe("");
    stub();
    expect((await workspaceFor(actor("parent"),"zh-CN")).families[0].guardianLabel).toBe("Mother");
  });
  it("withholds the assigned case worker",async()=>{
    expect((await workspaceFor(actor("student"),"zh-CN")).families[0].assignedTo).toBeNull();
    stub();
    expect((await workspaceFor(actor("staff"),"zh-CN")).families[0].assignedTo).toBe(OTHER);
  });
  it("shows a student only themselves in the member list",async()=>{
    const workspace=await workspaceFor(actor("student"),"zh-CN");
    expect(workspace.families[0].members.map(m=>m.id)).toEqual([SELF]);
  });
  it("shows caring roles the whole member list",async()=>{
    const workspace=await workspaceFor(actor("parent"),"zh-CN");
    expect(workspace.families[0].members.map(m=>m.id).sort()).toEqual([SELF,OTHER].sort());
  });
  it("withholds report ids and the report list",async()=>{
    const workspace=await workspaceFor(actor("student"),"zh-CN");
    expect(workspace.assessments[0].reportId).toBeNull();
    expect(workspace.reports).toEqual([]);
  });
  it("withholds goals, observations, the staff list and content versions",async()=>{
    const workspace=await workspaceFor(actor("student"),"zh-CN");
    expect(workspace.goals).toEqual([]);
    expect(workspace.observations).toEqual([]);
    expect(workspace.staff).toEqual([]);
    expect(workspace.contentVersions).toEqual([]);
  });
  it("does not even query for the things a student may not see",async()=>{
    await workspaceFor(actor("student"),"zh-CN");
    expect(sqls().some(sql=>sql.includes("FROM observations o"))).toBe(false);
    expect(sqls().some(sql=>sql.includes("FROM goals WHERE"))).toBe(false);
    expect(sqls().some(sql=>sql.includes("FROM content_versions ORDER BY"))).toBe(false);
  });
});

describe("what a parent receives, and what they still do not",()=>{
  it("gets reports and goals",async()=>{
    const workspace=await workspaceFor(actor("parent"),"zh-CN");
    expect(workspace.reports).toHaveLength(1);
    expect(workspace.goals).toHaveLength(1);
  });
  it("orders goals by creation time and id so a status change cannot reshuffle ties",async()=>{
    await workspaceFor(actor("parent"),"zh-CN");
    const sql=sqls().find(item=>item.includes("FROM goals WHERE"));
    expect(sql).toContain("ORDER BY created_at DESC, id ASC");
  });
  it("still does not get case observations or the staff list",async()=>{
    const workspace=await workspaceFor(actor("parent"),"zh-CN");
    expect(workspace.observations).toEqual([]);
    expect(workspace.staff).toEqual([]);
  });
});

describe("administrator extras",()=>{
  it("gets observations, the staff list and content versions",async()=>{
    const workspace=await workspaceFor(actor("admin"),"zh-CN");
    expect(workspace.observations).toHaveLength(1);
    expect(workspace.staff).toHaveLength(1);
    expect(workspace.contentVersions).toHaveLength(1);
  });
  it("gets the same for staff except content versions, which are admin-only",async()=>{
    const workspace=await workspaceFor(actor("staff"),"zh-CN");
    expect(workspace.observations).toHaveLength(1);
    expect(workspace.contentVersions).toEqual([]);
  });
});

describe("safety alerts on the workbench",()=>{
  it("asks only for alerts that nobody has marked viewed",async()=>{
    await workspaceFor(actor("staff"),"zh-CN");
    const sql=sqls().find(item=>item.includes("FROM staff_alerts a"));
    expect(sql).toContain("a.viewed_at IS NULL");
  });
  it("does not query alerts for a parent or a student",async()=>{
    await workspaceFor(actor("parent"),"zh-CN");
    expect(sqls().some(sql=>sql.includes("FROM staff_alerts"))).toBe(false);
    stub();
    await workspaceFor(actor("student"),"zh-CN");
    expect(sqls().some(sql=>sql.includes("FROM staff_alerts"))).toBe(false);
  });
  it("routes an unassigned family's open alert to regional admins and staff",async()=>{
    const unassigned={...familyRow,assigned_to:null,assigned_name:null};
    mockQuery.mockImplementation((async(sql:string)=>{
      const text=String(sql);
      if(text.includes("FROM families f WHERE"))return [unassigned];
      if(text.includes("FROM staff_alerts"))return [{id:"alert-unassigned",family_id:FAMILY_ID,child_name:"Synthetic child",created_at:new Date("2026-10-06T00:00:00Z")}];
      return [];
    }) as never);
    for(const role of ["admin","staff"] as const){
      mockQuery.mockClear();
      const workspace=await workspaceFor(actor(role),"zh-CN");
      expect(workspace.families[0].assignedTo).toBeNull();
      expect(workspace.alerts).toEqual([{id:"alert-unassigned",familyId:FAMILY_ID,childName:"Synthetic child",createdAt:"2026-10-06T00:00:00.000Z"}]);
      const sql=sqls().find(item=>item.includes("FROM staff_alerts a"));
      expect(sql).toContain("a.region=$1");
      expect(sql).toContain("a.viewed_at IS NULL");
      expect(sql).not.toMatch(/assigned_to/);
    }
  });
  it("maps an open alert onto the workbench",async()=>{
    mockQuery.mockImplementation((async(sql:string)=>{
      const text=String(sql);
      if(text.includes("FROM families f WHERE"))return [familyRow];
      if(text.includes("FROM staff_alerts"))return [{id:"alert-1",family_id:FAMILY_ID,child_name:"Synthetic child",created_at:new Date("2026-10-06T00:00:00Z")}];
      return [];
    }) as never);
    const workspace=await workspaceFor(actor("staff"),"zh-CN");
    expect(workspace.alerts).toEqual([{id:"alert-1",familyId:FAMILY_ID,childName:"Synthetic child",createdAt:"2026-10-06T00:00:00.000Z"}]);
  });
});

describe("triad reports with fixed round sources",()=>{
  const triadDefinition={...demoScale,bundle:"growth-triad"};
  const at=(day:string)=>new Date(`2026-${day}T00:00:00Z`);
  function row(over:Record<string,unknown>){
    return {...assessmentRow,definition:triadDefinition,status:"published",submitted_at:at("03-01"),report_id:null,triad_round_id:"round-1",triad_job_id:null,respondent_id:OTHER,...over};
  }
  function load(rows:unknown[],role:Role="parent"){
    mockQuery.mockImplementation((async(sql:string)=>{
      if(String(sql).includes("FROM families f WHERE"))return [familyRow];
      if(String(sql).includes("FROM assessments a JOIN families f"))return rows;
      return [];
    }) as never);
    return workspaceFor(actor(role),"zh-CN");
  }
  it("shows the same stored report for all three published sources",async()=>{
    const workspace=await load(["student","parent","teacher"].map(role=>row({id:role,respondent_role:role,report_id:"r1",triad_job_id:"job1"})));
    for(const item of workspace.assessments)expect(item).toMatchObject({status:"published",reportId:"r1",phase:null});
    const sql=sqls().find(value=>value.includes("FROM assessments a JOIN families f"));
    expect(sql).toContain("a.id=ANY(j.source_assessment_ids)");
  });
  it("shows generating for a student's own source without exposing peers or report id",async()=>{
    const workspace=await load([row({id:"child",respondent_id:SELF,respondent_role:"student",status:"queued",triad_job_id:"job1"})],"student");
    expect(workspace.assessments).toHaveLength(1);
    expect(workspace.assessments[0]).toMatchObject({status:"queued",reportId:null,phase:"reporting"});
  });
  it("keeps a new round waiting even when all previous roles have published",async()=>{
    const workspace=await load([
      ...["student","parent","teacher"].map(role=>row({id:role,respondent_role:role,triad_job_id:"job1",report_id:"r1"})),
      row({id:"p2",respondent_role:"parent",status:"queued",triad_round_id:"round-2",submitted_at:at("07-01")})
    ]);
    expect(workspace.assessments.find(item=>item.id==="p2")).toMatchObject({status:"queued",phase:"waiting",reportId:null});
  });
  it("does not infer a legacy report from role order or submission time",async()=>{
    const workspace=await load([
      row({id:"p1",respondent_role:"parent",triad_round_id:null,report_id:"legacy-report"}),
      row({id:"child",respondent_role:"student",triad_round_id:null,status:"queued",submitted_at:at("03-02")}),
      row({id:"teacher",respondent_role:"teacher",triad_round_id:null,status:"queued",submitted_at:at("03-03")})
    ]);
    expect(workspace.assessments.find(item=>item.id==="p1")?.reportId).toBe("legacy-report");
    for(const id of ["child","teacher"])expect(workspace.assessments.find(item=>item.id===id)).toMatchObject({status:"queued",phase:"waiting",reportId:null});
  });
  it("withholds shared report ids from students and teachers",async()=>{
    for(const role of ["student","teacher"] as const){
      const workspace=await load([row({id:role,respondent_role:role,report_id:"r1",triad_job_id:"job1"})],role);
      expect(workspace.assessments[0]).toMatchObject({status:"published",reportId:null});
    }
  });
  it("retains exact earlier and later report mappings regardless of row order",async()=>{
    const workspace=await load([
      row({id:"c2",respondent_role:"student",triad_round_id:"round-2",report_id:"r2"}),
      row({id:"p1",respondent_role:"parent",report_id:"r1"}),
      row({id:"t2",respondent_role:"teacher",triad_round_id:"round-2",report_id:"r2"}),
      row({id:"c1",respondent_role:"student",report_id:"r1"}),
      row({id:"p2",respondent_role:"parent",triad_round_id:"round-2",report_id:"r2"}),
      row({id:"t1",respondent_role:"teacher",report_id:"r1"})
    ]);
    for(const item of workspace.assessments)expect(item.reportId).toBe(item.id.endsWith("1")?"r1":"r2");
  });
});

describe("instrument visibility and summary",()=>{
  it("only lists instruments that apply to the caller's region",async()=>{
    const workspace=await workspaceFor(actor("admin"),"zh-CN");
    expect(workspace.scales).toHaveLength(1);
    expect(workspace.scales[0].title).toBe(demoScale.title["zh-CN"]);
  });
  it("counts only what this caller can see",async()=>{
    const workspace=await workspaceFor(actor("student"),"zh-CN");
    expect(workspace.summary.families).toBe(1);
    expect(workspace.summary.pendingAssessments).toBe(1);
    expect(workspace.summary.publishedReports).toBe(0);
    expect(workspace.summary.activeGoals).toBe(0);
  });
});
