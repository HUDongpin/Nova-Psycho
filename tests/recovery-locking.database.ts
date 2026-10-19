import assert from "node:assert/strict";
import { randomBytes,randomUUID } from "node:crypto";
import pg from "pg";
import type { Actor } from "../src/domain/types";
import { closeDatabase } from "../src/lib/db";
import { createRecovery } from "../src/lib/recovery";

const databaseUrl=process.env.NOVA_RECOVERY_LOCK_TEST_DATABASE_URL;
assert.ok(databaseUrl,"Set NOVA_RECOVERY_LOCK_TEST_DATABASE_URL to a fresh synthetic database");
const address=new URL(databaseUrl);
assert.ok(["127.0.0.1","localhost"].includes(address.hostname));
assert.match(address.pathname,/^\/nova_(pass2_cn|recovery_lock_test_[a-z0-9_]+)$/);
assert.equal(address.password,"");
Object.assign(process.env,{DATABASE_URL:databaseUrl,NOVA_REGION:"CN",NOVA_MODE:"demo",NOVA_PUBLIC_URL:"http://127.0.0.1:3202",NOVA_REPORT_STORAGE:"database",NOVA_WORKER_MODE:"continuous",NOVA_REPORT_KEY:"0".repeat(64),NOVA_AI_ENABLED:"false",NOVA_AUTH_PROVIDER:"local",VERCEL:"0"});

const observer=new pg.Client({connectionString:databaseUrl,application_name:"synthetic-recovery-observer",statement_timeout:10000});
const barrier=new pg.Client({connectionString:databaseUrl,application_name:"synthetic-recovery-barrier",statement_timeout:10000});
const actors:Actor[]=["A","B"].map(label=>({id:randomUUID(),name:`Synthetic recovery admin ${label}`,role:"admin",region:"CN"}));
const oldTokenHashes=actors.map(()=>randomBytes(32).toString("hex"));
type Outcome={status:"fulfilled"}|{status:"rejected";code:string;message:string};
let running:Promise<Outcome[]>|undefined;

try{
  await observer.connect();await barrier.connect();
  const settings=await observer.query("SELECT region,mode FROM deployment_settings WHERE singleton=true");
  assert.deepEqual(settings.rows,[{region:"CN",mode:"demo"}]);
  for(const [index,actor] of actors.entries()){
    await observer.query("INSERT INTO users(id,region,username,name,role,demo) VALUES($1,'CN',$2,$3,'admin',true)",[actor.id,`synthetic_recovery_${actor.id}`,actor.name]);
    await observer.query("INSERT INTO recovery_tokens(token_hash,user_id,region,expires_at) VALUES($1,$2,'CN',now()+interval '1 hour')",[oldTokenHashes[index],actor.id]);
  }
  await barrier.query("BEGIN");
  const blockerPid=(await barrier.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  await barrier.query("SELECT token_hash FROM recovery_tokens WHERE token_hash=ANY($1::text[]) ORDER BY token_hash FOR UPDATE",[oldTokenHashes]);
  const issue=(actor:Actor,target:Actor)=>createRecovery(actor,target.id).then<Outcome,Outcome>(
    ()=>({status:"fulfilled"}),
    error=>({status:"rejected",code:String(error?.code??""),message:error instanceof Error?error.message:"Unknown error"})
  );
  running=Promise.all([issue(actors[0],actors[1]),issue(actors[1],actors[0])]);
  let waiting=0;
  for(let attempt=0;attempt<500;attempt++){
    const blocked=await observer.query<{n:number}>(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE application_name='nova-cn' AND wait_event_type='Lock'
        AND $1::int=ANY(pg_blocking_pids(pid)) AND query LIKE 'UPDATE recovery_tokens SET used_at=%'`,[blockerPid]);
    waiting=blocked.rows[0].n;
    if(waiting===2)break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(waiting,2,"Both issuers must hold their target-account locks before the token barrier is released");
  await barrier.query("COMMIT");
  const outcomes=await running;
  const outstanding=await observer.query<{user_id:string;n:number}>("SELECT user_id,count(*)::int AS n FROM recovery_tokens WHERE user_id=ANY($1::uuid[]) AND used_at IS NULL GROUP BY user_id ORDER BY user_id",[actors.map(actor=>actor.id)]);
  console.log(JSON.stringify({bothIssuersReachedTokenBarrier:true,outcomes,outstandingCounts:outstanding.rows.map(row=>row.n)}));
  assert.deepEqual(outcomes,[{status:"fulfilled"},{status:"fulfilled"}],"Administrators issuing recovery links for each other must not deadlock");
  assert.equal(outstanding.rows.length,2);
  assert.ok(outstanding.rows.every(row=>row.n===1),"Each target retains exactly one outstanding recovery link");
  console.log("PASS: reciprocal recovery issuance completes without a foreign-key lock deadlock");

  await barrier.query("BEGIN");
  await barrier.query("SELECT token_hash FROM recovery_tokens WHERE user_id=$1 AND used_at IS NULL FOR UPDATE",[actors[1].id]);
  const first=issue(actors[0],actors[1]);
  running=Promise.all([first]);
  let firstPid:number|undefined;
  for(let attempt=0;attempt<500;attempt++){
    const blocked=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE application_name='nova-cn'
      AND $1::int=ANY(pg_blocking_pids(pid)) AND query LIKE 'UPDATE recovery_tokens SET used_at=%'`,[blockerPid]);
    firstPid=blocked.rows[0]?.pid;
    if(firstPid)break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(firstPid,"The first same-target issuer must hold the account lock at its token barrier");
  const second=issue(actors[1],actors[1]);
  running=Promise.all([first,second]);
  let serialized=false;
  for(let attempt=0;attempt<500;attempt++){
    const blocked=await observer.query<{n:number}>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='nova-cn'
      AND $1::int=ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT id,name,role,disabled FROM users%'`,[firstPid]);
    serialized=blocked.rows[0].n===1;
    if(serialized)break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(serialized,"The second issuer must wait for the first issuer's target-account lock");
  await barrier.query("COMMIT");
  assert.deepEqual(await running,[{status:"fulfilled"},{status:"fulfilled"}]);
  const active=await observer.query<{n:number}>("SELECT count(*)::int AS n FROM recovery_tokens WHERE user_id=$1 AND used_at IS NULL",[actors[1].id]);
  assert.equal(active.rows[0].n,1,"Serialized same-target issuance retires the earlier link");
  console.log("PASS: same-target recovery issuance remains serialized with one outstanding link");
}finally{
  await barrier.query("ROLLBACK").catch(()=>{});
  await running;
  const ids=actors.map(actor=>actor.id);
  await observer.query("DELETE FROM audit_events WHERE actor_id=ANY($1::uuid[])",[ids]);
  await observer.query("DELETE FROM recovery_tokens WHERE user_id=ANY($1::uuid[]) OR created_by=ANY($1::uuid[])",[ids]);
  await observer.query("DELETE FROM users WHERE id=ANY($1::uuid[])",[ids]);
  await closeDatabase();await barrier.end();await observer.end();
}
