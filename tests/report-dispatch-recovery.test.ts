import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
vi.mock("../src/lib/db",()=>({query:vi.fn()}));
vi.mock("../src/lib/report-dispatch",()=>({enqueueReportJob:vi.fn()}));
import { query } from "../src/lib/db";
import { enqueueReportJob } from "../src/lib/report-dispatch";
import { authorizedReportRecovery,recoverReportDispatches } from "../src/lib/report-dispatch-recovery";
import { GET as liveness } from "../src/app/api/liveness/route";
beforeEach(()=>{
  vi.stubEnv("NOVA_REGION","HK");vi.stubEnv("NOVA_MODE","demo");
  vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3101");vi.stubEnv("DATABASE_URL","postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_REPORT_KEY","ab".repeat(32));vi.stubEnv("NOVA_REPORT_STORAGE","database");
  vi.stubEnv("NOVA_WORKER_MODE","queue");vi.stubEnv("NOVA_QUEUE_REGION","sin1");
  vi.mocked(query).mockReset().mockResolvedValue([]);vi.mocked(enqueueReportJob).mockReset().mockResolvedValue();
});
afterEach(()=>{vi.unstubAllEnvs();vi.useRealTimers();});
describe("report recovery authentication",()=>{
  it("fails closed when the secret is missing, too short, or wrong",()=>{
    const request=new Request("https://www.tope.hk/api/cron/report-recovery");
    vi.stubEnv("CRON_SECRET",undefined);expect(authorizedReportRecovery(request)).toBe(false);
    vi.stubEnv("CRON_SECRET","short");expect(authorizedReportRecovery(request)).toBe(false);
    vi.stubEnv("CRON_SECRET","a".repeat(32));expect(authorizedReportRecovery(request)).toBe(false);
    expect(authorizedReportRecovery(new Request(request,{headers:{Authorization:`Bearer ${"b".repeat(32)}`}}))).toBe(false);
  });
  it("accepts only the exact bearer secret",()=>{
    vi.stubEnv("CRON_SECRET","a".repeat(32));
    expect(authorizedReportRecovery(new Request("https://www.tope.hk",{headers:{Authorization:`Bearer ${"a".repeat(32)}`}}))).toBe(true);
  });
});
describe("bounded dispatch recovery",()=>{
  it("selects only this region's due or expired jobs in a bounded batch",async()=>{
    vi.mocked(query).mockResolvedValue([{id:"job-a"},{id:"job-b"}]);
    vi.mocked(enqueueReportJob).mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce();
    await expect(recoverReportDispatches()).resolves.toEqual({selected:2,dispatched:1,pending:1});
    const [sql,params]=vi.mocked(query).mock.calls[0];
    expect(params).toEqual(["HK"]);expect(sql).toContain("a.region=$1");expect(sql).toContain("j.lease_until<now()");expect(sql).toContain("LIMIT 25");
  });
  it("does not poll when there is no work",async()=>{
    await expect(recoverReportDispatches()).resolves.toEqual({selected:0,dispatched:0,pending:0});
    expect(query).toHaveBeenCalledTimes(1);expect(enqueueReportJob).not.toHaveBeenCalled();
  });
  it("leaves the remaining batch durable when the soft deadline is reached",async()=>{
    vi.useFakeTimers();vi.setSystemTime(0);
    vi.mocked(query).mockResolvedValue([{id:"a"},{id:"b"},{id:"c"}]);
    vi.mocked(enqueueReportJob).mockImplementation(async()=>{vi.setSystemTime(Date.now()+20000);});
    await expect(recoverReportDispatches()).resolves.toEqual({selected:3,dispatched:2,pending:1});
  });
  it("provides liveness without configuration or a database connection",async()=>{
    vi.stubEnv("DATABASE_URL",undefined);
    await expect(liveness().json()).resolves.toEqual({ok:true});expect(query).not.toHaveBeenCalled();
  });
});
