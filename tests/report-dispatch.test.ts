import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
const send=vi.hoisted(()=>vi.fn());
const constructors=vi.hoisted(()=>vi.fn());
vi.mock("@vercel/queue",()=>({QueueClient:class{send=send;constructor(options:unknown){constructors(options);}}}));
vi.mock("../src/lib/db",()=>({query:vi.fn()}));
import { query } from "../src/lib/db";
import { dispatchAssessmentReport,enqueueReportJob,REPORT_TOPIC } from "../src/lib/report-dispatch";

const ASSESSMENT_ID="11111111-2222-4333-8444-555555555555";
const JOB_ID="22222222-3333-4444-8555-666666666666";
beforeEach(()=>{
  vi.stubEnv("NOVA_REGION","HK");vi.stubEnv("NOVA_MODE","demo");
  vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3101");vi.stubEnv("DATABASE_URL","postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_REPORT_KEY","ab".repeat(32));vi.stubEnv("NOVA_REPORT_STORAGE","database");
  vi.stubEnv("NOVA_WORKER_MODE","queue");vi.stubEnv("NOVA_QUEUE_REGION","sin1");
  send.mockReset().mockResolvedValue({messageId:"message"});constructors.mockClear();
  vi.mocked(query).mockReset().mockResolvedValue([{id:JOB_ID}]);
});
afterEach(()=>{vi.unstubAllEnvs();vi.useRealTimers();});

describe("report dispatch",()=>{
  it("sends only opaque identity in the configured physical queue region",async()=>{
    await dispatchAssessmentReport(ASSESSMENT_ID);
    expect(constructors).toHaveBeenCalledWith({region:"sin1",telemetry:{isEnabled:false}});
    expect(send).toHaveBeenCalledWith(REPORT_TOPIC,{jobId:JOB_ID,region:"HK"},{retentionSeconds:604800});
    expect(vi.mocked(query).mock.calls[0][1]).toEqual([ASSESSMENT_ID,"HK"]);
    expect(String(vi.mocked(query).mock.calls[0][0])).toContain("ANY(j.source_assessment_ids)");
  });
  it("does not dispatch when a triad is still waiting for another respondent",async()=>{
    vi.mocked(query).mockResolvedValue([]);
    await dispatchAssessmentReport(ASSESSMENT_ID);
    expect(send).not.toHaveBeenCalled();
  });
  it("retains accepted submissions when dispatch fails and schedules exactly one retry",async()=>{
    send.mockRejectedValue(new Error("synthetic unavailable"));
    const deferred:(()=>Promise<void>)[]=[];
    await expect(dispatchAssessmentReport(ASSESSMENT_ID,work=>deferred.push(work))).resolves.toBeUndefined();
    expect(deferred).toHaveLength(1);
    await expect(deferred[0]()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    expect(deferred).toHaveLength(1);
  });
  it("preserves a dispatch gap even if the process cannot resolve the SQL job immediately",async()=>{
    vi.mocked(query).mockRejectedValueOnce(new Error("database sleeping")).mockResolvedValueOnce([{id:JOB_ID}]);
    const deferred:(()=>Promise<void>)[]=[];
    await dispatchAssessmentReport(ASSESSMENT_ID,work=>deferred.push(work));
    expect(send).not.toHaveBeenCalled();
    await deferred[0]();expect(send).toHaveBeenCalledTimes(1);
  });
  it("allows a later staff retry to send a fresh delivery for the same SQL job",async()=>{
    await enqueueReportJob(JOB_ID);await enqueueReportJob(JOB_ID);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.every(call=>!("idempotencyKey" in call[2]))).toBe(true);
  });
  it("never creates idle queue or database traffic in continuous mode",async()=>{
    vi.stubEnv("NOVA_WORKER_MODE","continuous");
    await dispatchAssessmentReport(ASSESSMENT_ID);
    expect(query).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
  });
  it("bounds a hung send instead of holding the submission open indefinitely",async()=>{
    vi.useFakeTimers();send.mockImplementation(()=>new Promise(()=>{}));
    const deferred=vi.fn();
    const pending=dispatchAssessmentReport(ASSESSMENT_ID,deferred);
    await vi.advanceTimersByTimeAsync(8000);await pending;
    expect(deferred).toHaveBeenCalledTimes(1);
  });
});
