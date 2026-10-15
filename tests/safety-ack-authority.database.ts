import assert from "node:assert/strict";
import { randomUUID,randomBytes } from "node:crypto";
import pg from "pg";
const databaseUrl=process.env.NOVA_SAFETY_ACK_TEST_DATABASE_URL;
assert.ok(databaseUrl,"Set NOVA_SAFETY_ACK_TEST_DATABASE_URL to a fresh synthetic database");
const address=new URL(databaseUrl);
assert.ok(["127.0.0.1","localhost"].includes(address.hostname));
assert.match(address.pathname,/^\/nova_(pass2_cn|safety_ack_test_[a-z0-9_]+)$/);
assert.equal(address.password,"");
Object.assign(process.env,{DATABASE_URL:databaseUrl,NOVA_REGION:"CN",NOVA_MODE:"demo",NOVA_AUTH_PROVIDER:"local",NOVA_AI_ENABLED:"false",NOVA_PUBLIC_URL:"http://127.0.0.1:3100",NOVA_REPORT_DIR:"work/qa/cumulative-review/safety-ack-authority/private-reports",NOVA_REPORT_KEY:randomBytes(32).toString("hex")});
const {acknowledgeSafetyAlert}=await import("../src/lib/triad");
const {closeDatabase}=await import("../src/lib/db");
const client=new pg.Client({connectionString:databaseUrl,statement_timeout:10000}),blocker=new pg.Client({connectionString:databaseUrl,statement_timeout:10000}),revoker=new pg.Client({connectionString:databaseUrl,statement_timeout:10000});
const userId=randomUUID(),familyId=randomUUID(),alertId=randomUUID();let gated=false;
const receipts:unknown[]=[];
await client.connect();await blocker.connect();await revoker.connect();
try{
 assert.deepEqual((await client.query("SELECT region,mode FROM deployment_settings WHERE singleton=true")).rows,[{region:"CN",mode:"demo"}]);
 await client.query("INSERT INTO users(id,region,name,role,demo) VALUES($1,'CN','Synthetic alert worker','staff',true)",[userId]);
 await client.query("INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label) VALUES($1,'CN','Synthetic alert family','Synthetic child','2013-04-12','S2','Synthetic guardian')",[familyId]);
 await client.query("INSERT INTO staff_alerts(id,family_id,region) VALUES($1,$2,'CN')",[alertId,familyId]);
 const actor={id:userId,name:"Synthetic alert worker",role:"staff" as const,region:"CN" as const};
 for(const [change,expected] of [["disabled=true","ACCOUNT_REVOKED"],["role='parent'","ROLE_CONFLICT"],["region='HK'","REGION_MISMATCH"]]){
  await client.query("UPDATE users SET disabled=false,role='staff',region='CN' WHERE id=$1",[userId]);
  await client.query("UPDATE staff_alerts SET viewed_at=NULL,viewed_by=NULL WHERE id=$1",[alertId]);
  await client.query("DELETE FROM audit_events WHERE entity_id=$1",[alertId]);
  await blocker.query("BEGIN");gated=true;
  await blocker.query("SELECT id FROM families WHERE id=$1 FOR UPDATE",[familyId]);
  await blocker.query("SELECT id FROM staff_alerts WHERE id=$1 FOR UPDATE",[alertId]);
  const pid=(await blocker.query("SELECT pg_backend_pid() AS id")).rows[0].id;
  const pending=acknowledgeSafetyAlert(actor,alertId).then(()=>({ok:true}),error=>({error:error.code}));
  let waited=false;
  for(let i=0;i<200;i++){
   if((await client.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting",[pid])).rows[0].waiting){waited=true;break;}
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(waited,true);
  await client.query(`UPDATE users SET ${change} WHERE id=$1`,[userId]);
  await blocker.query("COMMIT");gated=false;
  const outcome=await pending;
  const alert=(await client.query("SELECT viewed_at,viewed_by FROM staff_alerts WHERE id=$1",[alertId])).rows[0];
  const audits=(await client.query("SELECT count(*)::int AS count FROM audit_events WHERE entity_id=$1",[alertId])).rows[0].count;
  receipts.push({change,expected,waited,outcome,marked:alert.viewed_at!==null,audits});
 }
 console.log(JSON.stringify({synthetic:true,operationalSqlBoundary:true,cases:receipts},null,2));
 assert.equal(receipts.every((row:any)=>row.outcome.error===row.expected&&!row.marked&&row.audits===0),true);
 await client.query("UPDATE users SET disabled=false,role='staff',region='CN' WHERE id=$1",[userId]);
 await Promise.all([acknowledgeSafetyAlert(actor,alertId),acknowledgeSafetyAlert(actor,alertId)]);
 assert.equal((await client.query("SELECT count(*)::int AS count FROM audit_events WHERE entity_id=$1",[alertId])).rows[0].count,1);
 assert.equal((await client.query("SELECT viewed_by FROM staff_alerts WHERE id=$1",[alertId])).rows[0].viewed_by,userId);
 console.log("PASS: unassigned regional safety staff acknowledgement and concurrent replay produce one audit/first viewer");
 await client.query("UPDATE staff_alerts SET viewed_at=NULL,viewed_by=NULL WHERE id=$1",[alertId]);
 await client.query("DELETE FROM audit_events WHERE entity_id=$1",[alertId]);
 await blocker.query("BEGIN");gated=true;
 await blocker.query("SELECT id FROM staff_alerts WHERE id=$1 FOR UPDATE",[alertId]);
 const blockerPid=(await blocker.query("SELECT pg_backend_pid() AS id")).rows[0].id;
 const acknowledgement=acknowledgeSafetyAlert(actor,alertId);
 let acknowledgementWaited=false;
 for(let i=0;i<200;i++){
  if((await client.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'UPDATE staff_alerts%') AS waiting",[blockerPid])).rows[0].waiting){acknowledgementWaited=true;break;}
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.equal(acknowledgementWaited,true,"acknowledgement holds actor SHARE before waiting for alert row");
 const revokerPid=(await revoker.query("SELECT pg_backend_pid() AS id")).rows[0].id;
 const revoked=revoker.query("UPDATE users SET disabled=true WHERE id=$1",[userId]);
 let revocationWaited=false;
 for(let i=0;i<200;i++){
  if((await client.query("SELECT cardinality(pg_blocking_pids($1))>0 AS waiting",[revokerPid])).rows[0].waiting){revocationWaited=true;break;}
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.equal(revocationWaited,true,"later revocation must wait for actor SHARE");
 await blocker.query("COMMIT");gated=false;
 await Promise.all([acknowledgement,revoked]);
 assert.equal((await client.query("SELECT viewed_by FROM staff_alerts WHERE id=$1",[alertId])).rows[0].viewed_by,userId);
 assert.equal((await client.query("SELECT count(*)::int AS count FROM audit_events WHERE entity_id=$1",[alertId])).rows[0].count,1);
 await assert.rejects(acknowledgeSafetyAlert(actor,alertId),{code:"ACCOUNT_REVOKED"});
 console.log("PASS: acknowledgement acquiring actor SHARE first finishes before waiting revocation; later replay is denied");
}finally{
 if(gated)await blocker.query("ROLLBACK");
 await closeDatabase();
 await client.query("DELETE FROM audit_events WHERE entity_id=$1",[alertId]);
 await client.query("DELETE FROM families WHERE id=$1",[familyId]);
 await client.query("DELETE FROM users WHERE id=$1",[userId]);
 await blocker.end();await revoker.end();await client.end();
}
