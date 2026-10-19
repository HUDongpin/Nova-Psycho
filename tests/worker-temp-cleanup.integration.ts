import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { demoScale } from "../src/domain/demo";
import { closeDatabase } from "../src/lib/db";
import { cleanAbandonedPrivatePdfTemps } from "../src/lib/storage";

const databaseUrl=process.env.NOVA_WORKER_TEMP_TEST_DATABASE_URL;
assert.ok(databaseUrl,"Set NOVA_WORKER_TEMP_TEST_DATABASE_URL to a fresh synthetic database");
const address=new URL(databaseUrl);
assert.ok(["127.0.0.1","localhost"].includes(address.hostname));
assert.match(address.pathname,/^\/nova_(pass2_cn|worker_temp_test_[a-z0-9_]+)$/);assert.equal(address.password,"");
const root=path.resolve("work/qa/review-pass3/worker");await fs.mkdir(root,{recursive:true});
const dir=await fs.mkdtemp(path.join(root,"pg-temp-fixture-"));
Object.assign(process.env,{DATABASE_URL:databaseUrl,NOVA_REGION:"CN",NOVA_MODE:"demo",NOVA_PUBLIC_URL:"http://127.0.0.1:3197",NOVA_REPORT_STORAGE:"filesystem",NOVA_REPORT_DIR:dir,NOVA_WORKER_MODE:"continuous",NOVA_REPORT_KEY:"0".repeat(64),NOVA_AI_ENABLED:"false",VERCEL:"0"});
const client=new pg.Client({connectionString:databaseUrl,application_name:"synthetic-worker-temp-test",statement_timeout:10000});
const userId=randomUUID(),familyId=randomUUID(),assessmentId=randomUUID(),jobId=randomUUID(),token=randomUUID(),replacement=randomUUID();
const name=(claim:string)=>`${assessmentId}.${claim}.zh-CN.pdf.enc.0123456789abcdef.tmp`;
const stale=new Date(Date.now()-25*60*60*1000);
async function stage(claim:string){const filename=path.join(dir,name(claim));await fs.writeFile(filename,"NOVA1 synthetic encrypted temporary");await fs.utimes(filename,stale,stale);}

try{
  await client.connect();
  assert.deepEqual((await client.query("SELECT region,mode FROM deployment_settings WHERE singleton=true")).rows,[{region:"CN",mode:"demo"}]);
  await client.query("INSERT INTO users(id,region,username,name,role,demo) VALUES($1,'CN',$2,'Synthetic temp parent','parent',true)",[userId,`synthetic_temp_${userId}`]);
  await client.query("INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label) VALUES($1,'CN','Synthetic temp family','Synthetic temp child','2013-04-12','S2','Parent')",[familyId]);
  await client.query("INSERT INTO assessments(id,family_id,region,respondent_id,respondent_role,scale_version_id,locale,status,submitted_at) VALUES($1,$2,'CN',$3,'parent',$4,'zh-CN','queued',now())",[assessmentId,familyId,userId,`${demoScale.id}@${demoScale.version}`]);
  await client.query("INSERT INTO report_jobs(id,assessment_id,state,attempts,claim_token,lease_until) VALUES($1,$2,'running',1,$3,now()-interval '1 second')",[jobId,assessmentId,token]);
  await stage(token);await cleanAbandonedPrivatePdfTemps();assert.deepEqual(await fs.readdir(dir),[name(token)]);
  console.log("PASS: expired matching running claim retains its aged temporary");
  await client.query("UPDATE report_jobs SET claim_token=$2 WHERE id=$1",[jobId,replacement]);
  await stage(replacement);await cleanAbandonedPrivatePdfTemps();assert.deepEqual(await fs.readdir(dir),[name(replacement)]);
  console.log("PASS: replacement claim retains its temporary and old fenced token is removed");
  for(const state of ["ready","failed","done"]){
    await client.query("UPDATE report_jobs SET state=$2 WHERE id=$1",[jobId,state]);
    await stage(replacement);await cleanAbandonedPrivatePdfTemps();assert.deepEqual(await fs.readdir(dir),[]);
    console.log(`PASS: ${state} claim no longer retains its abandoned temporary`);
  }
  await stage(replacement);await client.query("DELETE FROM families WHERE id=$1",[familyId]);
  await cleanAbandonedPrivatePdfTemps();assert.deepEqual(await fs.readdir(dir),[]);
  console.log("PASS: deleted family leaves no aged encrypted temporary");
}finally{
  await client.query("DELETE FROM families WHERE id=$1",[familyId]);
  await client.query("DELETE FROM users WHERE id=$1",[userId]);
  await closeDatabase();await client.end();await fs.rm(dir,{recursive:true,force:true});
}
