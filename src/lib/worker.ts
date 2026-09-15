import { randomUUID } from "node:crypto";
import type { AssessmentSnapshot,Locale,ReportPayload } from "../domain/types";
import { selectNarrative } from "../domain/narrative";
import { compareResults } from "../domain/scoring";
import { reportHtml } from "../domain/report-html";
import { getConfig } from "./config";
import { query,transaction } from "./db";
import { renderPdf } from "./pdf";
import { listPrivatePdfKeys,removePrivatePdf,writePrivatePdf } from "./storage";
export async function processDeletionJobs():Promise<void>{
  const jobs=await query("SELECT file_key FROM file_deletion_jobs LIMIT 50");
  for(const job of jobs){await removePrivatePdf(job.file_key);await query("DELETE FROM file_deletion_jobs WHERE file_key=$1",[job.file_key]);}
}
export async function cleanOrphanReports():Promise<void>{
  for(const key of await listPrivatePdfKeys()){
    const id=key.slice(0,36);const rows=await query("SELECT a.status,r.pdf_keys FROM assessments a LEFT JOIN reports r ON r.assessment_id=a.id WHERE a.id=$1",[id]);
    const r=rows[0];if(!r||r.status==="failed"||(r.pdf_keys&&!Object.values(r.pdf_keys).includes(key)))await removePrivatePdf(key);
  }
}
// Refreshes this region's heartbeat row. A stale heartbeat is the only reliable
// signal that the report pipeline has stopped, since an idle queue looks healthy
// whether or not anything is listening to it.
export async function recordHeartbeat(workerId:string):Promise<void>{
  await query(`INSERT INTO worker_heartbeats(region,worker_id,cycles) VALUES($1,$2,1)
    ON CONFLICT(region) DO UPDATE SET
      started_at=CASE WHEN worker_heartbeats.worker_id<>EXCLUDED.worker_id THEN now() ELSE worker_heartbeats.started_at END,
      worker_id=EXCLUDED.worker_id,
      heartbeat_at=now(),
      cycles=CASE WHEN worker_heartbeats.worker_id<>EXCLUDED.worker_id THEN 1 ELSE worker_heartbeats.cycles+1 END`,
    [getConfig().region,workerId]);
}
export async function processOneJob():Promise<boolean>{
  const token=randomUUID();
  const jobs=await query(`WITH candidate AS (
    SELECT j.id FROM report_jobs j JOIN assessments a ON a.id=j.assessment_id
    WHERE j.available_at<=now() AND (j.state='ready' OR (j.state='running' AND j.lease_until<now()))
    ORDER BY a.submitted_at,j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED
  ) UPDATE report_jobs j SET state='running',attempts=j.attempts+1,lease_until=now()+interval '5 minutes',claim_token=$1 FROM candidate WHERE j.id=candidate.id RETURNING j.*`,[token]);
  const job=jobs[0];if(!job)return false;
  const keys:Partial<Record<Locale,string>>={};
  try{
    const rows=await query("SELECT * FROM assessments WHERE id=$1 AND region=$2",[job.assessment_id,getConfig().region]);
    const assessment=rows[0];if(!assessment?.snapshot)throw new Error("Missing assessment snapshot");
    const snapshot=assessment.snapshot as AssessmentSnapshot;
    if(snapshot.scale.demo&&getConfig().mode!=="demo")throw new Error("Demo snapshot rejected in service mode");
    // Consent may be withdrawn after submission. Never contact AI without current permission too.
    const consent=await query("SELECT id FROM consents WHERE family_id=$1 AND revoked_at IS NULL AND scopes @> '[\"ai_processing\"]'::jsonb LIMIT 1",[assessment.family_id]);
    const selection=await selectNarrative({...snapshot,aiConsented:snapshot.aiConsented&&consent.length>0},getConfig().ai);
    const previous=await query("SELECT snapshot,submitted_at FROM assessments WHERE family_id=$1 AND respondent_id=$2 AND scale_version_id=$3 AND submitted_at<$4 AND snapshot IS NOT NULL ORDER BY submitted_at DESC LIMIT 1",[assessment.family_id,assessment.respondent_id,assessment.scale_version_id,assessment.submitted_at]);
    const prior=previous[0];const payload:ReportPayload={...snapshot,...selection,comparison:compareResults(snapshot.score,prior?(prior.snapshot as AssessmentSnapshot).score:null,prior?new Date(prior.submitted_at).toISOString():undefined)};
    const htmlDocuments={"zh-CN":reportHtml(payload,"zh-CN"),"zh-HK":reportHtml(payload,"zh-HK")};
    for(const locale of ["zh-CN","zh-HK"] as const){
      const key=`${assessment.id}.${token}.${locale}.pdf.enc`;keys[locale]=key;
      await writePrivatePdf(key,await renderPdf(htmlDocuments[locale]));
    }
    await transaction(async client=>{
      const familyLock=await client.query("SELECT id FROM families WHERE id=$1 AND region=$2 FOR UPDATE",[assessment.family_id,getConfig().region]);
      if(!familyLock.rows[0])throw new Error("Family deleted");
      const claim=await client.query("SELECT id FROM report_jobs WHERE id=$1 AND claim_token=$2 AND state='running' AND lease_until>now() FOR UPDATE",[job.id,token]);
      if(!claim.rows[0])throw new Error("Report claim expired or family deleted");
      await client.query("INSERT INTO reports(id,assessment_id,family_id,region,payload,pdf_keys,created_at,html_documents) VALUES($1,$1,$2,$3,$4,$5,$6,$7) ON CONFLICT(assessment_id) DO NOTHING",[assessment.id,assessment.family_id,getConfig().region,JSON.stringify(payload),JSON.stringify(keys),assessment.submitted_at,JSON.stringify(htmlDocuments)]);
      await client.query("UPDATE assessments SET status='published' WHERE id=$1",[assessment.id]);
      await client.query("UPDATE report_jobs SET state='done',lease_until=NULL,last_error_code=NULL WHERE id=$1 AND claim_token=$2",[job.id,token]);
      await client.query("INSERT INTO audit_events(region,action,entity_id) VALUES($1,'report.auto_published',$2)",[getConfig().region,assessment.id]);
    });
    return true;
  }catch{
    for(const key of Object.values(keys))await removePrivatePdf(key).catch(()=>{});
    const terminal=job.attempts>=3;
    const changed=await query("UPDATE report_jobs SET state=$1,lease_until=NULL,available_at=now()+interval '10 seconds',last_error_code='REPORT_GENERATION_FAILED' WHERE id=$2 AND claim_token=$3 RETURNING assessment_id",[terminal?"failed":"ready",job.id,token]);
    if(terminal&&changed[0])await query("UPDATE assessments SET status='failed' WHERE id=$1 AND status='queued'",[changed[0].assessment_id]);
    console.error("nova_report_generation_failed",{region:getConfig().region,attempt:job.attempts});return true;
  }
}
