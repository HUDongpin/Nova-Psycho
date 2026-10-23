import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { AssessmentSnapshot,Locale,ReportPayload,StoredAnswer } from "../domain/types";
import { eligibleAdviceIds, selectNarrative } from "../domain/narrative";
import { buildTriadNarrativeSource,selectTriadNarrative,triadTemplateSelection,type TriadNarrativeSource } from "../domain/triad-narrative";
import { composeTriad,TRIAD_BUNDLE,triadResultMode,triadRolesReady } from "../domain/triad-report";
import { compareTriad, type TriadComparisonSource } from "../domain/triad-comparison";
import { compareResults } from "../domain/scoring";
import { reportHtml } from "../domain/report-html";
import { instrumentWriteBlockReason, normValidated } from "../domain/validation";
import { ACTIVE_CONSENT_ROWS_SQL, PARENT_REPORT_SCOPE, consentScopePredicate, consentScopeGrantedSql, hasGranted } from "./consent";
import { getConfig, isDemoMode } from "./config";
import { query,transaction } from "./db";
import { renderPdf } from "./pdf";
import { cleanAbandonedPrivatePdfTemps,listPrivatePdfKeys,removePrivatePdf,writePrivatePdf } from "./storage";
import { validateId } from "./http";
import { getSyntheticTestFamilyMembers, type SyntheticTestMember } from "./synthetic-testing";
type SyntheticSourceIdentity={id:string;respondent_id:string;respondent_role:string};
function syntheticSourcesMatch(sources:SyntheticSourceIdentity[],members:SyntheticTestMember[]):boolean{
  return sources.length>0&&new Set(sources.map(source=>source.id)).size===sources.length&&
    sources.every(source=>members.some(member=>member.id===source.respondent_id&&member.role===source.respondent_role));
}
export type ReportJobResult=
  |{status:"published"}
  |{status:"already_done"}
  |{status:"paused"}
  |{status:"retry_at";retryAt:string}
  |{status:"terminal"};
export interface ReportWorkerDependencies {narrativeFetcher?:typeof fetch}
const AI_CONSENT_IDS_SQL=`SELECT c.id FROM consents c WHERE c.family_id=$1 AND ${consentScopePredicate("c","ai_processing")} ORDER BY c.id`;
function consentIds(rows:{id:string}[]):string[]{return rows.map(row=>row.id).sort();}
function sameConsentIds(expected:string[],actual:{id:string}[]):boolean{
  const current=consentIds(actual);
  return expected.length>0&&current.length===expected.length&&current.every((id,index)=>id===expected[index]);
}
export async function processDeletionJobs():Promise<"done"|"busy">{
  if(getConfig().reportStorage==="database")return "done";
  const jobs=await query("SELECT file_key FROM file_deletion_jobs LIMIT 50");
  for(const job of jobs){
    if(await removePrivatePdf(job.file_key)==="busy")return "busy";
    await query("DELETE FROM file_deletion_jobs WHERE file_key=$1",[job.file_key]);
  }
  return "done";
}
export async function cleanOrphanReports():Promise<"done"|"busy">{
  if(getConfig().reportStorage==="database")return "done";
  await cleanAbandonedPrivatePdfTemps();
  for(const key of await listPrivatePdfKeys()){
    const id=key.slice(0,36);const rows=await query("SELECT a.status,r.pdf_keys FROM assessments a LEFT JOIN reports r ON r.assessment_id=a.id WHERE a.id=$1",[id]);
    const r=rows[0];if(!r||r.status==="failed"||(r.pdf_keys&&!Object.values(r.pdf_keys).includes(key))){
      if(await removePrivatePdf(key)==="busy")return "busy";
    }
  }
  return "done";
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
export async function processOneJob(dependencies:ReportWorkerDependencies={}):Promise<boolean>{
  return (await runReportJob(undefined,dependencies)).status!=="already_done";
}
export async function processReportJob(jobId:string,dependencies:ReportWorkerDependencies={}):Promise<ReportJobResult>{
  validateId(jobId);
  return runReportJob(jobId,dependencies);
}
async function unclaimedJobResult(jobId:string|undefined):Promise<ReportJobResult>{
  if(!jobId)return {status:"already_done"};
  const rows=await query(`SELECT j.state,j.available_at,j.lease_until FROM report_jobs j
    JOIN assessments a ON a.id=j.assessment_id WHERE j.id=$1 AND a.region=$2`,[jobId,getConfig().region]);
  const job=rows[0];
  if(!job||job.state==="done"||job.state==="paused")return job?.state==="paused"?{status:"paused"}:{status:"already_done"};
  if(job.state==="failed")return {status:"terminal"};
  const due=new Date(job.state==="running"?job.lease_until:job.available_at).getTime();
  return {status:"retry_at",retryAt:new Date(Math.max(Date.now()+1000,Number.isFinite(due)?due:Date.now()+10000)).toISOString()};
}
// The claim filter skips a job when parent_report consent is gone. A queue delivery
// would otherwise retry every second, and the continuous worker would leave the row
// ready or on an expired lease and poll it forever. Pause it on the same ledger as a
// post-claim pause. A live running lease is left for that worker, which re-checks
// consent before publication. Family lock first, then the job: consent grant and
// publication take the locks in that order, and a re-check under those locks drops a race.
function dueJobMissingParentReportSql():string{
  const missingConsent=`NOT (${consentScopeGrantedSql("a.family_id","parent_report")})`;
  return `((j.state='ready' AND j.available_at<=now()) OR (j.state='running' AND j.lease_until<now())) AND ${missingConsent}`;
}
async function pauseLockedJobMissingParentReportConsent(client:PoolClient,jobId:string,familyId:string,region:string):Promise<boolean>{
  const family=await client.query("SELECT id FROM families WHERE id=$1 AND region=$2 FOR UPDATE",[familyId,region]);
  if(!family.rows[0])return false;
  const locked=await client.query(`SELECT j.id FROM report_jobs j JOIN assessments a ON a.id=j.assessment_id WHERE j.id=$1 AND a.region=$2 AND a.family_id=$3 AND ${dueJobMissingParentReportSql()} FOR UPDATE OF j`,[jobId,region,familyId]);
  if(!locked.rows[0])return false;
  // A ready row was never claimed, so its attempt count stays. An expired running
  // row already counted the claim that did not publish; give that attempt back so
  // restoring consent does not walk the job into the attempt cap.
  const paused=await client.query("UPDATE report_jobs SET state='paused', lease_until=NULL, claim_token=NULL, last_error_code='PARENT_REPORT_CONSENT_REQUIRED', attempts=CASE WHEN state='running' THEN GREATEST(attempts-1,0) ELSE attempts END WHERE id=$1 AND ((state='ready' AND available_at<=now()) OR (state='running' AND lease_until<now())) RETURNING id",[jobId]);
  return paused.rows.length>0;
}
async function pauseDueReadyJobMissingParentReportConsent(jobId:string):Promise<boolean>{
  const region=getConfig().region;
  return transaction(async client=>{
    const located=await client.query<{id:string;family_id:string}>(`SELECT j.id,a.family_id FROM report_jobs j JOIN assessments a ON a.id=j.assessment_id WHERE j.id=$1 AND a.region=$2 AND ${dueJobMissingParentReportSql()}`,[jobId,region]);
    const row=located.rows[0];
    if(!row)return false;
    return pauseLockedJobMissingParentReportConsent(client,jobId,row.family_id,region);
  });
}
type StageValue<T>={ok:true;value:T}|{ok:false;error:unknown};
interface ReportStageConsent {aiConsented:boolean;aiConsentIds:string[]}
// Materialization puts the wall-clock lease check after any claim-row lock wait.
const LOCK_LIVE_REPORT_CLAIM_SQL=`WITH locked_claim AS MATERIALIZED (
  SELECT id,lease_until FROM report_jobs WHERE id=$1 AND claim_token=$2 AND state='running' FOR UPDATE
) SELECT id FROM locked_claim WHERE lease_until>clock_timestamp()`;
// Withdrawal takes the family UPDATE lock. Start one stage while its grant is
// locked, then release before waiting for external work. In-flight work cannot
// be unsent; the next stage and publication each need a fresh grant.
async function reportStage<T>(jobId:string,token:string,familyId:string,start:(consent:ReportStageConsent)=>Promise<T>):Promise<{status:"paused"}|{status:"completed";value:T}>{
  let pending:Promise<StageValue<T>>|undefined;
  try{
    const admitted=await transaction(async client=>{
      const familyLock=await client.query("SELECT id FROM families WHERE id=$1 AND region=$2 FOR SHARE",[familyId,getConfig().region]);
      if(!familyLock.rows[0])throw new Error("Family deleted");
      const claim=await client.query(LOCK_LIVE_REPORT_CLAIM_SQL,[jobId,token]);
      if(!claim.rows[0])throw new Error("Report claim expired or family deleted");
      const consent=await client.query<{id:string;scopes:unknown}>(ACTIVE_CONSENT_ROWS_SQL,[familyId]);
      if(!hasGranted(consent.rows,[PARENT_REPORT_SCOPE])){
        await client.query("UPDATE report_jobs SET state='paused', lease_until=NULL, claim_token=NULL, last_error_code='PARENT_REPORT_CONSENT_REQUIRED', attempts=GREATEST(attempts-1,0) WHERE id=$1 AND claim_token=$2 AND state='running'",[jobId,token]);
        return false;
      }
      const aiConsents=consent.rows.filter(row=>hasGranted([row],["ai_processing"]));
      pending=start({aiConsented:aiConsents.length>0,aiConsentIds:consentIds(aiConsents)}).then(value=>({ok:true,value} as const),error=>({ok:false,error} as const));
      return true;
    });
    if(!admitted)return {status:"paused"};
  }catch(error){
    // A lost COMMIT response can leave work running. Drain its captured result
    // before recovery; stages return values and never write report files.
    await pending;
    throw error;
  }
  const result=await pending!;
  if(!result.ok)throw result.error;
  return {status:"completed",value:result.value};
}
// The continuous worker claims without a job id. Pause one family per transaction
// so this scan never acquires several family locks in a different order to grants.
async function pauseIdleJobsMissingParentReportConsent():Promise<boolean>{
  const region=getConfig().region;
  const located=await query<{id:string;family_id:string}>(`SELECT j.id,a.family_id FROM report_jobs j JOIN assessments a ON a.id=j.assessment_id WHERE a.region=$1 AND ${dueJobMissingParentReportSql()} ORDER BY a.family_id,j.id LIMIT 25`,[region]);
  let pausedAny=false;
  for(const row of located){
    const paused=await transaction(client=>pauseLockedJobMissingParentReportConsent(client,row.id,row.family_id,region));
    if(paused)pausedAny=true;
  }
  return pausedAny;
}
async function runReportJob(jobId:string|undefined,dependencies:ReportWorkerDependencies):Promise<ReportJobResult>{
  const token=randomUUID();
  const jobs=await query(`WITH candidate AS (
    SELECT j.id,j.attempts>=3 AS attempt_limit_reached FROM report_jobs j JOIN assessments a ON a.id=j.assessment_id
    WHERE a.region=$2 AND ($3::uuid IS NULL OR j.id=$3) AND j.available_at<=now()
      AND (j.state='ready' OR (j.state='running' AND j.lease_until<now()))
      AND ${consentScopeGrantedSql("a.family_id","parent_report")}
    ORDER BY a.submitted_at,j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED
  ) UPDATE report_jobs j SET state='running',attempts=LEAST(j.attempts+1,3),lease_until=now()+interval '5 minutes',claim_token=$1 FROM candidate WHERE j.id=candidate.id RETURNING j.*,candidate.attempt_limit_reached`,[token,getConfig().region,jobId??null]);
  const job=jobs[0];
  if(!job){
    if(jobId&&await pauseDueReadyJobMissingParentReportConsent(jobId))return {status:"paused"};
    if(!jobId&&await pauseIdleJobsMissingParentReportConsent())return {status:"paused"};
    return unclaimedJobResult(jobId);
  }
  const keys:Partial<Record<Locale,string>>={};
  const pdfs:Partial<Record<Locale,Buffer>>={};
  const attemptedKeys=new Set<string>();
  let unboundTriad=false;
  let blockCode:string|null=null;
  let syntheticTest=false;
  const rejectSyntheticScope=()=>{
    blockCode="SYNTHETIC_TEST_SCOPE_REQUIRED";
    throw new Error("Synthetic report source authorization changed");
  };
  const rejectSnapshot=(item:AssessmentSnapshot|null|undefined)=>{
    if(item?.syntheticTest&&!syntheticTest)rejectSyntheticScope();
    if(isDemoMode()||syntheticTest)return;
    const code=instrumentWriteBlockReason(item?.scale??{},"service");
    if(!code)return;
    blockCode=code;
    throw new Error(code==="UNVALIDATED_INSTRUMENT"?"Unvalidated instrument rejected in service mode":"Demo snapshot rejected in service mode");
  };
  try{
    if(job.attempt_limit_reached)throw new Error("Report attempt limit reached");
    const rows=await query("SELECT * FROM assessments WHERE id=$1 AND region=$2",[job.assessment_id,getConfig().region]);
    const assessment=rows[0];if(!assessment?.snapshot)throw new Error("Missing assessment snapshot");
    const snapshot=assessment.snapshot as AssessmentSnapshot;
    const syntheticMembers=isDemoMode()?null:await getSyntheticTestFamilyMembers(String(assessment.family_id),getConfig().region);
    syntheticTest=syntheticMembers!==null&&syntheticSourcesMatch([assessment as SyntheticSourceIdentity],syntheticMembers);
    rejectSnapshot(snapshot);
    let payload:ReportPayload;
    let publishIds=[assessment.id as string];
    const sources:AssessmentSnapshot[]=[snapshot];
    let sourceIdentities:SyntheticSourceIdentity[]=[assessment as SyntheticSourceIdentity];
    let triadSelection:{sources:TriadNarrativeSource[];consentIds:string[]}|undefined;
    if(snapshot.scale.bundle===TRIAD_BUNDLE){
      unboundTriad=!assessment.triad_round_id||!job.source_assessment_ids;
      if(unboundTriad)throw new Error("Triad sources require review");
      const sourceIds=job.source_assessment_ids as string[];
      if(sourceIds.length!==3||new Set(sourceIds).size!==3||!sourceIds.includes(assessment.id))throw new Error("Invalid triad sources");
      const siblings=await query("SELECT id,respondent_role,answers,snapshot,submitted_at,respondent_id FROM assessments WHERE id=ANY($1::uuid[]) AND family_id=$2 AND region=$3 AND triad_round_id=$4 AND submitted_at IS NOT NULL",[sourceIds,assessment.family_id,getConfig().region,assessment.triad_round_id]);
      if(siblings.length!==3||new Set(siblings.map(row=>row.id)).size!==3||!triadRolesReady(siblings.map(row=>row.respondent_role))||siblings.some(row=>!sourceIds.includes(row.id)||row.snapshot?.scale?.bundle!==TRIAD_BUNDLE))throw new Error("Triad incomplete");
      if(syntheticTest&&!syntheticSourcesMatch(siblings as SyntheticSourceIdentity[],syntheticMembers!))rejectSyntheticScope();
      for(const row of siblings)rejectSnapshot(row.snapshot as AssessmentSnapshot);
      if(siblings.some(row=>row.snapshot.score.region!==getConfig().region||row.snapshot.score.respondentRole!==row.respondent_role||!row.snapshot.scale.roles.includes(row.respondent_role)))throw new Error("Invalid triad source snapshot");
      if(siblings.find(row=>row.respondent_role==="parent")?.id!==assessment.id)throw new Error("Invalid triad report owner");
      const resultMode=triadResultMode(siblings.map(row=>row.snapshot.scale));
      sources.splice(0,sources.length,...siblings.map(row=>row.snapshot as AssessmentSnapshot));
      sourceIdentities=siblings as SyntheticSourceIdentity[];
      // Select one completed round before this round, even when its report failed
      // or this job is retried after newer rounds. Frozen snapshots are the source.
      const firstSubmission=new Date(Math.min(...siblings.map(row=>new Date(row.submitted_at).getTime()))).toISOString();
      const previous=resultMode==="support-intake"?[]:await query(`WITH prior_round AS (
        SELECT prior.id FROM triad_rounds prior
        JOIN triad_rounds current_round ON current_round.id=$3 AND current_round.family_id=$1 AND current_round.region=$2
        JOIN assessments a ON a.triad_round_id=prior.id AND a.family_id=prior.family_id AND a.region=prior.region
        WHERE prior.family_id=$1 AND prior.region=$2 AND (prior.created_at,prior.id)<(current_round.created_at,current_round.id)
        GROUP BY prior.id,prior.created_at
        HAVING count(*)=3 AND count(DISTINCT a.respondent_role)=3
          AND bool_and(a.submitted_at IS NOT NULL AND a.snapshot IS NOT NULL AND COALESCE(a.snapshot->'scale'->>'bundle'=$4,false))
          AND max(a.submitted_at)<$5::timestamptz
        ORDER BY prior.created_at DESC,prior.id DESC LIMIT 1
      ) SELECT a.respondent_role,a.respondent_id,a.snapshot,a.submitted_at
        FROM assessments a JOIN prior_round ON prior_round.id=a.triad_round_id
        WHERE a.family_id=$1 AND a.region=$2`,[assessment.family_id,getConfig().region,assessment.triad_round_id,TRIAD_BUNDLE,firstSubmission]);
      const comparisonSource=(row:typeof siblings[number]):TriadComparisonSource=>{
        const stored=row.snapshot as AssessmentSnapshot;
        return {role:row.respondent_role,respondentId:row.respondent_id,scale:stored.scale,score:stored.score,submittedAt:new Date(row.submitted_at).toISOString()};
      };
      const narrativeSources=resultMode==="support-intake"?[]:siblings.map(row=>buildTriadNarrativeSource(row.respondent_role,row.snapshot.scale.dimensions,row.snapshot.score,row.snapshot.aiConsented));
      const composed=await reportStage(job.id,token,assessment.family_id,async({aiConsented,aiConsentIds})=>{
        const triad=composeTriad(siblings.map(row=>{const stored=row.snapshot as AssessmentSnapshot;return {role:row.respondent_role,scale:stored.scale,answers:row.answers as Record<string,StoredAnswer>,score:stored.score,submittedAt:new Date(row.submitted_at).toISOString()};}));
        if(resultMode==="support-intake")return {
          ...snapshot,selectedAdviceIds:[],generationMode:"template" as const,fallbackReason:"support_intake",aiModel:null,
          comparison:{available:false,reason:"not_scored" as const},triad,
          score:{...snapshot.score,resultMode,dimensions:[],risk:triad.safety.length>0,riskMessages:triad.safety}
        } satisfies ReportPayload;
        const comparisons=compareTriad(siblings.map(comparisonSource),previous.length?previous.map(comparisonSource):null);
        triad.comparisons=comparisons;
        triadSelection={sources:narrativeSources,consentIds:aiConsentIds};
        const config=getConfig();
        let selection=syntheticTest?triadTemplateSelection(narrativeSources,snapshot.advice,"synthetic_test")
          :await selectTriadNarrative(narrativeSources,snapshot.advice,config.ai,{triadEnabled:config.triadAiEnabled,currentAiConsented:aiConsented},dependencies.narrativeFetcher);
        if(selection.generationMode==="ai"&&!sameConsentIds(aiConsentIds,await query<{id:string}>(AI_CONSENT_IDS_SQL,[assessment.family_id]))){
          selection=triadTemplateSelection(narrativeSources,snapshot.advice,"ai_consent_changed");
        }
        return {...snapshot,...selection,
          comparison:comparisons.some(comparison=>comparison.available)?{available:true}:{available:false,reason:previous.length?"incomplete":"first_assessment"},
          triad,score:{...snapshot.score,risk:triad.safety.length>0,riskMessages:triad.safety}} satisfies ReportPayload;
      });
      if(composed.status==="paused")return {status:"paused"};
      payload=composed.value;
      publishIds=siblings.map(row=>row.id);
    }else{
      const selection=await reportStage(job.id,token,assessment.family_id,async({aiConsented})=>syntheticTest
        ?{selectedAdviceIds:eligibleAdviceIds(snapshot),generationMode:"template" as const,fallbackReason:"synthetic_test",aiModel:null}
        :selectNarrative({...snapshot,aiConsented:snapshot.aiConsented&&aiConsented},getConfig().ai));
      if(selection.status==="paused")return {status:"paused"};
      const previous=await query("SELECT snapshot,submitted_at FROM assessments WHERE family_id=$1 AND respondent_id=$2 AND scale_version_id=$3 AND submitted_at<$4 AND snapshot IS NOT NULL ORDER BY submitted_at DESC LIMIT 1",[assessment.family_id,assessment.respondent_id,assessment.scale_version_id,assessment.submitted_at]);
      const prior=previous[0];
      payload={...snapshot,...selection.value,comparison:compareResults(snapshot.score,prior?(prior.snapshot as AssessmentSnapshot).score:null,prior?new Date(prior.submitted_at).toISOString():undefined)};
    }
    if(syntheticTest)payload={...payload,syntheticTest:true,aiConsented:false,generationMode:"template",aiModel:null,score:{...payload.score,demo:true}};
    if(sources.some(item=>!normValidated(item?.scale?.norm)))payload={...payload,score:{...payload.score,demo:true}};
    for(let renderPass=0;renderPass<2;renderPass++){
      const htmlDocuments={"zh-CN":reportHtml(payload,"zh-CN"),"zh-HK":reportHtml(payload,"zh-HK")};
      const renderToken=renderPass===0?token:randomUUID();
      for(const locale of ["zh-CN","zh-HK"] as const){
        const rendered=await reportStage(job.id,token,assessment.family_id,()=>renderPdf(htmlDocuments[locale]));
        if(rendered.status==="paused"){
          if(getConfig().reportStorage==="filesystem")for(const key of attemptedKeys)await removePrivatePdf(key).catch(()=>{});
          return {status:"paused"};
        }
        const key=`${assessment.id}.${renderToken}.${locale}.pdf.enc`;keys[locale]=key;attemptedKeys.add(key);
        if(getConfig().reportStorage==="database")pdfs[locale]=rendered.value;
        else await writePrivatePdf(key,rendered.value);
      }
      const outcome=await transaction(async client=>{
        const familyLock=await client.query("SELECT id FROM families WHERE id=$1 AND region=$2 FOR UPDATE",[assessment.family_id,getConfig().region]);
        if(!familyLock.rows[0])throw new Error("Family deleted");
        const claim=await client.query(LOCK_LIVE_REPORT_CLAIM_SQL,[job.id,token]);
        if(!claim.rows[0])throw new Error("Report claim expired or family deleted");
        if(syntheticTest){
          const members=await getSyntheticTestFamilyMembers(String(assessment.family_id),getConfig().region,client);
          const current=await client.query<SyntheticSourceIdentity>("SELECT id,respondent_id,respondent_role FROM assessments WHERE id=ANY($1::uuid[]) AND family_id=$2 AND region=$3 AND triad_round_id IS NOT DISTINCT FROM $4::uuid AND submitted_at IS NOT NULL FOR SHARE",[publishIds,assessment.family_id,getConfig().region,assessment.triad_round_id??null]);
          if(!members||current.rows.length!==sourceIdentities.length||!syntheticSourcesMatch(current.rows,members)||
            current.rows.some(row=>!sourceIdentities.some(source=>source.id===row.id&&source.respondent_id===row.respondent_id&&source.respondent_role===row.respondent_role)))rejectSyntheticScope();
        }
        const consent=await client.query<{scopes:unknown}>(ACTIVE_CONSENT_ROWS_SQL,[assessment.family_id]);
        if(!hasGranted(consent.rows,[PARENT_REPORT_SCOPE])){
          await client.query("UPDATE report_jobs SET state='paused', lease_until=NULL, claim_token=NULL, last_error_code='PARENT_REPORT_CONSENT_REQUIRED', attempts=GREATEST(attempts-1,0) WHERE id=$1 AND claim_token=$2 AND state='running'",[job.id,token]);
          return "paused" as const;
        }
        if(triadSelection&&payload.generationMode==="ai"){
          const current=await client.query<{id:string}>(AI_CONSENT_IDS_SQL,[assessment.family_id]);
          if(!sameConsentIds(triadSelection.consentIds,current.rows))return "ai_consent_changed" as const;
        }
        if(getConfig().reportStorage==="database")for(const locale of ["zh-CN","zh-HK"] as const){
          await writePrivatePdf(keys[locale]!,pdfs[locale]!,client);
        }
        await client.query("INSERT INTO reports(id,assessment_id,family_id,region,payload,pdf_keys,created_at,html_documents) VALUES($1,$1,$2,$3,$4,$5,$6,$7) ON CONFLICT(assessment_id) DO NOTHING",[assessment.id,assessment.family_id,getConfig().region,JSON.stringify(payload),JSON.stringify(keys),assessment.submitted_at,JSON.stringify(htmlDocuments)]);
        await client.query("UPDATE assessments SET status='published' WHERE id=ANY($1::uuid[])",[publishIds]);
        await client.query("UPDATE report_jobs SET state='done',lease_until=NULL,last_error_code=NULL WHERE id=$1 AND claim_token=$2",[job.id,token]);
        await client.query("INSERT INTO audit_events(region,action,entity_id) VALUES($1,'report.auto_published',$2)",[getConfig().region,assessment.id]);
        return "published" as const;
      });
      if(outcome==="ai_consent_changed"){
        if(getConfig().reportStorage==="filesystem"){
          const published=await query<{pdf_keys:Record<Locale,string>}>("SELECT pdf_keys FROM reports WHERE assessment_id=$1 AND region=$2",[assessment.id,getConfig().region]);
          const referenced=new Set(Object.values(published[0]?.pdf_keys??{}));
          for(const key of attemptedKeys){
            if(referenced.has(key))continue;
            if(await removePrivatePdf(key).catch(()=>undefined)==="done")attemptedKeys.delete(key);
          }
        }
        payload={...payload,...triadTemplateSelection(triadSelection!.sources,snapshot.advice,"ai_consent_changed")};
        continue;
      }
      if(outcome==="paused"){
        if(getConfig().reportStorage==="filesystem")for(const key of attemptedKeys)await removePrivatePdf(key).catch(()=>{});
        return {status:"paused"};
      }
      return {status:"published"};
    }
    throw new Error("Report rendering did not converge");
  }catch{
    const terminal=unboundTriad||blockCode!==null||job.attempts>=3;
    const reason=blockCode??(unboundTriad?"TRIAD_SOURCES_UNBOUND":job.attempt_limit_reached?"REPORT_ATTEMPTS_EXHAUSTED":"REPORT_GENERATION_FAILED");
    const failureSql=`WITH changed AS (
      UPDATE report_jobs SET state=$1,lease_until=NULL,available_at=now()+interval '10 seconds',last_error_code=$4
      WHERE id=$2 AND claim_token=$3 AND state='running' RETURNING assessment_id,source_assessment_ids,available_at
    ), failed_assessments AS (
      UPDATE assessments SET status='failed' WHERE $1='failed' AND status='queued'
        AND id IN (SELECT unnest(COALESCE(source_assessment_ids,ARRAY[assessment_id])) FROM changed) RETURNING id
    ) SELECT assessment_id,source_assessment_ids,available_at FROM changed`;
    const failureValues=[terminal?"failed":"ready",job.id,token,reason];
    const changed=terminal?await transaction(async client=>{
      await client.query("SELECT f.id FROM families f JOIN assessments a ON a.family_id=f.id WHERE a.id=$1 AND f.region=$2 FOR UPDATE OF f",[job.assessment_id,getConfig().region]);
      return (await client.query(failureSql,failureValues)).rows;
    }):await query(failureSql,failureValues);
    if(getConfig().reportStorage==="filesystem"&&attemptedKeys.size){
      // COMMIT may succeed even if its response is lost. The job update above
      // waits for that transaction before deciding which files are unreferenced.
      const published=changed.length?[]:await query<{pdf_keys:Record<Locale,string>}>("SELECT pdf_keys FROM reports WHERE assessment_id=$1 AND region=$2",[job.assessment_id,getConfig().region]);
      const referenced=new Set(Object.values(published[0]?.pdf_keys??{}));
      for(const key of attemptedKeys)if(!referenced.has(key))await removePrivatePdf(key).catch(()=>{});
    }
    console.error("nova_report_generation_failed",{region:getConfig().region,attempt:job.attempts});
    if(!changed[0])return unclaimedJobResult(job.id);
    return terminal?{status:"terminal"}:{status:"retry_at",retryAt:new Date(changed[0].available_at??Date.now()+10000).toISOString()};
  }
}
