import { describe,it,expect,beforeEach,afterEach,vi } from "vitest";

vi.mock("../src/lib/db",()=>({query:vi.fn()}));
import { query } from "../src/lib/db";
import { addGoal,addObservation,updateGoal } from "../src/lib/care";
import type { Actor,Role } from "../src/domain/types";

const mockQuery=vi.mocked(query);
const FAMILY_ID="22222222-3333-4444-8555-666666666666";
const GOAL_ID="11111111-2222-4333-8444-555555555555";
const actor=(role:Role,over:Partial<Actor>={}):Actor=>({id:"99999999-8888-4777-8666-555555555555",name:"Synthetic",role,region:"CN",...over});

beforeEach(()=>{
  vi.stubEnv("NOVA_REGION","CN");vi.stubEnv("NOVA_MODE","demo");
  vi.stubEnv("DATABASE_URL","postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR","work/test-private");
  vi.stubEnv("NOVA_REPORT_KEY","0".repeat(64));
  mockQuery.mockReset();
  mockQuery.mockImplementation((async(sql:string)=>{
    if(String(sql).includes("FROM families f WHERE f.id=$1"))return [{id:FAMILY_ID,region:"CN",family_name:"Synthetic",child_name:"Synthetic child",birth_date:"2013-04-12",grade:"S2",guardian_label:"Mother",assigned_to:null,created_at:new Date()}];
    if(String(sql).includes("SELECT family_id FROM goals"))return [{family_id:FAMILY_ID}];
    return [];
  }) as never);
});
afterEach(()=>vi.unstubAllEnvs());

describe("care goals",()=>{
  it("refuses students and teachers",async()=>{
    for(const role of ["student","teacher"] as const){
      await expect(addGoal(actor(role),{familyId:FAMILY_ID,title:"t",detail:"d"})).rejects.toMatchObject({code:"ROLE_DENIED"});
      await expect(updateGoal(actor(role),GOAL_ID,{status:"completed"})).rejects.toMatchObject({code:"ROLE_DENIED"});
    }
  });
  it("lets an administrator, staff member and parent create a goal",async()=>{
    for(const role of ["admin","staff","parent"] as const){
      await expect(addGoal(actor(role),{familyId:FAMILY_ID,title:"Synthetic goal",detail:"detail"})).resolves.toMatchObject({id:expect.any(String)});
    }
  });
  it("requires a non-empty title and a bounded detail",async()=>{
    await expect(addGoal(actor("admin"),{familyId:FAMILY_ID,title:"   ",detail:"d"})).rejects.toThrow();
    await expect(addGoal(actor("admin"),{familyId:FAMILY_ID,title:"t",detail:"x".repeat(2001)})).rejects.toThrow();
  });
  it("refuses a family the caller cannot reach",async()=>{
    mockQuery.mockImplementation((async()=>[]) as never);
    await expect(addGoal(actor("staff"),{familyId:FAMILY_ID,title:"t",detail:"d"})).rejects.toMatchObject({code:"NOT_FOUND"});
  });
  it("rejects a malformed goal id before querying",async()=>{
    await expect(updateGoal(actor("admin"),"nope",{status:"completed"})).rejects.toMatchObject({code:"NOT_FOUND"});
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it("only accepts the two known goal statuses",async()=>{
    await expect(updateGoal(actor("admin"),GOAL_ID,{status:"deleted"})).rejects.toThrow();
  });
  it("checks the goal's own family before allowing a status change",async()=>{
    mockQuery.mockImplementation((async(sql:string)=>{
      if(String(sql).includes("SELECT family_id FROM goals"))return [{family_id:FAMILY_ID}];
      return []; // familyFor finds nothing in scope
    }) as never);
    await expect(updateGoal(actor("parent"),GOAL_ID,{status:"completed"})).rejects.toMatchObject({code:"NOT_FOUND"});
  });
});

describe("case observations",()=>{
  it("refuses parents, students and teachers",async()=>{
    for(const role of ["parent","student","teacher"] as const){
      await expect(addObservation(actor(role),{familyId:FAMILY_ID,body:"note"})).rejects.toMatchObject({code:"ROLE_DENIED"});
    }
  });
  it("lets an administrator and a staff member record one",async()=>{
    for(const role of ["admin","staff"] as const){
      await expect(addObservation(actor(role),{familyId:FAMILY_ID,body:"Synthetic note"})).resolves.toMatchObject({id:expect.any(String)});
    }
  });
  it("requires a non-empty body",async()=>{
    await expect(addObservation(actor("staff"),{familyId:FAMILY_ID,body:"   "})).rejects.toThrow();
  });
  it("refuses a family the caller cannot reach",async()=>{
    mockQuery.mockImplementation((async()=>[]) as never);
    await expect(addObservation(actor("staff"),{familyId:FAMILY_ID,body:"note"})).rejects.toMatchObject({code:"NOT_FOUND"});
  });
});
