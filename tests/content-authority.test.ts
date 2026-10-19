import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { Actor } from "../src/domain/types";
import { demoAdvice, demoScale, demoTemplate } from "../src/domain/demo";
vi.mock("../src/lib/db",()=>({query:vi.fn(),transaction:vi.fn()}));
import { query, transaction } from "../src/lib/db";
import { createContent, importScale, setScaleStatus } from "../src/lib/content";

const actor:Actor={id:"99999999-8888-4777-8666-555555555555",name:"Synthetic admin",role:"admin",region:"CN"};
let current:(Actor&{disabled:boolean;demo:boolean})|null,beforeContentLock:()=>void,writes:string[];
const client={query:vi.fn()};
const operations=[
  {name:"scale import",run:()=>importScale(actor,{definition:demoScale})},
  {name:"scale retirement",run:()=>setScaleStatus(actor,`${demoScale.id}@${demoScale.version}`,{status:"retired"})},
  {name:"advice publication",run:()=>createContent(actor,"advice",{version:"2.0.0",content:demoAdvice})},
  {name:"template publication",run:()=>createContent(actor,"template",{version:"2.0.0",content:demoTemplate})},
];
beforeEach(()=>{
  vi.clearAllMocks();vi.stubEnv("NOVA_REGION","CN");vi.stubEnv("NOVA_MODE","service");
  vi.stubEnv("DATABASE_URL","postgresql://synthetic.invalid/nova");vi.stubEnv("NOVA_PUBLIC_URL","https://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR","work/test-private");vi.stubEnv("NOVA_REPORT_KEY","0".repeat(64));
  current={...actor,disabled:false,demo:false};beforeContentLock=()=>{};writes=[];
  vi.mocked(query).mockResolvedValue([]);
  client.query.mockImplementation(async(sql:string,values:unknown[]=[])=>{
    if(sql.includes("pg_advisory_xact_lock")){beforeContentLock();return{rows:[],rowCount:1};}
    if(sql.startsWith("INSERT INTO scales")||sql.startsWith("UPDATE scales")||sql.startsWith("INSERT INTO content_versions")){
      if(sql.includes("FROM users")){
        const offset=sql.startsWith("UPDATE scales")?2:4;
        const [id,region,demoAllowed]=values.slice(offset);
        if(!current||current.id!==id||current.region!==region||current.role!=="admin"||current.disabled||(!demoAllowed&&current.demo))return{rows:[],rowCount:0};
      }
      writes.push(sql);return{rows:[{id:"synthetic"}],rowCount:1};
    }
    if(sql.includes("FROM content_versions WHERE kind=$1"))return{rows:[{id:"synthetic-advice",version:"1.0.0",content:demoAdvice}],rowCount:1};
    if(sql.includes("SELECT id,definition,status FROM scales"))return{rows:[{id:"synthetic-scale",definition:demoScale,status:"active"}],rowCount:1};
    if(sql.includes("SELECT s.definition FROM scales s"))return{rows:[{definition:demoScale}],rowCount:1};
    throw new Error(`Unexpected synthetic SQL: ${sql}`);
  });
  vi.mocked(transaction).mockImplementation(async fn=>fn(client as unknown as PoolClient));
});
afterEach(()=>vi.unstubAllEnvs());
describe.each(operations)("$name checks the current administrator at mutation",operation=>{
  it("allows the active administrator",async()=>{await operation.run();expect(writes).toHaveLength(1);});
  it.each(["disabled","demoted","moved","demo","removed"] as const)("rejects an issuer %s while waiting for the content lock",async change=>{
    beforeContentLock=()=>{
      if(change==="disabled")current!.disabled=true;
      if(change==="demoted")current!.role="staff";
      if(change==="moved")current!.region="HK";
      if(change==="demo")current!.demo=true;
      if(change==="removed")current=null;
    };
    await expect(operation.run()).rejects.toMatchObject({status:403,code:"FORBIDDEN"});
    expect(writes).toEqual([]);expect(query).not.toHaveBeenCalled();
  });
  it("allows demo administrators in the demo deployment",async()=>{vi.stubEnv("NOVA_MODE","demo");current!.demo=true;await operation.run();expect(writes).toHaveLength(1);});
});
