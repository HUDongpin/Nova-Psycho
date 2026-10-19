import { describe,it,expect,beforeEach,afterEach,vi } from "vitest";

vi.mock("../src/lib/db",()=>({query:vi.fn(),transaction:vi.fn()}));
vi.mock("../src/lib/auth",async importOriginal=>{
  const actual=await importOriginal<typeof import("../src/lib/auth")>();
  return {...actual,hashPassword:vi.fn(async()=>"scrypt$stub")};
});
import { query,transaction } from "../src/lib/db";
import { familyScope } from "../src/lib/access";
import { acceptInvitation,assignFamily,createFamily,createInvitation,deleteFamily,invitationInfo,recordConsent } from "../src/lib/families";
import type { Actor,Role } from "../src/domain/types";

const mockQuery=vi.mocked(query);
const mockTransaction=vi.mocked(transaction);

const FAMILY_ID="11111111-2222-4333-8444-555555555555";
const USER_ID="99999999-8888-4777-8666-555555555555";
const actor=(role:Role,over:Partial<Actor>={}):Actor=>({id:USER_ID,name:"Synthetic",role,region:"CN",...over});
const familyRow={id:FAMILY_ID,region:"CN",family_name:"Synthetic family",child_name:"Synthetic child",birth_date:"2013-04-12",grade:"S2",guardian_label:"Mother",assigned_to:null,created_at:new Date()};
let currentRole:Role="admin";

const clientCalls:string[]=[];
async function answerClient(sql:string,_params?:unknown[]):Promise<{rows:unknown[]}>{
  clientCalls.push(String(sql));
  if(String(sql).includes("FROM families f WHERE f.id=$1")&&String(sql).includes("FOR UPDATE"))return {rows:[{id:FAMILY_ID}]};
  if(String(sql).includes("role=$2 AND region=$3 AND NOT disabled FOR SHARE"))return {rows:[{id:_params?.[0]??USER_ID}]};
  if(String(sql).includes("parent_member"))return {rows:[{parent_member:1}]};
  if(String(sql).includes("SELECT id,region,assigned_to FROM families"))return {rows:[familyRow]};
  if(String(sql).includes("SELECT id,region,birth_date,join_code FROM families"))return {rows:[{...familyRow,join_code:null}]};
  if(String(sql).includes("SELECT id,name,role,region,disabled,demo FROM users"))return {rows:[{...actor(currentRole),disabled:false,demo:false}]};
  if(String(sql).includes("SELECT id FROM users"))return {rows:await query(sql,_params)};
  if(String(sql).includes("SELECT id FROM families"))return {rows:[{id:FAMILY_ID}]};
  if(String(sql).includes("SELECT family_id FROM invitations"))return {rows:[{family_id:FAMILY_ID}]};
  if(String(sql).includes("FOR UPDATE OF i"))return {rows:[{family_id:FAMILY_ID,role:"parent"}]};
  if(String(sql).includes("SELECT user_id FROM memberships"))return {rows:[{user_id:USER_ID}]};
  if(String(sql).includes("SELECT 1 FROM memberships"))return {rows:[{exists:true}]};
  if(String(sql).includes("SELECT pdf_keys FROM reports"))return {rows:[{pdf_keys:{"zh-CN":"a.zh-CN.pdf.enc"}}]};
  return {rows:[]};
}
const client={
  // Declared with a params argument so mock.calls exposes the bound values.
  query:vi.fn(answerClient)
};

function stubDb(){
  currentRole="admin";
  mockQuery.mockReset();mockTransaction.mockReset();client.query.mockReset();clientCalls.length=0;
  client.query.mockImplementation(answerClient);
  mockTransaction.mockImplementation((async(fn:(c:unknown)=>Promise<unknown>)=>fn(client)) as never);
  // familyFor() lookup
  mockQuery.mockImplementation((async(sql:string)=>{
    const text=String(sql);
    if(text.includes("FROM families f WHERE f.id=$1"))return [familyRow];
    if(text.includes("SELECT id FROM users"))return [{id:USER_ID}];
    return [];
  }) as never);
}

beforeEach(()=>{
  vi.stubEnv("NOVA_REGION","CN");vi.stubEnv("NOVA_MODE","demo");
  vi.stubEnv("DATABASE_URL","postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR","work/test-private");
  vi.stubEnv("NOVA_REPORT_KEY","0".repeat(64));
  stubDb();
});
afterEach(()=>vi.unstubAllEnvs());

const validFamily={familyName:"Synthetic family",childName:"Synthetic child",birthDate:"2013-04-12",grade:"S2",guardianLabel:"Mother"};

describe("creating a family",()=>{
  it("refuses roles that do not manage families",async()=>{
    for(const role of ["parent","student","teacher"] as const){
      await expect(createFamily(actor(role),validFamily)).rejects.toMatchObject({code:"ROLE_DENIED"});
    }
  });
  it("accepts an administrator and a staff member",async()=>{
    await expect(createFamily(actor("admin"),validFamily)).resolves.toMatchObject({id:expect.any(String)});
    currentRole="staff";
    await expect(createFamily(actor("staff"),validFamily)).resolves.toMatchObject({id:expect.any(String)});
  });
  // Two layers reject a bad date: the schema enforces the shape, the handler enforces
  // that the date exists and falls in the supported age band.
  it.each([["2013-13-01"],["2013-02-30"]])("rejects the impossible birth date %s",async value=>{
    await expect(createFamily(actor("admin"),{...validFamily,birthDate:value})).rejects.toMatchObject({code:"INVALID_BIRTHDATE"});
  });
  it.each([["not-a-date"],["2013-04-12T00:00:00Z"],["20130412"],[""]])("rejects the malformed birth date %s",async value=>{
    await expect(createFamily(actor("admin"),{...validFamily,birthDate:value})).rejects.toThrow();
  });
  it("rejects a child outside the supported age band",async()=>{
    await expect(createFamily(actor("admin"),{...validFamily,birthDate:"2025-01-01"})).rejects.toMatchObject({code:"INVALID_BIRTHDATE"});
    await expect(createFamily(actor("admin"),{...validFamily,birthDate:"1990-01-01"})).rejects.toMatchObject({code:"INVALID_BIRTHDATE"});
  });
  it("assigns staff to themselves rather than trusting the payload",async()=>{
    currentRole="staff";
    await createFamily(actor("staff"),{...validFamily,assignedTo:"11111111-2222-4333-8444-555555555555"});
    const insert=client.query.mock.calls.find(call=>String(call[0]).includes("INSERT INTO families"));
    expect(insert?.[1]).toContain(USER_ID);
  });
  it("refuses an assignee who is not staff in this region",async()=>{
    mockQuery.mockImplementation((async(sql:string)=>{
      const text=String(sql);
      if(text.includes("FROM families f WHERE f.id=$1"))return [familyRow];
      if(text.includes("SELECT id FROM users"))return [];
      return [];
    }) as never);
    await expect(createFamily(actor("admin"),{...validFamily,assignedTo:FAMILY_ID})).rejects.toMatchObject({code:"INVALID_STAFF"});
  });
});

describe("assigning an existing family",()=>{
  it("refuses every non-admin without opening a transaction",async()=>{
    for(const role of ["staff","parent","student","teacher"] as const){
      await expect(assignFamily(actor(role),FAMILY_ID,{assignedTo:USER_ID})).rejects.toMatchObject({code:"ROLE_DENIED"});
    }
    expect(mockTransaction).not.toHaveBeenCalled();
  });
  it("requires an exact UUID assignment payload",async()=>{
    await expect(assignFamily(actor("admin"),"bad",{assignedTo:USER_ID})).rejects.toMatchObject({code:"NOT_FOUND"});
    for(const input of [{},{assignedTo:null},{assignedTo:"bad"},{assignedTo:USER_ID,region:"HK"}]){
      await expect(assignFamily(actor("admin"),FAMILY_ID,input)).rejects.toThrow();
    }
    expect(mockTransaction).not.toHaveBeenCalled();
  });
  it("locks the regional family and valid staff before updating and auditing",async()=>{
    client.query.mockResolvedValueOnce({rows:[{id:FAMILY_ID}]}).mockResolvedValueOnce({rows:[{id:USER_ID}]}).mockResolvedValueOnce({rows:[{...actor("admin"),disabled:false,demo:false}]});
    await expect(assignFamily(actor("admin"),FAMILY_ID,{assignedTo:USER_ID})).resolves.toEqual({id:FAMILY_ID,assignedTo:USER_ID});
    const calls=client.query.mock.calls;
    expect(calls[0][0]).toContain("region=$2 FOR UPDATE");
    expect(calls[0][1]).toEqual([FAMILY_ID,"CN"]);
    expect(calls[1][0]).toContain("role='staff' AND NOT disabled FOR SHARE");
    expect(calls[1][1]).toEqual([USER_ID,"CN"]);
    expect(calls[2][0]).toContain("FROM users WHERE id=$1 FOR UPDATE");
    expect(calls[2][1]).toEqual([USER_ID]);
    expect(calls[3][0]).toContain("UPDATE families SET assigned_to");
    expect(calls[4][0]).toContain("family.assigned");
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it("hides missing and foreign-region families before looking up the assignee",async()=>{
    client.query.mockResolvedValueOnce({rows:[]});
    await expect(assignFamily(actor("admin"),FAMILY_ID,{assignedTo:USER_ID})).rejects.toMatchObject({code:"NOT_FOUND"});
    expect(client.query).toHaveBeenCalledTimes(1);
  });
  it("leaves assignment untouched when the candidate is disabled, foreign or not staff",async()=>{
    client.query.mockResolvedValueOnce({rows:[{id:FAMILY_ID}]}).mockResolvedValueOnce({rows:[]});
    await expect(assignFamily(actor("admin"),FAMILY_ID,{assignedTo:USER_ID})).rejects.toMatchObject({code:"INVALID_STAFF"});
    expect(client.query).toHaveBeenCalledTimes(2);
  });
});

describe("recording guardian consent",()=>{
  const grant=(scope:string,over:Record<string,unknown>={})=>({action:"grant" as const,scope,guardianName:"Synthetic guardian",...over});
  it("refuses a student or teacher",async()=>{
    for(const role of ["student","teacher"] as const){
      await expect(recordConsent(actor(role),FAMILY_ID,grant("assessment"))).rejects.toMatchObject({code:"ROLE_DENIED"});
    }
  });
  it("rejects a bare accepted flag instead of recording every purpose",async()=>{
    await expect(recordConsent(actor("parent"),FAMILY_ID,{accepted:true,guardianName:"Synthetic guardian"})).rejects.toMatchObject({status:422,code:"CONSENT_SCOPE_REQUIRED",field:"accepted"});
    expect(clientCalls.some(sql=>sql.includes("INSERT INTO consents"))).toBe(false);
  });
  it("requires a signed-offline reference from staff, who are not the guardian",async()=>{
    await expect(recordConsent(actor("staff"),FAMILY_ID,grant("assessment"))).rejects.toMatchObject({code:"CONSENT_REFERENCE_REQUIRED"});
  });
  it("accepts a reference from staff",async()=>{
    currentRole="staff";
    await expect(recordConsent(actor("staff"),FAMILY_ID,grant("assessment",{reference:"SYNTHETIC-REF"}))).resolves.toEqual({ok:true});
  });
  it("does not demand a reference from a parent giving online consent",async()=>{
    await expect(recordConsent(actor("parent"),FAMILY_ID,grant("assessment"))).resolves.toEqual({ok:true});
  });
  it("records one purpose per row with the online method and notice version",async()=>{
    for(const scope of ["assessment","sensitive_data","parent_report"])await recordConsent(actor("parent"),FAMILY_ID,grant(scope));
    const inserts=client.query.mock.calls.filter(call=>String(call[0]).includes("INSERT INTO consents"));
    expect(inserts.map(call=>JSON.parse(String((call[1] as unknown[])[7])))).toEqual([["assessment"],["sensitive_data"],["parent_report"]]);
    expect(inserts.every(call=>(call[1] as unknown[])[4]==="online_guardian"&&typeof (call[1] as unknown[])[6]==="string")).toBe(true);
    expect(clientCalls.filter(sql=>sql.includes("UPDATE consents SET revoked_at")).every(sql=>sql.includes("consent_scope_revocations"))).toBe(true);
  });
  it("grants a missing purpose without revoking the ones already recorded",async()=>{
    client.query.mockImplementation(async(sql:string,params?:unknown[])=>{
      clientCalls.push(String(sql));
      if(String(sql).includes("AS scopes FROM consents WHERE family_id=$1"))return {rows:[{scopes:["assessment"]},{scopes:["sensitive_data"]}]};
      return answerClient(sql,params);
    });
    await recordConsent(actor("parent"),FAMILY_ID,grant("parent_report"));
    const inserts=client.query.mock.calls.filter(call=>String(call[0]).includes("INSERT INTO consents"));
    expect(inserts.map(call=>JSON.parse(String((call[1] as unknown[])[7])))).toEqual([["parent_report"]]);
    const retire=clientCalls.filter(sql=>sql.includes("UPDATE consents SET revoked_at"));
    expect(retire.every(sql=>sql.includes("consent_scope_revocations"))).toBe(true);
    expect(clientCalls.some(sql=>sql.includes("INSERT INTO consent_scope_revocations"))).toBe(false);
    expect(clientCalls.some(sql=>sql.includes("j.state='paused'")||sql.includes("j.state='ready'"))).toBe(true);
  });
  it("requires an explicit confirmation before withdrawing assessment or sensitive data",async()=>{
    await expect(recordConsent(actor("parent"),FAMILY_ID,{action:"withdraw",scope:"assessment",guardianName:"Synthetic guardian"})).rejects.toMatchObject({code:"CONSENT_WITHDRAW_CONFIRMATION"});
    await expect(recordConsent(actor("parent"),FAMILY_ID,{action:"withdraw",scope:"sensitive_data",guardianName:"Synthetic guardian",confirmWithdraw:false})).rejects.toMatchObject({code:"CONSENT_WITHDRAW_CONFIRMATION"});
    expect(clientCalls.some(sql=>sql.includes("UPDATE consents SET revoked_at"))).toBe(false);
  });
  it("revokes a single-purpose row without rewriting any other consent",async()=>{
    const consentId="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    client.query.mockImplementation(async(sql:string,params?:unknown[])=>{
      clientCalls.push(String(sql));
      if(String(sql).includes("AS scopes FROM consents WHERE family_id=$1"))return {rows:[{scopes:["parent_report"]}]};
      if(String(sql).includes("c.id, c.scopes"))return {rows:[{id:consentId,scopes:["parent_report"]}]};
      if(String(sql).includes("FROM consent_scope_revocations WHERE consent_id"))return {rows:[]};
      return answerClient(sql,params);
    });
    await recordConsent(actor("parent"),FAMILY_ID,{action:"withdraw",scope:"parent_report",guardianName:"Synthetic guardian"});
    expect(clientCalls.some(sql=>sql.includes("UPDATE consents"))).toBe(false);
    const revocation=client.query.mock.calls.find(call=>String(call[0]).includes("INSERT INTO consent_scope_revocations"));
    expect(revocation?.[1]).toEqual([expect.any(String),consentId,FAMILY_ID,"parent_report",USER_ID,"Synthetic guardian","online_guardian",null]);
    expect(clientCalls.some(sql=>sql.includes("INSERT INTO consents"))).toBe(false);
  });
  it("records evidence when the last remaining scope is withdrawn and does not rewrite the grant",async()=>{
    const consentId="cccccccc-dddd-4eee-8fff-000000000000";
    client.query.mockImplementation(async(sql:string,params?:unknown[])=>{
      clientCalls.push(String(sql));
      if(String(sql).includes("AS scopes FROM consents WHERE family_id=$1"))return {rows:[{scopes:["sensitive_data"]}]};
      if(String(sql).includes("c.id, c.scopes"))return {rows:[{id:consentId,scopes:["sensitive_data"]}]};
      return answerClient(sql,params);
    });
    await recordConsent(actor("staff"),FAMILY_ID,{action:"withdraw",scope:"sensitive_data",guardianName:"Synthetic guardian",reference:"SYNTHETIC-LAST",confirmWithdraw:true});
    expect(clientCalls.some(sql=>sql.includes("UPDATE consents"))).toBe(false);
    const revocation=client.query.mock.calls.find(call=>String(call[0]).includes("INSERT INTO consent_scope_revocations"));
    expect(String(revocation?.[0])).toContain("guardian_name,method,reference");
    expect(revocation?.[1]).toEqual([expect.any(String),consentId,FAMILY_ID,"sensitive_data",USER_ID,"Synthetic guardian","offline_signed","SYNTHETIC-LAST"]);
  });
  it("keeps a legacy combined row and records only the withdrawn purpose",async()=>{
    const consentId="bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    client.query.mockImplementation(async(sql:string,params?:unknown[])=>{
      clientCalls.push(String(sql));
      if(String(sql).includes("AS scopes FROM consents WHERE family_id=$1"))return {rows:[{scopes:["assessment","parent_report","sensitive_data"]}]};
      if(String(sql).includes("c.id, c.scopes"))return {rows:[{id:consentId,scopes:["assessment","parent_report","sensitive_data"]}]};
      if(String(sql).includes("FROM consent_scope_revocations WHERE consent_id"))return {rows:[]};
      return answerClient(sql,params);
    });
    await recordConsent(actor("parent"),FAMILY_ID,{action:"withdraw",scope:"parent_report",guardianName:"Synthetic current guardian"});
    expect(clientCalls.some(sql=>sql.includes("UPDATE consents")||sql.includes("INSERT INTO consents"))).toBe(false);
    const revocation=client.query.mock.calls.find(call=>String(call[0]).includes("INSERT INTO consent_scope_revocations"));
    expect(String(revocation?.[0])).toContain("guardian_name,method,reference");
    expect(revocation?.[1]).toEqual([expect.any(String),consentId,FAMILY_ID,"parent_report",USER_ID,"Synthetic current guardian","online_guardian",null]);
    const familyLock=clientCalls.findIndex(sql=>sql.includes("FROM families f WHERE f.id=$1")&&sql.includes("FOR UPDATE"));
    const userLock=clientCalls.findIndex(sql=>sql.includes("NOT disabled FOR SHARE"));
    const write=clientCalls.findIndex(sql=>sql.includes("INSERT INTO consent_scope_revocations"));
    expect(familyLock).toBeGreaterThanOrEqual(0);
    expect(userLock).toBeGreaterThan(familyLock);
    expect(write).toBeGreaterThan(userLock);
  });
  it("locks with familyScope's SQL and values, then re-checks the actor before writing",async()=>{
    const scope=familyScope(actor("staff"),2);
    await recordConsent(actor("staff"),FAMILY_ID,grant("assessment",{reference:"SYNTHETIC-REF"}));
    const lock=client.query.mock.calls.find(call=>String(call[0]).includes("FROM families f WHERE f.id=$1")&&String(call[0]).includes("FOR UPDATE"));
    expect(String(lock?.[0])).toBe(`SELECT f.id FROM families f WHERE f.id=$1 AND ${scope.sql} FOR UPDATE`);
    expect(lock?.[1]).toEqual([FAMILY_ID,...scope.values]);
    const familyLock=clientCalls.findIndex(sql=>sql.includes("FROM families f WHERE f.id=$1")&&sql.includes("FOR UPDATE"));
    const userLock=clientCalls.findIndex(sql=>sql.includes("NOT disabled FOR SHARE"));
    const write=clientCalls.findIndex(sql=>sql.includes("INSERT INTO consents"));
    expect(familyLock).toBeGreaterThanOrEqual(0);
    expect(userLock).toBeGreaterThan(familyLock);
    expect(write).toBeGreaterThan(userLock);
  });
  it("rejects the old staff member when the locked familyScope check no longer matches",async()=>{
    // A safety alert does not get a second allow path here. An empty familyScope
    // result after the family lock is a refusal. This branch's helper still
    // matches any staff_alerts row, including after reassignment. PR #11 narrows
    // familyScope to an unresolved alert only while the family is unassigned, and
    // this same query then refuses the old staff member.
    const scope=familyScope(actor("staff"),2);
    client.query.mockImplementation(async(sql:string,params?:unknown[])=>{
      clientCalls.push(String(sql));
      if(String(sql).includes("FROM families f WHERE f.id=$1")&&String(sql).includes("FOR UPDATE"))return {rows:[]};
      return answerClient(sql,params);
    });
    await expect(recordConsent(actor("staff"),FAMILY_ID,{action:"withdraw",scope:"parent_report",guardianName:"Synthetic guardian",reference:"SYNTHETIC-REF"})).rejects.toMatchObject({status:404,code:"NOT_FOUND"});
    const lock=client.query.mock.calls.find(call=>String(call[0]).includes("FOR UPDATE"));
    expect(String(lock?.[0])).toBe(`SELECT f.id FROM families f WHERE f.id=$1 AND ${scope.sql} FOR UPDATE`);
    expect(lock?.[1]).toEqual([FAMILY_ID,...scope.values]);
    expect(clientCalls.filter(sql=>sql.includes("staff_alerts"))).toEqual([String(lock?.[0])]);
    expect(clientCalls.some(sql=>sql.includes("INSERT INTO consents")||sql.includes("UPDATE consents")||sql.includes("INSERT INTO consent_scope_revocations"))).toBe(false);
  });
  it("still lets a parent and an administrator record consent when familyScope matches",async()=>{
    await expect(recordConsent(actor("parent"),FAMILY_ID,grant("sensitive_data"))).resolves.toEqual({ok:true});
    await expect(recordConsent(actor("admin"),FAMILY_ID,grant("parent_report",{reference:"SYNTHETIC-REF"}))).resolves.toEqual({ok:true});
    for(const role of ["parent","admin"] as const){
      const scope=familyScope(actor(role),2);
      expect(clientCalls.some(sql=>sql===`SELECT f.id FROM families f WHERE f.id=$1 AND ${scope.sql} FOR UPDATE`)).toBe(true);
    }
  });
  it("rechecks a disabled or role-changed account under the family lock and does not write",async()=>{
    client.query.mockImplementation(async(sql:string)=>{
      clientCalls.push(String(sql));
      if(String(sql).includes("FROM families f WHERE f.id=$1")&&String(sql).includes("FOR UPDATE"))return {rows:[{id:FAMILY_ID}]};
      if(String(sql).includes("NOT disabled FOR SHARE"))return {rows:[]};
      if(String(sql).includes("SELECT role, region, disabled FROM users"))return {rows:[{role:"staff",region:"CN",disabled:true}]};
      return {rows:[]};
    });
    await expect(recordConsent(actor("staff"),FAMILY_ID,grant("assessment",{reference:"SYNTHETIC-REF"}))).rejects.toMatchObject({status:403,code:"ACCOUNT_REVOKED"});
    expect(clientCalls.some(sql=>sql.includes("INSERT INTO consents"))).toBe(false);
    clientCalls.length=0;
    client.query.mockImplementation(async(sql:string)=>{
      clientCalls.push(String(sql));
      if(String(sql).includes("FROM families f WHERE f.id=$1")&&String(sql).includes("FOR UPDATE"))return {rows:[{id:FAMILY_ID}]};
      if(String(sql).includes("NOT disabled FOR SHARE"))return {rows:[]};
      if(String(sql).includes("SELECT role, region, disabled FROM users"))return {rows:[{role:"parent",region:"CN",disabled:false}]};
      return {rows:[]};
    });
    await expect(recordConsent(actor("staff"),FAMILY_ID,grant("assessment",{reference:"SYNTHETIC-REF"}))).rejects.toMatchObject({status:409,code:"ROLE_CONFLICT"});
    expect(clientCalls.some(sql=>sql.includes("INSERT INTO consents"))).toBe(false);
  });
});

describe("deleting a family",()=>{
  it("uses transactional database cascading instead of leaving a filesystem deletion job",async()=>{
    vi.stubEnv("NOVA_REPORT_STORAGE","database");
    await deleteFamily(actor("admin"),FAMILY_ID,{confirmation:"Synthetic child"});
    expect(clientCalls.some(sql=>sql.includes("DELETE FROM families"))).toBe(true);
    expect(clientCalls.some(sql=>sql.includes("file_deletion_jobs")||sql.includes("SELECT pdf_keys"))).toBe(false);
    expect(clientCalls.some(sql=>sql.includes("DELETE FROM sessions"))).toBe(false);
  });
  it("refuses staff and students",async()=>{
    for(const role of ["staff","student","teacher"] as const){
      await expect(deleteFamily(actor(role),FAMILY_ID,{confirmation:"Synthetic child"})).rejects.toMatchObject({code:"ROLE_DENIED"});
    }
  });
  it("requires the child's name to be typed exactly",async()=>{
    await expect(deleteFamily(actor("admin"),FAMILY_ID,{confirmation:"wrong name"})).rejects.toMatchObject({code:"CONFIRMATION_MISMATCH"});
  });
  it("queues every stored PDF for deletion before removing the family",async()=>{
    await deleteFamily(actor("admin"),FAMILY_ID,{confirmation:"Synthetic child"});
    expect(clientCalls.some(sql=>sql.includes("INSERT INTO file_deletion_jobs"))).toBe(true);
    expect(clientCalls.findIndex(sql=>sql.includes("INSERT INTO file_deletion_jobs")))
      .toBeLessThan(clientCalls.findIndex(sql=>sql.includes("DELETE FROM families")));
  });
  it("preserves independent accounts and their sessions when a family is removed",async()=>{
    await deleteFamily(actor("admin"),FAMILY_ID,{confirmation:"Synthetic child"});
    expect(clientCalls.some(sql=>sql.includes("DELETE FROM sessions")||sql.includes("DELETE FROM users"))).toBe(false);
  });
  it("rechecks an account disabled after its initial family lookup",async()=>{
    vi.stubEnv("NOVA_REPORT_STORAGE","database");
    client.query.mockResolvedValueOnce({rows:[{id:FAMILY_ID}]}).mockResolvedValueOnce({rows:[{...actor("admin"),disabled:true,demo:false}]});
    await expect(deleteFamily(actor("admin"),FAMILY_ID,{confirmation:"Synthetic child"})).rejects.toMatchObject({code:"ACCOUNT_REVOKED"});
    expect(clientCalls.some(sql=>sql.includes("DELETE FROM families"))).toBe(false);
  });
  it("rechecks parent membership under the family lock",async()=>{
    vi.stubEnv("NOVA_REPORT_STORAGE","database");
    client.query.mockResolvedValueOnce({rows:[{id:FAMILY_ID}]}).mockResolvedValueOnce({rows:[{...actor("parent"),disabled:false,demo:false}]}).mockResolvedValueOnce({rows:[]});
    await expect(deleteFamily(actor("parent"),FAMILY_ID,{confirmation:"Synthetic child"})).rejects.toMatchObject({code:"NOT_FOUND"});
    expect(clientCalls.some(sql=>sql.includes("DELETE FROM families"))).toBe(false);
  });
});

describe("invitations",()=>{
  const issuanceOutcome=(issuer:Actor,role:"parent"|"student"|"teacher")=>{currentRole=issuer.role;return createInvitation(issuer,FAMILY_ID,{role}).then(()=>({allowed:true}),error=>({status:error.status,code:error.code}));};
  it("refuses a parent or student issuing one",async()=>{
    for(const role of ["parent","student","teacher"] as const){
      await expect(createInvitation(actor(role),FAMILY_ID,{role:"parent"})).rejects.toMatchObject({code:"ROLE_DENIED"});
    }
  });
  it("returns a link with a 64-character token and an expiry",async()=>{
    const result=await createInvitation(actor("admin"),FAMILY_ID,{role:"parent"});
    expect(result.url).toMatch(/\/invite#token=[a-f0-9]{64}$/);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
  });
  it("never returns the stored hash instead of the token",async()=>{
    const result=await createInvitation(actor("admin"),FAMILY_ID,{role:"parent"});
    const token=result.url.split("token=")[1];
    const stored=client.query.mock.calls.find(call=>String(call[0]).includes("INSERT INTO invitations"))?.[1] as unknown[];
    expect(String(stored)).not.toContain(token);
  });
  it.each(["parent","student","teacher"] as const)("refuses safety-visible staff granting a %s membership",async role=>{
    client.query.mockResolvedValueOnce({rows:[{...familyRow,assigned_to:"77777777-6666-4555-8444-333333333333"}]});
    await expect(issuanceOutcome(actor("staff"),role)).resolves.toMatchObject({status:404,code:"NOT_FOUND"});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO invitations"))).toBe(false);
    expect(mockQuery.mock.calls.some(([sql])=>String(sql).includes("invitation.created"))).toBe(false);
  });
  it.each(["parent","student","teacher"] as const)("allows the assigned staff member to invite a %s after locking the family",async role=>{
    currentRole="staff";
    client.query.mockResolvedValueOnce({rows:[{...familyRow,assigned_to:USER_ID}]});
    await expect(createInvitation(actor("staff"),FAMILY_ID,{role})).resolves.toMatchObject({url:expect.stringContaining("/invite#token=")});
    expect(client.query.mock.calls[0][0]).toContain("region=$2 FOR UPDATE");
    expect(client.query.mock.calls[0][1]).toEqual([FAMILY_ID,"CN"]);
    const insert=client.query.mock.calls.find(([sql])=>String(sql).includes("INSERT INTO invitations"));
    expect(insert?.[1]?.[2]).toBe(role);
  });
  it("rechecks the assignee after locking even when an earlier read showed the actor assigned",async()=>{
    mockQuery.mockImplementation((async(sql:string)=>String(sql).includes("FROM families f WHERE f.id=$1")?[{...familyRow,assigned_to:USER_ID}]:[]) as never);
    client.query.mockResolvedValueOnce({rows:[{...familyRow,assigned_to:"77777777-6666-4555-8444-333333333333"}]});
    await expect(issuanceOutcome(actor("staff"),"parent")).resolves.toMatchObject({status:404,code:"NOT_FOUND"});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO invitations"))).toBe(false);
  });
  it.each(["admin","staff"] as const)("denies a different-region family to %s without issuing a token",async role=>{
    client.query.mockResolvedValueOnce({rows:[{...familyRow,region:"HK",assigned_to:USER_ID}]});
    await expect(issuanceOutcome(actor(role),"parent")).resolves.toMatchObject({status:404,code:"NOT_FOUND"});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO invitations"))).toBe(false);
  });
  it("does not grant invitations for an unassigned family to staff",async()=>{
    client.query.mockResolvedValueOnce({rows:[familyRow]});
    await expect(issuanceOutcome(actor("staff"),"parent")).resolves.toMatchObject({status:404,code:"NOT_FOUND"});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO invitations"))).toBe(false);
  });
  it("rejects a token that is not 64 hex characters",async()=>{
    for(const bad of ["short","z".repeat(64),"a".repeat(63)]){
      await expect(invitationInfo(bad)).rejects.toMatchObject({code:"INVALID_INVITATION"});
    }
  });
  it("accepts a well-formed token and returns only the family summary",async()=>{
    mockQuery.mockResolvedValueOnce([{family_name:"Synthetic family",role:"parent",region:"CN",expires_at:new Date()}]);
    const info=await invitationInfo("a".repeat(64));
    expect(Object.keys(info).sort()).toEqual(["expiresAt","familyName","region","role"]);
  });
});

describe("accepting an invitation",()=>{
  const valid={token:"a".repeat(64),name:"Synthetic",username:"demo_parent",password:"a-long-enough-password"};
  it("rejects a password under 12 characters",async()=>{
    await expect(acceptInvitation({...valid,password:"short"})).rejects.toThrow();
  });
  it.each([["ab"],["has spaces"],["UPPER!"],["a".repeat(101)]])("rejects the username %s",async username=>{
    await expect(acceptInvitation({...valid,username})).rejects.toThrow();
  });
  it("accepts a plausible username and returns the newly created account id",async()=>{
    await expect(acceptInvitation(valid)).resolves.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
  it("marks the invitation used so it cannot be replayed",async()=>{
    await acceptInvitation(valid);
    expect(clientCalls.some(sql=>sql.includes("UPDATE invitations SET used_at=now()"))).toBe(true);
  });
  it("creates the membership with the invited role, not a client-supplied one",async()=>{
    await acceptInvitation(valid);
    const membership=client.query.mock.calls.find(call=>String(call[0]).includes("INSERT INTO memberships"))?.[1] as unknown[];
    expect(membership).toContain("parent");
  });
  it("refuses an invitation that does not exist",async()=>{
    client.query.mockImplementationOnce(async()=>({rows:[]}));
    await expect(acceptInvitation(valid)).rejects.toMatchObject({code:"INVALID_INVITATION"});
  });
});
