import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { demoScale } from "../src/domain/demo";
import { closeDatabase } from "../src/lib/db";
import { processReportJob } from "../src/lib/worker";

const databaseUrl=process.env.NOVA_WORKER_LOCK_TEST_DATABASE_URL;
assert.ok(databaseUrl,"Set NOVA_WORKER_LOCK_TEST_DATABASE_URL to a fresh synthetic database");
const address=new URL(databaseUrl);
assert.ok(["127.0.0.1","localhost"].includes(address.hostname));
assert.match(address.pathname,/^\/nova_(pass2_cn|worker_lock_test_[a-z0-9_]+)$/);
assert.equal(address.password,"");
Object.assign(process.env,{DATABASE_URL:databaseUrl,NOVA_REGION:"CN",NOVA_MODE:"demo",NOVA_PUBLIC_URL:"http://127.0.0.1:3197",NOVA_REPORT_STORAGE:"database",NOVA_WORKER_MODE:"continuous",NOVA_REPORT_KEY:"0".repeat(64),NOVA_AI_ENABLED:"false",VERCEL:"0"});
const observer=new pg.Client({connectionString:databaseUrl,application_name:"synthetic-worker-lock-observer",statement_timeout:10000});
const retry=new pg.Client({connectionString:databaseUrl,application_name:"synthetic-worker-lock-retry",statement_timeout:10000});
const userId=randomUUID(),familyId=randomUUID(),assessmentId=randomUUID(),jobId=randomUUID();
let running:Promise<unknown>|undefined;

try{
  await observer.connect();await retry.connect();
  const retryPid=(await retry.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  const settings=await observer.query("SELECT region,mode FROM deployment_settings WHERE singleton=true");
  assert.deepEqual(settings.rows,[{region:"CN",mode:"demo"}]);
  await observer.query("INSERT INTO users(id,region,username,name,role,demo) VALUES($1,'CN',$2,'Synthetic lock parent','parent',true)",[userId,`synthetic_lock_${userId}`]);
  await observer.query("INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label) VALUES($1,'CN','Synthetic lock family','Synthetic lock child','2013-04-12','S2','Parent')",[familyId]);
  await observer.query("INSERT INTO assessments(id,family_id,region,respondent_id,respondent_role,scale_version_id,locale,status,submitted_at) VALUES($1,$2,'CN',$3,'parent',$4,'zh-CN','queued',now())",[assessmentId,familyId,userId,`${demoScale.id}@${demoScale.version}`]);
  await observer.query("INSERT INTO report_jobs(id,assessment_id,state,attempts,lease_until) VALUES($1,$2,'running',3,now()-interval '1 second')",[jobId,assessmentId]);
  await retry.query("BEGIN");
  await retry.query("SELECT id,region,assigned_to FROM families WHERE id=$1 AND region=$2 FOR UPDATE",[familyId,"CN"]);
  await retry.query("SELECT * FROM assessments WHERE id=$1 AND region=$2 FOR UPDATE",[assessmentId,"CN"]);
  const settled=processReportJob(jobId).then(value=>({status:"fulfilled" as const,value}),reason=>({status:"rejected" as const,reason}));
  running=settled;
  let blockedQuery:string|undefined;
  for(let attempt=0;attempt<200;attempt++){
    const blocked=await observer.query<{query:string}>("SELECT query FROM pg_stat_activity WHERE application_name='nova-cn' AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",[retryPid]);
    if(blocked.rows[0]){blockedQuery=blocked.rows[0].query;break;}
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(blockedQuery,"The worker must reach the held retry transaction before its job lock is requested");
  console.log("Blocked worker statement:",blockedQuery.replace(/\s+/g," "));
  const retryLock=await retry.query("SELECT * FROM report_jobs WHERE assessment_id=$1 OR $1=ANY(source_assessment_ids) FOR UPDATE",[assessmentId]).then(()=>({status:"fulfilled" as const}),reason=>({status:"rejected" as const,reason}));
  await retry.query("ROLLBACK");
  const worker=await settled;
  const durable=await observer.query("SELECT j.state,j.attempts,a.status FROM report_jobs j JOIN assessments a ON a.id=j.assessment_id WHERE j.id=$1",[jobId]);
  console.log(JSON.stringify({worker:worker.status==="rejected"?{status:worker.status,code:worker.reason.code,message:worker.reason.message}:worker,retryLock:retryLock.status==="rejected"?{status:retryLock.status,code:retryLock.reason.code,message:retryLock.reason.message}:retryLock,durable:durable.rows[0]}));
  assert.equal(retryLock.status,"fulfilled","The retry lock sequence must not deadlock with terminal worker state persistence");
  assert.equal(worker.status,"fulfilled","The worker must persist its terminal state without a deadlock exception");
  if(worker.status==="fulfilled")assert.deepEqual(worker.value,{status:"terminal"});
  assert.deepEqual(durable.rows,[{state:"failed",attempts:3,status:"failed"}]);
  console.log("PASS: terminal worker persistence and retry lock sequence complete without deadlock");
}finally{
  await retry.query("ROLLBACK").catch(()=>{});
  await running;
  await observer.query("DELETE FROM families WHERE id=$1",[familyId]);
  await observer.query("DELETE FROM users WHERE id=$1",[userId]);
  await closeDatabase();await retry.end();await observer.end();
}
