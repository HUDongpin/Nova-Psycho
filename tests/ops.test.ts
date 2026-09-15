import { describe,it,expect,beforeEach,afterEach,vi } from "vitest";

vi.mock("../src/lib/db",()=>({query:vi.fn()}));
import { query } from "../src/lib/db";
import { opsStatus } from "../src/lib/ops";

const mockQuery=vi.mocked(query);

interface JobRow { ready:number; running:number; done:number; failed:number; oldest_ready_seconds:number|null; expired_leases:number }
interface BeatRow { worker_id:string; heartbeat_age_seconds:number; uptime_seconds:number; cycles:string|number }

const jobs=(over:Partial<JobRow>={}):JobRow=>({ready:0,running:0,done:6,failed:0,oldest_ready_seconds:null,expired_leases:0,...over});
const beat=(over:Partial<BeatRow>={}):BeatRow=>({worker_id:"11111111-2222-4333-8444-555555555555",heartbeat_age_seconds:3,uptime_seconds:120,cycles:24,...over});

function stubDb(jobRow:JobRow,beatRow:BeatRow|null){
  mockQuery.mockReset();
  mockQuery.mockImplementation((async(sql:string)=>{
    const text=String(sql);
    if(text.includes("report_jobs"))return [jobRow];
    if(text.includes("worker_heartbeats"))return beatRow?[beatRow]:[];
    return [];
  }) as never);
}

beforeEach(()=>{
  vi.stubEnv("NOVA_REGION","CN");vi.stubEnv("NOVA_MODE","demo");
  vi.stubEnv("DATABASE_URL","postgresql://nova:pw@127.0.0.1:55431/nova_cn");
  vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR","work/test-private");
  vi.stubEnv("NOVA_REPORT_KEY","0".repeat(64));
});
afterEach(()=>vi.unstubAllEnvs());

describe("worker liveness",()=>{
  it("reports a healthy worker with no warnings",async()=>{
    stubDb(jobs(),beat());
    const status=await opsStatus();
    expect(status.worker.alive).toBe(true);
    expect(status.worker.heartbeatAgeSeconds).toBe(3);
    expect(status.worker.cycles).toBe(24);
    expect(status.warnings).toEqual([]);
  });
  it("flags a worker that has never started",async()=>{
    stubDb(jobs(),null);
    const status=await opsStatus();
    expect(status.worker.alive).toBe(false);
    expect(status.worker.workerId).toBeNull();
    expect(status.warnings).toContain("worker_never_started");
  });
  it("flags a heartbeat older than the grace window",async()=>{
    stubDb(jobs(),beat({heartbeat_age_seconds:304}));
    const status=await opsStatus();
    expect(status.worker.alive).toBe(false);
    expect(status.warnings).toContain("worker_stale");
  });
  it("treats a heartbeat exactly at the boundary as alive",async()=>{
    stubDb(jobs(),beat({heartbeat_age_seconds:60}));
    expect((await opsStatus()).worker.alive).toBe(true);
  });
  it("treats a heartbeat one second past the boundary as stale",async()=>{
    stubDb(jobs(),beat({heartbeat_age_seconds:61}));
    expect((await opsStatus()).worker.alive).toBe(false);
  });
  it("coerces the bigint cycle counter to a number",async()=>{
    stubDb(jobs(),beat({cycles:"41"}));
    expect((await opsStatus()).worker.cycles).toBe(41);
  });
});

describe("queue health",()=>{
  it("reports counts per state",async()=>{
    stubDb(jobs({ready:2,running:1,done:9,failed:3}),beat());
    const status=await opsStatus();
    expect(status.jobs).toEqual({ready:2,running:1,done:9,failed:3});
  });
  it("flags any failed job",async()=>{
    stubDb(jobs({failed:1}),beat());
    expect((await opsStatus()).warnings).toContain("failed_jobs");
  });
  it("flags a lease that has expired",async()=>{
    stubDb(jobs({running:1,expired_leases:1}),beat());
    expect((await opsStatus()).warnings).toContain("expired_leases");
  });
  it("flags a backlog only once the oldest wait passes the threshold",async()=>{
    stubDb(jobs({ready:1,oldest_ready_seconds:300}),beat());
    expect((await opsStatus()).warnings).not.toContain("queue_backlog");
    stubDb(jobs({ready:1,oldest_ready_seconds:301}),beat());
    expect((await opsStatus()).warnings).toContain("queue_backlog");
  });
  it("reports no oldest wait when the queue is empty",async()=>{
    stubDb(jobs({oldest_ready_seconds:null}),beat());
    expect((await opsStatus()).oldestReadySeconds).toBeNull();
  });
  it("rounds the oldest wait to whole seconds",async()=>{
    stubDb(jobs({ready:1,oldest_ready_seconds:12.7}),beat());
    expect((await opsStatus()).oldestReadySeconds).toBe(13);
  });
  it("can report several problems at once",async()=>{
    stubDb(jobs({ready:5,failed:2,expired_leases:1,oldest_ready_seconds:900}),beat({heartbeat_age_seconds:600}));
    const status=await opsStatus();
    expect(status.warnings).toEqual(expect.arrayContaining(["worker_stale","failed_jobs","expired_leases","queue_backlog"]));
    expect(status.warnings).toHaveLength(4);
  });
});

describe("status metadata",()=>{
  it("reports the region and mode the process is running as",async()=>{
    stubDb(jobs(),beat());
    const status=await opsStatus();
    expect(status.region).toBe("CN");
    expect(status.mode).toBe("demo");
    expect(Number.isNaN(Date.parse(status.checkedAt))).toBe(false);
  });
});
