import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import type { PoolClient } from "pg";
import type { Actor,RespondentRole } from "../src/domain/types";
import { childScale,parentScale,teacherScale } from "../src/domain/triad-scales";
import { previewAnswers } from "../src/domain/triad-report";
import { demoAdvice,demoTemplate } from "../src/domain/demo";

vi.mock("../src/lib/db",()=>({query:vi.fn(),transaction:vi.fn()}));
vi.mock("../src/lib/content",()=>({currentContent:vi.fn(),lockContent:vi.fn()}));
import { query,transaction } from "../src/lib/db";
import { currentContent } from "../src/lib/content";
import { submitAssessment } from "../src/lib/assessments";
import { queueTriadReport } from "../src/lib/triad";

const familyId="11111111-2222-4333-8444-555555555555";
const assessmentId="22222222-3333-4444-8555-666666666666";
const userId="33333333-4444-4555-8666-777777777777";
const roundId="44444444-5555-4666-8777-888888888888";
const scales={parent:parentScale,student:childScale,teacher:teacherScale};
const client={query:vi.fn<(sql:string,values?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>>()};
const actor=(role:RespondentRole):Actor=>({id:userId,name:"Synthetic",role,region:"CN"});

beforeEach(()=>{
  vi.stubEnv("NOVA_REGION","CN");vi.stubEnv("NOVA_MODE","demo");
  vi.stubEnv("DATABASE_URL","postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR","work/test-private");vi.stubEnv("NOVA_REPORT_KEY","0".repeat(64));
  vi.mocked(query).mockReset();client.query.mockReset();
  vi.mocked(transaction).mockImplementation(fn=>fn(client as unknown as PoolClient));
  vi.mocked(currentContent).mockImplementation((async(kind:string)=>({id:kind,version:"1.0.0",content:kind==="advice"?demoAdvice:demoTemplate})) as typeof currentContent);
});
afterEach(()=>vi.unstubAllEnvs());

function setup(role:RespondentRole,status="pending"){
  const assessment={id:assessmentId,family_id:familyId,respondent_id:userId,respondent_role:role,definition:scales[role],status,draft_revision:0,triad_round_id:roundId};
  vi.mocked(query).mockImplementation(async(sql:string)=>{
    if(sql.includes("FROM assessments a JOIN scales"))return [assessment];
    if(sql.includes("FROM families f WHERE"))return [{id:familyId,child_name:"Synthetic child",birth_date:"2013-04-12",grade:"S2"}];
    return [];
  });
  client.query.mockImplementation(async(sql:string)=>{
    if(sql.includes("SELECT id FROM families"))return {rows:[{id:familyId}]};
    if(sql.includes("SELECT a.*,r.id AS report_id"))return {rows:[assessment]};
    if(sql.includes("SELECT scopes FROM consents"))return {rows:[{scopes:["assessment","parent_report","sensitive_data"]}]};
    if(sql.includes("INSERT INTO staff_alerts"))return {rows:[{id:"new-alert"}]};
    return {rows:[]};
  });
}
const calls=()=>client.query.mock.calls;

describe("safety at accepted triad submission",()=>{
  it.each(["parent","student","teacher"] as const)("notifies a %s risk before waiting for other roles",async role=>{
    setup(role);
    const result=await submitAssessment(actor(role),assessmentId,{answers:previewAnswers(scales[role],"risk"),acknowledged:true,revision:0});
    const writes=calls();
    const alerts=writes.filter(([sql])=>sql.includes("INSERT INTO staff_alerts"));
    expect(alerts).toHaveLength(1);
    expect(String(alerts[0][0])).toContain("ON CONFLICT(assessment_id) WHERE assessment_id IS NOT NULL DO NOTHING");
    expect(alerts[0][1]?.slice(1)).toEqual([familyId,"CN",assessmentId]);
    expect(writes.findIndex(([sql])=>sql.includes("INSERT INTO staff_alerts"))).toBeLessThan(writes.findIndex(([sql])=>sql.includes("SELECT id,respondent_role")));
    expect(writes.filter(([sql])=>sql.includes("triad.safety_notified"))).toHaveLength(1);
    expect(writes.some(([sql])=>sql.includes("INSERT INTO report_jobs"))).toBe(false);
    expect(result).toMatchObject({status:"queued",reportId:null,phase:"waiting",safetyGuidance:true});
  });
  it("does not notify for a calm accepted submission",async()=>{
    setup("student");
    const result=await submitAssessment(actor("student"),assessmentId,{answers:previewAnswers(childScale,"calm"),acknowledged:true,revision:0});
    expect(calls().some(([sql])=>sql.includes("INSERT INTO staff_alerts"))).toBe(false);
    expect(result).toMatchObject({safetyGuidance:false,phase:"waiting"});
  });
  it("does not notify from a hidden immediate-danger answer",async()=>{
    setup("student");
    const answers=previewAnswers(childScale,"calm");
    answers.c15=1;
    const result=await submitAssessment(actor("student"),assessmentId,{answers,acknowledged:true,revision:0});
    expect(calls().some(([sql])=>sql.includes("INSERT INTO staff_alerts"))).toBe(false);
    expect(result.safetyGuidance).toBe(false);
  });
  it("rejects a harm answer combined with an exclusive safety option before notifying",async()=>{
    setup("student");
    const answers=previewAnswers(childScale,"risk");
    answers.c14=[1,6];
    await expect(submitAssessment(actor("student"),assessmentId,{answers,acknowledged:true,revision:0})).rejects.toMatchObject({status:422});
    expect(calls().some(([sql])=>sql.includes("INSERT INTO staff_alerts"))).toBe(false);
  });
  it("rejects an incomplete risk submission before notifying",async()=>{
    setup("student");
    await expect(submitAssessment(actor("student"),assessmentId,{answers:{c14:[1]},acknowledged:true,revision:0})).rejects.toMatchObject({status:422});
    expect(calls().some(([sql])=>sql.includes("INSERT INTO staff_alerts"))).toBe(false);
  });
  it("keeps an accepted submission's existing alert on replay",async()=>{
    setup("student","queued");
    await submitAssessment(actor("student"),assessmentId,{answers:previewAnswers(childScale,"risk"),acknowledged:true,revision:0});
    expect(calls().some(([sql])=>sql.includes("staff_alerts"))).toBe(false);
  });
  it("does not notify again when the complete round is queued",async()=>{
    client.query.mockImplementation(async sql=>({rows:sql.startsWith("SELECT")?["parent","student","teacher"].map((role,i)=>({id:`source-${i}`,respondent_role:role,snapshot:{score:{risk:true}}})):[{id:"job"}]}));
    await queueTriadReport(client as unknown as PoolClient,familyId,roundId);
    expect(calls().filter(([sql])=>sql.includes("INSERT INTO report_jobs"))).toHaveLength(1);
    expect(calls().some(([sql])=>sql.includes("staff_alerts")||sql.includes("safety_notified"))).toBe(false);
  });
  it("keeps exactly one alert when the other roles later complete the round",async()=>{
    setup("student");
    await submitAssessment(actor("student"),assessmentId,{answers:previewAnswers(childScale,"risk"),acknowledged:true,revision:0});
    expect(calls().filter(([sql])=>sql.includes("INSERT INTO staff_alerts"))).toHaveLength(1);
    client.query.mockImplementation(async sql=>({rows:sql.includes("SELECT id,respondent_role")?["parent","student","teacher"].map((role,i)=>({id:`source-${i}`,respondent_role:role})):[{id:"job"}]}));
    await queueTriadReport(client as unknown as PoolClient,familyId,roundId);
    expect(calls().filter(([sql])=>sql.includes("INSERT INTO staff_alerts"))).toHaveLength(1);
    expect(calls().filter(([sql])=>sql.includes("INSERT INTO report_jobs"))).toHaveLength(1);
  });
});
