import { describe,it,expect,beforeEach,afterEach,vi } from "vitest";

vi.mock("../src/lib/db",()=>({query:vi.fn(),transaction:vi.fn()}));
import { query,transaction } from "../src/lib/db";
import { createContent,currentContent,getScale,importScale,setScaleStatus } from "../src/lib/content";
import { demoAdvice,demoScale,demoTemplate } from "../src/domain/demo";
import type { Actor,Role } from "../src/domain/types";

const mockQuery=vi.mocked(query);
const mockTransaction=vi.mocked(transaction);
const SCALE_ID=`${demoScale.id}@${demoScale.version}`;
const actor=(role:Role,over:Partial<Actor>={}):Actor=>({id:"99999999-8888-4777-8666-555555555555",name:"Synthetic",role,region:"CN",...over});

const clientCalls:string[]=[];
const defaultClientQuery=async(sql:string)=>{
  clientCalls.push(String(sql));
  const text=String(sql);
  if(text.includes("FROM content_versions WHERE kind=$1"))return {rows:[{id:"a1",version:"1.0.0",content:demoAdvice}]};
  if(text.includes("SELECT id,definition,status FROM scales"))return {rows:[{id:SCALE_ID,definition:demoScale,status:"retired"}]};
  if(text.includes("SELECT s.definition FROM scales s"))return {rows:[{definition:demoScale}]};
  return {rows:[]};
};
const client={query:vi.fn(defaultClientQuery)};

beforeEach(()=>{
  vi.stubEnv("NOVA_REGION","CN");vi.stubEnv("NOVA_MODE","demo");
  vi.stubEnv("DATABASE_URL","postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR","work/test-private");
  vi.stubEnv("NOVA_REPORT_KEY","0".repeat(64));
  mockQuery.mockReset();mockTransaction.mockReset();clientCalls.length=0;
  // mockReset, not mockClear: one test installs its own implementation, and that would
  // otherwise leak into every test that runs after it.
  client.query.mockReset();
  client.query.mockImplementation(defaultClientQuery);
  mockTransaction.mockImplementation((async(fn:(c:unknown)=>Promise<unknown>)=>fn(client)) as never);
  mockQuery.mockImplementation((async(sql:string)=>{
    if(String(sql).includes("FROM content_versions WHERE kind=$1"))return [{id:"a1",version:"1.0.0",content:demoAdvice}];
    if(String(sql).includes("SELECT id,definition,status FROM scales"))return [{id:SCALE_ID,definition:demoScale,status:"retired"}];
    return [];
  }) as never);
});
afterEach(()=>vi.unstubAllEnvs());

describe("reading published content",()=>{
  it("returns the newest version of the requested kind",async()=>{
    await expect(currentContent("advice")).resolves.toMatchObject({version:"1.0.0"});
  });
  it("refuses to proceed when no content has been published yet",async()=>{
    mockQuery.mockResolvedValueOnce([]);
    await expect(currentContent("advice")).rejects.toMatchObject({code:"CONTENT_NOT_CONFIGURED"});
  });
  it("reports an unknown instrument version as not found",async()=>{
    mockQuery.mockResolvedValueOnce([]);
    await expect(getScale(SCALE_ID)).rejects.toMatchObject({code:"SCALE_NOT_FOUND"});
  });
});

describe("importing an instrument version",()=>{
  it("refuses anyone who is not an administrator",async()=>{
    for(const role of ["staff","parent","student","teacher"] as const){
      await expect(importScale(actor(role),{definition:demoScale})).rejects.toMatchObject({code:"ROLE_DENIED"});
    }
    expect(mockTransaction).not.toHaveBeenCalled();
  });
  it("refuses an instrument that does not cover this region",async()=>{
    await expect(importScale(actor("admin"),{definition:{...demoScale,regions:["HK"],norm:{...demoScale.norm,regions:["HK"]}}})).rejects.toMatchObject({code:"SCALE_REGION"});
  });
  it("refuses an instrument whose bands reference advice that does not exist",async()=>{
    const broken={...demoScale,dimensions:demoScale.dimensions.map((d,index)=>index===0?{...d,bands:d.bands.map(b=>({...b,adviceIds:["no_such_advice"]}))}:d)};
    await expect(importScale(actor("admin"),{definition:broken})).rejects.toMatchObject({code:"ADVICE_MISMATCH"});
  });
  it("stores a well-formed instrument under an id-version key",async()=>{
    await expect(importScale(actor("admin"),{definition:demoScale})).resolves.toEqual({id:SCALE_ID});
  });
  it("serialises publication against assignment via the content lock",async()=>{
    await importScale(actor("admin"),{definition:demoScale});
    expect(clientCalls.some(sql=>sql.includes("pg_advisory_xact_lock"))).toBe(true);
  });
});

describe("retiring and reactivating a version",()=>{
  it("refuses anyone who is not an administrator",async()=>{
    await expect(setScaleStatus(actor("staff"),SCALE_ID,{status:"retired"})).rejects.toMatchObject({code:"ROLE_DENIED"});
  });
  it("retires a version without re-validating advice",async()=>{
    await expect(setScaleStatus(actor("admin"),SCALE_ID,{status:"retired"})).resolves.toEqual({ok:true});
  });
  it("validates advice references before reactivating",async()=>{
    await setScaleStatus(actor("admin"),SCALE_ID,{status:"active"});
    expect(clientCalls.some(sql=>sql.includes("FROM content_versions WHERE kind=$1"))).toBe(true);
  });
  it("refuses reactivation when the advice the instrument needs is gone",async()=>{
    client.query.mockImplementation(async(sql:string)=>{
      const text=String(sql);
      clientCalls.push(text);
      if(text.includes("SELECT id,definition,status FROM scales"))return {rows:[{id:SCALE_ID,definition:demoScale,status:"retired"}]};
      if(text.includes("FROM content_versions WHERE kind=$1"))return {rows:[{id:"a1",version:"2.0.0",content:{title:demoAdvice.title,blocks:[]}}]};
      return {rows:[]};
    });
    await expect(setScaleStatus(actor("admin"),SCALE_ID,{status:"active"})).rejects.toMatchObject({code:"ADVICE_MISMATCH"});
  });
  it("only accepts the two known statuses",async()=>{
    await expect(setScaleStatus(actor("admin"),SCALE_ID,{status:"deleted"})).rejects.toThrow();
  });
});

describe("publishing new content versions",()=>{
  it("refuses anyone who is not an administrator",async()=>{
    await expect(createContent(actor("staff"),"advice",{version:"2.0.0",content:demoAdvice})).rejects.toMatchObject({code:"ROLE_DENIED"});
  });
  it("requires a semantic version",async()=>{
    await expect(createContent(actor("admin"),"advice",{version:"v2",content:demoAdvice})).rejects.toThrow();
  });
  it("refuses an advice library that would break an active instrument",async()=>{
    // Schema-valid but incomplete: it keeps one block while the active instrument's
    // bands still reference the others, which is the case the reference check exists for.
    await expect(createContent(actor("admin"),"advice",{version:"2.0.0",content:{title:demoAdvice.title,blocks:[demoAdvice.blocks[0]]}})).rejects.toMatchObject({code:"ADVICE_MISMATCH"});
  });
  it("refuses a structurally invalid advice library outright",async()=>{
    await expect(createContent(actor("admin"),"advice",{version:"2.0.0",content:{title:demoAdvice.title,blocks:[]}})).rejects.toThrow();
  });
  it("accepts an advice library that preserves what active instruments need",async()=>{
    await expect(createContent(actor("admin"),"advice",{version:"2.0.0",content:demoAdvice})).resolves.toMatchObject({id:expect.any(String)});
  });
  it("validates a report template shape",async()=>{
    await expect(createContent(actor("admin"),"template",{version:"2.0.0",content:demoTemplate})).resolves.toMatchObject({id:expect.any(String)});
    await expect(createContent(actor("admin"),"template",{version:"2.0.1",content:{title:demoTemplate.title}})).rejects.toThrow();
  });
});
