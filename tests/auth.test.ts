import { describe,it,expect,beforeEach,afterEach,vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("../src/lib/db",()=>({query:vi.fn()}));
import { query } from "../src/lib/db";
import { actorOf,audit,checkPassword,cookieName,endSession,hashPassword,hashToken,limitLogin,requireActor,setSession } from "../src/lib/auth";

const mockQuery=vi.mocked(query);

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

beforeEach(()=>{mockQuery.mockReset();config();});
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
});
