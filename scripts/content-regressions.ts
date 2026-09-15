import pg from "pg";
import {randomBytes,randomUUID} from "node:crypto";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import {getConfig} from "../src/lib/config";
import {pool,query,closeDatabase} from "../src/lib/db";
import {createContent,currentContent,importScale,setScaleStatus} from "../src/lib/content";
import {createFamily,recordConsent} from "../src/lib/families";
import {createAssessment,submitAssessment} from "../src/lib/assessments";
import {demoAdvice,demoScale,demoTemplate} from "../src/domain/demo";
import type {Actor} from "../src/domain/types";

const original=getConfig();assert.equal(original.mode,"demo");
const control=new pg.Client({connectionString:original.databaseUrl});await control.connect();
const database=`nova_ci_${randomBytes(6).toString("hex")}`;let created=false;
const results:{name:string;passed:boolean}[]=[];
async function check(name:string,fn:()=>Promise<void>){await fn();results.push({name,passed:true});console.log(`PASS ${name}`);}
try{
  await control.query(`CREATE DATABASE "${database}"`);created=true;
  const url=new URL(original.databaseUrl);url.pathname=`/${database}`;process.env.DATABASE_URL=url.toString();
  await pool().query(await fs.readFile(new URL("../src/lib/schema.sql",import.meta.url),"utf8"));
  await pool().query("INSERT INTO deployment_settings(singleton,region,mode) VALUES(true,$1,'demo')",[original.region]);
  const admin:Actor={id:randomUUID(),name:"isolated admin",role:"admin",region:original.region};
  const student:Actor={id:randomUUID(),name:"isolated student",role:"student",region:original.region};
  for(const user of [admin,student])await query("INSERT INTO users(id,region,username,name,role,demo) VALUES($1,$2,$3,$4,$5,true)",[user.id,user.region,user.role,user.name,user.role]);
  await check("empty advice and template stores accept first immutable versions",async()=>{
    await assert.rejects(()=>currentContent("advice"),(e:unknown)=>(e as {code?:string}).code==="CONTENT_NOT_CONFIGURED");
    await createContent(admin,"advice",{version:"1.0.0",content:demoAdvice});
    await createContent(admin,"template",{version:"1.0.0",content:demoTemplate});
    assert.equal((await currentContent("advice")).version,"1.0.0");assert.equal((await currentContent("template")).version,"1.0.0");
  });
  const scale=await importScale(admin,{definition:demoScale});const family=await createFamily(admin,{familyName:"isolated",childName:"合成孩子",birthDate:"2013-01-01",grade:"七年级",guardianLabel:"母亲"});
  await query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,'student')",[family.id,student.id]);
  await recordConsent(admin,family.id,{accepted:true,guardianName:"合成监护人",reference:"ISOLATED_TEST",aiProcessing:false});
  const assessment=await createAssessment(admin,{familyId:family.id,respondentId:student.id,scaleVersionId:scale.id,locale:"zh-CN"});
  const removed={...demoAdvice,blocks:demoAdvice.blocks.filter(b=>b.id!=="listen")};
  await check("retired scales keep advice needed by already-assigned pending assessments",async()=>{
    await setScaleStatus(admin,scale.id,{status:"retired"});
    await assert.rejects(()=>createContent(admin,"advice",{version:"2.0.0",content:removed}),(e:unknown)=>(e as {code?:string}).code==="ADVICE_MISMATCH");
    const result=await submitAssessment(student,assessment.id,{answers:{q1:1,q2:2,q3:1,q4:2,q5:1,q6:2,q7:1,q8:2,q9:0},acknowledged:true,revision:0});assert.equal(result.status,"queued");
  });
  await check("accepted submissions replay after later advice removal without creating duplicate jobs",async()=>{
    await createContent(admin,"advice",{version:"2.0.0",content:removed});
    const before=(await query("SELECT snapshot FROM assessments WHERE id=$1",[assessment.id]))[0].snapshot;
    const replay=await submitAssessment(student,assessment.id,{answers:{q1:0},acknowledged:true,revision:0});
    assert.equal(replay.status,"queued");assert.equal(replay.id,assessment.id);
    assert.equal((await query("SELECT count(*)::int AS total FROM report_jobs WHERE assessment_id=$1",[assessment.id]))[0].total,1);
    assert.deepEqual((await query("SELECT snapshot FROM assessments WHERE id=$1",[assessment.id]))[0].snapshot,before);
  });
  await check("reactivation rejects incompatible advice and accepts restored references",async()=>{
    await assert.rejects(()=>setScaleStatus(admin,scale.id,{status:"active"}),(e:unknown)=>(e as {code?:string}).code==="ADVICE_MISMATCH");
    await createContent(admin,"advice",{version:"3.0.0",content:demoAdvice});await setScaleStatus(admin,scale.id,{status:"active"});
    const frozen=(await query("SELECT snapshot FROM assessments WHERE id=$1",[assessment.id]))[0].snapshot;assert.equal(frozen.advice.version,"1.0.0");assert.ok(frozen.advice.content.blocks.some((b:{id:string})=>b.id==="listen"));
  });
}finally{
  await closeDatabase();process.env.DATABASE_URL=original.databaseUrl;
  if(created)await control.query(`DROP DATABASE "${database}"`);
  await control.end();await fs.mkdir("work/qa",{recursive:true});await fs.writeFile("work/qa/content-regressions.json",JSON.stringify({timestamp:new Date().toISOString(),isolatedDatabase:true,syntheticDataOnly:true,results},null,2));
}
console.log(`Content lifecycle acceptance passed: ${results.length} checks.`);
