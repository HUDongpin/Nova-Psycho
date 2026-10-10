import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor,AdviceLibrary,AssessmentSnapshot,Locale,ReportTemplate,RespondentRole,ScaleDefinition } from "../domain/types";
import { text } from "../domain/types";
import { scoreAssessment,ScoringError,validateAnswers } from "../domain/scoring";
import { surveyDefinition } from "../domain/survey";
import { TRIAD_BUNDLE } from "../domain/triad-report";
import { reportRetryBlocker } from "../domain/report-retry";
import { queueTriadReport,triadRoundFor } from "./triad";
import { ensureAdviceReferences } from "../domain/validation";
import { ageAt,canManageFamilyReports,consentFor,familyFor } from "./access";
import { audit } from "./auth";
import { getConfig } from "./config";
import { currentContent,getScale,lockContent } from "./content";
import { query,transaction } from "./db";
import { HttpError,requireRole,validateId } from "./http";
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
async function refuseDemoBesideOfficial(familyId:string,respondentId:string,region:"CN"|"HK",role:RespondentRole,age:number){
  const held=await query("SELECT a.id FROM assessments a JOIN scales s ON s.id=a.scale_version_id WHERE a.family_id=$1 AND a.respondent_id=$2 AND a.region=$3 AND COALESCE(s.definition->>'demo','false')<>'true' LIMIT 1",[familyId,respondentId,region]);
  if(held[0])throw new HttpError(409,"这位成员已经有正式问卷，不能再加一份演示卷。","DEMO_NOT_ASSIGNABLE");
  const official=await query("SELECT id FROM scales WHERE status='active' AND COALESCE(definition->>'demo','false')<>'true' AND (definition->'regions') ? $1 AND (definition->'roles') ? $2 AND (definition->>'minAge')::int<=$3 AND (definition->>'maxAge')::int>=$3 LIMIT 1",[region,role,age]);
  if(official[0])throw new HttpError(409,"正式问卷已经可以使用，不能再分配演示题。","DEMO_NOT_ASSIGNABLE");
}
export async function createAssessment(actor:Actor,input:unknown){
  requireRole(actor.role,["admin","staff","parent"]);
  const d=z.object({familyId:z.string().uuid(),respondentId:z.string().uuid(),scaleVersionId:z.string().max(100),locale:z.enum(["zh-CN","zh-HK"])}).strict().parse(input);
  const family=await familyFor(actor,d.familyId),scale=await getScale(d.scaleVersionId);
  if(scale.status!=="active")throw new HttpError(409,"该量表版本已停用。","SCALE_RETIRED");
  if(scale.definition.demo&&getConfig().mode!=="demo")throw new HttpError(409,"正式服务环境不能分配演示量表。","DEMO_INSTRUMENT");
  const members=await query("SELECT m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.family_id=$1 AND m.user_id=$2 AND NOT u.disabled AND u.region=$3",[d.familyId,d.respondentId,actor.region]);
  if(!members[0])throw new HttpError(422,"填答者未与此家庭建立授权关系。","INVALID_RESPONDENT");
  const role=members[0].role as RespondentRole;
  const age=ageAt(family.birth_date);
  if(scoreAssessment(scale.definition,{}, {age,region:actor.region,role}).status==="ineligible")throw new HttpError(422,"该量表不适用于孩子年龄、地区或填答者角色。","INELIGIBLE");
  if(scale.definition.demo)await refuseDemoBesideOfficial(family.id,d.respondentId,actor.region,role,age);
  return transaction(async client=>{
    // Serialize new tasks per family to enforce retake/pending rules under concurrent requests.
    const lock=await client.query("SELECT id FROM families WHERE id=$1 FOR UPDATE",[family.id]);
    if(!lock.rows[0])throw new HttpError(404,"该家庭已删除。","NOT_FOUND");
    await lockContent(client);
    const currentScale=await client.query("SELECT status FROM scales WHERE id=$1",[d.scaleVersionId]);
    if(currentScale.rows[0]?.status!=="active")throw new HttpError(409,"该量表版本已停用。","SCALE_RETIRED");
    const pending=await client.query("SELECT id,triad_round_id FROM assessments WHERE family_id=$1 AND respondent_id=$2 AND scale_version_id=$3 AND status='pending'",[family.id,d.respondentId,d.scaleVersionId]);
    if(pending.rows[0]){
      if(scale.definition.bundle===TRIAD_BUNDLE&&!pending.rows[0].triad_round_id){
        const roundId=await triadRoundFor(client,family.id,role);
        await client.query("UPDATE assessments SET triad_round_id=$1 WHERE id=$2",[roundId,pending.rows[0].id]);
      }
      return {id:pending.rows[0].id};
    }
    // Failed report generation still counts: the child already submitted answers.
    const last=await client.query("SELECT submitted_at FROM assessments WHERE family_id=$1 AND respondent_id=$2 AND scale_version_id=$3 AND submitted_at IS NOT NULL ORDER BY submitted_at DESC LIMIT 1",[family.id,d.respondentId,d.scaleVersionId]);
    if(last.rows[0]&&Date.now()-new Date(last.rows[0].submitted_at).getTime()<scale.definition.retakeDays*86400000)throw new HttpError(409,`此量表建议至少间隔 ${scale.definition.retakeDays} 天复测。`,"RETAKE_INTERVAL");
    const roundId=scale.definition.bundle===TRIAD_BUNDLE?await triadRoundFor(client,family.id,role):null;
    const id=randomUUID();await client.query("INSERT INTO assessments(id,family_id,region,respondent_id,respondent_role,scale_version_id,locale,triad_round_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[id,family.id,actor.region,d.respondentId,role,d.scaleVersionId,d.locale,roundId]);return {id};
  });
}
async function ownAssessment(actor:Actor,id:string){
  validateId(id);const r=await query("SELECT a.*,s.definition,f.child_name,f.birth_date FROM assessments a JOIN scales s ON s.id=a.scale_version_id JOIN families f ON f.id=a.family_id JOIN memberships m ON m.family_id=f.id AND m.user_id=a.respondent_id WHERE a.id=$1 AND a.respondent_id=$2 AND a.region=$3 AND f.region=$3 AND m.role=$4",[id,actor.id,actor.region,actor.role]);
  if(!r[0])throw new HttpError(404,"未找到分配给您的测评。","NOT_FOUND");return r[0];
}
export async function assessmentDetail(actor:Actor,id:string,locale:Locale){
  const a=await ownAssessment(actor,id),s=a.definition as ScaleDefinition;
  return {id,status:a.status,childName:a.child_name,scaleTitle:text(s.title,locale),demo:s.demo,description:text(s.description,locale),surveyJson:surveyDefinition(s,a.respondent_role,locale),draftAnswers:a.status==="pending"?a.draft_answers:{},draftRevision:a.draft_revision,consentRequired:!await consentFor(a.family_id)};
}
export async function saveDraft(actor:Actor,id:string,input:unknown){
  const {answers,revision}=z.object({answers:answerSchema,acknowledged:z.literal(true),revision:z.number().int().nonnegative()}).strict().parse(input),a=await ownAssessment(actor,id);
  if(a.definition.demo&&getConfig().mode!=="demo")throw new HttpError(409,"正式服务环境不能收集演示量表答案。","DEMO_INSTRUMENT");
  if(!await consentFor(a.family_id))throw new HttpError(409,"请先完成监护人授权。","GUARDIAN_CONSENT_REQUIRED");
  try{validateAnswers(a.definition,answers);}catch{throw new HttpError(422,"答案格式不符合量表要求。","INVALID_ANSWERS");}
  const r=await query("UPDATE assessments SET draft_answers=$1,draft_revision=draft_revision+1,acknowledged_at=COALESCE(acknowledged_at,now()) WHERE id=$2 AND respondent_id=$3 AND status='pending' AND draft_revision=$4 RETURNING id,draft_revision",[JSON.stringify(answers),id,actor.id,revision]);
  if(!r[0])throw new HttpError(409,"草稿已在另一个页面更新或测评已提交，请重新载入并核对答案。","DRAFT_CONFLICT");return {ok:true,revision:r[0].draft_revision};
}
export async function submitAssessment(actor:Actor,id:string,input:unknown){
  const d=z.object({answers:answerSchema,acknowledged:z.literal(true),revision:z.number().int().nonnegative()}).strict().parse(input);const own=await ownAssessment(actor,id);
  const family=await familyFor(actor,own.family_id);const scale=own.definition as ScaleDefinition;
  if(scale.demo&&getConfig().mode!=="demo")throw new HttpError(409,"正式服务环境不能提交演示量表。","DEMO_INSTRUMENT");
  const result=await transaction(async client=>{
    const lockedFamily=await client.query("SELECT id FROM families WHERE id=$1 FOR UPDATE",[family.id]);
    if(!lockedFamily.rows[0])throw new HttpError(404,"该家庭已删除。","NOT_FOUND");
    const locked=await client.query("SELECT a.*,r.id AS report_id FROM assessments a LEFT JOIN reports r ON r.assessment_id=a.id WHERE a.id=$1 AND a.respondent_id=$2 FOR UPDATE OF a",[id,actor.id]);
    const a=locked.rows[0];if(!a)throw new HttpError(404,"测评不存在。","NOT_FOUND");
    if(a.status!=="pending")return {id,status:a.status,reportId:a.report_id??null};
    if(a.draft_revision!==d.revision)throw new HttpError(409,"草稿已在另一个页面更新，请重新载入并核对答案。","DRAFT_CONFLICT");
    const consent=await client.query("SELECT scopes FROM consents WHERE family_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",[a.family_id]);
    const scopes=consent.rows[0]?.scopes as string[]|undefined;
    if(!scopes||!["assessment","parent_report","sensitive_data"].every(s=>scopes.includes(s)))throw new HttpError(409,"请先完成监护人授权。","GUARDIAN_CONSENT_REQUIRED");
    let score;try{score=scoreAssessment(scale,d.answers,{age:ageAt(family.birth_date),region:actor.region,role:a.respondent_role});}catch(e){if(e instanceof ScoringError)throw new HttpError(422,"答案格式不符合量表要求。","INVALID_ANSWERS");throw e;}
    if(score.status==="ineligible")throw new HttpError(422,"当前量表不适用于此孩子。","INELIGIBLE");
    if(scale.items.some(item=>item.gate!==undefined&&d.answers[item.id]!==item.gate))throw new HttpError(422,"需要先同意参加这次了解，才能提交。","ENTRY_GATE");
    if(scale.bundle===TRIAD_BUNDLE&&score.status!=="valid")throw new HttpError(422,"还有必答部分没完成，或某个方面的有效回答不足。选择“不确定或不适用”不会被算进分数。","INCOMPLETE_TRIAD");
    // Only a new submission depends on current content. Replays above retain the
    // accepted snapshot even when its retired scale's advice is later removed.
    await lockContent(client);
    const advice=await currentContent<AdviceLibrary>("advice",client),template=await currentContent<ReportTemplate>("template",client);
    try{ensureAdviceReferences(scale,advice.content);}catch{throw new HttpError(409,"量表的报告建议配置需要更新。","ADVICE_MISMATCH");}
    const roundId=scale.bundle===TRIAD_BUNDLE?(a.triad_round_id??await triadRoundFor(client,a.family_id,a.respondent_role)):null;
    const submittedAt=new Date().toISOString();
    const snapshot:AssessmentSnapshot={scale,advice,template,score,childName:family.child_name,grade:family.grade,submittedAt,aiConsented:scopes.includes("ai_processing")};
    await client.query("UPDATE assessments SET answers=$1,draft_answers='{}',snapshot=$2,status='queued',submitted_at=$3,acknowledged_at=COALESCE(acknowledged_at,$3),triad_round_id=$5 WHERE id=$4",[JSON.stringify(d.answers),JSON.stringify(snapshot),submittedAt,id,roundId]);
    if(scale.bundle===TRIAD_BUNDLE){
      if(score.risk){
        const alert=await client.query("INSERT INTO staff_alerts(id,family_id,region,assessment_id) VALUES($1,$2,$3,$4) ON CONFLICT(assessment_id) WHERE assessment_id IS NOT NULL DO NOTHING RETURNING id",[randomUUID(),a.family_id,actor.region,id]);
        if(alert.rows[0])await client.query("INSERT INTO audit_events(region,action,entity_id) VALUES($1,'triad.safety_notified',$2)",[actor.region,id]);
      }
      await queueTriadReport(client,a.family_id,roundId);return {id,status:"queued",reportId:null};
    }
    await client.query("INSERT INTO report_jobs(id,assessment_id) VALUES($1,$2) ON CONFLICT(assessment_id) DO NOTHING",[randomUUID(),id]);return {id,status:"queued",reportId:null};
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
    const locked=await client.query("SELECT * FROM assessments WHERE id=$1 AND region=$2 FOR UPDATE",[id,actor.region]);
    const a=locked.rows[0];if(!a)throw new HttpError(404,"未找到该测评。","NOT_FOUND");
    const jobs=await client.query("SELECT * FROM report_jobs WHERE assessment_id=$1 OR $1=ANY(source_assessment_ids) FOR UPDATE",[id]);
    const job=jobs.rows[0];
    const consent=await client.query("SELECT scopes FROM consents WHERE family_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",[a.family_id]);
    const scopes=consent.rows[0]?.scopes as string[]|undefined;
    const blocker=reportRetryBlocker({status:a.status,jobState:job?.state??null,hasSnapshot:a.snapshot!=null,hasAnswers:a.answers!=null,hasSubmission:a.submitted_at!=null,isTriad:a.snapshot?.scale?.bundle===TRIAD_BUNDLE,hasRoundSources:a.triad_round_id!=null&&job?.source_assessment_ids!=null,hasConsent:!!scopes&&["assessment","parent_report","sensitive_data"].every(s=>scopes.includes(s))});
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
