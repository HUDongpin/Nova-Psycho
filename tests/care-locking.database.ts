import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Actor } from "../src/domain/types";
import { addGoal, addObservation, updateGoal } from "../src/lib/care";
import { closeDatabase, pool, query } from "../src/lib/db";
import { getConfig } from "../src/lib/config";

// Opt-in fixture harness; never run against a regional service database.
const config=getConfig(), database=new URL(config.databaseUrl);
assert.equal(config.mode,"demo");assert.equal(config.region,"CN");assert.equal(config.ai.enabled,false);
assert.equal(database.hostname,"127.0.0.1");assert.equal(database.port,"55493");assert.equal(database.pathname,"/nova_pass2_cn");
assert.equal(database.searchParams.get("application_name"),"nova_pass3_care");
const output=process.env.CARE_TEST_OUTPUT??"work/qa/review-pass3/care";
assert.ok(output.startsWith("work/qa/review-pass3/care"));await mkdir(output,{recursive:true});
const results:{name:string;passed:boolean;detail?:string}[]=[];
const staff:Actor={id:randomUUID(),name:"Synthetic care worker",role:"staff",region:"CN"};
const other:Actor={...staff,id:randomUUID(),name:"Synthetic replacement worker"};
const families:string[]=[];
async function check(name:string,action:()=>Promise<void>){
  console.log(`RUN ${name}`);
  try{await action();results.push({name,passed:true});console.log(`PASS ${name}`);}
  catch(error){results.push({name,passed:false,detail:error instanceof Error?error.message:String(error)});console.log(`FAIL ${name}`);}
}
async function waitForLock(){
  for(let attempt=0;attempt<150;attempt++){
    const rows=await query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock'",["nova_pass3_care"]);
    if(rows.length)return;await delay(20);
  }
  throw new Error("Synthetic care mutation did not reach its PostgreSQL lock barrier");
}
const operations=[
  {name:"goal creation",run:(family:string,_goal:string)=>addGoal(staff,{familyId:family,title:"Synthetic goal",detail:""})},
  {name:"goal status",run:(_family:string,goal:string)=>updateGoal(staff,goal,{status:"completed"})},
  {name:"private observation",run:(family:string,_goal:string)=>addObservation(staff,{familyId:family,body:"Synthetic observation"})},
];
try{
  for(const actor of [staff,other])await query("INSERT INTO users(id,region,name,role,demo) VALUES($1,'CN',$2,'staff',true)",[actor.id,actor.name]);
  for(const operation of operations)for(const scenario of ["reassigned","safety-alert","disabled"] as const){
    await check(`${operation.name}: ${scenario} while the database write waits`,async()=>{
      const family=randomUUID(),goal=randomUUID();families.push(family);
      await query("INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label,assigned_to) VALUES($1,'CN','Synthetic care family','Synthetic child','2014-01-01','Synthetic','Synthetic',$2)",[family,staff.id]);
      await query("INSERT INTO goals(id,family_id,title,detail,created_by) VALUES($1,$2,'Synthetic existing goal','',$3)",[goal,family,staff.id]);
      if(scenario==="safety-alert")await query("INSERT INTO staff_alerts(id,family_id,region) VALUES($1,$2,'CN')",[randomUUID(),family]);
      const blocker=await pool().connect();let pending:Promise<{ok:true}|{ok:false;error:unknown}>|undefined;
      try{
        await blocker.query("BEGIN");
        await blocker.query("SELECT id FROM families WHERE id=$1 FOR UPDATE",[family]);
        // The goal barrier lets the old standalone UPDATE pass authorization,
        // then wait until the reassignment commits. Inserts wait on the family FK.
        await blocker.query("SELECT id FROM goals WHERE id=$1 FOR UPDATE",[goal]);
        pending=operation.run(family,goal).then(()=>({ok:true as const}),error=>({ok:false as const,error}));
        await waitForLock();
        if(scenario==="disabled")await blocker.query("UPDATE users SET disabled=true WHERE id=$1",[staff.id]);
        else await blocker.query("UPDATE families SET assigned_to=$1 WHERE id=$2",[other.id,family]);
        await blocker.query("COMMIT");
        const result=await pending;
        if(scenario==="safety-alert")assert.equal(result.ok,true,"regional safety-alert access must remain permitted");
        else{
          assert.equal(result.ok,false,"care mutation committed after its authority changed");
          assert.equal((result as {ok:false;error:{code:string}}).error.code,scenario==="disabled"?"ACCOUNT_REVOKED":"NOT_FOUND");
          assert.equal((await query("SELECT status FROM goals WHERE id=$1",[goal]))[0].status,"active");
          assert.equal((await query("SELECT count(*)::int n FROM goals WHERE family_id=$1",[family]))[0].n,1);
          assert.equal((await query("SELECT count(*)::int n FROM observations WHERE family_id=$1",[family]))[0].n,0);
        }
      }finally{await blocker.query("ROLLBACK");blocker.release();await pending;await query("UPDATE users SET disabled=false WHERE id=$1",[staff.id]);}
    });
  }
}finally{
  await query("DELETE FROM audit_events WHERE actor_id=ANY($1::uuid[])",[[staff.id,other.id]]);
  await query("DELETE FROM families WHERE id=ANY($1::uuid[])",[families]);
  await query("DELETE FROM users WHERE id=ANY($1::uuid[])",[[staff.id,other.id]]);
  await writeFile(`${output}/postgres-results.json`,JSON.stringify(results,null,2));await closeDatabase();
}
assert.equal(results.filter(result=>!result.passed).length,0,"care authorization PostgreSQL regressions must all pass");
