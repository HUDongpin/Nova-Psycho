import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { POST } from '../src/app/api/[...path]/route';
import { hashPassword, hashToken, actorOf } from '../src/lib/auth';
import { query, pool, closeDatabase } from '../src/lib/db';
import { getConfig } from '../src/lib/config';

const output=process.env.SESSION_TEST_OUTPUT??'work/qa/recovery-review/session/green';
assert.ok(output.startsWith('work/qa/recovery-review/session/'));
const config=getConfig(),url=new URL(config.databaseUrl),prefix=`sessionproof_${randomUUID().slice(0,8)}_`;
assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55496');assert.equal(url.pathname,'/nova_recovery_session_cn');
assert.equal(config.region,'CN');assert.equal(config.mode,'demo');assert.equal(config.ai.enabled,false);
await mkdir(output,{recursive:true});
const oldPassword='Synthetic-old-password-1982',newPassword='Synthetic-new-password-1983';
const ids:string[]=[],familyIds:string[]=[],names:string[]=[],results:unknown[]=[];
let adminCookie='';
async function post(path:string,body:unknown,cookie=''){
 const response=await POST(new Request(`${config.publicUrl}/api/${path}`,{method:'POST',headers:{origin:config.publicUrl,'content-type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(body)}),{params:Promise.resolve({path:path.split('/')})});
 return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]??''};
}
async function actor(cookie:string){return actorOf(new Request(`${config.publicUrl}/api/session`,{headers:{cookie}}),false);}
async function check(name:string,fn:()=>Promise<unknown>){console.log(`RUN ${name}`);try{const detail=await fn();results.push({name,passed:true,detail});console.log(`PASS ${name}`);}catch(error){results.push({name,passed:false,detail:String(error)});console.log(`FAIL ${name}: ${String(error)}`);}}
async function wait(sql:string,values:unknown[]=[]){for(let i=0;i<300;i++){const rows=await query(sql,values);if(rows.length)return rows;await delay(15);}throw Error(`Controlled barrier was not reached: ${sql}`);}

async function reset(userId:string){const issued=await post(`users/${userId}/recovery`,{},adminCookie);assert.equal(issued.status,201,JSON.stringify(issued));const token=issued.body.url.split('token=')[1];const accepted=await post('recovery',{token,password:newPassword});assert.equal(accepted.status,200,JSON.stringify(accepted));return token;}
async function fixtureUser(label:string,demo=false){const id=randomUUID(),username=prefix+label;ids.push(id);names.push(username);await query("INSERT INTO users(id,region,username,name,role,password_hash,demo) VALUES($1,'CN',$2,'Synthetic session account','parent',$3,$4)",[id,username,await hashPassword(oldPassword),demo]);return{id,username};}
async function family(join=false){const id=randomUUID(),code=`TOPE-${randomUUID().replaceAll('-','').slice(0,8).toUpperCase()}`;familyIds.push(id);await query("INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label,join_code) VALUES($1,'CN','Synthetic session family','Synthetic child','2014-01-01','初中','母亲',$2)",[id,join?code:null]);if(join)await query("INSERT INTO consents(id,family_id,actor_id,guardian_name,method,notice_version,scopes) VALUES($1,$2,$3,'Synthetic guardian','online_guardian','synthetic',$4)",[randomUUID(),id,ids[0],JSON.stringify(['assessment','parent_report','sensitive_data'])]);return{id,code};}
async function barrier(username:string){await query('INSERT INTO nova_session_proof_gate(username) VALUES($1)',[username]);const b=await pool().connect();await b.query('BEGIN');await b.query('SELECT pg_advisory_xact_lock(742690,1)');return b;}
try{
 const admin=await fixtureUser('admin');await query("UPDATE users SET role='admin' WHERE id=$1",[admin.id]);const login=await post('auth/login',{username:admin.username,password:oldPassword});assert.equal(login.status,200);adminCookie=login.cookie;
 await query('CREATE TABLE nova_session_proof_gate(username text PRIMARY KEY)');
 await query(`CREATE FUNCTION nova_session_proof_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM users u JOIN nova_session_proof_gate g ON u.username=g.username WHERE u.id=NEW.user_id) THEN PERFORM pg_advisory_xact_lock(742690,1); END IF; RETURN NEW; END $$`);
 await query('CREATE TRIGGER nova_session_proof_pause BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION nova_session_proof_pause()');
 for(const flow of ['profile','invitation','parent','join'] as const)for(const recovered of [true,false]){
  await check(`${flow}: ${recovered?'completed recovery rejects the delayed initial grant':'current normalized credentials create the initial session'}`,async()=>{
   const username=prefix+flow+(recovered?'_race':'_valid');names.push(username);let path='',body:Record<string,unknown>={};
   if(flow==='profile'){path='auth/register';body={name:'Synthetic parent',role:'parent',username,password:oldPassword};}
   if(flow==='invitation'){const f=await family();const invite=await post(`families/${f.id}/invites`,{role:'parent'},adminCookie);assert.equal(invite.status,201,JSON.stringify(invite));path='invite';body={token:invite.body.url.split('token=')[1],name:'Synthetic parent',username,password:oldPassword};}
   if(flow==='parent'){path='triad/parent';body={parentName:'Synthetic parent',username,password:oldPassword,relationship:'母亲',childName:'Synthetic child',birthDate:'2014-01-01',grade:'初中',assessment:true,sensitiveData:true,parentReport:true};}
   if(flow==='join'){const f=await family(true);path='triad/join';body={code:f.code,role:'student',name:'Synthetic student',username,password:oldPassword};}
   body.username=`  ${username.toUpperCase()}  `;
   // Delay only dispatch of the real pool query. The route, creation services,
   // password verification, recovery and PostgreSQL results remain unmocked.
   // Both old issuance and current credential lookup occur after creation commits.
   const db=pool(),original=db.query.bind(db);let release!:()=>void,reached!:()=>void;
   const gate=new Promise<void>(resolve=>{release=resolve;});const atGrant=new Promise<void>(resolve=>{reached=resolve;});
   const readQuery=original as (sql:string,values?:unknown[])=>Promise<{rows:Record<string,unknown>[],rowCount:number|null}>;
   db.query=(async(sql:string,values:unknown[]=[])=>{
    if((sql.startsWith('INSERT INTO sessions')||sql.startsWith('SELECT id,password_hash FROM users WHERE username'))){
     const current=(await readQuery('SELECT id FROM users WHERE username=$1',[username])).rows[0];
     if(current&&(values.includes(current.id)||values.includes(username))){reached();await gate;}
    }
    return readQuery(sql,values);
   }) as typeof db.query;
   let pending:ReturnType<typeof post>|undefined;
   try{
    pending=post(path,body);await Promise.race([atGrant,delay(5000).then(()=>{throw Error('Enrollment did not reach its initial session grant');})]);
    const [created]=await query('SELECT id FROM users WHERE username=$1',[username]);assert.ok(created);ids.push(created.id);
    const joined=await query('SELECT family_id FROM memberships WHERE user_id=$1',[created.id]);for(const row of joined)if(!familyIds.includes(row.family_id))familyIds.push(row.family_id);
    if(recovered)await reset(created.id);assert.equal((await query('SELECT 1 FROM sessions WHERE user_id=$1',[created.id])).length,0);
    release();const result=await pending;db.query=original;
    const duplicate=await post(path,body);assert.ok([409,404].includes(duplicate.status),JSON.stringify(duplicate));assert.equal(duplicate.cookie,'');
    if(!recovered){assert.equal(result.status,flow==='invitation'?200:201);assert.equal((await actor(result.cookie))?.id,created.id);return{normalizedCredentialsAccepted:true,duplicateCannotGrantNewSession:true};}
    const oldLogin=await post('auth/login',{username,password:oldPassword});assert.equal(oldLogin.status,401);assert.equal(oldLogin.cookie,'');
    assert.equal(result.status,401,'completed credential recovery must invalidate the old initial login');assert.equal(result.cookie,'');
    assert.equal((await query('SELECT 1 FROM sessions WHERE user_id=$1',[created.id])).length,0);
    const newLogin=await post('auth/login',{username,password:newPassword});assert.equal(newLogin.status,200);assert.equal((await actor(newLogin.cookie))?.id,created.id);
    return{recoveryCommittedBeforeGrant:true,oldInitialGrantRejected:true,existingUsernameRetryStatus:duplicate.status,newPasswordWorks:true};
   }finally{release();await pending;db.query=original;}
  });
 }
 for(const change of ['private','disabled','region','unchanged'] as const)await check(`public demo: ${change} before fresh grant check`,async()=>{
  const user=await fixtureUser(`demo_${change}`,true),b=await pool().connect();let pending:ReturnType<typeof post>|undefined;
  try{await b.query('BEGIN');await b.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user.id]);pending=post('auth/demo',{accountId:user.id});
   await wait("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND (query LIKE 'INSERT INTO sessions%' OR query LIKE 'SELECT id FROM users WHERE id=$1 FOR UPDATE%') AND wait_event_type='Lock'");
   if(change!=='unchanged')await b.query(`UPDATE users SET ${change==='private'?'demo=false':change==='disabled'?'disabled=true':"region='HK'"} WHERE id=$1`,[user.id]);
   await b.query('COMMIT');const result=await pending;
   if(change==='unchanged'){assert.equal(result.status,200);assert.equal((await actor(result.cookie))?.id,user.id);}
   else{assert.equal(result.status,403,'a demo grant must recheck eligibility after its user lock');assert.equal(result.body.code,'INVALID_DEMO_ACCOUNT');assert.equal(result.cookie,'');}
   return{status:result.status};
  }finally{await b.query('ROLLBACK');b.release();await pending;}
 });
 await check('public demo: password recovery does not make a public account private',async()=>{
  const user=await fixtureUser('demo_recovery',true);await reset(user.id);const result=await post('auth/demo',{accountId:user.id});assert.equal(result.status,200);assert.equal((await actor(result.cookie))?.id,user.id);
 });
 await check('password login: issued session is removed when recovery follows the login lock',async()=>{
  const user=await fixtureUser('login_wins'),b=await barrier(user.username);let login:ReturnType<typeof post>|undefined,recovery:Promise<string>|undefined;
  try{login=post('auth/login',{username:user.username,password:oldPassword});await wait("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'INSERT INTO sessions%' AND wait_event='advisory'");
   recovery=reset(user.id);await wait("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT id,name,role,disabled FROM users%' AND wait_event_type='Lock'");
   await b.query('COMMIT');const result=await login;assert.equal(result.status,200);await recovery;assert.equal(await actor(result.cookie),null);
  }finally{await b.query('ROLLBACK');b.release();await login;await recovery;await query('DELETE FROM nova_session_proof_gate WHERE username=$1',[user.username]);}
 });
 await check('password login: completed recovery wins before delayed user lock',async()=>{
  const user=await fixtureUser('password_race');const issued=await post(`users/${user.id}/recovery`,{},adminCookie),token=issued.body.url.split('token=')[1];
  const b=await pool().connect();let recovery:ReturnType<typeof post>|undefined,login:ReturnType<typeof post>|undefined;
  try{await b.query('BEGIN');await b.query('SELECT token_hash FROM recovery_tokens WHERE token_hash=$1 FOR UPDATE',[hashToken(token)]);
   recovery=post('recovery',{token,password:newPassword});await wait("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT r.user_id FROM recovery_tokens%' AND wait_event_type='Lock'");
   login=post('auth/login',{username:user.username,password:oldPassword});await wait("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT id FROM users WHERE id=$1 FOR UPDATE%' AND wait_event_type='Lock'");
   await b.query('COMMIT');assert.equal((await recovery).status,200);const result=await login;assert.equal(result.status,401);assert.equal(result.cookie,'');
   const current=await post('auth/login',{username:user.username,password:newPassword});assert.equal(current.status,200);assert.equal((await actor(current.cookie))?.id,user.id);return{stalePasswordRejected:true,newPasswordWorks:true};
  }finally{await b.query('ROLLBACK');b.release();await recovery;await login;}
 });
 await check('test login: stale credential rejected; current allowlisted credential succeeds',async()=>{
  const user=await fixtureUser('test_login'),b=await pool().connect();let pending:ReturnType<typeof post>|undefined;
  process.env.NOVA_AUTH_PROVIDER='clerk';process.env.NOVA_TEST_ACCOUNT_USERNAMES=user.username;
  try{await b.query('BEGIN');await b.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user.id]);pending=post('auth/test-login',{username:user.username,password:oldPassword});await wait("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT id FROM users WHERE id=$1 FOR UPDATE%' AND wait_event_type='Lock'");
   await b.query('UPDATE users SET password_hash=$1 WHERE id=$2',[await hashPassword(newPassword),user.id]);await b.query('COMMIT');const stale=await pending;assert.equal(stale.status,401);assert.equal(stale.cookie,'');
   const valid=await post('auth/test-login',{username:user.username,password:newPassword});assert.equal(valid.status,200);assert.match(valid.cookie,/nova_cn_test_session=/);assert.equal((await actor(valid.cookie))?.id,user.id);
   const noLocalRecovery=await post('recovery',{token:'a'.repeat(64),password:newPassword});assert.equal(noLocalRecovery.status,409);assert.equal(noLocalRecovery.body.code,'CLERK_RECOVERY_REQUIRED');
   return{staleCredentialRejected:true,currentCredentialWorks:true,localRecoveryDisabledForClerk:true};
  }finally{await b.query('ROLLBACK');b.release();await pending;process.env.NOVA_AUTH_PROVIDER='local';delete process.env.NOVA_TEST_ACCOUNT_USERNAMES;}
 });
}finally{
 await query('DROP TRIGGER IF EXISTS nova_session_proof_pause ON sessions');await query('DROP FUNCTION IF EXISTS nova_session_proof_pause()');await query('DROP TABLE IF EXISTS nova_session_proof_gate');
 await query('DELETE FROM audit_events WHERE actor_id=ANY($1::uuid[]) OR entity_id=ANY($2::text[])',[ids,familyIds]);await query('DELETE FROM families WHERE id=ANY($1::uuid[])',[familyIds]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[ids]);
 await query('DELETE FROM login_attempts WHERE key_hash=ANY($1::text[])',[names.map(n=>hashToken(`user:${n}`))]);
 await writeFile(`${output}/results.json`,JSON.stringify({syntheticOnly:true,actualPostHandlers:true,results},null,2));await closeDatabase();
}
assert.ok(results.every(result=>(result as {passed:boolean}).passed),'all diagnostic assertions pass');
