import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { Actor,AdviceLibrary,AssessmentSnapshot,Locale,ReportTemplate,RespondentRole,ScaleDefinition } from "../domain/types";
import { text } from "../domain/types";
import { statedAgeMismatch } from "../domain/age-review";
import { scoreAssessment,ScoringError,validateAnswers } from "../domain/scoring";
import { completionIssues,completionRules } from "../domain/completion";
import { surveyDefinition } from "../domain/survey";
import { titleEmphasis } from "../domain/survey-presentation";
import { surveySupplements } from "../domain/survey-supplements";
import { TRIAD_BUNDLE, triadRolesReady } from "../domain/triad-report";
import { reportRetryBlocker } from "../domain/report-retry";
import { lockRegistrationActor,queueTriadReport,requireRegistrationConsent,resolveTriadAssignment } from "./triad";
import { effectiveDemo, ensureAdviceReferences, instrumentWriteBlockReason, isKnownTriadInstrument } from "../domain/validation";
import { ageAt,canManageFamilyReports,consentFor,familyFor } from "./access";
import { ACTIVE_CONSENT_ROWS_SQL, PARENT_REPORT_SCOPE, PARTICIPATION_SCOPES, grantedScopes, hasGranted } from "./consent";
import { audit } from "./auth";
import { getConfig } from "./config";
import { TRIAD_LIBRARY_KEY } from "./content-seed";
import { currentContent,getScale,lockContent } from "./content";
import { query,transaction } from "./db";
import { HttpError,requireRole,validateId } from "./http";
import { isSyntheticTestActorForFamily } from "./synthetic-testing";
function storedScale(value:unknown):ScaleDefinition|undefined{
  if(typeof value==="string"){try{return JSON.parse(value) as ScaleDefinition;}catch{return undefined;}}
  return value&&typeof value==="object"?value as ScaleDefinition:undefined;
}
// Handing back an older parent form would publish service-team writing that the requested version keeps for staff.
function parentStaffWritingWouldLeak(requested:ScaleDefinition,pending:ScaleDefinition|undefined):boolean{
  if(!pending||requested.id!=="growth-parent"||pending.id!=="growth-parent")return false;
  const pendingReport=new Map(pending.items.map(item=>[item.id,item.report]));
  return requested.items.some(item=>item.report==="staff"&&pendingReport.get(item.id)==="words");
}
const answerSchema=z.record(z.string(),z.union([z.number(),z.array(z.number()).max(20),z.string().max(2000),z.null()])).transform(record=>{
  const answers:Record<string,number|number[]|string>={};
  for(const [key,value] of Object.entries(record)){
    if(value===null)continue;
    if(typeof value==="string"){const trimmed=value.trim();if(trimmed)answers[key]=trimmed;continue;}
    if(Array.isArray(value)){if(value.length)answers[key]=value;continue;}
    answers[key]=value;
  }
  return answers;
});
export { surveyDefinition };
type SubmissionPhase = "waiting" | "reporting" | "consent" | null;
interface PhaseReader { query(sql:string,values?:unknown[]):Promise<{rows:Record<string,unknown>[]}> }
// Same predicate queueTriadReport uses, so a round is "ready" only when parent, student and teacher have all submitted.
const TRIAD_SUBMITTED_ROLES_SQL="SELECT id,respondent_role FROM assessments WHERE family_id=$1 AND region=$2 AND triad_round_id=$3 AND submitted_at IS NOT NULL ORDER BY respondent_role";
const REPORT_JOB_FOR_ASSESSMENT_SQL="SELECT id FROM report_jobs WHERE assessment_id=$1 OR $1=ANY(source_assessment_ids) LIMIT 1";
function poolPhaseReader():PhaseReader{
  return {query:async(sql,values)=>({rows:await query(sql,values??[]) as Record<string,unknown>[]})};
}
function clientPhaseReader(client:PoolClient):PhaseReader{
  return {query:async(sql,values)=>({rows:(await client.query(sql,values)).rows as Record<string,unknown>[]})};
}
function safetyGuidanceFor(snapshot:AssessmentSnapshot|null|undefined):boolean{
  return snapshot?.score?.risk===true;
}
// "waiting" is only the other triad roles. A finished round, or a single-role
// submission, with no parent_report grant is "consent" even though no job exists.
// A job that consent still allows is "reporting", including the 9-item demo.
// Effective scopes already drop purposes named in consent_scope_revocations.
async function submissionPhase(db:PhaseReader,assessmentId:string,familyId:string,roundId:string|null,status:string,scale:ScaleDefinition):Promise<SubmissionPhase>{
  if(status!=="queued"&&status!=="published")return null;
  const consent=await db.query(ACTIVE_CONSENT_ROWS_SQL,[familyId]);
  const parentReport=hasGranted(consent.rows,[PARENT_REPORT_SCOPE]);
  const triad=scale.bundle===TRIAD_BUNDLE;
  const submitted=triad&&roundId?await db.query(TRIAD_SUBMITTED_ROLES_SQL,[familyId,getConfig().region,roundId]):{rows:[]};
  const roundReady=triadRolesReady(submitted.rows.map(row=>String(row.respondent_role)));
  if(status==="published"&&!parentReport)return "consent";
  if(status==="queued"&&!parentReport&&(!triad||roundReady))return "consent";
  if(status!=="queued")return null;
  const jobs=await db.query(REPORT_JOB_FOR_ASSESSMENT_SQL,[assessmentId]);
  if(!triad)return jobs.rows[0]?"reporting":null;
  return jobs.rows[0]?"reporting":"waiting";
}
async function refuseDemoBesideOfficial(familyId:string,respondentId:string,region:"CN"|"HK",role:RespondentRole,age:number,client?:PoolClient){
  const read=async(sql:string,values:unknown[])=>client?(await client.query(sql,values)).rows:query(sql,values);
  const held=await read("SELECT a.id FROM assessments a JOIN scales s ON s.id=a.scale_version_id WHERE a.family_id=$1 AND a.respondent_id=$2 AND a.region=$3 AND COALESCE(s.definition->>'demo','false')<>'true' AND COALESCE(s.definition->'norm'->>'validated','false')='true' LIMIT 1",[familyId,respondentId,region]);
  if(held[0])throw new HttpError(409,"这位成员已经有正式问卷，不能再加一份演示卷。","DEMO_NOT_ASSIGNABLE");
  const official=await read("SELECT id FROM scales WHERE status='active' AND COALESCE(definition->>'demo','false')<>'true' AND COALESCE(definition->'norm'->>'validated','false')='true' AND (definition->'regions') ? $1 AND (definition->'roles') ? $2 AND (definition->>'minAge')::int<=$3 AND (definition->>'maxAge')::int>=$3 LIMIT 1",[region,role,age]);
  if(official[0])throw new HttpError(409,"正式问卷已经可以使用，不能再分配演示题。","DEMO_NOT_ASSIGNABLE");
}
async function admitInstrument(actor:Actor,familyId:string,scale:ScaleDefinition,action:"assign"|"draft"|"submit",client?:PoolClient):Promise<boolean>{
  const syntheticTest=await isSyntheticTestActorForFamily(actor,familyId,client);
  if(syntheticTest)return true;
  const reason=instrumentWriteBlockReason(scale,getConfig().mode);
  if(!reason)return false;
  if(reason==="UNVALIDATED_INSTRUMENT")throw new HttpError(409,"正式服务不能使用尚未验证常模的量表。","UNVALIDATED_INSTRUMENT");
  const message=action==="assign"?"正式服务环境不能分配演示量表。":action==="draft"?"正式服务环境不能收集演示量表答案。":"正式服务环境不能提交演示量表。";
  throw new HttpError(409,message,"DEMO_INSTRUMENT");
}
export async function createAssessment(actor:Actor,input:unknown){
  requireRole(actor.role,["admin","staff","parent"]);
  const d=z.object({familyId:z.string().uuid(),respondentId:z.string().uuid(),scaleVersionId:z.string().max(100),locale:z.enum(["zh-CN","zh-HK"])}).strict().parse(input);
  const family=await familyFor(actor,d.familyId),scale=await getScale(d.scaleVersionId);
  if(scale.status!=="active")throw new HttpError(409,"该量表版本已停用。","SCALE_RETIRED");
  await admitInstrument(actor,family.id,scale.definition,"assign");
  const members=await query("SELECT m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.family_id=$1 AND m.user_id=$2 AND NOT u.disabled AND u.region=$3",[d.familyId,d.respondentId,actor.region]);
  if(!members[0])throw new HttpError(422,"填答者未与此家庭建立授权关系。","INVALID_RESPONDENT");
  const role=members[0].role as RespondentRole;
  const age=ageAt(family.birth_date);
  if(scoreAssessment(scale.definition,{}, {age,region:actor.region,role}).status==="ineligible")throw new HttpError(422,"该量表不适用于孩子年龄、地区或填答者角色。","INELIGIBLE");
  if(scale.definition.demo&&!isKnownTriadInstrument(scale.definition))await refuseDemoBesideOfficial(family.id,d.respondentId,actor.region,role,age);
  return transaction(async client=>{
    // Serialize new tasks per family to enforce retake/pending rules under concurrent requests.
    const lock=await client.query("SELECT id FROM families WHERE id=$1 FOR UPDATE",[family.id]);
    if(!lock.rows[0])throw new HttpError(404,"该家庭已删除。","NOT_FOUND");
    await lockRegistrationActor(client,actor,"SHARE");
    await familyFor(actor,family.id,client);
    await admitInstrument(actor,family.id,scale.definition,"assign",client);
    const currentMember=await client.query("SELECT m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.family_id=$1 AND m.user_id=$2 AND NOT u.disabled AND u.region=$3 AND u.role=m.role FOR SHARE OF u,m",[family.id,d.respondentId,actor.region]);
    if(currentMember.rows[0]?.role!==role)throw new HttpError(422,"填答者未与此家庭建立授权关系。","INVALID_RESPONDENT");
    await lockContent(client);
    const currentScale=await client.query("SELECT status FROM scales WHERE id=$1",[d.scaleVersionId]);
    if(currentScale.rows[0]?.status!=="active")throw new HttpError(409,"该量表版本已停用。","SCALE_RETIRED");
    if(scale.definition.demo&&!isKnownTriadInstrument(scale.definition))await refuseDemoBesideOfficial(family.id,d.respondentId,actor.region,role,age,client);
    const triadVersions=scale.definition.bundle===TRIAD_BUNDLE;
    const pending=triadVersions
      ?await client.query("SELECT a.id,a.triad_round_id,a.scale_version_id,s.definition FROM assessments a JOIN scales s ON s.id=a.scale_version_id WHERE a.family_id=$1 AND a.respondent_id=$2 AND s.scale_id=$3 AND a.status='pending' ORDER BY a.created_at,a.id LIMIT 1",[family.id,d.respondentId,scale.definition.id])
      :await client.query("SELECT id,triad_round_id FROM assessments WHERE family_id=$1 AND respondent_id=$2 AND scale_version_id=$3 AND status='pending'",[family.id,d.respondentId,d.scaleVersionId]);
    if(pending.rows[0]&&parentStaffWritingWouldLeak(scale.definition,storedScale(pending.rows[0].definition)))throw new HttpError(409,"已有一份旧版家长问卷尚未提交，暂时不能分配新版。请联系服务人员核对旧任务；不要为切换版本而继续提交旧问卷。","PARENT_VERSION_PENDING");
    if(pending.rows[0]){
      if(scale.definition.bundle===TRIAD_BUNDLE&&!pending.rows[0].triad_round_id){
        const pendingScale=storedScale(pending.rows[0].definition);
        if(!pendingScale)throw new HttpError(409,"已有问卷版本尚未核实，请联系服务团队。","TRIAD_LEGACY_REVIEW_REQUIRED");
        const {roundId}=await resolveTriadAssignment(client,family.id,role,{requestedScale:pendingScale,preserveExisting:true});
        await client.query("UPDATE assessments SET triad_round_id=$1 WHERE id=$2",[roundId,pending.rows[0].id]);
      }
      return {id:pending.rows[0].id};
    }
    // Failed report generation still counts: the child already submitted answers.
    const last=triadVersions
      ?await client.query("SELECT a.submitted_at FROM assessments a JOIN scales s ON s.id=a.scale_version_id WHERE a.family_id=$1 AND a.respondent_id=$2 AND s.scale_id=$3 AND a.submitted_at IS NOT NULL ORDER BY a.submitted_at DESC LIMIT 1",[family.id,d.respondentId,scale.definition.id])
      :await client.query("SELECT submitted_at FROM assessments WHERE family_id=$1 AND respondent_id=$2 AND scale_version_id=$3 AND submitted_at IS NOT NULL ORDER BY submitted_at DESC LIMIT 1",[family.id,d.respondentId,d.scaleVersionId]);
    if(last.rows[0]&&Date.now()-new Date(last.rows[0].submitted_at).getTime()<scale.definition.retakeDays*86400000)throw new HttpError(409,`此量表建议至少间隔 ${scale.definition.retakeDays} 天复测。`,"RETAKE_INTERVAL");
    const assignment=triadVersions?await resolveTriadAssignment(client,family.id,role,{requestedScale:scale.definition}):null;
    const roundId=assignment?.roundId??null;
    const scaleVersionId=assignment?.scaleVersionId??d.scaleVersionId;
    const id=randomUUID();await client.query("INSERT INTO assessments(id,family_id,region,respondent_id,respondent_role,scale_version_id,locale,triad_round_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[id,family.id,actor.region,d.respondentId,role,scaleVersionId,d.locale,roundId]);return {id};
  });
}
async function ownAssessment(actor:Actor,id:string){
  validateId(id);const r=await query("SELECT a.*,s.definition,f.child_name,f.birth_date FROM assessments a JOIN scales s ON s.id=a.scale_version_id JOIN families f ON f.id=a.family_id JOIN memberships m ON m.family_id=f.id AND m.user_id=a.respondent_id WHERE a.id=$1 AND a.respondent_id=$2 AND a.region=$3 AND f.region=$3 AND m.role=$4",[id,actor.id,actor.region,actor.role]);
  if(!r[0])throw new HttpError(404,"未找到分配给您的测评。","NOT_FOUND");return r[0];
}
export async function assessmentDetail(actor:Actor,id:string,locale:Locale){
  const a=await ownAssessment(actor,id),s=a.definition as ScaleDefinition;
  const phase=await submissionPhase(poolPhaseReader(),id,String(a.family_id),a.triad_round_id??null,a.status,s);
  const safetyGuidance=a.status!=="pending"&&safetyGuidanceFor(a.snapshot);
  const emphasis=titleEmphasis(s,a.respondent_role,locale);
  const supplements=surveySupplements(s,locale);
  const syntheticTest=a.status==="pending"?await isSyntheticTestActorForFamily(actor,String(a.family_id)):a.snapshot?.syntheticTest===true;
  const responseBlockedReason=a.status==="pending"&&!syntheticTest?instrumentWriteBlockReason(s,getConfig().mode):null;
  const age=ageAt(String(a.birth_date).slice(0,10));
  return {id,status:a.status,...(responseBlockedReason?{responseBlockedReason}:{}),...(syntheticTest?{syntheticTest:true}:{}),childName:a.child_name,scaleTitle:text(s.title,locale),demo:effectiveDemo(s),description:text(s.description,locale),surveyJson:surveyDefinition(s,a.respondent_role,locale,{age}),...(s.bundle===TRIAD_BUNDLE?{completionRules:completionRules(s,age)}:{}),...(emphasis.length?{titleEmphasis:emphasis}:{}),...(supplements.length?{supplements}:{}),draftAnswers:a.status==="pending"?a.draft_answers:{},draftRevision:a.draft_revision,consentRequired:!await consentFor(a.family_id),phase,safetyGuidance};
}
export async function saveDraft(actor:Actor,id:string,input:unknown){
  const {answers,revision}=z.object({answers:answerSchema,acknowledged:z.literal(true),revision:z.number().int().nonnegative()}).strict().parse(input),a=await ownAssessment(actor,id);
  await admitInstrument(actor,String(a.family_id),a.definition,"draft");
  if(!await consentFor(a.family_id))throw new HttpError(409,"请先完成监护人授权。","GUARDIAN_CONSENT_REQUIRED");
  try{validateAnswers(a.definition,answers);}catch{throw new HttpError(422,"答案格式不符合量表要求。","INVALID_ANSWERS");}
  return transaction(async client=>{
    const lock=await client.query("SELECT id FROM families WHERE id=$1 FOR UPDATE",[a.family_id]);
    if(!lock.rows[0])throw new HttpError(404,"该家庭已删除。","NOT_FOUND");
    await lockRegistrationActor(client,actor,"SHARE");
    await requireRegistrationConsent(client,a.family_id);
    await admitInstrument(actor,String(a.family_id),a.definition,"draft",client);
    const r=await client.query("UPDATE assessments SET draft_answers=$1,draft_revision=draft_revision+1,acknowledged_at=COALESCE(acknowledged_at,now()) WHERE id=$2 AND respondent_id=$3 AND status='pending' AND draft_revision=$4 RETURNING id,draft_revision",[JSON.stringify(answers),id,actor.id,revision]);
    if(!r.rows[0])throw new HttpError(409,"草稿已在另一个页面更新或测评已提交，请重新载入并核对答案。","DRAFT_CONFLICT");return {ok:true,revision:r.rows[0].draft_revision};
  });
}
export async function submitAssessment(actor:Actor,id:string,input:unknown){
  const d=z.object({answers:answerSchema,acknowledged:z.literal(true),revision:z.number().int().nonnegative()}).strict().parse(input);const own=await ownAssessment(actor,id);
  const scale=own.definition as ScaleDefinition;
  await admitInstrument(actor,String(own.family_id),scale,"submit");
  const family=await familyFor(actor,own.family_id);
  const result=await transaction(async client=>{
    const lockedFamily=await client.query("SELECT id FROM families WHERE id=$1 FOR UPDATE",[family.id]);
    if(!lockedFamily.rows[0])throw new HttpError(404,"该家庭已删除。","NOT_FOUND");
    await lockRegistrationActor(client,actor,"SHARE");
    const syntheticTest=await admitInstrument(actor,family.id,scale,"submit",client);
    const locked=await client.query("SELECT a.*,r.id AS report_id FROM assessments a LEFT JOIN reports r ON r.assessment_id=a.id WHERE a.id=$1 AND a.respondent_id=$2 FOR UPDATE OF a",[id,actor.id]);
    const a=locked.rows[0];if(!a)throw new HttpError(404,"测评不存在。","NOT_FOUND");
    if(a.status!=="pending")return {id,status:a.status,reportId:a.report_id??null,phase:await submissionPhase(clientPhaseReader(client),id,a.family_id,a.triad_round_id??null,a.status,scale),safetyGuidance:safetyGuidanceFor(a.snapshot)};
    if(a.draft_revision!==d.revision)throw new HttpError(409,"草稿已在另一个页面更新，请重新载入并核对答案。","DRAFT_CONFLICT");
    const consent=await client.query(ACTIVE_CONSENT_ROWS_SQL,[a.family_id]);
    if(!hasGranted(consent.rows,PARTICIPATION_SCOPES))throw new HttpError(409,"请先完成测评与敏感资料的监护人授权。","GUARDIAN_CONSENT_REQUIRED");
    const scopes=grantedScopes(consent.rows);
    const age=ageAt(String(family.birth_date).slice(0,10));
    let score;try{score=scoreAssessment(scale,d.answers,{age,region:actor.region,role:a.respondent_role});}catch(e){if(e instanceof ScoringError)throw new HttpError(422,"答案格式不符合量表要求。","INVALID_ANSWERS");throw e;}
    if(syntheticTest)score={...score,demo:true};
    if(score.status==="ineligible")throw new HttpError(422,"当前量表不适用于此孩子。","INELIGIBLE");
    if(statedAgeMismatch(scale,d.answers,age))score={...score,reviewFlags:["age_mismatch" as const]};
    if(scale.items.some(item=>item.gate!==undefined&&d.answers[item.id]!==item.gate))throw new HttpError(422,"需要先同意参加这次了解，才能提交。","ENTRY_GATE");
    if(scale.bundle===TRIAD_BUNDLE&&score.status!=="valid")throw new HttpError(422,"请查看未完成的题目或资料不足的部分。","INCOMPLETE_TRIAD",undefined,completionIssues(completionRules(scale,age),d.answers));
    // Only a new submission depends on current content. Replays above retain the
    // accepted snapshot even when its retired scale's advice is later removed.
    await lockContent(client);
    const libraryKey=scale.bundle===TRIAD_BUNDLE?TRIAD_LIBRARY_KEY:null;
    const advice=await currentContent<AdviceLibrary>("advice",client,libraryKey),template=await currentContent<ReportTemplate>("template",client,libraryKey);
    try{ensureAdviceReferences(scale,advice.content);}catch{throw new HttpError(409,"量表的报告建议配置需要更新。","ADVICE_MISMATCH");}
    const roundId=scale.bundle===TRIAD_BUNDLE?(a.triad_round_id??(await resolveTriadAssignment(client,a.family_id,a.respondent_role,{requestedScale:scale,preserveExisting:true})).roundId):null;
    const submittedAt=new Date().toISOString();
    const snapshot:AssessmentSnapshot={scale,advice,template,score,childName:family.child_name,grade:family.grade,submittedAt,aiConsented:!syntheticTest&&scopes.has("ai_processing"),...(syntheticTest?{syntheticTest:true}:{})};
    await client.query("UPDATE assessments SET answers=$1,draft_answers='{}',snapshot=$2,status='queued',submitted_at=$3,acknowledged_at=COALESCE(acknowledged_at,$3),triad_round_id=$5 WHERE id=$4",[JSON.stringify(d.answers),JSON.stringify(snapshot),submittedAt,id,roundId]);
    if(scale.bundle===TRIAD_BUNDLE){
      if(score.risk){
        const alert=await client.query("INSERT INTO staff_alerts(id,family_id,region,assessment_id) VALUES($1,$2,$3,$4) ON CONFLICT(assessment_id) WHERE assessment_id IS NOT NULL DO NOTHING RETURNING id",[randomUUID(),a.family_id,actor.region,id]);
        if(alert.rows[0])await client.query("INSERT INTO audit_events(region,action,entity_id) VALUES($1,'triad.safety_notified',$2)",[actor.region,id]);
      }
      if(score.reviewFlags?.includes("age_mismatch"))await client.query("INSERT INTO audit_events(region,action,entity_id) VALUES($1,'triad.age_mismatch',$2)",[actor.region,id]);
      await queueTriadReport(client,a.family_id,roundId);
      return {id,status:"queued",reportId:null,phase:await submissionPhase(clientPhaseReader(client),id,a.family_id,roundId,"queued",scale),safetyGuidance:score.risk===true};
    }
    if(scopes.has(PARENT_REPORT_SCOPE))await client.query("INSERT INTO report_jobs(id,assessment_id) VALUES($1,$2) ON CONFLICT(assessment_id) DO NOTHING",[randomUUID(),id]);
    return {id,status:"queued",reportId:null,phase:await submissionPhase(clientPhaseReader(client),id,a.family_id,null,"queued",scale),safetyGuidance:score.risk===true};
  });await audit(actor,"assessment.submitted",id);return result;
}
export async function retryReport(actor:Actor,id:string){
  requireRole(actor.role,["admin","staff"]);validateId(id);
  const found=await query("SELECT family_id FROM assessments WHERE id=$1 AND region=$2",[id,actor.region]);
  if(!found[0])throw new HttpError(404,"未找到该测评。","NOT_FOUND");
  await familyFor(actor,found[0].family_id);
  const result=await transaction(async client=>{
    const familyLock=await client.query("SELECT id,region,assigned_to FROM families WHERE id=$1 AND region=$2 FOR UPDATE",[found[0].family_id,actor.region]);
    if(!familyLock.rows[0])throw new HttpError(404,"该家庭已删除。","NOT_FOUND");
    if(!canManageFamilyReports(actor,familyLock.rows[0]))throw new HttpError(404,"未找到该家庭或没有访问权限。","NOT_FOUND");
    await lockRegistrationActor(client,actor,"SHARE");
    const locked=await client.query("SELECT * FROM assessments WHERE id=$1 AND region=$2 FOR UPDATE",[id,actor.region]);
    const a=locked.rows[0];if(!a)throw new HttpError(404,"未找到该测评。","NOT_FOUND");
    const jobs=await client.query("SELECT * FROM report_jobs WHERE assessment_id=$1 OR $1=ANY(source_assessment_ids) FOR UPDATE",[id]);
    const job=jobs.rows[0];
    const consent=await client.query(ACTIVE_CONSENT_ROWS_SQL,[a.family_id]);
    const blocker=reportRetryBlocker({status:a.status,jobState:job?.state??null,hasSnapshot:a.snapshot!=null,hasAnswers:a.answers!=null,hasSubmission:a.submitted_at!=null,isTriad:a.snapshot?.scale?.bundle===TRIAD_BUNDLE,hasRoundSources:a.triad_round_id!=null&&job?.source_assessment_ids!=null,hasConsent:hasGranted(consent.rows,[PARENT_REPORT_SCOPE])});
    if(blocker){
      const messages={TRIAD_LEGACY_REVIEW_REQUIRED:"旧三方报告缺少已核实的轮次来源，请联系服务团队处理。",GUARDIAN_CONSENT_REQUIRED:"请先完成监护人授权。",REPORT_NOT_FAILED:"仅可重新排队生成失败的报告，不会重新开始作答。"};
      throw new HttpError(409,messages[blocker],blocker);
    }
    if(a.status==="queued"&&job?.state==="ready")return {id,status:"queued" as const,retried:false};
    await client.query("UPDATE assessments SET status='queued' WHERE id=ANY($1::uuid[]) AND status='failed'",[job.source_assessment_ids??[id]]);
    await client.query("UPDATE report_jobs SET state='ready',attempts=0,lease_until=NULL,claim_token=NULL,last_error_code=NULL,available_at=now() WHERE id=$1 AND state='failed'",[job.id]);
    return {id,status:"queued" as const,retried:true};
  });
  if(result.retried)await audit(actor,"report.retry_queued",id);
  return {id:result.id,status:result.status};
}
