import pg from "pg";
import {randomBytes,randomUUID} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import {getConfig} from "../src/lib/config";
import {pool,query,closeDatabase} from "../src/lib/db";
import {createContent,currentContent,importScale,setScaleStatus} from "../src/lib/content";
import {createFamily,recordConsent} from "../src/lib/families";
import {createAssessment,retryReport,submitAssessment} from "../src/lib/assessments";
import {reportFor} from "../src/lib/reports";
import {processOneJob} from "../src/lib/worker";
import {closePdfBrowser} from "../src/lib/pdf";
import {readPrivatePdf} from "../src/lib/storage";
import {demoAdvice,demoScale,demoTemplate} from "../src/domain/demo";
import type {Actor} from "../src/domain/types";

const original=getConfig();assert.equal(original.mode,"demo");
const originalReportDir=process.env.NOVA_REPORT_DIR;
const control=new pg.Client({connectionString:original.databaseUrl});await control.connect();
const database=`nova_ci_${randomBytes(6).toString("hex")}`;let created=false;let reportDir="";
const results:{name:string;passed:boolean}[]=[];
async function check(name:string,fn:()=>Promise<void>){await fn();results.push({name,passed:true});console.log(`PASS ${name}`);}
const codeOf=(e:unknown)=>(e as {code?:string}).code;
try{
  await fs.mkdir("work/qa",{recursive:true});
  reportDir=await fs.mkdtemp(path.resolve("work/qa/retry-regressions-"));
  process.env.NOVA_REPORT_DIR=reportDir;
  await control.query(`CREATE DATABASE "${database}"`);created=true;
  const url=new URL(original.databaseUrl);url.pathname=`/${database}`;process.env.DATABASE_URL=url.toString();
  await pool().query(await fs.readFile(new URL("../src/lib/schema.sql",import.meta.url),"utf8"));
  await pool().query("INSERT INTO deployment_settings(singleton,region,mode) VALUES(true,$1,'demo')",[original.region]);
  const admin:Actor={id:randomUUID(),name:"isolated admin",role:"admin",region:original.region};
  const staff:Actor={id:randomUUID(),name:"isolated staff",role:"staff",region:original.region};
  const otherStaff:Actor={id:randomUUID(),name:"isolated other staff",role:"staff",region:original.region};
  const parent:Actor={id:randomUUID(),name:"isolated parent",role:"parent",region:original.region};
  const otherParent:Actor={id:randomUUID(),name:"isolated other parent",role:"parent",region:original.region};
  const student:Actor={id:randomUUID(),name:"isolated student",role:"student",region:original.region};
  const teacher:Actor={id:randomUUID(),name:"isolated teacher",role:"teacher",region:original.region};
  const foreign:Actor={...admin,region:original.region==="CN"?"HK":"CN"};
  for(const user of [admin,staff,otherStaff,parent,otherParent,student,teacher])await query("INSERT INTO users(id,region,username,name,role,demo) VALUES($1,$2,$3,$4,$5,true)",[user.id,user.region,user.id,user.name,user.role]);
  await createContent(admin,"advice",{version:"1.0.0",content:demoAdvice});
  await createContent(admin,"template",{version:"1.0.0",content:demoTemplate});
  const scale=await importScale(admin,{definition:demoScale});
  const family=await createFamily(admin,{familyName:"isolated retry",childName:"合成孩子",birthDate:"2013-01-01",grade:"七年级",guardianLabel:"母亲",assignedTo:staff.id});
  await query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,'student'),($1,$3,'parent'),($1,$4,'teacher')",[family.id,student.id,parent.id,teacher.id]);
  await recordConsent(admin,family.id,{accepted:true,guardianName:"合成监护人",reference:"ISOLATED_RETRY",aiProcessing:false});
  const assessment=await createAssessment(admin,{familyId:family.id,respondentId:student.id,scaleVersionId:scale.id,locale:"zh-CN"});
  const answers={q1:1,q2:2,q3:1,q4:2,q5:1,q6:2,q7:1,q8:2,q9:0};
  assert.equal((await submitAssessment(student,assessment.id,{answers,acknowledged:true,revision:0})).status,"queued");
  const frozen=(await query("SELECT answers,snapshot,submitted_at FROM assessments WHERE id=$1",[assessment.id]))[0];
  assert.equal(frozen.snapshot.advice.version,"1.0.0");
  await query("UPDATE report_jobs SET state='failed',attempts=3,lease_until=NULL,claim_token=NULL,last_error_code='REPORT_GENERATION_FAILED' WHERE assessment_id=$1",[assessment.id]);
  await query("UPDATE assessments SET status='failed' WHERE id=$1",[assessment.id]);
  await check("failed submissions still count toward retake interval",async()=>{
    await assert.rejects(()=>createAssessment(admin,{familyId:family.id,respondentId:student.id,scaleVersionId:scale.id,locale:"zh-CN"}),e=>codeOf(e)==="RETAKE_INTERVAL");
  });
  await setScaleStatus(admin,scale.id,{status:"retired"});
  await createContent(admin,"advice",{version:"2.0.0",content:{...demoAdvice,blocks:demoAdvice.blocks.filter(b=>b.id!=="listen")}});
  await check("role, region, other-staff and live consent denials do not mutate a failed report",async()=>{
    const beforeJob=(await query("SELECT state,attempts FROM report_jobs WHERE assessment_id=$1",[assessment.id]))[0];
    await assert.rejects(()=>retryReport(student,assessment.id),e=>codeOf(e)==="ROLE_DENIED");
    await assert.rejects(()=>retryReport(parent,assessment.id),e=>codeOf(e)==="ROLE_DENIED");
    await assert.rejects(()=>retryReport(teacher,assessment.id),e=>codeOf(e)==="ROLE_DENIED");
    await assert.rejects(()=>retryReport(foreign,assessment.id),e=>codeOf(e)==="NOT_FOUND");
    await assert.rejects(()=>retryReport(otherStaff,assessment.id),e=>codeOf(e)==="NOT_FOUND");
    await query("UPDATE consents SET revoked_at=now() WHERE family_id=$1 AND revoked_at IS NULL",[family.id]);
    await assert.rejects(()=>retryReport(staff,assessment.id),e=>codeOf(e)==="GUARDIAN_CONSENT_REQUIRED");
    await recordConsent(admin,family.id,{accepted:true,guardianName:"合成监护人",reference:"ISOLATED_RETRY_REGRANT",aiProcessing:false});
    assert.equal((await query("SELECT status FROM assessments WHERE id=$1",[assessment.id]))[0].status,"failed");
    assert.deepEqual((await query("SELECT state,attempts FROM report_jobs WHERE assessment_id=$1",[assessment.id]))[0],beforeJob);
    assert.deepEqual((await query("SELECT answers,snapshot,submitted_at FROM assessments WHERE id=$1",[assessment.id]))[0],frozen);
  });
  await check("retry does not reset a running report job",async()=>{
    const token=randomUUID();
    await query("UPDATE assessments SET status='queued' WHERE id=$1",[assessment.id]);
    await query("UPDATE report_jobs SET state='running',attempts=2,lease_until=now()+interval '5 minutes',claim_token=$1 WHERE assessment_id=$2",[token,assessment.id]);
    await assert.rejects(()=>retryReport(admin,assessment.id),e=>codeOf(e)==="REPORT_NOT_FAILED");
    const job=(await query("SELECT state,attempts,claim_token FROM report_jobs WHERE assessment_id=$1",[assessment.id]))[0];
    assert.equal(job.state,"running");assert.equal(job.attempts,2);assert.equal(job.claim_token,token);
    await query("UPDATE report_jobs SET state='failed',lease_until=NULL,claim_token=NULL WHERE assessment_id=$1",[assessment.id]);
    await query("UPDATE assessments SET status='failed' WHERE id=$1",[assessment.id]);
  });
  await check("concurrent retry requeues one job from the frozen snapshot after advice removal",async()=>{
    const [first,second]=await Promise.all([retryReport(admin,assessment.id),retryReport(staff,assessment.id)]);
    assert.equal(first.status,"queued");assert.equal(second.status,"queued");
    assert.equal((await retryReport(admin,assessment.id)).status,"queued");
    assert.equal((await query("SELECT count(*)::int AS total FROM report_jobs WHERE assessment_id=$1",[assessment.id]))[0].total,1);
    assert.equal((await query("SELECT state FROM report_jobs WHERE assessment_id=$1",[assessment.id]))[0].state,"ready");
    assert.equal((await query("SELECT status FROM assessments WHERE id=$1",[assessment.id]))[0].status,"queued");
    const after=(await query("SELECT answers,snapshot,submitted_at FROM assessments WHERE id=$1",[assessment.id]))[0];
    assert.deepEqual(after,frozen);
    assert.equal(after.snapshot.advice.version,"1.0.0");
    assert.ok(after.snapshot.advice.content.blocks.some((b:{id:string})=>b.id==="listen"));
    assert.equal((await currentContent("advice")).version,"2.0.0");
    await assert.rejects(()=>createAssessment(admin,{familyId:family.id,respondentId:student.id,scaleVersionId:scale.id,locale:"zh-CN"}),e=>codeOf(e)==="SCALE_RETIRED");
  });
  await check("worker publishes bilingual HTML and PDF from the frozen snapshot",async()=>{
    assert.equal(await processOneJob(),true);
    assert.equal((await query("SELECT status FROM assessments WHERE id=$1",[assessment.id]))[0].status,"published");
    const report=await reportFor(admin,assessment.id);
    assert.equal(report.payload.advice.version,"1.0.0");
    assert.ok(report.payload.selectedAdviceIds.includes("listen"));
    assert.ok(report.html_documents["zh-CN"].includes("演示报告"));
    assert.ok(report.html_documents["zh-HK"].includes("示範報告"));
    assert.ok(report.html_documents["zh-CN"].includes("留一段不急着给答案的时间"));
    assert.ok(report.html_documents["zh-HK"].includes("留一段不急着給答案的時間"));
    assert.ok(report.html_documents["zh-CN"].includes("建议库")&&report.html_documents["zh-CN"].includes("1.0.0"));
    assert.ok(!report.html_documents["zh-CN"].includes('"q1"'));
    for(const locale of ["zh-CN","zh-HK"] as const){
      const pdf=await readPrivatePdf(report.pdf_keys[locale]);assert.equal(pdf.subarray(0,4).toString(),"%PDF");
    }
  });
  await check("reportFor denies unprotected roles and outsiders",async()=>{
    await assert.rejects(()=>reportFor(student,assessment.id),e=>codeOf(e)==="ROLE_DENIED");
    await assert.rejects(()=>reportFor(teacher,assessment.id),e=>codeOf(e)==="ROLE_DENIED");
    await assert.rejects(()=>reportFor(otherStaff,assessment.id),e=>codeOf(e)==="NOT_FOUND");
    await assert.rejects(()=>reportFor(otherParent,assessment.id),e=>codeOf(e)==="NOT_FOUND");
    const visible=await reportFor(parent,assessment.id);assert.equal(visible.id,assessment.id);
  });
  await check("published snapshot and report queue cannot be rewritten by retry",async()=>{
    await assert.rejects(()=>retryReport(admin,assessment.id),e=>codeOf(e)==="REPORT_NOT_FAILED");
    await assert.rejects(()=>query("UPDATE assessments SET answers=answers||'{\"q1\":999}'::jsonb WHERE id=$1",[assessment.id]),/immutable/i);
    await assert.rejects(()=>query("UPDATE reports SET payload=payload WHERE id=$1",[assessment.id]),/immutable/i);
    await assert.rejects(()=>query("INSERT INTO report_jobs(id,assessment_id) VALUES($1,$2)",[randomUUID(),assessment.id]),e=>codeOf(e)==="23505");
    assert.equal((await query("SELECT count(*)::int AS total FROM report_jobs WHERE assessment_id=$1",[assessment.id]))[0].total,1);
    assert.equal((await query("SELECT state FROM report_jobs WHERE assessment_id=$1",[assessment.id]))[0].state,"done");
    assert.equal((await query("SELECT count(*)::int AS total FROM reports WHERE assessment_id=$1",[assessment.id]))[0].total,1);
    assert.deepEqual((await query("SELECT answers,snapshot,submitted_at FROM assessments WHERE id=$1",[assessment.id]))[0],frozen);
  });
}finally{
  await closePdfBrowser().catch(()=>{});
  await closeDatabase();
  process.env.DATABASE_URL=original.databaseUrl;
  if(originalReportDir===undefined)delete process.env.NOVA_REPORT_DIR;else process.env.NOVA_REPORT_DIR=originalReportDir;
  if(created)await control.query(`DROP DATABASE "${database}"`);
  await control.end();
  if(reportDir)await fs.rm(reportDir,{recursive:true,force:true});
  await fs.mkdir("work/qa",{recursive:true});
  await fs.writeFile("work/qa/retry-regressions.json",JSON.stringify({timestamp:new Date().toISOString(),isolatedDatabase:true,syntheticDataOnly:true,results},null,2));
}
console.log(`Retry report acceptance passed: ${results.length} checks.`);
