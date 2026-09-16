import { describe,it,expect,beforeEach,vi } from "vitest";

vi.mock("../src/lib/db",()=>({query:vi.fn()}));
import { query } from "../src/lib/db";
import { consentFor,familyFor } from "../src/lib/access";
import type { FamilyRow } from "../src/lib/access";
import type { Actor,Role } from "../src/domain/types";

const mockQuery=vi.mocked(query);

const FAMILY_ID="11111111-2222-4333-8444-555555555555";
const USER_ID="99999999-8888-4777-8666-555555555555";
const actor=(role:Role,over:Partial<Actor>={}):Actor=>({id:USER_ID,name:"Synthetic",role,region:"CN",...over});
const familyRow:FamilyRow={
  id:FAMILY_ID,region:"CN",family_name:"Synthetic family",child_name:"Synthetic child",
  birth_date:"2013-04-12",grade:"S2",guardian_label:"Mother",assigned_to:null,created_at:new Date()
};

beforeEach(()=>{
  mockQuery.mockReset();
});

describe("familyFor",()=>{
  it("rejects a non-UUID id as NOT_FOUND before querying",async()=>{
    await expect(familyFor(actor("admin"),"not-a-uuid")).rejects.toMatchObject({status:404,code:"NOT_FOUND"});
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("resolves to the family row for an administrator",async()=>{
    mockQuery.mockResolvedValueOnce([familyRow]);
    await expect(familyFor(actor("admin"),FAMILY_ID)).resolves.toEqual(familyRow);
    const [sql,values]=mockQuery.mock.calls[0];
    expect(String(sql)).toContain("f.region=");
    expect(values).toEqual([FAMILY_ID,"CN"]);
  });

  it("rejects a missing family with a Chinese not-found message",async()=>{
    mockQuery.mockResolvedValueOnce([]);
    const rejection=familyFor(actor("admin"),FAMILY_ID);
    await expect(rejection).rejects.toMatchObject({status:404,code:"NOT_FOUND"});
    await expect(rejection).rejects.toThrow(/家庭|权限/);
  });

  it("binds assigned_to to the staff actor",async()=>{
    mockQuery.mockResolvedValueOnce([familyRow]);
    await familyFor(actor("staff"),FAMILY_ID);
    const [sql,values]=mockQuery.mock.calls[0];
    expect(String(sql)).toContain("f.assigned_to=");
    expect(values).toContain(USER_ID);
  });

  it("scopes a parent through memberships",async()=>{
    mockQuery.mockResolvedValueOnce([familyRow]);
    await familyFor(actor("parent"),FAMILY_ID);
    const [sql,values]=mockQuery.mock.calls[0];
    expect(String(sql)).toContain("EXISTS");
    expect(String(sql)).toMatch(/memberships/);
    expect(values).toContain(USER_ID);
    expect(values).toContain("parent");
  });
});

describe("consentFor",()=>{
  it("returns true when an active consent row exists",async()=>{
    mockQuery.mockResolvedValueOnce([{id:"c1"}]);
    await expect(consentFor(FAMILY_ID)).resolves.toBe(true);
    const [sql]=mockQuery.mock.calls[0];
    expect(String(sql)).toContain("revoked_at IS NULL");
    expect(String(sql)).toContain("assessment");
    expect(String(sql)).toContain("parent_report");
    expect(String(sql)).toContain("sensitive_data");
    expect(String(sql)).toContain("@>");
  });

  it("returns false when no consent row exists",async()=>{
    mockQuery.mockResolvedValueOnce([]);
    await expect(consentFor(FAMILY_ID)).resolves.toBe(false);
  });
});
