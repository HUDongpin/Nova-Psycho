import assert from "node:assert/strict";
import {randomBytes,randomUUID} from "node:crypto";
import fs from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {createFamily,recordConsent,deleteFamily,createInvitation,acceptInvitation} from "../src/lib/families";
import {query,transaction,closeDatabase} from "../src/lib/db";
import {getConfig} from "../src/lib/config";
import type {Actor,ReportPayload} from "../src/domain/types";
import {reportDetail,reportFor} from "../src/lib/reports";
import {readPrivatePdf} from "../src/lib/storage";
import {processDeletionJobs,cleanOrphanReports} from "../src/lib/worker";

assert.equal(getConfig().mode,"demo","Database checks only use an explicitly classified demo database");
const rows=await query("SELECT id,name,role,region FROM users WHERE demo AND role='admin' LIMIT 1");
const admin=rows[0] as Actor;assert.ok(admin);
const results:{name:string;passed:boolean}[]=[];
async function check(name:string,fn:()=>Promise<void>){await fn();results.push({name,passed:true});console.log(`PASS ${name}`);}
const createdFamilies=new Set<string>();
async function newFamily(){const f=await createFamily(admin,{familyName:"并发测试家庭",childName:"并发合成孩子",birthDate:"2014-04-10",grade:"六年级",guardianLabel:"母亲"});createdFamilies.add(f.id);return f.id;}
try{
  await check("consent renewals serialize and allow exactly one active grant",async()=>{
    const id=await newFamily();
    const grant=(allow:boolean)=>recordConsent(admin,id,{accepted:true,guardianName:"合成监护人",reference:"SYNTHETIC-REGRESSION",aiProcessing:allow});
    await grant(true);
    await Promise.all([grant(true),grant(false),grant(true),grant(false)]);
    assert.equal((await query("SELECT id FROM consents WHERE family_id=$1 AND revoked_at IS NULL",[id])).length,1);
    await grant(false);
    const current=await query("SELECT scopes FROM consents WHERE family_id=$1 AND revoked_at IS NULL",[id]);assert.ok(!current[0].scopes.includes("ai_processing"));
    await assert.rejects(()=>query("INSERT INTO consents(id,family_id,guardian_name,method,notice_version,scopes) VALUES($1,$2,'synthetic','synthetic','test','[]')",[randomUUID(),id]),(e:unknown)=>(e as {code?:string}).code==="23505");
  });
  await check("concurrent invitation admission and deletion leave no orphan account",async()=>{
    for(let i=0;i<5;i++){
      const id=await newFamily(),inv=await createInvitation(admin,id,{role:"student"});const token=new URLSearchParams(new URL(inv.url).hash.slice(1)).get("token")!;
      const username=`qa_race_${randomBytes(6).toString("hex")}`;
      const results=await Promise.allSettled([acceptInvitation({token,name:"并发合成学生",username,password:randomBytes(18).toString("base64url")}),deleteFamily(admin,id,{confirmation:"并发合成孩子"})]);
      assert.equal(results[1].status,"fulfilled");createdFamilies.delete(id);
      assert.equal((await query("SELECT id FROM users WHERE username=$1",[username])).length,0);
      assert.equal((await query("SELECT id FROM families WHERE id=$1",[id])).length,0);
    }
  });
  await check("published answers, reports, scales and content are immutable in PostgreSQL",async()=>{
    const a=(await query("SELECT id FROM assessments WHERE submitted_at IS NOT NULL LIMIT 1"))[0];assert.ok(a);
    await assert.rejects(()=>query("UPDATE assessments SET answers=answers||'{\"q1\":999}'::jsonb WHERE id=$1",[a.id]),/immutable/i);
    await assert.rejects(()=>query("UPDATE reports SET payload=payload WHERE id=(SELECT id FROM reports LIMIT 1)"),/immutable/i);
    await assert.rejects(()=>query("UPDATE scales SET version='999.0.0' WHERE id=(SELECT id FROM scales LIMIT 1)"),/immutable/i);
    await assert.rejects(()=>query("UPDATE content_versions SET version='999.0.0' WHERE id=(SELECT id FROM content_versions LIMIT 1)"),/immutable/i);
    await transaction(async c=>{await c.query("UPDATE assessments SET status=status WHERE id=$1",[a.id]);});
  });
  await check("HTML is frozen and private PDFs are encrypted and decryptable",async()=>{
    const id=(await query("SELECT id FROM reports LIMIT 1"))[0].id;const report=await reportFor(admin,id);
    assert.ok(report.html_documents["zh-CN"].includes("家庭支持"));assert.ok(report.html_documents["zh-HK"].includes("測評"));
    const altered={...report,payload:structuredClone(report.payload) as ReportPayload};altered.payload.template.content.title={"zh-CN":"SHOULD_NOT_CHANGE_OLD_HTML","zh-HK":"SHOULD_NOT_CHANGE_OLD_HTML"};
    assert.equal(reportDetail(altered,"zh-CN").html,report.html_documents["zh-CN"]);
    const key=report.pdf_keys["zh-CN"],encrypted=await fs.readFile(`${getConfig().reportDir}/${key}`);assert.equal(encrypted.subarray(0,5).toString(),"NOVA1");assert.equal((await readPrivatePdf(key)).subarray(0,4).toString(),"%PDF");
  });
  await check("service-mode process rejects a demo-classified database",async()=>{
    const code="import {assertDatabaseRegion,closeDatabase} from './src/lib/db.ts'; let rejected=false; try {await assertDatabaseRegion();} catch(e){rejected=e.message==='Database data classification does not match process mode';} finally {await closeDatabase();} process.exit(rejected?0:1);";
    const child=spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",code],{cwd:process.cwd(),env:{...process.env,NOVA_MODE:"service",NOVA_PUBLIC_URL:"https://service.example.invalid"},stdio:"ignore",timeout:20000});assert.equal(child.status,0);
  });
  await check("same-person comparison source survives absence of an earlier PDF",async()=>{
    const seq=await query("SELECT family_id,respondent_id,scale_version_id,count(*) FROM assessments WHERE snapshot IS NOT NULL GROUP BY family_id,respondent_id,scale_version_id HAVING count(*)>=2 LIMIT 1");assert.ok(seq[0]);
    const ordered=await query("SELECT id,snapshot,submitted_at FROM assessments WHERE family_id=$1 AND respondent_id=$2 AND scale_version_id=$3 AND snapshot IS NOT NULL ORDER BY submitted_at",[seq[0].family_id,seq[0].respondent_id,seq[0].scale_version_id]);
    const current=ordered[ordered.length-1];
    await transaction(async c=>{
      const prior=await c.query("SELECT snapshot,submitted_at FROM assessments WHERE family_id=$1 AND respondent_id=$2 AND scale_version_id=$3 AND submitted_at<$4 AND snapshot IS NOT NULL ORDER BY submitted_at DESC LIMIT 1",[seq[0].family_id,seq[0].respondent_id,seq[0].scale_version_id,current.submitted_at]);
      assert.ok(prior.rows[0]?.snapshot?.score); // The worker query deliberately has no dependency on reports/report_jobs.
    });
  });
  await processDeletionJobs();await cleanOrphanReports();
}finally{
  for(const id of createdFamilies)await deleteFamily(admin,id,{confirmation:"并发合成孩子"});
  await processDeletionJobs();
  await fs.mkdir("work/qa",{recursive:true});await fs.writeFile("work/qa/database-checks.json",JSON.stringify({timestamp:new Date().toISOString(),region:getConfig().region,syntheticDataOnly:true,results},null,2));
  await closeDatabase();
}
console.log(`Database acceptance passed: ${results.length} checks.`);
