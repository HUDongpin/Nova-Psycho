import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";

vi.mock("../src/lib/db",()=>({query:vi.fn(),transaction:vi.fn()}));
vi.mock("../src/lib/pdf",()=>({renderPdf:vi.fn(),closePdfBrowser:vi.fn(async()=>undefined)}));
vi.mock("../src/lib/storage",()=>({writePrivatePdf:vi.fn(),removePrivatePdf:vi.fn(),listPrivatePdfKeys:vi.fn()}));
import { query } from "../src/lib/db";
import { consumeReportMessage,ReportRetryAt } from "../src/lib/report-queue";
import { processReportJob } from "../src/lib/worker";

const JOB_ID="22222222-3333-4444-8555-666666666666";
const ASSESSMENT_ID="11111111-2222-4333-8444-555555555555";
const replacementToken="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const retryAt="2026-10-11T00:02:00.000Z";
type DurableJob={state:"ready"|"running"|"done"|"failed";claim_token:string;available_at:string;lease_until:string|null};
let durableJob:DurableJob|undefined;
let failedClaim:string|undefined;

beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-11T00:00:00.000Z"));
  vi.stubEnv("NOVA_REGION","HK");vi.stubEnv("NOVA_MODE","demo");
  vi.stubEnv("DATABASE_URL","postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3101");
  vi.stubEnv("NOVA_REPORT_KEY","ab".repeat(32));vi.stubEnv("NOVA_REPORT_STORAGE","database");
  vi.stubEnv("NOVA_WORKER_MODE","queue");vi.stubEnv("NOVA_QUEUE_REGION","sin1");
  failedClaim=undefined;
  vi.mocked(query).mockReset().mockImplementation((async(sql:string,values:unknown[]=[])=>{
    if(sql.includes("WITH candidate AS"))return [{id:JOB_ID,assessment_id:ASSESSMENT_ID,attempts:1}];
    if(sql.includes("SELECT * FROM assessments"))throw new Error("Old worker resumes after its claim was replaced");
    if(sql.includes("UPDATE report_jobs SET state=$1")){
      failedClaim=values[2] as string;
      return [];
    }
    if(sql.includes("SELECT j.state,j.available_at,j.lease_until"))return durableJob?[durableJob]:[];
    throw new Error("Unexpected synthetic database query");
  }) as never);
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});

describe("lost report claims",()=>{
  it.each(["ready","running"] as const)("keeps queue delivery retryable when the replacement job is %s",async state=>{
    durableJob={state,claim_token:replacementToken,available_at:retryAt,lease_until:state==="running"?retryAt:null};
    const before={...durableJob};
    await expect(consumeReportMessage({jobId:JOB_ID,region:"HK"})).rejects.toMatchObject({constructor:ReportRetryAt,retryAt});
    expect(failedClaim).not.toBe(replacementToken);
    expect(durableJob).toEqual(before);
  });
  it.each(["done","failed",undefined] as const)("reports the durable outcome after losing its claim to %s",async state=>{
    durableJob=state?{state,claim_token:replacementToken,available_at:retryAt,lease_until:null}:undefined;
    await expect(processReportJob(JOB_ID)).resolves.toEqual({status:state==="failed"?"terminal":"already_done"});
  });
  it("does not acknowledge a lost claim when its durable state cannot be read",async()=>{
    const database=vi.mocked(query).getMockImplementation()!;
    vi.mocked(query).mockImplementation((async(sql:string,values:unknown[]=[])=>{
      if(sql.includes("SELECT j.state,j.available_at,j.lease_until"))throw new Error("Synthetic read unavailable");
      return database(sql,values);
    }) as never);
    await expect(consumeReportMessage({jobId:JOB_ID,region:"HK"})).rejects.toThrow("Report processing temporarily unavailable");
  });
});
