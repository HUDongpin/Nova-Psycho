/** Local service-mode source-provenance check; no HTTP service or AI calls. */
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { getConfig } from "../src/lib/config";
import { effectiveDatabaseHost } from "../scripts/test-database-guard";
import { query, closeDatabase } from "../src/lib/db";
import { createParentFamily, joinFamily } from "../src/lib/triad";
import { startStaffObservation } from "../src/lib/staff-observation";
import { submitAssessment } from "../src/lib/assessments";
import { processReportJob } from "../src/lib/worker";
import { closePdfBrowser } from "../src/lib/pdf";
import { stagedParentScale, stagedChildScale, topeStaffScale } from "../src/domain/triad-scales";
import { previewAnswers } from "../src/domain/triad-report";
import type { Actor, ScaleDefinition } from "../src/domain/types";
const config=getConfig(),url=new URL(config.databaseUrl);
assert.equal(config.mode,"service");assert.equal(config.ai.enabled,false);assert.equal(config.triadAiEnabled,false);
assert.equal(effectiveDatabaseHost(config.databaseUrl),"127.0.0.1");assert.equal(url.search,"");assert.equal(url.pathname,"/nova_parent_first_service_20261023");
assert.equal(config.publicUrl,"https://synthetic.example.invalid");
const prefix=`pf_${randomBytes(6).toString("hex")}`;
process.env.NOVA_TEST_ACCOUNT_USERNAMES=["parent","student","teacher","staff"].map(role=>`${prefix}.${role}`).join(",");
async function account(role:Actor["role"]):Promise<Actor>{
  const id=randomUUID();await query("INSERT INTO users(id,region,username,name,role,password_hash,demo) VALUES($1,$2,$3,'Synthetic service source',$4,'synthetic-unused-password-hash',false)",[id,config.region,`${prefix}.${role}`,role]);
  return {id,name:"Synthetic service source",role,region:config.region,sessionMethod:"test"};
}
let passed=false;
try{
  const parent=await account("parent"),student=await account("student"),teacher=await account("teacher"),staff=await account("staff");
  const f=await createParentFamily(parent,{requestId:randomUUID(),relationship:"母亲",childName:"Synthetic service child",birthDate:"2014-06-01",grade:"初中",assessment:true,sensitiveData:true,parentReport:true},"zh-CN");
  process.env.NOVA_SYNTHETIC_TEST_FAMILY_IDS=f.familyId;
  await query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,'student'),($1,$3,'teacher')",[f.familyId,student.id,teacher.id]);
  await query("UPDATE families SET assigned_to=$1 WHERE id=$2",[staff.id,f.familyId]);
  const parentTask=(await query("SELECT id FROM assessments WHERE family_id=$1 AND respondent_role='parent'",[f.familyId]))[0].id;
  async function submit(who:Actor,id:string,scale:ScaleDefinition){
    const answers=previewAnswers(scale,"calm");
    if(scale===stagedChildScale){answers.c_share_support=[0];delete answers.c_share_confirm;}
    if(scale===topeStaffScale)answers.o_visit_date="2026-10-23";
    const result=await submitAssessment(who,id,{answers,revision:0,acknowledged:true});assert.equal(result.status,"submitted");
  }
  async function publish(version:number){
    const job=(await query("SELECT j.id FROM report_jobs j JOIN assessments a ON a.id=j.assessment_id WHERE a.family_id=$1 AND j.report_version=$2",[f.familyId,version]))[0];
    assert.deepEqual(await processReportJob(job.id),{status:"published"});
    const report=(await query("SELECT payload FROM reports WHERE id=$1",[job.id]))[0].payload;
    assert.equal(report.syntheticTest,true);assert.equal(report.generationMode,"template");assert.equal(report.aiModel,null);assert.equal(report.revision.version,version);
  }
  await submit(parent,parentTask,stagedParentScale);await publish(1);
  await assert.rejects(startStaffObservation({...staff,sessionMethod:undefined},f.familyId,"zh-CN"),{code:"SYNTHETIC_TEST_SCOPE_REQUIRED"});
  const staffTask=await startStaffObservation(staff,f.familyId,"zh-CN");await submit(staff,staffTask.id,topeStaffScale);await publish(2);
  const studentTask=await joinFamily(student,{code:f.joinCode},"zh-CN");await submit(student,studentTask.assessmentId,stagedChildScale);await publish(3);
  assert.equal((await query("SELECT id FROM reports WHERE family_id=$1",[f.familyId])).length,3);
  passed=true;console.log("PASS local service-mode synthetic parent + assigned test staff + student, with ordinary staff session denied");
}finally{
  await closePdfBrowser();await closeDatabase();
  await fs.writeFile("work/parent-first-20261023/synthetic-service-results.json",JSON.stringify({passed,localDatabaseOnly:true,serviceMode:true,syntheticOnly:true,aiEnabled:false,liveServiceCalled:false},null,2),{mode:0o600});
}
