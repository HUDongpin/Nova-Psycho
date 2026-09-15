import { describe,it,expect,beforeEach,afterEach,vi } from "vitest";

vi.mock("../src/lib/db",()=>({query:vi.fn(),transaction:vi.fn()}));
vi.mock("../src/lib/auth",async importOriginal=>{
  const actual=await importOriginal<typeof import("../src/lib/auth")>();
  return {...actual,hashPassword:vi.fn(async()=>"scrypt$stub")};
});
import { query,transaction } from "../src/lib/db";
import { acceptInvitation,createFamily,createInvitation,deleteFamily,invitationInfo,recordConsent } from "../src/lib/families";
import type { Actor,Role } from "../src/domain/types";

const mockQuery=vi.mocked(query);
const mockTransaction=vi.mocked(transaction);

const FAMILY_ID="11111111-2222-4333-8444-555555555555";
const USER_ID="99999999-8888-4777-8666-555555555555";
const actor=(role:Role,over:Partial<Actor>={}):Actor=>({id:USER_ID,name:"Synthetic",role,region:"CN",...over});
const familyRow={id:FAMILY_ID,region:"CN",family_name:"Synthetic family",child_name:"Synthetic child",birth_date:"2013-04-12",grade:"S2",guardian_label:"Mother",assigned_to:null,created_at:new Date()};

const clientCalls:string[]=[];
const client={
  query:vi.fn(async(sql:string)=>{
    clientCalls.push(String(sql));
    if(String(sql).includes("SELECT id FROM families"))return {rows:[{id:FAMILY_ID}]};
    if(String(sql).includes("SELECT family_id FROM invitations"))return {rows:[{family_id:FAMILY_ID}]};
    if(String(sql).includes("FOR UPDATE OF i"))return {rows:[{family_id:FAMILY_ID,role:"parent"}]};
    if(String(sql).includes("SELECT user_id FROM memberships"))return {rows:[{user_id:USER_ID}]};
    if(String(sql).includes("SELECT pdf_keys FROM reports"))return {rows:[{pdf_keys:{"zh-CN":"a.zh-CN.pdf.enc"}}]};
    return {rows:[]};
  })
};

function stubDb(){
  mockQuery.mockReset();mockTransaction.mockReset();client.query.mockClear();clientCalls.length=0;
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
    await createFamily(actor("staff"),{...validFamily,assignedTo:"11111111-2222-4333-8444-555555555555"});
    const insert=mockQuery.mock.calls.find(call=>String(call[0]).includes("INSERT INTO families"));
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

describe("recording guardian consent",()=>{
  const consent={accepted:true as const,guardianName:"Synthetic guardian"};
  it("refuses a student or teacher",async()=>{
    for(const role of ["student","teacher"] as const){
      await expect(recordConsent(actor(role),FAMILY_ID,consent)).rejects.toMatchObject({code:"ROLE_DENIED"});
    }
  });
  it("requires a signed-offline reference from staff, who are not the guardian",async()=>{
    await expect(recordConsent(actor("staff"),FAMILY_ID,consent)).rejects.toMatchObject({code:"CONSENT_REFERENCE_REQUIRED"});
  });
  it("accepts a reference from staff",async()=>{
    await expect(recordConsent(actor("staff"),FAMILY_ID,{...consent,reference:"SYNTHETIC-REF"})).resolves.toEqual({ok:true});
  });
  it("does not demand a reference from a parent giving online consent",async()=>{
    await expect(recordConsent(actor("parent"),FAMILY_ID,consent)).resolves.toEqual({ok:true});
  });
  it("records the offline method for staff and the online method for parents",async()=>{
    await recordConsent(actor("parent"),FAMILY_ID,consent);
    expect(clientCalls.some(sql=>sql.includes("INSERT INTO consents"))).toBe(true);
    const values=client.query.mock.calls.find(call=>String(call[0]).includes("INSERT INTO consents"))?.[1] as unknown[];
    expect(values).toContain("online_guardian");
  });
  it("always includes the mandatory scopes and adds AI only when granted",async()=>{
    await recordConsent(actor("parent"),FAMILY_ID,consent);
    const withoutAi=client.query.mock.calls.find(call=>String(call[0]).includes("INSERT INTO consents"))?.[1] as unknown[];
    expect(String(withoutAi)).toContain("assessment");
    expect(String(withoutAi)).toContain("parent_report");
    expect(String(withoutAi)).toContain("sensitive_data");
    client.query.mockClear();clientCalls.length=0;
    await recordConsent(actor("parent"),FAMILY_ID,{...consent,aiProcessing:true});
    const withAi=client.query.mock.calls.find(call=>String(call[0]).includes("INSERT INTO consents"))?.[1] as unknown[];
    expect(String(withAi)).toContain("ai_processing");
  });
  it("revokes any previous active consent first",async()=>{
    await recordConsent(actor("parent"),FAMILY_ID,consent);
    expect(clientCalls.some(sql=>sql.includes("UPDATE consents SET revoked_at=now()"))).toBe(true);
  });
});

describe("deleting a family",()=>{
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
  it("ends the sessions of the members it removes",async()=>{
    await deleteFamily(actor("admin"),FAMILY_ID,{confirmation:"Synthetic child"});
    expect(clientCalls.some(sql=>sql.includes("DELETE FROM sessions"))).toBe(true);
  });
});

describe("invitations",()=>{
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
