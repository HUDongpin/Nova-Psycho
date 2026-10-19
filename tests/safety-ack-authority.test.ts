import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import type { PoolClient } from "pg";
import type { Actor } from "../src/domain/types";
vi.mock("../src/lib/db",()=>({query:vi.fn(),transaction:vi.fn()}));
import {query,transaction} from "../src/lib/db";
import {acknowledgeSafetyAlert} from "../src/lib/triad";
const familyId="11111111-2222-4333-8444-555555555555",alertId="22222222-3333-4444-8555-666666666666",actorId="33333333-4444-4555-8666-777777777777";
const actor:Actor={id:actorId,name:"Synthetic safety worker",role:"staff",region:"CN"};
let current:Actor&{disabled:boolean;demo:boolean},present:boolean,viewed:boolean,viewer:string|null,audits:number,failAudit:boolean,alertPresent:boolean;
const client={query:vi.fn()};
beforeEach(()=>{
 vi.clearAllMocks();vi.stubEnv("NOVA_REGION","CN");vi.stubEnv("NOVA_MODE","demo");vi.stubEnv("DATABASE_URL","postgresql://synthetic.invalid/nova");vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3100");vi.stubEnv("NOVA_REPORT_DIR","work/test-private");vi.stubEnv("NOVA_REPORT_KEY","0".repeat(64));
 current={...actor,disabled:false,demo:false};present=true;viewed=false;viewer=null;audits=0;failAudit=false;alertPresent=true;
 const execute=async(sql:string,values:unknown[]=[],locked=false)=>{
  if(sql.includes("FROM users WHERE id=$1"))return[current];
  if(sql.includes("FROM families"))return !locked||present?[{id:familyId,region:"CN",assigned_to:null}]:[];
  if(sql.includes("FROM staff_alerts WHERE id=$1"))return locked&&!alertPresent?[]:[{id:alertId,family_id:familyId,resolved_at:null,viewed_at:viewed?new Date():null}];
  if(sql.startsWith("UPDATE staff_alerts")){if(viewed)return[];viewed=true;viewer=String(values[0]);return[{id:alertId}];}
  if(sql.includes("INSERT INTO audit_events")){if(failAudit)throw new Error("Synthetic audit failure");audits++;return[];}
  throw new Error(`Unexpected synthetic query ${sql}`);
 };
 vi.mocked(query).mockImplementation((async(sql:string,values?:unknown[])=>execute(sql,values)) as never);
 client.query.mockImplementation(async(sql:string,values?:unknown[])=>({rows:await execute(sql,values,true)}));
 vi.mocked(transaction).mockImplementation(async fn=>{const prior={viewed,viewer,audits};try{return await fn(client as unknown as PoolClient);}catch(error){({viewed,viewer,audits}=prior);throw error;}});
});
afterEach(()=>vi.unstubAllEnvs());
describe("safety acknowledgement authority",()=>{
 it.each([["disabled","ACCOUNT_REVOKED"],["role","ROLE_CONFLICT"],["region","REGION_MISMATCH"]] as const)("rejects changed %s before marking or auditing",async(change,code)=>{
  if(change==="disabled")current.disabled=true;else if(change==="role")current.role="parent";else current.region="HK";
  await expect(acknowledgeSafetyAlert(actor,alertId)).rejects.toMatchObject({code});expect(viewed).toBe(false);expect(audits).toBe(0);
 });
 it("does not accept a viewed replay from a newly disabled account",async()=>{viewed=true;current.disabled=true;await expect(acknowledgeSafetyAlert(actor,alertId)).rejects.toMatchObject({code:"ACCOUNT_REVOKED"});expect(audits).toBe(0);});
 it("rejects a family deleted after preflight",async()=>{present=false;await expect(acknowledgeSafetyAlert(actor,alertId)).rejects.toMatchObject({code:"NOT_FOUND"});expect(viewed).toBe(false);expect(audits).toBe(0);});
 it("rejects an alert removed after preflight",async()=>{alertPresent=false;await expect(acknowledgeSafetyAlert(actor,alertId)).rejects.toMatchObject({code:"NOT_FOUND"});expect(viewed).toBe(false);expect(audits).toBe(0);});
 it("allows unassigned regional staff with safety scope and preserves first viewer on replay",async()=>{await acknowledgeSafetyAlert(actor,alertId);await acknowledgeSafetyAlert(actor,alertId);expect(viewer).toBe(actorId);expect(audits).toBe(1);});
 it("rolls back the viewed mark if its audit write fails",async()=>{failAudit=true;await expect(acknowledgeSafetyAlert(actor,alertId)).rejects.toThrow("Synthetic audit failure");expect(viewed).toBe(false);expect(viewer).toBeNull();expect(audits).toBe(0);});
});
