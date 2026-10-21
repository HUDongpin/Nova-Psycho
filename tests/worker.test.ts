import { describe,it,expect,beforeEach,afterEach,vi } from "vitest";

vi.mock("../src/lib/db",()=>({query:vi.fn(),transaction:vi.fn()}));
vi.mock("../src/lib/pdf",()=>({renderPdf:vi.fn(async()=>Buffer.from("%PDF-1.4 stub")),closePdfBrowser:vi.fn()}));
vi.mock("../src/lib/storage",()=>({writePrivatePdf:vi.fn(async()=>undefined),removePrivatePdf:vi.fn(async()=>"done"),listPrivatePdfKeys:vi.fn(async()=>[]),cleanAbandonedPrivatePdfTemps:vi.fn(async()=>undefined)}));
vi.mock("../src/domain/narrative",()=>({selectNarrative:vi.fn(async()=>({selectedAdviceIds:["listen"],generationMode:"template",fallbackReason:"ai_disabled",aiModel:null}))}));
import { query,transaction } from "../src/lib/db";
import { renderPdf } from "../src/lib/pdf";
import { listPrivatePdfKeys,removePrivatePdf,writePrivatePdf } from "../src/lib/storage";
import { cleanOrphanReports,processDeletionJobs,processOneJob,processReportJob,recordHeartbeat } from "../src/lib/worker";
import { demoAdvice,demoScale,demoTemplate } from "../src/domain/demo";
import { scoreAssessment } from "../src/domain/scoring";
import { childScale,parentScale,teacherScale } from "../src/domain/triad-scales";
import { childScale as oldChild,parentScale as oldParent,teacherScale as oldTeacher } from "./fixtures/triad-scales-ed66f27";
import { previewAnswers } from "../src/domain/triad-report";
import * as triadReports from "../src/domain/triad-report";
import { selectNarrative } from "../src/domain/narrative";
import type { AssessmentSnapshot, ReportPayload } from "../src/domain/types";

const mockQuery=vi.mocked(query);
const mockTransaction=vi.mocked(transaction);
const mockWrite=vi.mocked(writePrivatePdf);
const mockRemove=vi.mocked(removePrivatePdf);
const mockList=vi.mocked(listPrivatePdfKeys);
const mockRender=vi.mocked(renderPdf);

const ASSESSMENT_ID="11111111-2222-4333-8444-555555555555";
const TOKEN="33333333-4444-4555-8666-777777777777";
const snapshot:AssessmentSnapshot={
  scale:demoScale,advice:{id:"a",version:"1.0.0",content:demoAdvice},template:{id:"t",version:"1.0.0",content:demoTemplate},
  score:scoreAssessment(demoScale,{q1:1,q2:2,q3:1,q4:2,q5:1,q6:2,q7:1,q8:2,q9:0},{age:12,region:"CN",role:"student"}),
  childName:"Synthetic child",grade:"S2",submittedAt:"2026-09-15T00:00:00.000Z",aiConsented:false
};

const clientCalls:string[]=[];
const client={query:vi.fn(async(sql:string,_values:unknown[]=[])=>{clientCalls.push(String(sql));return {rows:[] as Record<string,unknown>[]};})};

function config(){
  vi.stubEnv("NOVA_REGION","CN");vi.stubEnv("NOVA_MODE","demo");
  vi.stubEnv("DATABASE_URL","postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR","work/test-private");
  vi.stubEnv("NOVA_REPORT_KEY","0".repeat(64));
}

beforeEach(()=>{
  config();
  mockQuery.mockReset();mockTransaction.mockReset();mockWrite.mockClear();mockRemove.mockReset();mockList.mockReset();mockRender.mockReset().mockResolvedValue(Buffer.from("%PDF-1.4 stub"));
  mockRemove.mockResolvedValue("done");
  clientCalls.length=0;
  client.query.mockReset().mockImplementation(async(sql:string)=>{
    clientCalls.push(sql);
    if(sql.includes("AS scopes FROM consents"))return {rows:[{scopes:["parent_report"]}]};
    if(sql.includes("SELECT id FROM families")||sql.includes("FROM report_jobs WHERE id=$1 AND claim_token"))return {rows:[{id:"locked"}]};
    return {rows:[]};
  });
  mockTransaction.mockImplementation((async(fn:(c:unknown)=>Promise<unknown>)=>fn(client)) as never);
  mockList.mockResolvedValue([]);
});
afterEach(()=>vi.unstubAllEnvs());

describe("worker heartbeat",()=>{
  it("upserts by worker id and refreshes the timestamp",async()=>{
    mockQuery.mockResolvedValueOnce([]);
    await recordHeartbeat("worker-a");
    const [sql,values]=mockQuery.mock.calls[0];
    expect(String(sql)).toContain("INSERT INTO worker_heartbeats");
    expect(String(sql)).toContain("ON CONFLICT(region) DO UPDATE");
    expect(String(sql)).toContain("heartbeat_at=now()");
    expect(values).toEqual(["CN","worker-a"]);
  });
  it("resets the cycle counter when a different worker takes over",async()=>{
    mockQuery.mockResolvedValueOnce([]);
    await recordHeartbeat("worker-b");
    expect(String(mockQuery.mock.calls[0][0])).toContain("worker_heartbeats.worker_id<>EXCLUDED.worker_id THEN 1");
  });
});

describe("deletion queue",()=>{
  it("removes each queued file and clears its row",async()=>{
    mockQuery.mockResolvedValueOnce([{file_key:"a.zh-CN.pdf.enc"}]).mockResolvedValue([]);
    await processDeletionJobs();
    expect(mockRemove).toHaveBeenCalledWith("a.zh-CN.pdf.enc");
    expect(String(mockQuery.mock.calls[1][0])).toContain("DELETE FROM file_deletion_jobs");
  });
  it("does nothing when the queue is empty",async()=>{
    mockQuery.mockResolvedValueOnce([]);
    await processDeletionJobs();
    expect(mockRemove).not.toHaveBeenCalled();
  });
  it("preserves the busy job and stops the batch, then clears it only after a later successful removal",async()=>{
    const jobs=[{file_key:"a.zh-CN.pdf.enc"},{file_key:"b.zh-CN.pdf.enc"}];
    mockQuery.mockResolvedValueOnce(jobs).mockResolvedValue([]);
    mockRemove.mockResolvedValueOnce("busy");
    await expect(processDeletionJobs()).resolves.toBe("busy");
    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    mockQuery.mockResolvedValueOnce(jobs);
    await expect(processDeletionJobs()).resolves.toBe("done");
    expect(mockQuery.mock.calls.filter(([sql])=>String(sql).startsWith("DELETE FROM file_deletion_jobs"))).toEqual([
      ["DELETE FROM file_deletion_jobs WHERE file_key=$1",[jobs[0].file_key]],
      ["DELETE FROM file_deletion_jobs WHERE file_key=$1",[jobs[1].file_key]]
    ]);
  });
  it("does not clear a queued task or continue the batch after a real removal failure",async()=>{
    mockQuery.mockResolvedValueOnce([{file_key:"a.zh-CN.pdf.enc"},{file_key:"b.zh-CN.pdf.enc"}]);
    const failure=new Error("synthetic filesystem failure");
    mockRemove.mockRejectedValueOnce(failure);
    await expect(processDeletionJobs()).rejects.toBe(failure);
    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe("orphan report cleanup",()=>{
  it("removes a file whose assessment is gone or failed",async()=>{
    mockList.mockResolvedValueOnce([`${ASSESSMENT_ID}.${TOKEN}.zh-CN.pdf.enc`]);
    mockQuery.mockResolvedValueOnce([]);
    await cleanOrphanReports();
    expect(mockRemove).toHaveBeenCalled();
  });
  it("removes a file that the report record does not reference",async()=>{
    mockList.mockResolvedValueOnce([`${ASSESSMENT_ID}.${TOKEN}.zh-CN.pdf.enc`]);
    mockQuery.mockResolvedValueOnce([{status:"published",pdf_keys:{"zh-HK":"other.zh-HK.pdf.enc"}}]);
    await cleanOrphanReports();
    expect(mockRemove).toHaveBeenCalled();
  });
  it("keeps a file the published report still references",async()=>{
    const key=`${ASSESSMENT_ID}.${TOKEN}.zh-CN.pdf.enc`;
    mockList.mockResolvedValueOnce([key]);
    mockQuery.mockResolvedValueOnce([{status:"published",pdf_keys:{"zh-CN":key}}]);
    await cleanOrphanReports();
    expect(mockRemove).not.toHaveBeenCalled();
  });
  it("stops at a busy orphan and retries the retained files on the next cleanup",async()=>{
    const keys=[`${ASSESSMENT_ID}.${TOKEN}.zh-CN.pdf.enc`,`${ASSESSMENT_ID}.${TOKEN}.zh-HK.pdf.enc`];
    mockList.mockResolvedValue(keys);
    mockQuery.mockResolvedValue([]);
    mockRemove.mockResolvedValueOnce("busy");
    await expect(cleanOrphanReports()).resolves.toBe("busy");
    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    await expect(cleanOrphanReports()).resolves.toBe("done");
    expect(mockRemove.mock.calls).toEqual([[keys[0]],[keys[0]],[keys[1]]]);
  });
  it("propagates a failed orphan removal and stops the batch",async()=>{
    mockList.mockResolvedValue([`${ASSESSMENT_ID}.${TOKEN}.zh-CN.pdf.enc`,`${ASSESSMENT_ID}.${TOKEN}.zh-HK.pdf.enc`]);
    mockQuery.mockResolvedValue([]);
    const failure=new Error("synthetic database failure");
    mockRemove.mockRejectedValueOnce(failure);
    await expect(cleanOrphanReports()).rejects.toBe(failure);
    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe("processing one job",()=>{
  const job={id:"job1",assessment_id:ASSESSMENT_ID,attempts:1};
  it("returns false when there is nothing to claim",async()=>{
    mockQuery.mockResolvedValue([]);
    await expect(processOneJob()).resolves.toBe(false);
    expect(mockQuery.mock.calls.some(([sql])=>String(sql).includes("WITH candidate"))).toBe(true);
    expect(mockQuery.mock.calls.some(([sql])=>String(sql).includes("ORDER BY a.family_id,j.id LIMIT 25"))).toBe(true);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
  it("claims a job with a lease and skip-locked semantics",async()=>{
    mockQuery.mockResolvedValueOnce([job]).mockResolvedValue([]);
    await processOneJob();
    const sql=String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain("FOR UPDATE OF j SKIP LOCKED");
    expect(sql).toContain("parent_report");
    expect(sql).toContain("lease_until<now()");
    expect(sql).toContain("lease_until=now()+interval '5 minutes'");
  });
  it("scopes the assessment lookup to this region",async()=>{
    mockQuery.mockResolvedValueOnce([job]).mockResolvedValueOnce([]).mockResolvedValue([]);
    await processOneJob();
    const lookup=mockQuery.mock.calls.find(call=>String(call[0]).includes("FROM assessments WHERE id=$1"))!;
    expect(lookup[1]).toEqual([ASSESSMENT_ID,"CN"]);
  });
  it("refuses to publish a demo snapshot in service mode",async()=>{
    vi.stubEnv("NOVA_MODE","service");vi.stubEnv("NOVA_PUBLIC_URL","https://nova.example.invalid");
    mockQuery.mockResolvedValueOnce([job]).mockResolvedValueOnce([{snapshot}]).mockResolvedValue([]);
    await processOneJob();
    expect(mockWrite).not.toHaveBeenCalled();
  });
  it("renders both locales and stores them encrypted",async()=>{
    mockQuery.mockResolvedValueOnce([job])
      .mockResolvedValueOnce([{id:ASSESSMENT_ID,family_id:"family",snapshot}])
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);
    await processOneJob();
    expect(mockRender).toHaveBeenCalledTimes(2);
    expect(mockWrite).toHaveBeenCalledTimes(2);
    const keys=mockWrite.mock.calls.map(call=>String(call[0]));
    expect(keys.some(key=>key.endsWith("zh-CN.pdf.enc"))).toBe(true);
    expect(keys.some(key=>key.endsWith("zh-HK.pdf.enc"))).toBe(true);
  });
  it("does not contact the model when AI consent has been withdrawn",async()=>{
    mockQuery.mockResolvedValueOnce([job])
      .mockResolvedValueOnce([{id:ASSESSMENT_ID,family_id:"family",snapshot:{...snapshot,aiConsented:true}}])
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);
    await processOneJob();
    const { selectNarrative } = await import("../src/domain/narrative");
    const passed=vi.mocked(selectNarrative).mock.calls.at(-1)?.[0];
    expect(passed?.aiConsented).toBe(false);
  });
  it("requeues with a backoff while attempts remain",async()=>{
    mockQuery.mockResolvedValueOnce([{...job,attempts:1}])
      .mockResolvedValueOnce([{id:ASSESSMENT_ID,family_id:"family",snapshot}])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{assessment_id:ASSESSMENT_ID}])
      .mockResolvedValue([]);
    mockRender.mockRejectedValueOnce(new Error("render failed"));
    await processOneJob();
    const failure=mockQuery.mock.calls.find(call=>String(call[0]).includes("UPDATE report_jobs SET state=$1"))!;
    expect(failure[1]).toContain("ready");
  });
  it("marks the job and the assessment failed after the final attempt",async()=>{
    mockQuery.mockResolvedValueOnce([{...job,attempts:3}])
      .mockResolvedValueOnce([{id:ASSESSMENT_ID,family_id:"family",snapshot}])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{assessment_id:ASSESSMENT_ID}])
      .mockResolvedValue([]);
    mockRender.mockRejectedValueOnce(new Error("render failed"));
    await processOneJob();
    const failure=client.query.mock.calls.find(call=>String(call[0]).includes("UPDATE report_jobs SET state=$1"))!;
    expect(failure[1]).toContain("failed");
    const familyFailureLock=client.query.mock.calls.find(([sql])=>String(sql).includes("FOR UPDATE OF f"));
    expect(familyFailureLock?.[1]).toEqual([ASSESSMENT_ID,"CN"]);
    expect(client.query.mock.calls.indexOf(familyFailureLock!)).toBeLessThan(client.query.mock.calls.indexOf(failure));
    expect(failure[0]).toContain("UPDATE assessments SET status='failed'");
  });
  it("cleans up partially written files when rendering fails",async()=>{
    mockQuery.mockResolvedValueOnce([{...job,attempts:3}])
      .mockResolvedValueOnce([{id:ASSESSMENT_ID,family_id:"family",snapshot}])
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);
    mockRender.mockResolvedValueOnce(Buffer.from("%PDF-1.4 stub")).mockRejectedValueOnce(new Error("render failed"));
    await processOneJob();
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockRemove.mock.calls.map(([key])=>key)).toEqual(mockWrite.mock.calls.map(([key])=>key));
  });
});


describe("fixed triad report sources",()=>{
  const rows=([childScale,parentScale,teacherScale]).map((scale,index)=>{
    const role=scale.roles[0],answers=previewAnswers(scale);
    return {id:`source-${index}`,family_id:"family",triad_round_id:"round",respondent_id:`respondent-${role}`,respondent_role:role,answers,submitted_at:snapshot.submittedAt,
      snapshot:{...snapshot,scale,score:scoreAssessment(scale,answers,{age:12,region:"CN",role})}};
  });
  const parent=rows[1],sourceIds=rows.map(row=>row.id);
  function configure(sources:string[]|null=sourceIds,returned=rows,previous:typeof rows=[]){
    mockQuery.mockImplementation((async(sql:string)=>{
      if(sql.includes("WITH candidate AS"))return [{id:"triad-job",assessment_id:parent.id,attempts:1,source_assessment_ids:sources}];
      if(sql.includes("SELECT * FROM assessments WHERE id="))return [parent];
      if(sql.includes("SELECT id,respondent_role,answers"))return returned;
      if(sql.includes("WITH prior_round AS"))return previous;
      return [];
    }) as never);
    mockTransaction.mockImplementation((async(fn:(c:unknown)=>Promise<unknown>)=>fn({query:async()=>({rows:[{id:"locked"}]})})) as never);
  }
  it("renders only the pinned round and publishes those three sources",async()=>{
    configure();
    const calls:{sql:string;values:unknown[]}[]=[];
    mockTransaction.mockImplementation((async(fn:(c:unknown)=>Promise<unknown>)=>fn({query:async(sql:string,values:unknown[])=>{calls.push({sql,values});if(sql.includes("AS scopes FROM consents WHERE family_id=$1"))return {rows:[{scopes:["parent_report"]}]};return {rows:[{id:"locked"}]};}})) as never);
    await processOneJob();
    expect(mockRender).toHaveBeenCalledTimes(2);
    const lookup=mockQuery.mock.calls.find(([sql])=>String(sql).includes("SELECT id,respondent_role,answers"));
    expect(lookup?.[1]).toEqual([sourceIds,"family","CN","round"]);
    const publish=calls.find(call=>call.sql.includes("UPDATE assessments SET status='published'"));
    expect(publish?.values).toEqual([sourceIds]);
    expect(mockQuery.mock.calls.some(([sql])=>String(sql).includes("staff_alerts"))).toBe(false);
    expect(calls.some(call=>call.sql.includes("staff_alerts"))).toBe(false);
  });
  it("publishes comparison for the second complete triad round",async()=>{
    const previous=rows.map(row=>{
      const answers={...row.answers};
      if(row.respondent_role==="parent")for(const item of row.snapshot.scale.dimensions.find(d=>d.key==="q14")!.items)answers[item]=2;
      return {...row,id:`prior-${row.id}`,triad_round_id:"prior-round",submitted_at:"2026-06-01T00:00:00.000Z",
        snapshot:{...row.snapshot,score:scoreAssessment(row.snapshot.scale,answers,{age:12,region:"CN",role:row.respondent_role})}};
    });
    configure(sourceIds,rows,previous);
    let published:ReportPayload|undefined;
    mockTransaction.mockImplementation((async(fn:(c:unknown)=>Promise<unknown>)=>fn({query:async(sql:string,values:unknown[])=>{
      if(sql.includes("AS scopes FROM consents WHERE family_id=$1"))return {rows:[{scopes:["parent_report"]}]};
      if(sql.includes("INSERT INTO reports"))published=JSON.parse(values[3] as string) as ReportPayload;
      return {rows:[{id:"locked"}]};
    }})) as never);
    await processOneJob();
    expect(published).toBeDefined();
    expect(published!.comparison.available).toBe(true);
    expect(published!.triad!.comparisons!.find(item=>item.role==="parent")!.changes!.find(item=>item.key==="q14")).toMatchObject({previous:2,current:4,delta:2});
    expect(published!.triad!.comparisons!.every(item=>item.previousDate==="2026-06-01T00:00:00.000Z")).toBe(true);
    expect(JSON.stringify(published!.triad!.comparisons)).not.toContain("respondent-");
    const lookup=mockQuery.mock.calls.find(([sql])=>String(sql).includes("WITH prior_round AS"));
    expect(lookup?.[1]).toEqual(["family","CN","round","growth-triad",snapshot.submittedAt]);
  });
  it("records a first-round reason for each role without fabricating changes",async()=>{
    configure();
    let published:ReportPayload|undefined;
    mockTransaction.mockImplementation((async(fn:(c:unknown)=>Promise<unknown>)=>fn({query:async(sql:string,values:unknown[])=>{
      if(sql.includes("AS scopes FROM consents WHERE family_id=$1"))return {rows:[{scopes:["parent_report"]}]};
      if(sql.includes("INSERT INTO reports"))published=JSON.parse(values[3] as string) as ReportPayload;
      return {rows:[{id:"locked"}]};
    }})) as never);
    await processOneJob();
    expect(published!.comparison).toEqual({available:false,reason:"first_assessment"});
    expect(published!.triad!.comparisons).toEqual(["student","parent","teacher"].map(role=>({
      role,currentDate:snapshot.submittedAt,available:false,reason:"first_assessment"
    })));
  });
  it("preserves other roles when the previous teacher is a different person",async()=>{
    const previous=rows.map(row=>({...row,respondent_id:row.respondent_role==="teacher"?"old-teacher":row.respondent_id,submitted_at:"2026-06-01T00:00:00.000Z"}));
    configure(sourceIds,rows,previous);
    let published:ReportPayload|undefined;
    mockTransaction.mockImplementation((async(fn:(c:unknown)=>Promise<unknown>)=>fn({query:async(sql:string,values:unknown[])=>{
      if(sql.includes("AS scopes FROM consents WHERE family_id=$1"))return {rows:[{scopes:["parent_report"]}]};
      if(sql.includes("INSERT INTO reports"))published=JSON.parse(values[3] as string) as ReportPayload;
      return {rows:[{id:"locked"}]};
    }})) as never);
    await processOneJob();
    expect(published!.comparison.available).toBe(true);
    expect(published!.triad!.comparisons!.map(item=>item.available)).toEqual([true,true,false]);
    expect(published!.triad!.comparisons![2]).toMatchObject({reason:"different_respondent",previousDate:"2026-06-01T00:00:00.000Z"});
  });
  it("fails an unbound legacy job without selecting historical answers or rendering",async()=>{
    configure(null);
    const calls:{sql:string;values:unknown[]}[]=[];
    mockTransaction.mockImplementation((async(fn:(c:unknown)=>Promise<unknown>)=>fn({query:async(sql:string,values:unknown[])=>{calls.push({sql,values});return {rows:[{assessment_id:parent.id}]};}})) as never);
    await processOneJob();
    expect(mockRender).not.toHaveBeenCalled();
    const failure=calls.find(({sql})=>sql.includes("UPDATE report_jobs SET state=$1"));
    expect(failure?.values).toEqual(["failed","triad-job",expect.any(String),"TRIAD_SOURCES_UNBOUND"]);
    expect(mockQuery.mock.calls.some(([sql])=>String(sql).includes("SELECT id,respondent_role,answers"))).toBe(false);
  });
  it("refuses incomplete pinned sources instead of filling a role from history",async()=>{
    configure(sourceIds,rows.slice(0,2));await processOneJob();
    expect(mockRender).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

describe("targeted queue execution",()=>{
  const JOB_ID="11111111-2222-4333-8444-111111111111";
  it("claims only the requested job in this deployment region",async()=>{
    mockQuery.mockResolvedValue([]);
    await expect(processReportJob(JOB_ID)).resolves.toEqual({status:"already_done"});
    expect(mockQuery.mock.calls[0][1]).toEqual([expect.any(String),"CN",JOB_ID]);
    expect(String(mockQuery.mock.calls[0][0])).toContain("j.id=$3");
    expect(String(mockQuery.mock.calls[0][0])).toContain("a.region=$2");
    expect(mockRender).not.toHaveBeenCalled();
  });
  it("rejects a malformed message before touching the database",async()=>{
    await expect(processReportJob("not-a-job")).rejects.toThrow();
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it("acknowledges a duplicate delivery for a completed job",async()=>{
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([{state:"done"}]);
    await expect(processReportJob(JOB_ID)).resolves.toEqual({status:"already_done"});
    expect(mockRender).not.toHaveBeenCalled();
  });
  it("keeps an unexpired claim scheduled for redelivery instead of acknowledging it",async()=>{
    const lease=new Date(Date.now()+120000).toISOString();
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([{state:"running",lease_until:lease}]);
    await expect(processReportJob(JOB_ID)).resolves.toEqual({status:"retry_at",retryAt:lease});
  });
  it("does not run a fourth render after three crashed claims",async()=>{
    mockQuery.mockResolvedValueOnce([{id:JOB_ID,assessment_id:ASSESSMENT_ID,attempts:3,attempt_limit_reached:true}])
      .mockResolvedValue([]);
    const calls:{sql:string;values:unknown[]}[]=[];
    mockTransaction.mockImplementation((async(fn:(c:unknown)=>Promise<unknown>)=>fn({query:async(sql:string,values:unknown[])=>{calls.push({sql,values});return {rows:[{assessment_id:ASSESSMENT_ID}]};}})) as never);
    await expect(processReportJob(JOB_ID)).resolves.toEqual({status:"terminal"});
    expect(mockRender).not.toHaveBeenCalled();
    expect(calls[0].sql).toContain("FOR UPDATE OF f");
    expect(calls[1].values).toContain("REPORT_ATTEMPTS_EXHAUSTED");
  });
  it.each([1,3])("preserves published filesystem PDFs when attempt %s loses the commit response",async attempts=>{
    const files=new Set<string>();
    let publishedKeys:Record<string,string>|undefined;
    mockWrite.mockImplementation(async key=>{files.add(key);});
    mockRemove.mockImplementation(async key=>{files.delete(key);return "done";});
    mockQuery.mockImplementation((async(sql:string)=>{
      if(sql.includes("WITH candidate AS"))return [{id:JOB_ID,assessment_id:ASSESSMENT_ID,attempts}];
      if(sql.includes("SELECT * FROM assessments WHERE id="))return [{id:ASSESSMENT_ID,family_id:"family",snapshot,submitted_at:snapshot.submittedAt}];
      if(sql.includes("AS scopes FROM consents"))return [{scopes:["parent_report"]}];
      if(sql.includes("SELECT pdf_keys FROM reports"))return publishedKeys?[{pdf_keys:publishedKeys}]:[];
      return [];
    }) as never);
    mockTransaction.mockImplementation((async(fn:(c:unknown)=>Promise<unknown>)=>{
      let publication=false;
      const result=await fn({query:async(sql:string,values:unknown[])=>{
        if(sql.includes("AS scopes FROM consents WHERE family_id=$1"))return {rows:[{scopes:["parent_report"]}]};
        if(sql.includes("INSERT INTO reports")){publishedKeys=JSON.parse(values[4] as string);publication=true;}
        if(sql.includes("UPDATE report_jobs SET state=$1"))return {rows:[]};
        return {rows:[{id:"locked"}]};
      }});
      if(publication)throw new Error("Connection lost after COMMIT succeeded");
      return result;
    }) as never);
    try{
      await expect(processReportJob(JOB_ID)).resolves.toEqual({status:"already_done"});
      expect(publishedKeys).toBeDefined();
      expect([...files].sort()).toEqual(Object.values(publishedKeys!).sort());
      expect(files.size).toBe(2);
      expect(mockRemove).not.toHaveBeenCalled();
    }finally{
      mockWrite.mockImplementation(async()=>undefined);
      mockRemove.mockImplementation(async()=>"done");
    }
  });
  it.each(["UPDATE report_jobs SET state=$1","SELECT pdf_keys FROM reports"])("leaves filesystem PDFs intact when recovery cannot confirm %s",async failedLookup=>{
    mockQuery.mockImplementation((async(sql:string)=>{
      if(sql.includes("WITH candidate AS"))return [{id:JOB_ID,assessment_id:ASSESSMENT_ID,attempts:1}];
      if(sql.includes("SELECT * FROM assessments WHERE id="))return [{id:ASSESSMENT_ID,family_id:"family",snapshot,submitted_at:snapshot.submittedAt}];
      if(sql.includes("AS scopes FROM consents"))return [{scopes:["parent_report"]}];
      if(sql.includes(failedLookup))throw new Error("Recovery database unavailable");
      return [];
    }) as never);
    mockTransaction.mockImplementation((async(fn:(c:unknown)=>Promise<unknown>)=>fn({query:async(sql:string)=>{
      if(sql.includes("FROM families")&&sql.includes("FOR UPDATE"))throw new Error("Publication connection lost");
      return {rows:sql.includes("AS scopes FROM consents")?[{scopes:["parent_report"]}]:[{id:"locked"}]};
    }})) as never);
    await expect(processReportJob(JOB_ID)).rejects.toThrow("Recovery database unavailable");
    expect(mockWrite).toHaveBeenCalledTimes(2);
    expect(mockRemove).not.toHaveBeenCalled();
  });
  it("removes unreferenced filesystem PDFs after losing a claim",async()=>{
    mockQuery.mockImplementation((async(sql:string)=>{
      if(sql.includes("WITH candidate AS"))return [{id:JOB_ID,assessment_id:ASSESSMENT_ID,attempts:1}];
      if(sql.includes("SELECT * FROM assessments WHERE id="))return [{id:ASSESSMENT_ID,family_id:"family",snapshot,submitted_at:snapshot.submittedAt}];
      if(sql.includes("AS scopes FROM consents"))return [{scopes:["parent_report"]}];
      return [];
    }) as never);
    mockTransaction.mockImplementation((async(fn:(c:unknown)=>Promise<unknown>)=>fn({query:async(sql:string)=>{
      if(sql.includes("FROM families")&&sql.includes("FOR UPDATE"))throw new Error("Report claim expired");
      return {rows:sql.includes("AS scopes FROM consents")?[{scopes:["parent_report"]}]:[{id:"locked"}]};
    }})) as never);
    await expect(processReportJob(JOB_ID)).resolves.toEqual({status:"already_done"});
    expect(mockWrite).toHaveBeenCalledTimes(2);
    expect(mockRemove.mock.calls.map(([key])=>key)).toEqual(mockWrite.mock.calls.map(([key])=>key));
  });
  it("stores both database PDFs only after family and claim locks in the publication transaction",async()=>{
    vi.stubEnv("NOVA_REPORT_STORAGE","database");
    mockQuery.mockResolvedValueOnce([{id:JOB_ID,assessment_id:ASSESSMENT_ID,attempts:1}])
      .mockResolvedValueOnce([{id:ASSESSMENT_ID,family_id:"family",snapshot,submitted_at:snapshot.submittedAt}])
      .mockResolvedValueOnce([]).mockResolvedValue([]);
    const events:string[]=[];
    const lockedClient={query:vi.fn(async(sql:string)=>{events.push(sql);if(sql.includes("AS scopes FROM consents WHERE family_id=$1"))return {rows:[{scopes:["parent_report"]}]};return {rows:[{id:"locked"}]};})};
    mockWrite.mockImplementation(async(_key,_pdf,client)=>{
      expect(client).toBe(lockedClient);
      expect(events.some(sql=>sql.includes("FROM families")&&sql.includes("FOR UPDATE"))).toBe(true);
      expect(events.some(sql=>sql.includes("FROM report_jobs")&&sql.includes("FOR UPDATE"))).toBe(true);
      events.push("pdf");
    });
    mockTransaction.mockImplementation((async(fn:(c:unknown)=>Promise<unknown>)=>fn(lockedClient)) as never);
    await expect(processReportJob(JOB_ID)).resolves.toEqual({status:"published"});
    expect(events.filter(value=>value==="pdf")).toHaveLength(2);
    expect(events.findIndex(value=>value.includes("INSERT INTO reports"))).toBeGreaterThan(events.lastIndexOf("pdf"));
    const publicationLock=events.findIndex(value=>value.includes("FROM families")&&value.includes("FOR UPDATE"));
    const publicationConsent=events.findIndex((value,index)=>index>publicationLock&&value.includes("AS scopes FROM consents WHERE family_id=$1"));
    expect(publicationConsent).toBeGreaterThan(publicationLock);
    expect(events.findIndex(value=>value.includes("INSERT INTO reports"))).toBeGreaterThan(publicationConsent);
    mockWrite.mockImplementation(async()=>undefined);
  });
  it("does not select a narrative or render a PDF when a claimed job sees parent-report consent withdrawn",async()=>{
    vi.mocked(selectNarrative).mockClear();
    mockRender.mockClear();
    mockWrite.mockClear();
    const events:string[]=[];
    mockQuery.mockImplementation((async(sql:string)=>{
      const text=String(sql);
      if(text.includes("WITH candidate AS"))return [{id:JOB_ID,assessment_id:ASSESSMENT_ID,attempts:1}];
      if(text.includes("SELECT * FROM assessments WHERE id="))return [{id:ASSESSMENT_ID,family_id:"family",snapshot:{...snapshot,aiConsented:true},submitted_at:snapshot.submittedAt}];
      if(text.includes("AS scopes FROM consents"))return [{scopes:["assessment","sensitive_data","ai_processing"]}];
      if(text.includes("ai_processing"))return [{id:"ai-still-granted"}];
      return [];
    }) as never);
    mockTransaction.mockImplementation((async(fn:(client:unknown)=>Promise<unknown>)=>fn({query:async(sql:string)=>{
      events.push(String(sql));
      if(String(sql).includes("AS scopes FROM consents"))return {rows:[{scopes:["assessment","sensitive_data","ai_processing"]}]};
      return {rows:[{id:"locked"}]};
    }})) as never);
    await expect(processReportJob(JOB_ID)).resolves.toEqual({status:"paused"});
    expect(selectNarrative).not.toHaveBeenCalled();
    expect(mockRender).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
    const familyAt=events.findIndex(sql=>sql.includes("FROM families")&&sql.includes("FOR SHARE"));
    const pauseAt=events.findIndex(sql=>sql.includes("PARENT_REPORT_CONSENT_REQUIRED"));
    expect(familyAt).toBeGreaterThanOrEqual(0);
    expect(pauseAt).toBeGreaterThan(familyAt);
    expect(events.some(sql=>sql.includes("INSERT INTO reports"))).toBe(false);
  });
  it("does not compose a triad narrative or render a PDF when a claimed job sees parent-report consent withdrawn",async()=>{
    const roleRows=([childScale,parentScale,teacherScale]).map((scale,index)=>{
      const role=scale.roles[0],answers=previewAnswers(scale);
      return {id:`source-${index}`,family_id:"family",triad_round_id:"round",respondent_id:`respondent-${role}`,respondent_role:role,answers,submitted_at:snapshot.submittedAt,
        snapshot:{...snapshot,scale,score:scoreAssessment(scale,answers,{age:12,region:"CN",role})}};
    });
    const parent=roleRows[1],sourceIds=roleRows.map(row=>row.id);
    vi.mocked(selectNarrative).mockClear();
    mockRender.mockClear();
    mockWrite.mockClear();
    mockQuery.mockImplementation((async(sql:string)=>{
      const text=String(sql);
      if(text.includes("WITH candidate AS"))return [{id:JOB_ID,assessment_id:parent.id,attempts:1,source_assessment_ids:sourceIds}];
      if(text.includes("SELECT * FROM assessments WHERE id="))return [parent];
      if(text.includes("SELECT id,respondent_role,answers"))return roleRows;
      if(text.includes("AS scopes FROM consents"))return [{scopes:["assessment","sensitive_data","ai_processing"]}];
      return [];
    }) as never);
    mockTransaction.mockImplementation((async(fn:(client:unknown)=>Promise<unknown>)=>fn({query:async(sql:string)=>{
      if(String(sql).includes("AS scopes FROM consents"))return {rows:[{scopes:["assessment","sensitive_data","ai_processing"]}]};
      if(String(sql).includes("UPDATE report_jobs SET state=$1"))return {rows:[{assessment_id:parent.id}]};
      return {rows:[{id:"locked"}]};
    }})) as never);
    const compose=vi.spyOn(triadReports,"composeTriad");
    try{
      await expect(processReportJob(JOB_ID)).resolves.toEqual({status:"paused"});
      expect(compose).not.toHaveBeenCalled();
      expect(selectNarrative).not.toHaveBeenCalled();
      expect(mockRender).not.toHaveBeenCalled();
      expect(mockWrite).not.toHaveBeenCalled();
    }finally{compose.mockRestore();}
  });
  it("pauses a claimed job inside the family lock when parent-report consent is gone and writes no report",async()=>{
    mockQuery.mockResolvedValueOnce([{id:JOB_ID,assessment_id:ASSESSMENT_ID,attempts:1}])
      .mockResolvedValueOnce([{id:ASSESSMENT_ID,family_id:"family",snapshot,submitted_at:snapshot.submittedAt}])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValue([]);
    const events:string[]=[];
    const lockedClient={query:vi.fn(async(sql:string)=>{
      events.push(sql);
      if(sql.includes("AS scopes FROM consents WHERE family_id=$1"))return {rows:[{scopes:["assessment"]},{scopes:["sensitive_data"]}]};
      return {rows:[{id:"locked"}]};
    })};
    mockTransaction.mockImplementation((async(fn:(c:unknown)=>Promise<unknown>)=>fn(lockedClient)) as never);
    await expect(processReportJob(JOB_ID)).resolves.toEqual({status:"paused"});
    const familyAt=events.findIndex(sql=>sql.includes("FROM families")&&sql.includes("FOR SHARE"));
    const pauseAt=events.findIndex(sql=>sql.includes("state='paused'")&&sql.includes("PARENT_REPORT_CONSENT_REQUIRED"));
    expect(familyAt).toBeGreaterThanOrEqual(0);
    expect(pauseAt).toBeGreaterThan(familyAt);
    expect(events.some(sql=>sql.includes("INSERT INTO reports"))).toBe(false);
    expect(mockQuery.mock.calls.some(([sql])=>String(sql).includes("UPDATE report_jobs SET state=$1"))).toBe(false);
  });
  it("refuses to publish an unvalidated non-demo triad in service mode and writes no report",async()=>{
    vi.stubEnv("NOVA_MODE","service");vi.stubEnv("NOVA_PUBLIC_URL","https://nova.example.invalid");
    const legacy=([oldChild,oldParent,oldTeacher]).map((scale,index)=>{
      const role=scale.roles[0],answers=previewAnswers(scale,"calm");
      const score={...scoreAssessment(scale,answers,{age:12,region:"CN" as const,role}),demo:false as const};
      return {id:`legacy-${index}`,family_id:"family",triad_round_id:"round",respondent_role:role,answers,submitted_at:snapshot.submittedAt,
        snapshot:{...snapshot,scale,score,childName:"Synthetic queued child",grade:"小学四至六年级"}};
    });
    expect(legacy.every(row=>row.snapshot.scale.demo===false&&row.snapshot.scale.norm.validated===false)).toBe(true);
    const parent=legacy[1],sourceIds=legacy.map(row=>row.id);
    mockQuery.mockImplementation((async(sql:string)=>{
      if(sql.includes("WITH candidate AS"))return [{id:JOB_ID,assessment_id:parent.id,attempts:1,source_assessment_ids:sourceIds}];
      if(sql.includes("SELECT * FROM assessments WHERE id="))return [{...parent,id:parent.id}];
      if(sql.includes("SELECT id,respondent_role,answers"))return legacy;
      return [];
    }) as never);
    client.query.mockImplementation((async(sql:string)=>{
      if(String(sql).includes("UPDATE report_jobs SET state=$1"))return {rows:[{assessment_id:parent.id,source_assessment_ids:sourceIds,available_at:new Date().toISOString()}]};
      return {rows:[]};
    }) as never);
    vi.mocked(selectNarrative).mockClear();
    await expect(processReportJob(JOB_ID)).resolves.toEqual({status:"terminal"});
    const failure=client.query.mock.calls.find(([sql])=>String(sql).includes("UPDATE report_jobs SET state=$1"));
    expect(failure?.[1]).toEqual(["failed",JOB_ID,expect.any(String),"UNVALIDATED_INSTRUMENT"]);
    expect(String(client.query.mock.calls[0]?.[0])).toContain("FOR UPDATE OF f");
    expect(selectNarrative).not.toHaveBeenCalled();
    expect(mockRender).not.toHaveBeenCalled();
    expect(mockQuery.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO reports"))).toBe(false);
    expect(legacy.every(row=>row.snapshot.scale.demo===false)).toBe(true);
  });
  it("rejects an unvalidated non-triad snapshot before narrative or PDF",async()=>{
    vi.stubEnv("NOVA_MODE","service");vi.stubEnv("NOVA_PUBLIC_URL","https://nova.example.invalid");
    vi.mocked(selectNarrative).mockClear();
    mockQuery.mockImplementation((async(sql:string)=>{
      if(sql.includes("WITH candidate AS"))return [{id:JOB_ID,assessment_id:ASSESSMENT_ID,attempts:1}];
      if(sql.includes("SELECT * FROM assessments WHERE id="))return [{id:ASSESSMENT_ID,family_id:"family",snapshot,submitted_at:snapshot.submittedAt}];
      return [];
    }) as never);
    client.query.mockImplementation((async(sql:string)=>{
      if(String(sql).includes("UPDATE report_jobs SET state=$1"))return {rows:[{assessment_id:ASSESSMENT_ID,source_assessment_ids:null,available_at:new Date().toISOString()}]};
      return {rows:[]};
    }) as never);
    await expect(processReportJob(JOB_ID)).resolves.toEqual({status:"terminal"});
    const failure=client.query.mock.calls.find(([sql])=>String(sql).includes("UPDATE report_jobs SET state=$1"));
    expect(failure?.[1]).toEqual(["failed",JOB_ID,expect.any(String),"UNVALIDATED_INSTRUMENT"]);
    expect(String(client.query.mock.calls[0]?.[0])).toContain("FOR UPDATE OF f");
    expect(selectNarrative).not.toHaveBeenCalled();
    expect(mockRender).not.toHaveBeenCalled();
    const consentSql=mockQuery.mock.calls.map(([sql])=>String(sql)).filter(sql=>sql.includes("FROM consents"));
    expect(consentSql).toEqual([expect.stringContaining("WITH candidate AS")]);
    expect(consentSql[0]).toContain("parent_report");
    expect(mockQuery.mock.calls.some(([sql])=>String(sql).includes("AS scopes FROM consents")||String(sql).includes("INSERT INTO reports"))).toBe(false);
  });
  it("rejects a triad whose sibling snapshot is unvalidated before narrative or PDF",async()=>{
    vi.stubEnv("NOVA_MODE","service");vi.stubEnv("NOVA_PUBLIC_URL","https://nova.example.invalid");
    vi.mocked(selectNarrative).mockClear();
    const parentScaleValidated=structuredClone(oldParent);
    parentScaleValidated.demo=false;
    parentScaleValidated.norm={...parentScaleValidated.norm,validated:true};
    const parentAnswers=previewAnswers(parentScaleValidated,"calm");
    const parentScore={...scoreAssessment(parentScaleValidated,parentAnswers,{age:12,region:"CN" as const,role:"parent" as const}),demo:false as const};
    const childAnswers=previewAnswers(oldChild,"calm");
    const rows=[
      {id:"legacy-child",family_id:"family",triad_round_id:"round",respondent_role:"student",answers:childAnswers,submitted_at:snapshot.submittedAt,snapshot:{...snapshot,scale:oldChild,score:{...scoreAssessment(oldChild,childAnswers,{age:12,region:"CN" as const,role:"student" as const}),demo:false as const}}},
      {id:"legacy-parent",family_id:"family",triad_round_id:"round",respondent_role:"parent",answers:parentAnswers,submitted_at:snapshot.submittedAt,snapshot:{...snapshot,scale:parentScaleValidated,score:parentScore}},
      {id:"legacy-teacher",family_id:"family",triad_round_id:"round",respondent_role:"teacher",answers:previewAnswers(oldTeacher,"calm"),submitted_at:snapshot.submittedAt,snapshot:{...snapshot,scale:structuredClone(oldTeacher),score:parentScore}}
    ];
    rows[2].snapshot.scale.norm={...rows[2].snapshot.scale.norm,validated:true};
    rows[2].snapshot.scale.demo=false;
    const sourceIds=rows.map(row=>row.id);
    mockQuery.mockImplementation((async(sql:string)=>{
      if(sql.includes("WITH candidate AS"))return [{id:JOB_ID,assessment_id:"legacy-parent",attempts:1,source_assessment_ids:sourceIds}];
      if(sql.includes("SELECT * FROM assessments WHERE id="))return [rows[1]];
      if(sql.includes("SELECT id,respondent_role,answers"))return rows;
      return [];
    }) as never);
    client.query.mockImplementation((async(sql:string)=>{
      if(String(sql).includes("UPDATE report_jobs SET state=$1"))return {rows:[{assessment_id:"legacy-parent",source_assessment_ids:sourceIds,available_at:new Date().toISOString()}]};
      return {rows:[]};
    }) as never);
    await expect(processReportJob(JOB_ID)).resolves.toEqual({status:"terminal"});
    expect(mockQuery.mock.calls.some(([sql])=>String(sql).includes("SELECT id,respondent_role,answers"))).toBe(true);
    expect(vi.mocked(selectNarrative)).not.toHaveBeenCalled();
    expect(mockRender).not.toHaveBeenCalled();
    expect(client.query.mock.calls.find(([sql])=>String(sql).includes("UPDATE report_jobs SET state=$1"))?.[1]).toEqual(["failed",JOB_ID,expect.any(String),"UNVALIDATED_INSTRUMENT"]);
    expect(mockQuery.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO reports"))).toBe(false);
  });
  it("publishes an unvalidated non-demo triad in demo mode with a demo label",async()=>{
    const legacy=([oldChild,oldParent,oldTeacher]).map((scale,index)=>{
      const role=scale.roles[0],answers=previewAnswers(scale,"calm");
      const score={...scoreAssessment(scale,answers,{age:12,region:"CN" as const,role}),demo:false as const};
      return {id:`legacy-${index}`,family_id:"family",triad_round_id:"round",respondent_role:role,answers,submitted_at:snapshot.submittedAt,
        snapshot:{...snapshot,scale,score,childName:"Synthetic queued child",grade:"小学四至六年级"}};
    });
    const parent=legacy[1],sourceIds=legacy.map(row=>row.id);
    const published:string[]=[];
    mockQuery.mockImplementation((async(sql:string)=>{
      if(sql.includes("WITH candidate AS"))return [{id:JOB_ID,assessment_id:parent.id,attempts:1,source_assessment_ids:sourceIds}];
      if(sql.includes("SELECT * FROM assessments WHERE id="))return [parent];
      if(sql.includes("SELECT id,respondent_role,answers"))return legacy;
      return [];
    }) as never);
    mockTransaction.mockImplementation((async(fn:(c:unknown)=>Promise<unknown>)=>fn({query:async(sql:string,values:unknown[])=>{published.push(String(sql));if(String(sql).includes("AS scopes FROM consents WHERE family_id=$1"))return {rows:[{scopes:["assessment","parent_report","sensitive_data"]}]};if(String(sql).includes("INSERT INTO reports"))published.push(String(values?.[3]),String(values?.[6]));return {rows:[{id:"locked"}]};}})) as never);
    await expect(processReportJob(JOB_ID)).resolves.toEqual({status:"published"});
    const payload=JSON.parse(published.find(value=>value.includes("\"demo\":true"))??"{}");
    expect(payload.score.demo).toBe(true);
    expect(payload.scale.demo).toBe(false);
    expect(payload.scale.version).toBe("1.0.0");
    expect(published.some(value=>value.includes("演示报告")&&value.includes("示範報告"))).toBe(true);
    expect(legacy.every(row=>row.snapshot.scale.demo===false&&row.snapshot.score.demo===false)).toBe(true);
    expect(published.some(value=>value.includes("INSERT INTO reports"))).toBe(true);

  });
  it("does not run filesystem cleanup or heartbeat polling for database storage",async()=>{
    vi.stubEnv("NOVA_REPORT_STORAGE","database");
    await processDeletionJobs();await cleanOrphanReports();
    expect(mockQuery).not.toHaveBeenCalled();expect(mockList).not.toHaveBeenCalled();
  });
});
