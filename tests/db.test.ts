import { describe,it,expect,beforeEach,afterEach,vi } from "vitest";

// db.ts enforces the boundary that keeps the two regions apart: one process may only
// ever talk to one region, in one mode. If this module is wrong, CN and HK isolation
// fails silently rather than loudly, so it is worth pinning.

const poolQuery=vi.fn();
const poolConnect=vi.fn();
vi.mock("pg",()=>{
  // closeDatabase() calls pool.end(), and transaction() calls pool.connect().
  const Pool=vi.fn(function(this:unknown){return {query:poolQuery,end:vi.fn(async()=>undefined),connect:poolConnect};});
  return {default:{Pool,types:{setTypeParser:vi.fn()}}};
});
import { assertDatabaseRegion,closeDatabase,pool,query,transaction } from "../src/lib/db";

function config(over:Record<string,string>={}){
  vi.stubEnv("NOVA_REGION","CN");vi.stubEnv("NOVA_MODE","demo");
  vi.stubEnv("DATABASE_URL","postgresql://synthetic.invalid/nova_cn");
  vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR","work/test-private");
  vi.stubEnv("NOVA_REPORT_KEY","0".repeat(64));
  for(const [key,value] of Object.entries(over))vi.stubEnv(key,value);
}
const deploymentRow=(region="CN",mode="demo")=>({rows:[{region,mode}]});

beforeEach(async()=>{
  config();poolQuery.mockReset();poolConnect.mockReset();
  // Default: the region check passes. transaction() runs it before it ever connects.
  poolQuery.mockResolvedValue(deploymentRow("CN","demo"));
  await closeDatabase();
});
afterEach(async()=>{await closeDatabase();vi.unstubAllEnvs();});

describe("region binding",()=>{
  it("accepts a database that matches the process region and mode",async()=>{
    poolQuery.mockResolvedValue(deploymentRow("CN","demo"));
    await expect(assertDatabaseRegion()).resolves.toBeUndefined();
  });
  it("refuses a database belonging to the other region",async()=>{
    poolQuery.mockResolvedValue(deploymentRow("HK","demo"));
    await expect(assertDatabaseRegion()).rejects.toThrow(/region does not match/i);
  });
  it("refuses a database whose data classification differs from the process mode",async()=>{
    poolQuery.mockResolvedValue(deploymentRow("CN","service"));
    await expect(assertDatabaseRegion()).rejects.toThrow(/classification does not match/i);
  });
  it("refuses an unconfigured database rather than assuming it is safe",async()=>{
    poolQuery.mockResolvedValue({rows:[]});
    await expect(assertDatabaseRegion()).rejects.toThrow();
  });
  it("refuses a process that tries to change region after it has already checked",async()=>{
    poolQuery.mockResolvedValue(deploymentRow("CN","demo"));
    await assertDatabaseRegion();
    config({NOVA_REGION:"HK",NOVA_PUBLIC_URL:"http://127.0.0.1:3101"});
    await expect(assertDatabaseRegion()).rejects.toThrow(/cannot change its region or service mode/i);
  });
  it("refuses a process that tries to switch from demo to service",async()=>{
    poolQuery.mockResolvedValue(deploymentRow("CN","demo"));
    await assertDatabaseRegion();
    config({NOVA_MODE:"service",NOVA_PUBLIC_URL:"https://nova.example.invalid"});
    await expect(assertDatabaseRegion()).rejects.toThrow(/cannot change its region or service mode/i);
  });
  it("refuses a pool whose connection string changed under it",async()=>{
    pool();
    config({DATABASE_URL:"postgresql://synthetic.invalid/other"});
    expect(()=>pool()).toThrow(/cannot switch database regions/i);
  });
  it("re-checks after a failure instead of caching the failure as success",async()=>{
    poolQuery.mockResolvedValue(deploymentRow("HK","demo"));
    await expect(assertDatabaseRegion()).rejects.toThrow();
    poolQuery.mockResolvedValue(deploymentRow("CN","demo"));
    await expect(assertDatabaseRegion()).resolves.toBeUndefined();
  });
  it("checks once and then stops querying on every call",async()=>{
    poolQuery.mockResolvedValue(deploymentRow("CN","demo"));
    await assertDatabaseRegion();
    await assertDatabaseRegion();
    await assertDatabaseRegion();
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });
});

describe("query and transaction plumbing",()=>{
  const transactionClient=()=>({
    query:vi.fn(async(sql:string)=>String(sql)==="SELECT region,mode FROM deployment_settings WHERE singleton=true"?deploymentRow("CN","demo"):{rows:[]}),
    release:vi.fn()
  });
  it("returns rows from a query",async()=>{
    poolQuery.mockResolvedValueOnce(deploymentRow("CN","demo")).mockResolvedValueOnce({rows:[{n:1}]});
    await expect(query("SELECT 1")).resolves.toEqual([{n:1}]);
  });
  it("commits a successful transaction and releases the client",async()=>{
    const client=transactionClient();
    poolConnect.mockResolvedValue(client);
    await expect(transaction(async()=>"value")).resolves.toBe("value");
    const issued=client.query.mock.calls.map(call=>String(call[0]));
    expect(issued).toContain("BEGIN");
    expect(issued).toContain("COMMIT");
    expect(client.release).toHaveBeenCalled();
  });
  it("rolls back and still releases the client when the body throws",async()=>{
    const client=transactionClient();
    poolConnect.mockResolvedValue(client);
    await expect(transaction(async()=>{throw new Error("boom");})).rejects.toThrow("boom");
    const issued=client.query.mock.calls.map(call=>String(call[0]));
    expect(issued).toContain("ROLLBACK");
    expect(issued).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalled();
  });
});
