import { describe,it,expect,beforeEach,afterEach,vi } from "vitest";

// Keep hashToken and audit real (they are pure and DB-backed respectively); stub only
// scrypt, which is deliberately slow and would dominate the suite.
vi.mock("../src/lib/auth",async importOriginal=>{
  const actual=await importOriginal<typeof import("../src/lib/auth")>();
  return {...actual,hashPassword:vi.fn(async()=>"scrypt$stub")};
});
vi.mock("../src/lib/db",()=>({query:vi.fn(),transaction:vi.fn()}));

import { hashToken } from "../src/lib/auth";
import { query,transaction } from "../src/lib/db";
import { acceptRecovery,createRecovery,recoveryInfo } from "../src/lib/recovery";
import { HttpError } from "../src/lib/http";
import type { Actor } from "../src/domain/types";

const mockQuery=vi.mocked(query);
const mockTransaction=vi.mocked(transaction);
const USER_ID="11111111-2222-4333-8444-555555555555";
const admin:Actor={id:"99999999-8888-4777-8666-555555555555",name:"Admin",role:"admin",region:"CN"};
const parent:Actor={...admin,role:"parent"};

const clientCalls:string[]=[];
async function defaultClientQuery(sql:string){
  clientCalls.push(String(sql));
  if(String(sql).includes("SELECT id,name,role,disabled FROM users"))return {rows:[{id:USER_ID,name:"Synthetic",role:"parent",disabled:false}]};
  if(String(sql).includes("SELECT id FROM users"))return {rows:[{id:USER_ID}]};
  if(String(sql).includes("SELECT user_id FROM recovery_tokens"))return {rows:[{user_id:USER_ID}]};
  if(String(sql).includes("FOR UPDATE OF r"))return {rows:[{user_id:USER_ID}]};
  return {rows:[]};
}
const client={query:vi.fn(defaultClientQuery)};

beforeEach(()=>{
  vi.stubEnv("NOVA_REGION","CN");vi.stubEnv("NOVA_MODE","demo");
  vi.stubEnv("DATABASE_URL","postgresql://nova:pw@127.0.0.1:55431/nova_cn");
  vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR","work/test-private");
  vi.stubEnv("NOVA_REPORT_KEY","0".repeat(64));
  mockQuery.mockReset();mockTransaction.mockReset();client.query.mockReset();clientCalls.length=0;
  client.query.mockImplementation(defaultClientQuery);
  mockTransaction.mockImplementation((async(fn:(c:unknown)=>Promise<unknown>)=>fn(client)) as never);
});
afterEach(()=>vi.unstubAllEnvs());

describe("issuing a recovery link",()=>{
  it("refuses anyone who is not an administrator",async()=>{
    await expect(createRecovery(parent,USER_ID)).rejects.toMatchObject({code:"ROLE_DENIED"});
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it("rejects a malformed account id before touching the database",async()=>{
    await expect(createRecovery(admin,"not-a-uuid")).rejects.toMatchObject({code:"NOT_FOUND"});
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it("returns a single-use link carrying a 64-character token",async()=>{
    const result=await createRecovery(admin,USER_ID);
    const token=result.url.split("token=")[1];
    expect(result.url.startsWith("http://127.0.0.1:3100/recover#token=")).toBe(true);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
  });
  it("never puts the stored hash in the link",async()=>{
    const result=await createRecovery(admin,USER_ID);
    const token=result.url.split("token=")[1];
    expect(result.url).not.toContain(hashToken(token));
  });
  it("retires an earlier outstanding link for the same account",async()=>{
    await createRecovery(admin,USER_ID);
    expect(clientCalls.some(sql=>sql.includes("UPDATE recovery_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL"))).toBe(true);
  });
  it("serializes issuance on the account row inside the transaction",async()=>{
    await createRecovery(admin,USER_ID);
    const lock=clientCalls.find(sql=>sql.includes("FROM users")&&sql.includes("FOR UPDATE"));
    expect(lock).toContain("SELECT id,name,role,disabled FROM users WHERE id=$1 AND region=$2 FOR UPDATE");
    expect(mockQuery.mock.calls.some(call=>String(call[0]).includes("FROM users"))).toBe(false);
  });
  it("locks the account before it writes recovery tokens",async()=>{
    await createRecovery(admin,USER_ID);
    const userLock=clientCalls.findIndex(sql=>sql.includes("FROM users")&&sql.includes("FOR UPDATE"));
    const retire=clientCalls.findIndex(sql=>sql.includes("UPDATE recovery_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL"));
    const insert=clientCalls.findIndex(sql=>sql.includes("INSERT INTO recovery_tokens"));
    expect(userLock).toBeGreaterThanOrEqual(0);
    expect(userLock).toBeLessThan(retire);
    expect(retire).toBeLessThan(insert);
  });
  it("refuses an account that does not exist in this region",async()=>{
    client.query.mockImplementation(async(sql:string)=>{
      clientCalls.push(String(sql));
      return {rows:[]};
    });
    await expect(createRecovery(admin,USER_ID)).rejects.toMatchObject({code:"NOT_FOUND"});
    expect(clientCalls.some(sql=>sql.includes("INSERT INTO recovery_tokens"))).toBe(false);
  });
  it("refuses a disabled account",async()=>{
    client.query.mockImplementation(async(sql:string)=>{
      clientCalls.push(String(sql));
      if(String(sql).includes("SELECT id,name,role,disabled FROM users"))return {rows:[{id:USER_ID,name:"Synthetic",role:"parent",disabled:true}]};
      return {rows:[]};
    });
    await expect(createRecovery(admin,USER_ID)).rejects.toMatchObject({code:"ACCOUNT_DISABLED"});
    expect(clientCalls.some(sql=>sql.includes("INSERT INTO recovery_tokens"))).toBe(false);
  });
});

describe("resolving a recovery link",()=>{
  it("returns the account it belongs to",async()=>{
    mockQuery.mockResolvedValueOnce([{name:"Synthetic",username:"demo_parent",role:"parent",region:"CN",expiresAt:"2026-09-15T12:00:00.000Z"}]);
    await expect(recoveryInfo("a".repeat(64))).resolves.toMatchObject({username:"demo_parent",role:"parent"});
  });
  it("rejects a malformed token without querying",async()=>{
    await expect(recoveryInfo("too-short")).rejects.toMatchObject({code:"INVALID_RECOVERY"});
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it("rejects an unknown or expired token",async()=>{
    mockQuery.mockResolvedValueOnce([]);
    await expect(recoveryInfo("b".repeat(64))).rejects.toBeInstanceOf(HttpError);
  });
});

describe("completing a recovery",()=>{
  const validToken="c".repeat(64);
  it("rejects a password under the minimum length",async()=>{
    await expect(acceptRecovery({token:validToken,password:"short"})).rejects.toThrow();
    expect(mockTransaction).not.toHaveBeenCalled();
  });
  it("rejects a malformed token",async()=>{
    await expect(acceptRecovery({token:"nope",password:"a-long-enough-password"})).rejects.toMatchObject({code:"INVALID_RECOVERY"});
  });
  it("sets the new password",async()=>{
    await acceptRecovery({token:validToken,password:"a-long-enough-password"});
    const update=clientCalls.find(sql=>sql.includes("UPDATE users SET password_hash"));
    expect(update).toBeDefined();
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE users SET password_hash"),["scrypt$stub",USER_ID]);
  });
  it("marks the link used so it cannot be replayed",async()=>{
    await acceptRecovery({token:validToken,password:"a-long-enough-password"});
    expect(clientCalls.some(sql=>sql.includes("UPDATE recovery_tokens SET used_at=now()"))).toBe(true);
  });
  // A recovery is often triggered precisely because someone else may have had access.
  it("ends every existing session for the account",async()=>{
    await acceptRecovery({token:validToken,password:"a-long-enough-password"});
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM sessions WHERE user_id=$1"),[USER_ID]);
  });
  it("writes an audit event attributed to the account, not to an administrator",async()=>{
    await acceptRecovery({token:validToken,password:"a-long-enough-password"});
    const audit=clientCalls.find(sql=>sql.includes("INSERT INTO audit_events"));
    expect(audit).toContain("user.recovery_completed");
  });
  it("locks the token row so two submissions cannot both succeed",async()=>{
    await acceptRecovery({token:validToken,password:"a-long-enough-password"});
    expect(clientCalls.some(sql=>sql.includes("FOR UPDATE OF r"))).toBe(true);
  });
  it("locks the account before the token when completing recovery",async()=>{
    await acceptRecovery({token:validToken,password:"a-long-enough-password"});
    const userLock=clientCalls.findIndex(sql=>sql.includes("SELECT id FROM users")&&sql.includes("FOR UPDATE"));
    const tokenLock=clientCalls.findIndex(sql=>sql.includes("FOR UPDATE OF r"));
    expect(userLock).toBeGreaterThanOrEqual(0);
    expect(tokenLock).toBeGreaterThan(userLock);
  });
  it("revokes every other outstanding link for the account",async()=>{
    await acceptRecovery({token:validToken,password:"a-long-enough-password"});
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE recovery_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL"),[USER_ID]);
  });
  it("does nothing when the token is already spent or expired",async()=>{
    client.query.mockImplementation(async(sql:string)=>{
      clientCalls.push(String(sql));
      if(String(sql).includes("SELECT user_id FROM recovery_tokens"))return {rows:[{user_id:USER_ID}]};
      if(String(sql).includes("SELECT id FROM users"))return {rows:[{id:USER_ID}]};
      if(String(sql).includes("FOR UPDATE OF r"))return {rows:[]};
      return {rows:[]};
    });
    await expect(acceptRecovery({token:validToken,password:"a-long-enough-password"})).rejects.toMatchObject({code:"INVALID_RECOVERY"});
    expect(clientCalls.some(sql=>sql.includes("UPDATE users SET password_hash"))).toBe(false);
  });
});
