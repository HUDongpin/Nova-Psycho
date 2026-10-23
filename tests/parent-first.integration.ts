/** Local synthetic database + real PDF verification. Never runs on a service database. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getConfig } from "../src/lib/config";
import { query, closeDatabase } from "../src/lib/db";
import { createParentFamily, joinFamily, queueTriadReport } from "../src/lib/triad";
import { assessmentDetail, saveDraft, submitAssessment } from "../src/lib/assessments";
import { startStaffObservation } from "../src/lib/staff-observation";
import { assignFamily, recordConsent, deleteFamily } from "../src/lib/families";
import { processReportJob, cleanOrphanReports, processDeletionJobs } from "../src/lib/worker";
import { retryStagedReport } from "../src/lib/staged-reports";
import { reportFor } from "../src/lib/reports";
import { readPrivatePdf } from "../src/lib/storage";
import { closePdfBrowser } from "../src/lib/pdf";
import { workspaceFor } from "../src/lib/workspace";
import { previewAnswers } from "../src/domain/triad-report";
import { stagedParentScale, stagedChildScale, topeStaffScale, parentScaleSupportIntake } from "../src/domain/triad-scales";
import type { Actor, ScaleDefinition, StoredAnswer } from "../src/domain/types";
import { transaction } from "../src/lib/db";
import { assertThrowawayDatabase } from "../scripts/test-database-guard";

const config=getConfig(), url=new URL(config.databaseUrl);
assert.equal(config.mode,"demo");assert.equal(config.ai.enabled,false);assert.equal(config.triadAiEnabled,false);
assert.ok(["localhost","127.0.0.1"].includes(url.hostname));assert.match(url.pathname,/^\/nova_parent_first_(cn|hk)_[a-z0-9_]+$/);
await assertThrowawayDatabase();
const locale=config.region==="HK"?"zh-HK":"zh-CN";
const output=path.resolve("work/parent-first-20261023",`integration-${config.region.toLowerCase()}${config.reportStorage==="filesystem"?"-filesystem":""}`);
await fs.mkdir(output,{recursive:true});
const results:{name:string;passed:boolean;durationMs:number}[]=[];
async function check(name:string,run:()=>Promise<void>){const started=Date.now();await run();results.push({name,passed:true,durationMs:Date.now()-started});console.log(`PASS ${config.region} ${name}`);}
async function actor(role:Actor["role"]):Promise<Actor>{
  const id=randomUUID(), name=`Synthetic staged ${role}`;
  await query("INSERT INTO users(id,region,username,name,role,demo) VALUES($1,$2,$3,$4,$5,false)",[id,config.region,`staged_${id}`,name,role]);
  return {id,name,role,region:config.region};
}
const admin=await actor("admin"),staff=await actor("staff"),otherStaff=await actor("staff");
async function family(consent=true){
  const parent=await actor("parent");
  const created=await createParentFamily(parent,{requestId:randomUUID(),relationship:"母亲",childName:"Synthetic staged child",birthDate:"2014-06-01",grade:"初中",assessment:true,sensitiveData:true,parentReport:consent},locale);
  await assignFamily(admin,created.familyId,{assignedTo:staff.id});
  const task=(await query("SELECT id,triad_round_id FROM assessments WHERE family_id=$1 AND respondent_role='parent'",[created.familyId]))[0];
  return {...created,parent,parentId:String(task.id),roundId:String(task.triad_round_id)};
}
function answers(scale:ScaleDefinition,share=true):Record<string,StoredAnswer>{
  const data=previewAnswers(scale);
  if(scale.roles[0]==="parent"){data.q22=[7];delete data.q23;}
  if(scale.roles[0]==="student"){
    data.c14=[6];delete data.c15;delete data.c16;data.c22="PRIVATE_SYNTHETIC_STUDENT_TEXT";
    data.c_share_support=share?[1,3]:[0];if(share)data.c_share_confirm=1;else delete data.c_share_confirm;
  }
  if(scale.id===topeStaffScale.id){data.o_visit_date="2026-10-23";data.o_safety=[3];data.o_private_notes="PRIVATE_SYNTHETIC_STAFF_TEXT";}
  return data;
}
async function submit(who:Actor,id:string,scale:ScaleDefinition,share=true){
  const task=await assessmentDetail(who,id,locale);
  return submitAssessment(who,id,{answers:answers(scale,share),revision:task.draftRevision,acknowledged:true});
}
async function jobs(familyId:string){return query("SELECT j.* FROM report_jobs j JOIN assessments a ON a.id=j.assessment_id WHERE a.family_id=$1 ORDER BY j.report_version",[familyId]);}
const persistedPdfs=new Set<string>();
async function publish(jobId:string){
  assert.deepEqual(await processReportJob(jobId),{status:"published"});
  const rows=await query("SELECT pdf_keys FROM reports WHERE job_id=$1",[jobId]);
  for(const key of Object.values(rows[0].pdf_keys) as string[])persistedPdfs.add(key);
}
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
let passed=false;
try{
  for(const order of [["student","teacher"],["teacher","student"]] as const){
    const f=await family();let firstHash="",firstId="";
    await check(`parent alone automatically queues a private report (${order.join(" then ")})`,async()=>{
      const result=await submit(f.parent,f.parentId,stagedParentScale);
      assert.equal(result.status,"submitted");
      const list=await jobs(f.familyId);assert.equal(list.length,1);assert.deepEqual(list[0].source_assessment_ids,[f.parentId]);
      await publish(list[0].id);firstId=list[0].id;
      const report=await reportFor(f.parent,firstId,locale);firstHash=digest(report);
      assert.equal(report.payload.revision?.version,1);assert.deepEqual(report.payload.revision?.sourceRoles,["parent"]);
      assert.match(report.html_documents[locale],locale==="zh-HK"?/首次家長報告/:/首次家长报告/);
      await reportFor(staff,firstId,locale);await assert.rejects(reportFor(otherStaff,firstId,locale),{code:"NOT_FOUND"});
      for(const language of ["zh-CN","zh-HK"] as const){
        const bytes=await readPrivatePdf(report.pdf_keys[language]);assert.equal(bytes.subarray(0,4).toString(),"%PDF");
        await fs.writeFile(path.join(output,`parent-${order[0]}-${language}.pdf`),bytes,{mode:0o600});
      }
    });
    for(const role of order){
      await check(`append ${role} and preserve first report (${order.join(" then ")})`,async()=>{
        const who=role==="student"?await actor("student"):staff;
        const task=role==="student"?await joinFamily(who,{code:f.joinCode},locale):await startStaffObservation(who,f.familyId,locale);
        const id="assessmentId" in task?task.assessmentId:task.id;
        const scale=role==="student"?stagedChildScale:topeStaffScale;
        const input={answers:answers(scale,order[0]==="student"),revision:0,acknowledged:true as const};
        const both=await Promise.all([submitAssessment(who,id,input),submitAssessment(who,id,input)]);
        assert.ok(both.every(result=>result.status==="submitted"));
        const list=await jobs(f.familyId),job=list.at(-1)!;assert.equal(job.report_version,list.length);
        await publish(job.id);assert.deepEqual(await processReportJob(job.id),{status:"already_done"});
        const report=await reportFor(f.parent,job.id,locale);
        assert.equal(report.payload.revision?.sourceRoles.length,list.length);
        for(const html of Object.values(report.html_documents)){
          assert.ok(!html.includes("PRIVATE_SYNTHETIC_STUDENT_TEXT"));assert.ok(!html.includes("PRIVATE_SYNTHETIC_STAFF_TEXT"));
        }
        assert.equal(digest(await reportFor(f.parent,firstId,locale)),firstHash);
        const workspace=await workspaceFor(f.parent,locale);
        assert.equal(workspace.assessments.filter(task=>task.familyId===f.familyId).length,list.length);
        assert.equal(workspace.reports.filter(report=>report.familyId===f.familyId).length,list.length);
        const studentIncluded=report.payload.revision!.sourceRoles.includes("student");
        if(studentIncluded)assert.equal(Boolean(report.payload.triad?.supportIntake?.studentShared),order[0]==="student");
        if(list.length===3)for(const language of ["zh-CN","zh-HK"] as const)await fs.writeFile(path.join(output,`complete-${order[0]}-${language}.pdf`),await readPrivatePdf(report.pdf_keys[language]),{mode:0o600});
      });
    }
    assert.equal((await jobs(f.familyId)).length,3);
  }
  await check("consent withdrawal hides all versions and restores the pending update",async()=>{
    const f=await family();await submit(f.parent,f.parentId,stagedParentScale);const first=(await jobs(f.familyId))[0];await publish(first.id);
    await recordConsent(f.parent,f.familyId,{action:"withdraw",scope:"parent_report",guardianName:f.parent.name});
    await assert.rejects(reportFor(f.parent,first.id,locale),{code:"GUARDIAN_CONSENT_REQUIRED"});
    const child=await actor("student"),task=await joinFamily(child,{code:f.joinCode},locale);await submit(child,task.assessmentId,stagedChildScale);
    assert.equal((await jobs(f.familyId)).length,1);
    await recordConsent(f.parent,f.familyId,{action:"grant",scope:"parent_report",guardianName:f.parent.name});
    const list=await jobs(f.familyId);assert.equal(list.length,2);await publish(list[1].id);
    assert.equal((await workspaceFor(f.parent,locale)).reports.filter(r=>r.familyId===f.familyId).length,2);
  });
  await check("failed update retains submitted answers and old report; retries target one job",async()=>{
    const f=await family();await submit(f.parent,f.parentId,stagedParentScale);const first=(await jobs(f.familyId))[0];await publish(first.id);
    const child=await actor("student"),task=await joinFamily(child,{code:f.joinCode},locale);await submit(child,task.assessmentId,stagedChildScale);
    const job=(await jobs(f.familyId))[1];await query("UPDATE report_jobs SET attempts=3 WHERE id=$1",[job.id]);
    assert.deepEqual(await processReportJob(job.id),{status:"terminal"});
    const statuses=await query("SELECT status FROM assessments WHERE family_id=$1",[f.familyId]);assert.ok(statuses.every(row=>row.status==="submitted"));
    await reportFor(f.parent,first.id,locale);await assert.rejects(retryStagedReport(otherStaff,job.id),{code:"NOT_FOUND"});
    await retryStagedReport(staff,job.id);await publish(job.id);assert.equal((await jobs(f.familyId)).length,2);
  });
  await check("simultaneous supplements freeze distinct versions and out-of-order completion keeps the newest link",async()=>{
    const f=await family();await submit(f.parent,f.parentId,stagedParentScale);
    const child=await actor("student"),studentTask=await joinFamily(child,{code:f.joinCode},locale),staffTask=await startStaffObservation(staff,f.familyId,locale);
    await Promise.all([submit(child,studentTask.assessmentId,stagedChildScale),submit(staff,staffTask.id,topeStaffScale)]);
    const list=await jobs(f.familyId);
    assert.deepEqual(list.map(job=>job.report_version),[1,2,3]);assert.deepEqual(list.map(job=>job.source_assessment_ids.length),[1,2,3]);
    await publish(list[2].id);await publish(list[0].id);await publish(list[1].id);
    const workspace=await workspaceFor(f.parent,locale);
    assert.ok(workspace.assessments.filter(task=>task.familyId===f.familyId).every(task=>task.reportId===list[2].id));
    await assert.rejects(query("UPDATE report_jobs SET source_assessment_ids=$1 WHERE id=$2",[[f.parentId],list[2].id]),/immutable/);
    await assert.rejects(query("UPDATE triad_rounds SET report_workflow='legacy_triad' WHERE id=$1",[f.roundId]),/immutable/);
  });
  await check("a queued update pauses on withdrawal and resumes despite an older published report",async()=>{
    const f=await family();await submit(f.parent,f.parentId,stagedParentScale);const first=(await jobs(f.familyId))[0];await publish(first.id);
    const child=await actor("student"),task=await joinFamily(child,{code:f.joinCode},locale);await submit(child,task.assessmentId,stagedChildScale);
    const second=(await jobs(f.familyId))[1];
    await recordConsent(f.parent,f.familyId,{action:"withdraw",scope:"parent_report",guardianName:f.parent.name});
    assert.deepEqual(await processReportJob(second.id),{status:"paused"});
    await recordConsent(f.parent,f.familyId,{action:"grant",scope:"parent_report",guardianName:f.parent.name});
    assert.equal((await jobs(f.familyId))[1].state,"ready");await publish(second.id);
  });
  await check("reassignment blocks the previous staff author and preserves the pending draft",async()=>{
    const f=await family();const task=await startStaffObservation(staff,f.familyId,locale);
    await saveDraft(staff,task.id,{answers:{o_visit_date:"2026-10-23"},revision:0,acknowledged:true});
    await assignFamily(admin,f.familyId,{assignedTo:otherStaff.id});
    await assert.rejects(saveDraft(staff,task.id,{answers:{},revision:1,acknowledged:true}),{code:"NOT_FOUND"});
    await assert.rejects(submit(staff,task.id,topeStaffScale),{code:"NOT_FOUND"});
    assert.deepEqual(await startStaffObservation(otherStaff,f.familyId,locale),task);
    assert.equal((await assessmentDetail(otherStaff,task.id,locale)).draftAnswers.o_visit_date,"2026-10-23");
  });
  await check("legacy rounds retain three-source gate and immutable questionnaires",async()=>{
    const f=await family();
    // An independent historical fixture uses the old form and an explicit legacy round.
    const round=randomUUID(),id=randomUUID();
    await query("INSERT INTO triad_rounds(id,family_id,region) VALUES($1,$2,$3)",[round,f.familyId,config.region]);
    await query("INSERT INTO assessments(id,family_id,region,respondent_id,respondent_role,scale_version_id,locale,triad_round_id) VALUES($1,$2,$3,$4,'parent',$5,$6,$7)",[id,f.familyId,config.region,f.parent.id,`${parentScaleSupportIntake.id}@${parentScaleSupportIntake.version}`,locale,round]);
    await submit(f.parent,id,parentScaleSupportIntake);
    assert.equal((await jobs(f.familyId)).length,0);
    await transaction(async client=>{await client.query("SELECT id FROM families WHERE id=$1 FOR UPDATE",[f.familyId]);assert.equal(await queueTriadReport(client,f.familyId,round),null);});
  });
  await cleanOrphanReports();
  for(const key of persistedPdfs)assert.equal((await readPrivatePdf(key)).subarray(0,4).toString(),"%PDF","Cleanup must retain every published version");
  await check("family deletion removes every report version and its private files",async()=>{
    const f=await family();await submit(f.parent,f.parentId,stagedParentScale);const first=(await jobs(f.familyId))[0];await publish(first.id);
    const child=await actor("student"),task=await joinFamily(child,{code:f.joinCode},locale);await submit(child,task.assessmentId,stagedChildScale);
    const second=(await jobs(f.familyId))[1];await publish(second.id);
    const rows=await query("SELECT id,pdf_keys FROM reports WHERE family_id=$1",[f.familyId]);assert.equal(rows.length,2);
    await deleteFamily(f.parent,f.familyId,{confirmation:"Synthetic staged child"});await processDeletionJobs();
    assert.equal((await jobs(f.familyId)).length,0);
    for(const row of rows){await assert.rejects(reportFor(admin,row.id,locale),{code:"NOT_FOUND"});for(const key of Object.values(row.pdf_keys) as string[])await assert.rejects(readPrivatePdf(key));}
  });
  passed=true;
}finally{
  await closePdfBrowser();await closeDatabase();
  await fs.writeFile(path.join(output,"results.json"),JSON.stringify({passed,region:config.region,storage:config.reportStorage,syntheticOnly:true,loopbackOnly:true,realPdfRendering:true,results},null,2),{mode:0o600});
}
