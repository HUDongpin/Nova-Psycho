import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import type { MessageMetadata } from "@vercel/queue";
vi.mock("../src/lib/worker",()=>({processReportJob:vi.fn()}));
vi.mock("../src/lib/pdf",()=>({closePdfBrowser:vi.fn(async()=>undefined)}));
import { processReportJob } from "../src/lib/worker";
import { closePdfBrowser } from "../src/lib/pdf";
import { consumeReportMessage,ReportRetryAt,reportQueueRetry } from "../src/lib/report-queue";
const JOB_ID="22222222-3333-4444-8555-666666666666";
const metadata:MessageMetadata={messageId:"synthetic",deliveryCount:1,createdAt:new Date(),expiresAt:new Date(),topicName:"nova-report",consumerGroup:"report",region:"sin1"};
beforeEach(()=>{
  vi.stubEnv("NOVA_REGION","HK");vi.stubEnv("NOVA_MODE","demo");
  vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3101");vi.stubEnv("DATABASE_URL","postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_REPORT_KEY","ab".repeat(32));vi.stubEnv("NOVA_REPORT_STORAGE","database");
  vi.stubEnv("NOVA_WORKER_MODE","queue");vi.stubEnv("NOVA_QUEUE_REGION","sin1");
  vi.mocked(processReportJob).mockReset();vi.mocked(closePdfBrowser).mockClear();
});
afterEach(()=>vi.unstubAllEnvs());
describe("private queue consumer",()=>{
  it.each([{jobId:JOB_ID,region:"CN"},{jobId:"bad",region:"HK"},{jobId:JOB_ID,region:"HK",answers:{}}])("ignores a stale or invalid message without reading family data",async message=>{
    await consumeReportMessage(message);
    expect(processReportJob).not.toHaveBeenCalled();
  });
  it.each(["published","already_done","terminal"] as const)("acknowledges %s jobs",async status=>{
    vi.mocked(processReportJob).mockResolvedValue({status});
    await expect(consumeReportMessage({jobId:JOB_ID,region:"HK"})).resolves.toBeUndefined();
    expect(processReportJob).toHaveBeenCalledWith(JOB_ID);expect(closePdfBrowser).toHaveBeenCalledTimes(1);
  });
  it("keeps transient failures unacknowledged until the SQL retry time",async()=>{
    const retryAt=new Date(Date.now()+10000).toISOString();
    vi.mocked(processReportJob).mockResolvedValue({status:"retry_at",retryAt});
    await expect(consumeReportMessage({jobId:JOB_ID,region:"HK"})).rejects.toMatchObject({retryAt});
    expect(reportQueueRetry(new ReportRetryAt(retryAt),metadata)).toEqual({afterSeconds:10});
    expect(closePdfBrowser).toHaveBeenCalledTimes(1);
  });
  it("limits repeated infrastructure failures while leaving the SQL row for recovery",()=>{
    expect(reportQueueRetry(new Error("network"),metadata)).toEqual({afterSeconds:30});
    expect(reportQueueRetry(new Error("network"),{...metadata,deliveryCount:8})).toEqual({acknowledge:true});
  });
});
