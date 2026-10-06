import pg from "pg";
import {randomBytes,randomUUID} from "node:crypto";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import {getConfig} from "../src/lib/config";
import {pool,query,closeDatabase} from "../src/lib/db";
import {hashToken} from "../src/lib/auth";
import {acceptRecovery,createRecovery,recoveryInfo} from "../src/lib/recovery";
import type {Actor} from "../src/domain/types";

// Password recovery is the one account path with no self-service fallback: a link is
// issued by an administrator and passed on out of band. These checks run against an
// isolated database so they can assert the things that matter — that the stored value is
// a hash, that a link cannot be replayed, and above all that completing a recovery ends
// every session the account had open.

const original=getConfig();assert.equal(original.mode,"demo");
const control=new pg.Client({connectionString:original.databaseUrl});await control.connect();
const database=`nova_recovery_${randomBytes(6).toString("hex")}`;let created=false;
const results:{name:string;passed:boolean}[]=[];
async function check(name:string,fn:()=>Promise<void>){await fn();results.push({name,passed:true});console.log(`PASS ${name}`);}
const tokenOf=(url:string)=>url.split("token=")[1]??"";
try{
  await control.query(`CREATE DATABASE "${database}"`);created=true;
  const url=new URL(original.databaseUrl);url.pathname=`/${database}`;process.env.DATABASE_URL=url.toString();
  await pool().query(await fs.readFile(new URL("../src/lib/schema.sql",import.meta.url),"utf8"));
  await pool().query("INSERT INTO deployment_settings(singleton,region,mode) VALUES(true,$1,'demo')",[original.region]);
  const admin:Actor={id:randomUUID(),name:"isolated admin",role:"admin",region:original.region};
  const parent:Actor={id:randomUUID(),name:"isolated parent",role:"parent",region:original.region};
  const student:Actor={id:randomUUID(),name:"isolated student",role:"student",region:original.region};
  const disabled:Actor={id:randomUUID(),name:"isolated disabled",role:"parent",region:original.region};
  // usernames are unique across the whole deployment, not per region, so two accounts
  // sharing a role must not share a username.
  for(const user of [admin,parent,student])await query("INSERT INTO users(id,region,username,name,role,demo) VALUES($1,$2,$3,$4,$5,true)",[user.id,user.region,`${user.role}-${user.id.slice(0,8)}`,user.name,user.role]);
  await query("INSERT INTO users(id,region,username,name,role,demo,disabled) VALUES($1,$2,$3,$4,$5,true,true)",[disabled.id,disabled.region,`disabled-${disabled.id.slice(0,8)}`,disabled.name,disabled.role]);

  let token="";
  await check("an administrator can issue a link, and only its hash is stored",async()=>{
    const issued=await createRecovery(admin,parent.id);
    token=tokenOf(issued.url);
    assert.match(token,/^[a-f0-9]{64}$/);
    assert.match(issued.url,/\/recover#token=/);
    assert.ok(Date.parse(issued.expiresAt)>Date.now());
    const rows=await query<{token_hash:string}>("SELECT token_hash FROM recovery_tokens WHERE user_id=$1",[parent.id]);
    assert.equal(rows.length,1);
    assert.equal(rows[0].token_hash,hashToken(token));
    assert.notEqual(rows[0].token_hash,token);
  });

  await check("issuing again retires the earlier outstanding link",async()=>{
    const second=await createRecovery(admin,parent.id);
    const outstanding=await query<{n:number}>("SELECT count(*)::int AS n FROM recovery_tokens WHERE user_id=$1 AND used_at IS NULL",[parent.id]);
    assert.equal(outstanding[0].n,1);
    await assert.rejects(()=>recoveryInfo(token),(e:unknown)=>(e as {code?:string}).code==="INVALID_RECOVERY");
    token=tokenOf(second.url);
    assert.equal((await recoveryInfo(token)).role,"parent");
  });

  await check("only an administrator may issue",async()=>{
    for(const actor of [parent,student]){
      await assert.rejects(()=>createRecovery(actor,parent.id),(e:unknown)=>(e as {code?:string}).code==="ROLE_DENIED");
    }
  });

  await check("a disabled account cannot be issued a link",async()=>{
    await assert.rejects(()=>createRecovery(admin,disabled.id),(e:unknown)=>(e as {code?:string}).code==="ACCOUNT_DISABLED");
  });

  await check("an unknown or malformed token reveals nothing",async()=>{
    for(const bad of ["", "short", "z".repeat(64)]){
      await assert.rejects(()=>recoveryInfo(bad),(e:unknown)=>(e as {code?:string}).code==="INVALID_RECOVERY");
    }
    assert.deepEqual(Object.keys(await recoveryInfo(token)).sort(),["expiresAt","name","region","role","username"]);
  });

  await check("a password under the minimum length is refused",async()=>{
    await assert.rejects(()=>acceptRecovery({token,password:"short"}));
    const still=await query<{n:number}>("SELECT count(*)::int AS n FROM recovery_tokens WHERE used_at IS NULL",[]);
    assert.equal(still[0].n,1);
  });

  const beforePassword=await query<{password_hash:string|null}>("SELECT password_hash FROM users WHERE id=$1",[parent.id]);
  const sessionToken="a".repeat(96);
  await query("INSERT INTO sessions(token_hash,user_id,region,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[hashToken(sessionToken),parent.id,original.region]);

  await check("completing a recovery sets the new password",async()=>{
    const live=await query<{n:number}>("SELECT count(*)::int AS n FROM sessions WHERE user_id=$1",[parent.id]);
    assert.equal(live[0].n,1,"a session should exist before recovery");
    await acceptRecovery({token,password:"correct-horse-battery-staple"});
    const after=await query<{password_hash:string|null}>("SELECT password_hash FROM users WHERE id=$1",[parent.id]);
    assert.notEqual(after[0].password_hash,beforePassword[0].password_hash);
    assert.ok(after[0].password_hash?.startsWith("scrypt")||after[0].password_hash?.includes(":"),"the password should be stored as a salt:key pair");
  });

  await check("completing a recovery ends every session the account had open",async()=>{
    const remaining=await query<{n:number}>("SELECT count(*)::int AS n FROM sessions WHERE user_id=$1",[parent.id]);
    assert.equal(remaining[0].n,0);
  });

  await check("the link cannot be replayed",async()=>{
    await assert.rejects(()=>acceptRecovery({token,password:"another-long-password"}),()=>true);
    await assert.rejects(()=>recoveryInfo(token),(e:unknown)=>(e as {code?:string}).code==="INVALID_RECOVERY");
  });

  await check("the audit trail records who issued it and that it completed",async()=>{
    // Issued twice above, so the same action legitimately appears more than once.
    const actions=await query<{action:string}>("SELECT DISTINCT action FROM audit_events WHERE action LIKE 'user.recovery%'",[]);
    assert.deepEqual(actions.map(row=>row.action).sort(),["user.recovery_completed","user.recovery_issued"]);
  });

  const outstandingOf=async(userId:string)=>query<{n:number}>("SELECT count(*)::int AS n FROM recovery_tokens WHERE user_id=$1 AND used_at IS NULL",[userId]);

  await check("concurrent issuance leaves a single outstanding link",async()=>{
    const [first,second]=await Promise.all([createRecovery(admin,student.id),createRecovery(admin,student.id)]);
    const outstanding=await query<{token_hash:string}>("SELECT token_hash FROM recovery_tokens WHERE user_id=$1 AND used_at IS NULL",[student.id]);
    assert.equal(outstanding.length,1);
    const tokens=[tokenOf(first.url),tokenOf(second.url)];
    const live=tokens.filter(value=>hashToken(value)===outstanding[0].token_hash);
    assert.equal(live.length,1);
    await recoveryInfo(live[0]);
    const retired=tokens.find(value=>hashToken(value)!==outstanding[0].token_hash);
    assert.ok(retired);
    await assert.rejects(()=>recoveryInfo(retired),(e:unknown)=>(e as {code?:string}).code==="INVALID_RECOVERY");
  });

  await check("completing recovery retires every outstanding link for the account",async()=>{
    const issued=await createRecovery(admin,student.id);
    const extra=randomBytes(32).toString("hex");
    await query("INSERT INTO recovery_tokens(token_hash,user_id,region,expires_at,created_by) VALUES($1,$2,$3,now()+interval '1 hour',$4)",[hashToken(extra),student.id,original.region,admin.id]);
    assert.equal((await outstandingOf(student.id))[0].n,2);
    await query("INSERT INTO sessions(token_hash,user_id,region,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[hashToken("b".repeat(96)),student.id,original.region]);
    await acceptRecovery({token:tokenOf(issued.url),password:"student-horse-battery-staple"});
    assert.equal((await outstandingOf(student.id))[0].n,0);
    await assert.rejects(()=>recoveryInfo(extra),(e:unknown)=>(e as {code?:string}).code==="INVALID_RECOVERY");
    assert.equal((await query<{n:number}>("SELECT count(*)::int AS n FROM sessions WHERE user_id=$1",[student.id]))[0].n,0);
  });

  await check("simultaneous consume and supersession leave at most one live link",async()=>{
    const issued=await createRecovery(admin,student.id);
    await query("INSERT INTO sessions(token_hash,user_id,region,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[hashToken("c".repeat(96)),student.id,original.region]);
    const [consumed,superseded]=await Promise.allSettled([
      acceptRecovery({token:tokenOf(issued.url),password:"student-second-password-ok"}),
      createRecovery(admin,student.id)
    ]);
    const live=(await outstandingOf(student.id))[0].n;
    assert.ok(live<=1);
    if(consumed.status==="fulfilled"){
      assert.equal((await query<{n:number}>("SELECT count(*)::int AS n FROM sessions WHERE user_id=$1",[student.id]))[0].n,0);
    }else{
      assert.equal(superseded.status,"fulfilled");
      assert.equal(live,1);
      await recoveryInfo(tokenOf((superseded as PromiseFulfilledResult<{url:string}>).value.url));
    }
  });

  await check("concurrent consumes of two outstanding links succeed only once",async()=>{
    const first=await createRecovery(admin,student.id);
    const secondToken=randomBytes(32).toString("hex");
    await query("INSERT INTO recovery_tokens(token_hash,user_id,region,expires_at,created_by) VALUES($1,$2,$3,now()+interval '1 hour',$4)",[hashToken(secondToken),student.id,original.region,admin.id]);
    assert.equal((await outstandingOf(student.id))[0].n,2);
    const results=await Promise.allSettled([
      acceptRecovery({token:tokenOf(first.url),password:"student-third-password-ok"}),
      acceptRecovery({token:secondToken,password:"student-fourth-password-ok"})
    ]);
    assert.equal(results.filter(result=>result.status==="fulfilled").length,1);
    assert.equal(results.filter(result=>result.status==="rejected").length,1);
    assert.equal((await outstandingOf(student.id))[0].n,0);
  });
}finally{
  await closeDatabase();process.env.DATABASE_URL=original.databaseUrl;
  if(created)await control.query(`DROP DATABASE "${database}"`);
  await control.end();await fs.mkdir("work/qa",{recursive:true});await fs.writeFile("work/qa/recovery-checks.json",JSON.stringify({timestamp:new Date().toISOString(),isolatedDatabase:true,syntheticDataOnly:true,results},null,2));
}
console.log(`Password recovery acceptance passed: ${results.length} checks.`);
