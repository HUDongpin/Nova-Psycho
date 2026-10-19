import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { Actor } from "../src/domain/types";
vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
import { query, transaction } from "../src/lib/db";
import { createFamily } from "../src/lib/families";

const ADMIN_ID="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",STAFF_ID="99999999-8888-4777-8666-555555555555";
const admin:Actor={id:ADMIN_ID,name:"Synthetic admin",role:"admin",region:"CN"};
const input={familyName:"Synthetic family",childName:"Synthetic child",birthDate:"2013-04-12",grade:"Synthetic",guardianLabel:"Synthetic"};
let current:Actor&{disabled:boolean;demo:boolean},staffEnabled:boolean,beforeAssigneeLock:()=>void,mutations:string[];
const client={query:vi.fn()};
beforeEach(()=>{
  vi.clearAllMocks();vi.stubEnv("NOVA_REGION","CN");vi.stubEnv("NOVA_MODE","demo");
  vi.stubEnv("DATABASE_URL","postgresql://synthetic.invalid/nova");vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR","work/test-private");vi.stubEnv("NOVA_REPORT_KEY","0".repeat(64));
  current={...admin,disabled:false,demo:false};staffEnabled=true;beforeAssigneeLock=()=>{};mutations=[];
  const execute=async(sql:string)=>{
    if(sql.includes("SELECT id FROM users")){
      if(sql.includes("FOR SHARE"))beforeAssigneeLock();
      const rows=staffEnabled?[{id:STAFF_ID}]:[];
      if(!sql.includes("FOR SHARE"))beforeAssigneeLock();
      return rows;
    }
    if(sql.includes("FROM users"))return[current];
    if(sql.startsWith("INSERT INTO families"))mutations.push(sql);
    return[];
  };
  vi.mocked(query).mockImplementation((async(sql:string)=>execute(sql)) as never);
  client.query.mockImplementation(async(sql:string)=>({rows:await execute(sql)}));
  vi.mocked(transaction).mockImplementation(async fn=>fn(client as unknown as PoolClient));
});
afterEach(()=>vi.unstubAllEnvs());
describe("new family authority",()=>{
  it("allows a current administrator to create an unassigned family",async()=>{await createFamily(admin,input);expect(mutations).toHaveLength(1);});
  it("allows a current administrator to assign an active regional worker",async()=>{await createFamily(admin,{...input,assignedTo:STAFF_ID});expect(mutations).toHaveLength(1);});
  it("rejects an assignee disabled while awaiting the account lock",async()=>{
    beforeAssigneeLock=()=>{staffEnabled=false;};
    await expect(createFamily(admin,{...input,assignedTo:STAFF_ID})).rejects.toMatchObject({code:"INVALID_STAFF"});expect(mutations).toEqual([]);
  });
  it.each(["disabled","demoted"] as const)("rejects a %s issuer after waiting for the assignee",async(change)=>{
    beforeAssigneeLock=()=>{if(change==="disabled")current.disabled=true;else current.role="teacher";};
    await expect(createFamily(admin,{...input,assignedTo:STAFF_ID})).rejects.toMatchObject({code:change==="disabled"?"ACCOUNT_REVOKED":"ROLE_CONFLICT"});expect(mutations).toEqual([]);
  });
  it.each(["disabled","demoted"] as const)("rejects a %s issuer even without an assignee",async(change)=>{
    if(change==="disabled")current.disabled=true;else current.role="teacher";
    await expect(createFamily(admin,input)).rejects.toMatchObject({code:change==="disabled"?"ACCOUNT_REVOKED":"ROLE_CONFLICT"});expect(mutations).toEqual([]);
  });
});
