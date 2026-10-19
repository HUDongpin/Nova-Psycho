import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir,writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Actor,AdviceLibrary } from "../src/domain/types";
import { demoScale,demoTemplate } from "../src/domain/demo";
import { createContent,currentContent,importScale,setScaleStatus } from "../src/lib/content";
import { closeDatabase,pool,query } from "../src/lib/db";
import { getConfig } from "../src/lib/config";

const config=getConfig(),database=new URL(config.databaseUrl);
assert.equal(config.mode,"demo");assert.equal(config.region,"CN");assert.equal(config.ai.enabled,false);
assert.equal(database.hostname,"127.0.0.1");assert.equal(database.port,"55495");assert.equal(database.pathname,"/nova_pass2_cn");
assert.equal(database.searchParams.get("application_name"),"nova_content_authority");
const output=process.env.CONTENT_TEST_OUTPUT??"work/qa/cumulative-review/content-authority/green";
assert.ok(output.startsWith("work/qa/cumulative-review/content-authority/"));await mkdir(output,{recursive:true});
const actor:Actor={id:randomUUID(),name:"Synthetic content administrator",role:"admin",region:"CN"};
const scales:string[]=[],versions:string[]=[];
const results:{name:string;passed:boolean;detail?:string}[]=[];
async function check(name:string,run:()=>Promise<void>){console.log(`RUN ${name}`);try{await run();results.push({name,passed:true});console.log(`PASS ${name}`);}catch(error){results.push({name,passed:false,detail:error instanceof Error?error.message:String(error)});console.log(`FAIL ${name}`);}}
async function waitForLock(){for(let i=0;i<150;i++){
  if((await query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock'",["nova_content_authority"])).length)return;await delay(20);
}throw new Error("Content mutation did not reach the controlled PostgreSQL lock");}
try{
  await query("INSERT INTO users(id,region,name,role,demo) VALUES($1,'CN',$2,'admin',true)",[actor.id,actor.name]);
  const advice=(await currentContent<AdviceLibrary>("advice")).content;
  // Preserve all seeded instruments' references when testing valid publication.
  const scaleRows=await query("SELECT definition FROM scales");
  const needed=new Set<string>();for(const row of scaleRows)for(const dimension of row.definition.dimensions)for(const band of dimension.bands)for(const id of band.adviceIds??[])needed.add(id);
  assert.ok([...needed].every(id=>advice.blocks.some(block=>block.id===id)),"Seeded advice must support all active fixtures");
  let serial=0;
  for(const operation of ["import","retire","advice","template"] as const)for(const change of ["disabled","demoted","moved","unchanged"] as const){
    await check(`${operation}: ${change} while content publication waits`,async()=>{
      const definition={...demoScale,id:`synthetic-content-${randomUUID()}`};const scaleId=`${definition.id}@${definition.version}`;scales.push(scaleId);
      const version=`999.${Date.now()}.${++serial}`;versions.push(version);
      if(operation==="retire")await query("INSERT INTO scales(id,scale_id,version,definition) VALUES($1,$2,$3,$4)",[scaleId,definition.id,definition.version,JSON.stringify(definition)]);
      const run=()=>operation==="import"?importScale(actor,{definition}):operation==="retire"?setScaleStatus(actor,scaleId,{status:"retired"}):createContent(actor,operation,{version,content:operation==="advice"?advice:demoTemplate});
      const blocker=await pool().connect();let pending:Promise<{ok:true}|{ok:false;error:unknown}>|undefined;
      try{
        await blocker.query("BEGIN");await blocker.query("SELECT pg_advisory_xact_lock(742681,1)");
        pending=run().then(()=>({ok:true as const}),error=>({ok:false as const,error}));await waitForLock();
        if(change==="disabled")await blocker.query("UPDATE users SET disabled=true WHERE id=$1",[actor.id]);
        if(change==="demoted")await blocker.query("UPDATE users SET role='staff' WHERE id=$1",[actor.id]);
        if(change==="moved")await blocker.query("UPDATE users SET region='HK' WHERE id=$1",[actor.id]);
        await blocker.query("COMMIT");const result=await pending;
        if(change==="unchanged")assert.equal(result.ok,true);
        else{
          assert.equal(result.ok,false,"revoked issuer still committed a content mutation");
          assert.equal((result as {ok:false;error:{code:string}}).error.code,"FORBIDDEN");
          if(operation==="retire")assert.equal((await query("SELECT status FROM scales WHERE id=$1",[scaleId]))[0].status,"active");
          else if(operation==="import")assert.equal((await query("SELECT id FROM scales WHERE id=$1",[scaleId])).length,0);
          else assert.equal((await query("SELECT id FROM content_versions WHERE version=$1",[version])).length,0);
        }
      }finally{await blocker.query("ROLLBACK");blocker.release();await pending;await query("UPDATE users SET disabled=false,role='admin',region='CN' WHERE id=$1",[actor.id]);}
    });
  }
}finally{
  await query("DELETE FROM audit_events WHERE actor_id=$1",[actor.id]);
  await query("DELETE FROM scales WHERE id=ANY($1::text[])",[scales]);
  await query("DELETE FROM content_versions WHERE version=ANY($1::text[])",[versions]);
  await query("DELETE FROM users WHERE id=$1",[actor.id]);
  await writeFile(`${output}/results.json`,JSON.stringify(results,null,2));await closeDatabase();
}
assert.equal(results.filter(result=>!result.passed).length,0,"content authorization fixtures must all pass");
