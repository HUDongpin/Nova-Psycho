import { describe,it,expect,beforeEach,afterEach,vi } from "vitest";

vi.mock("../src/lib/db",()=>({query:vi.fn(),transaction:vi.fn()}));
vi.mock("../src/lib/pdf",()=>({renderPdf:vi.fn(async()=>Buffer.from("%PDF-1.4 stub")),closePdfBrowser:vi.fn()}));
vi.mock("../src/lib/storage",()=>({writePrivatePdf:vi.fn(async()=>undefined),removePrivatePdf:vi.fn(async()=>undefined),listPrivatePdfKeys:vi.fn(async()=>[])}));
vi.mock("../src/domain/narrative",()=>({selectNarrative:vi.fn(async()=>({selectedAdviceIds:["listen"],generationMode:"template",fallbackReason:"ai_disabled",aiModel:null}))}));
import { query,transaction } from "../src/lib/db";
import { renderPdf } from "../src/lib/pdf";
import { listPrivatePdfKeys,removePrivatePdf,writePrivatePdf } from "../src/lib/storage";
import { cleanOrphanReports,processDeletionJobs,processOneJob,recordHeartbeat } from "../src/lib/worker";
import { demoAdvice,demoScale,demoTemplate } from "../src/domain/demo";
import { scoreAssessment } from "../src/domain/scoring";
import type { AssessmentSnapshot } from "../src/domain/types";

const mockQuery=vi.mocked(query);
const mockTransaction=vi.mocked(transaction);
const mockWrite=vi.mocked(writePrivatePdf);
const mockRemove=vi.mocked(removePrivatePdf);
const mockList=vi.mocked(listPrivatePdfKeys);
const mockRender=vi.mocked(renderPdf);

const ASSESSMENT_ID="11111111-2222-4333-8444-555555555555";
const FAMILY_ID="22222222-3333-4444-8555-666666666666";
const TOKEN="33333333-4444-4555-8666-777777777777";
const snapshot:AssessmentSnapshot={
  scale:demoScale,advice:{id:"a",version:"1.0.0",content:demoAdvice},template:{id:"t",version:"1.0.0",content:demoTemplate},
  score:scoreAssessment(demoScale,{q1:1,q2:2,q3:1,q4:2,q5:1,q6:2,q7:1,q8:2,q9:0},{age:12,region:"CN",role:"student"}),
  childName:"Synthetic child",grade:"S2",submittedAt:"2026-09-15T00:00:00.000Z",aiConsented:false
};

const clientCalls:string[]=[];
const client={query:vi.fn(async(sql:string)=>{clientCalls.push(String(sql));return {rows:[]};})};

function config(){
  vi.stubEnv("NOVA_REGION","CN");vi.stubEnv("NOVA_MODE","demo");
  vi.stubEnv("DATABASE_URL","postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR","work/test-private");
  vi.stubEnv("NOVA_REPORT_KEY","0".repeat(64));
}

beforeEach(()=>{
  config();
  mockQuery.mockReset();mockTransaction.mockReset();mockWrite.mockClear();mockRemove.mockClear();mockList.mockReset();mockRender.mockClear();
  clientCalls.length=0;
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
});

describe("processing one job",()=>{
  const job={id:"job1",assessment_id:ASSESSMENT_ID,attempts:1};
  it("returns false when there is nothing to claim",async()=>{
    mockQuery.mockResolvedValueOnce([]);
    await expect(processOneJob()).resolves.toBe(false);
  });
  it("claims a job with a lease and skip-locked semantics",async()=>{
    mockQuery.mockResolvedValueOnce([job]).mockResolvedValue([]);
    await processOneJob();
    const sql=String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain("FOR UPDATE OF j SKIP LOCKED");
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
      .mockResolvedValueOnce([{snapshot}])
      .mockResolvedValueOnce([{id:"c1"}])
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
      .mockResolvedValueOnce([{snapshot:{...snapshot,aiConsented:true}}])
      .mockResolvedValueOnce([]) // consent row gone
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);
    await processOneJob();
    const { selectNarrative } = await import("../src/domain/narrative");
    const passed=vi.mocked(selectNarrative).mock.calls.at(-1)?.[0];
    expect(passed?.aiConsented).toBe(false);
  });
  it("requeues with a backoff while attempts remain",async()=>{
    mockQuery.mockResolvedValueOnce([{...job,attempts:1}])
      .mockResolvedValueOnce([{snapshot}])
      .mockResolvedValueOnce([])
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
      .mockResolvedValueOnce([{snapshot}])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{assessment_id:ASSESSMENT_ID}])
      .mockResolvedValue([]);
    mockRender.mockRejectedValueOnce(new Error("render failed"));
    await processOneJob();
    const failure=mockQuery.mock.calls.find(call=>String(call[0]).includes("UPDATE report_jobs SET state=$1"))!;
    expect(failure[1]).toContain("failed");
    expect(mockQuery.mock.calls.some(call=>String(call[0]).includes("UPDATE assessments SET status='failed'"))).toBe(true);
  });
  it("cleans up partially written files when rendering fails",async()=>{
    mockQuery.mockResolvedValueOnce([{...job,attempts:3}])
      .mockResolvedValueOnce([{snapshot}])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);
    mockRender.mockRejectedValueOnce(new Error("render failed"));
    await processOneJob();
    expect(mockRemove).toHaveBeenCalled();
  });
});
