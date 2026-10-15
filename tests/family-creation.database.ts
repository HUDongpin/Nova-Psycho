import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Actor } from "../src/domain/types";
import { createFamily } from "../src/lib/families";
import { closeDatabase, pool, query } from "../src/lib/db";
import { getConfig } from "../src/lib/config";

const config=getConfig(),database=new URL(config.databaseUrl);
assert.equal(config.mode,"demo");assert.equal(config.region,"CN");assert.equal(config.ai.enabled,false);
assert.equal(database.hostname,"127.0.0.1");assert.equal(database.port,"55493");assert.equal(database.pathname,"/nova_pass2_cn");
assert.equal(database.searchParams.get("application_name"),"nova_pass3_creation");
const output=process.env.FAMILY_TEST_OUTPUT??"work/qa/review-pass3/family-creation";
assert.ok(output.startsWith("work/qa/review-pass3/family-creation"));await mkdir(output,{recursive:true});
const admin:Actor={id:randomUUID(),name:"Synthetic creation admin",role:"admin",region:"CN"};
const staff:Actor={id:randomUUID(),name:"Synthetic creation worker",role:"staff",region:"CN"};
const familyName=`Synthetic creation ${randomUUID()}`;
const input={familyName,childName:"Synthetic child",birthDate:"2014-01-01",grade:"Synthetic",guardianLabel:"Synthetic"};
const results:{name:string;passed:boolean;detail?:string}[]=[];
async function check(name:string,action:()=>Promise<void>){
  console.log(`RUN ${name}`);try{await action();results.push({name,passed:true});console.log(`PASS ${name}`);}
  catch(error){results.push({name,passed:false,detail:error instanceof Error?error.message:String(error)});console.log(`FAIL ${name}`);}
}
async function waitForLock(){
  for(let i=0;i<150;i++){
    if((await query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock'",["nova_pass3_creation"])).length)return;
    await delay(20);
  }throw new Error("Synthetic family creation did not reach its account lock barrier");
}
try{
  for(const user of [admin,staff])await query("INSERT INTO users(id,region,name,role,demo) VALUES($1,'CN',$2,$3,true)",[user.id,user.name,user.role]);
  for(const change of ["assignee-disabled","issuer-disabled","issuer-demoted"] as const){
    await check(`${change} during family creation account wait`,async()=>{
      const blocker=await pool().connect();let pending:Promise<{ok:true}|{ok:false;error:unknown}>|undefined;
      try{
        await blocker.query("BEGIN");await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE",[staff.id]);
        pending=createFamily(admin,{...input,assignedTo:staff.id}).then(()=>({ok:true as const}),error=>({ok:false as const,error}));
        await waitForLock();
        if(change==="assignee-disabled")await blocker.query("UPDATE users SET disabled=true WHERE id=$1",[staff.id]);
        else if(change==="issuer-disabled")await blocker.query("UPDATE users SET disabled=true WHERE id=$1",[admin.id]);
        else await blocker.query("UPDATE users SET role='teacher' WHERE id=$1",[admin.id]);
        await blocker.query("COMMIT");const result=await pending;
        assert.equal(result.ok,false,"family creation must not commit using revoked account authority");
        assert.equal((result as {ok:false;error:{code:string}}).error.code,change==="assignee-disabled"?"INVALID_STAFF":change==="issuer-disabled"?"ACCOUNT_REVOKED":"ROLE_CONFLICT");
        assert.equal((await query("SELECT 1 FROM families WHERE family_name=$1",[familyName])).length,0);
      }finally{
        await blocker.query("ROLLBACK");blocker.release();await pending;
        await query("DELETE FROM families WHERE family_name=$1",[familyName]);
        await query("UPDATE users SET disabled=false,role=$2 WHERE id=$1",[admin.id,"admin"]);
        await query("UPDATE users SET disabled=false WHERE id=$1",[staff.id]);
      }
    });
  }
  await check("current administrator and staff can still create families",async()=>{
    const unassigned=await createFamily(admin,input),assigned=await createFamily(admin,{...input,assignedTo:staff.id}),self=await createFamily(staff,{...input,assignedTo:admin.id});
    const rows=await query("SELECT id,assigned_to FROM families WHERE family_name=$1",[familyName]);
    assert.equal(rows.find(row=>row.id===unassigned.id)?.assigned_to,null);
    assert.equal(rows.find(row=>row.id===assigned.id)?.assigned_to,staff.id);
    assert.equal(rows.find(row=>row.id===self.id)?.assigned_to,staff.id);
  });
}finally{
  await query("DELETE FROM families WHERE family_name=$1",[familyName]);
  await query("DELETE FROM audit_events WHERE actor_id=ANY($1::uuid[])",[[admin.id,staff.id]]);
  await query("DELETE FROM users WHERE id=ANY($1::uuid[])",[[admin.id,staff.id]]);
  await writeFile(`${output}/postgres-results.json`,JSON.stringify(results,null,2));await closeDatabase();
}
assert.equal(results.filter(result=>!result.passed).length,0,"family creation authority regressions must all pass");
