import { describe,it,expect,beforeEach,afterEach,vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("../src/lib/db",()=>({query:vi.fn(),transaction:vi.fn()}));
import { query,transaction } from "../src/lib/db";
import { actorOf,audit,checkPassword,cookieName,endSession,hashPassword,hashToken,limitLogin,listAuditEvents,requireActor,setPasswordSession,setSession } from "../src/lib/auth";

const mockQuery=vi.mocked(query);
const mockTransaction=vi.mocked(transaction);

function config(over:Record<string,string>={}){
  vi.stubEnv("NOVA_REGION","CN");vi.stubEnv("NOVA_MODE","demo");
  vi.stubEnv("DATABASE_URL","postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR","work/test-private");
  vi.stubEnv("NOVA_REPORT_KEY","0".repeat(64));
  for(const [key,value] of Object.entries(over))vi.stubEnv(key,value);
}
const requestWithCookie=(cookie?:string)=>new Request("http://127.0.0.1:3100/api/workspace",{headers:cookie?{cookie}:{}});
const sessionCookie=(token:string)=>`nova_cn_session=${token}`;

beforeEach(()=>{mockQuery.mockReset();mockTransaction.mockReset();config();});
afterEach(()=>vi.unstubAllEnvs());

describe("token hashing",()=>{
  it("is a deterministic 64-character sha256",()=>{
    const digest=hashToken("abc");
    expect(digest).toBe(hashToken("abc"));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
  it("differs for different inputs",()=>{expect(hashToken("abc")).not.toBe(hashToken("abd"));});
  it("never stores the token itself",()=>{expect(hashToken("abc")).not.toContain("abc");});
});

describe("password hashing",()=>{
  it("stores a salt alongside the derived key",async()=>{
    const stored=await hashPassword("a-long-enough-password");
    const [salt,key]=stored.split(":");
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(key).toMatch(/^[0-9a-f]{128}$/);
  });
  it("salts the same password differently each time",async()=>{
    expect(await hashPassword("a-long-enough-password")).not.toBe(await hashPassword("a-long-enough-password"));
  });
  it("accepts the correct password",async()=>{
    const stored=await hashPassword("a-long-enough-password");
    await expect(checkPassword("a-long-enough-password",stored)).resolves.toBe(true);
  });
  it("refuses the wrong password",async()=>{
    const stored=await hashPassword("a-long-enough-password");
    await expect(checkPassword("a-long-enough-passwore",stored)).resolves.toBe(false);
  });
  it("refuses when no password is stored at all",async()=>{
    await expect(checkPassword("anything",null)).resolves.toBe(false);
  });
  it("fails closed on a malformed stored hash instead of throwing",async()=>{
    for(const stored of ["garbage",":", "aa:bb", "salt:"]) {
      await expect(checkPassword("anything",stored)).resolves.toBe(false);
    }
  });
});

describe("session cookies",()=>{
  it("names the cookie after the region",()=>{
    expect(cookieName()).toBe("nova_cn_session");
    config({NOVA_REGION:"HK",NOVA_PUBLIC_URL:"http://127.0.0.1:3101"});
    expect(cookieName()).toBe("nova_hk_session");
  });
  it("sets an http-only, lax, 12-hour cookie",async()=>{
    mockQuery.mockResolvedValueOnce([{token_hash:"x"}]);
    const response=NextResponse.json({ok:true});
    await setSession(response,"11111111-2222-4333-8444-555555555555");
    const cookie=response.cookies.get("nova_cn_session")!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("lax");
    expect(cookie.maxAge).toBe(43200);
    expect(cookie.path).toBe("/");
  });
  it("only marks the cookie secure in service mode",async()=>{
    mockQuery.mockResolvedValueOnce([{token_hash:"x"}]);
    const demo=NextResponse.json({ok:true});
    await setSession(demo,"11111111-2222-4333-8444-555555555555");
    expect(demo.cookies.get("nova_cn_session")!.secure).toBe(false);
  });
  it("refuses to open a session for a revoked account",async()=>{
    mockQuery.mockResolvedValueOnce([]);
    await expect(setSession(NextResponse.json({}),"11111111-2222-4333-8444-555555555555")).rejects.toMatchObject({code:"ACCOUNT_REVOKED"});
  });
  it("clears the cookie on logout",async()=>{
    mockQuery.mockResolvedValue([]);
    const response=NextResponse.json({ok:true});
    await endSession(requestWithCookie(sessionCookie("a".repeat(96))),response);
    expect(response.cookies.get("nova_cn_session")!.maxAge).toBe(0);
  });
});

describe("password login session issuance",()=>{
  const userId="11111111-2222-4333-8444-555555555555";
  const username="synthetic_login",password="synthetic-long-password";
  async function prepare(options:{changedHash?:boolean;missingLock?:boolean;missingCurrent?:boolean;commitFailure?:boolean}={}){
    const verifiedHash=await hashPassword(password);
    const currentHash=options.changedHash?await hashPassword("synthetic-new-password"):verifiedHash;
    mockQuery.mockResolvedValueOnce([{id:userId,password_hash:verifiedHash}]);
    const client={query:vi.fn(async(sql:string,_values?:unknown[])=>{
      if(sql.includes("FOR UPDATE"))return {rows:options.missingLock?[]:[{id:userId}]};
      if(sql.startsWith("SELECT"))return {rows:options.missingCurrent?[]:[{password_hash:currentHash}]};
      return {rows:[]};
    })};
    mockTransaction.mockImplementation((async(fn:(value:unknown)=>Promise<unknown>)=>{
      const result=await fn(client);
      if(options.commitFailure)throw new Error("Synthetic commit failure");
      return result;
    }) as never);
    return client;
  }
  it("rejects a password replaced after verification without issuing a cookie",async()=>{
    const client=await prepare({changedHash:true}),response=NextResponse.json({ok:true});
    await expect(setPasswordSession(response,username,password)).rejects.toMatchObject({status:401,code:"INVALID_CREDENTIALS"});
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(client.query.mock.calls.some(([sql])=>sql.startsWith("INSERT"))).toBe(false);
  });
  it("rejects an account removed before the user lock",async()=>{
    const client=await prepare({missingLock:true}),response=NextResponse.json({ok:true});
    await expect(setPasswordSession(response,username,password)).rejects.toMatchObject({code:"INVALID_CREDENTIALS"});
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
  it("rejects an account that no longer meets region, mode or enabled requirements",async()=>{
    const client=await prepare({missingCurrent:true}),response=NextResponse.json({ok:true});
    await expect(setPasswordSession(response,username,password)).rejects.toMatchObject({code:"INVALID_CREDENTIALS"});
    const freshRead=client.query.mock.calls[1];
    expect(freshRead[0]).toContain("region=$2");
    expect(freshRead[0]).toContain("NOT disabled");
    expect(freshRead[0]).toContain("OR NOT demo");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
  it.each([
    {region:"CN",mode:"demo",origin:"http://127.0.0.1:3100",secure:false},
    {region:"HK",mode:"service",origin:"https://synthetic.example",secure:true},
  ])("commits a $region $mode session with the existing cookie policy",async({region,mode,origin,secure})=>{
    config({NOVA_REGION:region,NOVA_MODE:mode,NOVA_PUBLIC_URL:origin});
    const client=await prepare(),response=NextResponse.json({ok:true});
    await setPasswordSession(response,username,password);
    expect(client.query.mock.calls[0][0]).toContain("FOR UPDATE");
    expect(client.query.mock.calls[1][0]).toContain("SELECT password_hash");
    expect(client.query.mock.calls[1][1]).toEqual([userId,region,mode==="demo"]);
    const insert=client.query.mock.calls[2];
    expect(insert[0]).toContain("INSERT INTO sessions");
    const cookie=response.cookies.get(`nova_${region.toLowerCase()}_session`)!;
    expect(cookie).toMatchObject({httpOnly:true,sameSite:"lax",maxAge:43200,path:"/",secure});
    expect(insert[1]?.[0]).toBe(hashToken(cookie.value));
    expect(insert[1]).not.toContain(cookie.value);
    expect(mockQuery.mock.calls[0][1]).toEqual([username,region,mode==="demo"]);
  });
  it("does not send a cookie when session commit fails",async()=>{
    await prepare({commitFailure:true});const response=NextResponse.json({ok:true});
    await expect(setPasswordSession(response,username,password)).rejects.toThrow("Synthetic commit failure");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
  it("rejects an incorrect password before acquiring a user lock",async()=>{
    await prepare();const response=NextResponse.json({ok:true});
    await expect(setPasswordSession(response,username,"incorrect-password")).rejects.toMatchObject({code:"INVALID_CREDENTIALS"});
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });
  it("rejects a missing account before creating a session",async()=>{
    mockQuery.mockResolvedValueOnce([]);const response=NextResponse.json({ok:true});
    await expect(setPasswordSession(response,username,password)).rejects.toMatchObject({code:"INVALID_CREDENTIALS"});
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("resolving the actor",()=>{
  const validToken="a".repeat(96);
  it("returns null without requiring a session",async()=>{
    await expect(actorOf(requestWithCookie(),false)).resolves.toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it("refuses an unauthenticated request when a session is required",async()=>{
    await expect(actorOf(requestWithCookie(),true)).rejects.toMatchObject({status:401,code:"UNAUTHENTICATED"});
    await expect(requireActor(requestWithCookie())).rejects.toMatchObject({code:"UNAUTHENTICATED"});
  });
  it("ignores a cookie that is not a 96-character hex token",async()=>{
    for(const bad of ["short","z".repeat(96),"a".repeat(95)]){
      await expect(actorOf(requestWithCookie(sessionCookie(bad)),false)).resolves.toBeNull();
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it("looks the session up by hash, in this region only",async()=>{
    mockQuery.mockResolvedValueOnce([{id:"u1",name:"Synthetic",role:"admin",region:"CN"}]);
    const actor=await actorOf(requestWithCookie(sessionCookie(validToken)),true);
    expect(actor).toMatchObject({id:"u1",role:"admin"});
    const [sql,values]=mockQuery.mock.calls[0];
    expect(String(sql)).toContain("s.token_hash=$1");
    expect(String(sql)).toContain("s.region=$2");
    expect(values).toContain(hashToken(validToken));
    expect(String(sql)).not.toContain(validToken);
  });
  it("returns null when the session does not resolve",async()=>{
    mockQuery.mockResolvedValueOnce([]);
    await expect(actorOf(requestWithCookie(sessionCookie(validToken)),false)).resolves.toBeNull();
  });
});

describe("login rate limiting",()=>{
  it("allows attempts below the per-account limit",async()=>{
    mockQuery.mockResolvedValue([{attempts:1}]);
    await expect(limitLogin("someone")).resolves.toBeUndefined();
  });
  it("refuses once the per-account limit is exceeded",async()=>{
    mockQuery.mockResolvedValueOnce([{attempts:9}]).mockResolvedValueOnce([{attempts:1}]);
    await expect(limitLogin("someone")).rejects.toMatchObject({status:429,code:"RATE_LIMITED"});
  });
  it("refuses once the global limit is exceeded",async()=>{
    mockQuery.mockResolvedValueOnce([{attempts:1}]).mockResolvedValueOnce([{attempts:301}]);
    await expect(limitLogin("someone")).rejects.toMatchObject({code:"RATE_LIMITED"});
  });
  it("keys the counter on a hash, never the raw username",async()=>{
    mockQuery.mockResolvedValue([{attempts:1}]);
    await limitLogin("Someone@Example.com");
    for(const [,values] of mockQuery.mock.calls)expect(values).not.toContain("Someone@Example.com");
  });
});

describe("audit trail",()=>{
  it("records the actor when there is one",async()=>{
    mockQuery.mockResolvedValueOnce([]);
    await audit({id:"u1",name:"Synthetic",role:"admin",region:"CN"},"family.created","f1");
    expect(mockQuery.mock.calls[0][1]).toEqual(["CN","u1","family.created","f1"]);
  });
  it("records a null actor for unauthenticated events",async()=>{
    mockQuery.mockResolvedValueOnce([]);
    await audit(null,"user.recovery_completed","u1");
    expect(mockQuery.mock.calls[0][1]).toEqual(["CN",null,"user.recovery_completed","u1"]);
  });
  it("lists four columns newest-first, bound to the region",async()=>{
    const rows=[{id:"a1",action:"family.created",entity_id:"f1",created_at:"2026-01-01"}];
    mockQuery.mockResolvedValueOnce(rows);
    await expect(listAuditEvents("CN")).resolves.toEqual(rows);
    const [sql,values]=mockQuery.mock.calls[0];
    const text=String(sql);
    const selected=(text.match(/SELECT\s+(.+?)\s+FROM/i)?.[1]??"").split(",").map(part=>part.trim());
    expect(selected).toEqual(["id","action","entity_id","created_at"]);
    expect(text).toContain("ORDER BY id DESC");
    expect(text).toContain("LIMIT 500");
    expect(values).toEqual(["CN"]);
    expect(text).not.toMatch(/actor_id|\bname\b|payload/i);
  });
  it("binds CN and HK as the sole query value",async()=>{
    mockQuery.mockResolvedValue([]);
    await listAuditEvents("CN");
    await listAuditEvents("HK");
    expect(mockQuery.mock.calls[0][1]).toEqual(["CN"]);
    expect(mockQuery.mock.calls[1][1]).toEqual(["HK"]);
  });
});
