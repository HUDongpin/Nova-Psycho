import type { Actor,Locale,ScaleDefinition,StoredAnswer } from "../domain/types";
import { text } from "../domain/types";
import { answerVisible } from "../domain/scoring";
import { TRIAD_BUNDLE,staffOnlyText } from "../domain/triad-report";
import { stagedTriadScaleIds } from "../domain/triad-scales";
import { effectiveDemo, instrumentWriteBlockReason } from "../domain/validation";
import { reportRetryBlocker } from "../domain/report-retry";
import { formatJoinCode } from "./triad";
import { ageAt,canInviteFamilyMembers,canManageFamilyReports,familyScope,iso,type FamilyRow } from "./access";
import { consentScopeGrantedSql, effectiveScopesSelect, grantedScopes } from "./consent";
import { getConfig } from "./config";
import { query } from "./db";
import { reportSummary } from "./reports";
import { syntheticRetakeCapability } from "./synthetic-retake";
import { isSyntheticTestActorForFamily } from "./synthetic-testing";

function intakeResponseSections(scale:ScaleDefinition,answers:Record<string,StoredAnswer>,locale:Locale,age?:number){
  const sections:{title:string;items:{itemId:string;label:string;responses:string[]}[]}[]=[];
  const pages=new Map<string,typeof sections[number]>();
  for(const item of scale.items){
    if(!answerVisible(answers,item,age))continue;
    const value=answers[item.id];
    const responses=typeof value==="string"?[value]:typeof value==="number"||Array.isArray(value)
      ?(typeof value==="number"?[value]:value).flatMap(selected=>{
        const choice=item.choices.find(candidate=>candidate.value===selected);
        return choice?[text(choice.label,locale)]:[];
      }):[];
    if(!responses.length)responses.push(locale==="zh-HK"?(item.required?"未回答":"未填寫（選填）"):(item.required?"未回答":"未填写（选填）"));
    const key=item.page??"assessment";
    let section=pages.get(key);
    if(!section){section={title:item.pageTitle?text(item.pageTitle,locale):text(scale.title,locale),items:[]};pages.set(key,section);sections.push(section);}
    section.items.push({itemId:item.id,label:text(item.label,locale),responses});
  }
  return sections;
}

export async function workspaceFor(actor:Actor,locale:Locale){
  const scope=familyScope(actor),care=["admin","staff","parent"].includes(actor.role),team=["admin","staff"].includes(actor.role);
  const families=await query<FamilyRow&{assigned_name:string|null}>(`SELECT f.*,(SELECT u.name FROM users u WHERE u.id=f.assigned_to AND u.region=f.region) AS assigned_name FROM families f WHERE ${scope.sql} ORDER BY f.created_at DESC`,scope.values);
  const ids=families.map(f=>f.id);
  const familyById=new Map(families.map(f=>[f.id,f]));
  const syntheticFamilies=new Set((await Promise.all(ids.map(async id=>await isSyntheticTestActorForFamily(actor,id)?id:null))).filter((id):id is string=>id!==null));
  const [members,consents,assessments,reports,goals,observations,scales,staff,content,alerts,triadAnswers,rounds,revisionJobs]=await Promise.all([
    query("SELECT m.family_id,u.id,u.name,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.family_id=ANY($1::uuid[]) AND NOT u.disabled",[ids]),
    query<{family_id:string;scopes:unknown}>(`SELECT c.family_id, ${effectiveScopesSelect("c")} AS scopes FROM consents c WHERE c.family_id=ANY($1::uuid[]) AND c.revoked_at IS NULL`,[ids]),
    query(`SELECT a.id,a.family_id,a.respondent_id,a.respondent_role,a.scale_version_id,a.status,a.created_at,a.submitted_at,a.triad_round_id,a.respondent_context,j.id AS triad_job_id,f.child_name,u.name AS respondent_name,s.definition,r.id AS report_id,COALESCE(a.snapshot->'score'->'reviewFlags','[]'::jsonb) AS review_flags,CASE WHEN a.snapshot->'score'->'reviewFlags' ? 'age_mismatch' AND jsonb_typeof(a.answers->'c_age')='number' THEN a.answers->'c_age' ELSE NULL END AS stated_age,
      COALESCE(a.snapshot->>'syntheticTest'='true',false) AS synthetic_test,j.state AS job_state,COALESCE(a.snapshot<>'null'::jsonb,false) AS has_snapshot,COALESCE(a.answers<>'null'::jsonb,false) AS has_answers,a.submitted_at IS NOT NULL AS has_submission,
      COALESCE(a.snapshot->'scale'->>'bundle'=$5,false) AS is_triad,(a.triad_round_id IS NOT NULL AND j.source_assessment_ids IS NOT NULL) AS has_round_sources,
      COALESCE((SELECT COUNT(DISTINCT s2.respondent_role)=3 FROM assessments s2 WHERE s2.triad_round_id=a.triad_round_id AND s2.submitted_at IS NOT NULL),false) AS round_ready,
      ${consentScopeGrantedSql("a.family_id","parent_report")} AS has_consent
      FROM assessments a JOIN families f ON f.id=a.family_id JOIN users u ON u.id=a.respondent_id JOIN scales s ON s.id=a.scale_version_id LEFT JOIN LATERAL (SELECT * FROM report_jobs WHERE assessment_id=a.id OR a.id=ANY(source_assessment_ids) ORDER BY report_version DESC NULLS LAST,created_at DESC LIMIT 1) j ON true LEFT JOIN LATERAL (SELECT id FROM reports WHERE (report_version IS NOT NULL AND triad_round_id=a.triad_round_id) OR (report_version IS NULL AND assessment_id=COALESCE(j.assessment_id,a.id)) ORDER BY report_version DESC NULLS LAST,created_at DESC LIMIT 1) r ON true WHERE a.family_id=ANY($1::uuid[]) AND a.region=$2 AND ($3::boolean OR a.respondent_id=$4) ORDER BY a.created_at DESC`,[ids,actor.region,care,actor.id,TRIAD_BUNDLE]),
    care?query(`SELECT * FROM reports WHERE family_id=ANY($1::uuid[]) AND region=$2 AND ${consentScopeGrantedSql("reports.family_id","parent_report")} ORDER BY created_at DESC`,[ids,actor.region]):Promise.resolve([]),
    care?query("SELECT * FROM goals WHERE family_id=ANY($1::uuid[]) ORDER BY created_at DESC, id ASC",[ids]):Promise.resolve([]),
    team?query("SELECT o.*,u.name AS author_name FROM observations o LEFT JOIN users u ON u.id=o.created_by WHERE o.family_id=ANY($1::uuid[]) ORDER BY o.created_at DESC",[ids]):Promise.resolve([]),
    query("SELECT * FROM scales ORDER BY created_at DESC"),
    team?query("SELECT id,name FROM users WHERE region=$1 AND role='staff' AND NOT disabled ORDER BY name",[actor.region]):Promise.resolve([]),
    actor.role==="admin"?query("SELECT id,kind,version,library_key,created_at FROM content_versions ORDER BY created_at DESC"):Promise.resolve([]),
    team?query(`SELECT a.id,a.family_id,f.child_name,a.created_at,a.viewed_at FROM staff_alerts a JOIN families f ON f.id=a.family_id WHERE a.region=$1 AND (${scope.sql}) AND a.resolved_at IS NULL ORDER BY a.created_at DESC`,scope.values):Promise.resolve([]),
    team?query("SELECT a.id,a.family_id,a.respondent_role,a.submitted_at,a.answers,a.snapshot->'score'->'age' AS age,COALESCE(NULLIF(a.snapshot->'scale','null'::jsonb),s.definition) AS definition FROM assessments a JOIN scales s ON s.id=a.scale_version_id WHERE a.family_id=ANY($1::uuid[]) AND a.region=$2 AND a.answers IS NOT NULL AND a.submitted_at IS NOT NULL AND s.definition->>'bundle'=$3 ORDER BY a.submitted_at DESC,a.id",[ids,actor.region,TRIAD_BUNDLE]):Promise.resolve([]),
    care?query("SELECT DISTINCT ON (family_id) id,family_id,report_workflow FROM triad_rounds WHERE family_id=ANY($1::uuid[]) AND region=$2 ORDER BY family_id,created_at DESC,id DESC",[ids,actor.region]):Promise.resolve([]),
    care?query("SELECT j.id,a.family_id,j.triad_round_id,j.report_version,j.source_assessment_ids,j.state,r.id AS report_id FROM report_jobs j JOIN assessments a ON a.id=j.assessment_id LEFT JOIN reports r ON r.job_id=j.id WHERE a.family_id=ANY($1::uuid[]) AND a.region=$2 AND j.report_version IS NOT NULL ORDER BY j.report_version DESC",[ids,actor.region]):Promise.resolve([])
  ]);
  const scopesByFamily=new Map<string,{scopes:unknown}[]>();
  for(const row of consents as {family_id:string;scopes:unknown}[]){
    const list=scopesByFamily.get(row.family_id)??[];
    list.push({scopes:row.scopes});
    scopesByFamily.set(row.family_id,list);
  }
  const retakeEntries=actor.role==="parent"?await Promise.all([...syntheticFamilies].map(async id=>[id,await syntheticRetakeCapability(actor,id)] as const)):[];
  const retakes=new Map(retakeEntries);
  const scopedFamilies=families.map(f=>{
    const canInviteMembers=canInviteFamilyMembers(actor,f);
    const showCode=actor.role==="parent"||canInviteMembers;
    const granted=grantedScopes(scopesByFamily.get(f.id)??[]);
    const consentChoices={assessment:granted.has("assessment"),sensitiveData:granted.has("sensitive_data"),parentReport:granted.has("parent_report"),aiProcessing:granted.has("ai_processing")};
    const activeRound=rounds.find(row=>row.family_id===f.id);
    const staffTask=activeRound?assessments.find(task=>task.triad_round_id===activeRound.id&&task.respondent_role==="teacher"):null;
    const activeRoundOpen=!!activeRound&&new Set(assessments.filter(task=>task.triad_round_id===activeRound.id&&task.submitted_at).map(task=>task.respondent_role)).size<3;
    const canStartStaffObservation=actor.role==="staff"&&canManageFamilyReports(actor,f)&&activeRound?.report_workflow==="parent_first_v1"&&(!staffTask||staffTask.status==="pending");
    return {activeRoundOpen,reportWorkflow:activeRound?.report_workflow??"legacy_triad",activeRoundId:activeRound?.id??null,canStartStaffObservation,...(retakes.get(f.id)?{syntheticRetake:retakes.get(f.id)!}:{}),id:f.id,familyName:f.family_name,childName:f.child_name,age:ageAt(f.birth_date),birthDate:f.birth_date,grade:f.grade,region:f.region,guardianLabel:care?f.guardian_label:"",assignedTo:team?f.assigned_to:null,assignedName:team?f.assigned_name??null:null,canInviteMembers,joinCode:showCode&&f.join_code?formatJoinCode(f.join_code):null,createdAt:iso(f.created_at),consent:consentChoices.assessment&&consentChoices.sensitiveData,consents:consentChoices,members:members.filter(m=>m.family_id===f.id&&(care||m.id===actor.id)).map(m=>({id:m.id,name:m.name,role:m.role}))};
  });
  const reportPhase=(row:typeof assessments[number],status:string):"waiting"|"reporting"|"consent"|null=>{
    const triad=(row.definition as ScaleDefinition).bundle===TRIAD_BUNDLE;
    const parentReport=row.has_consent===true;
    const roundReady=row.round_ready===true;
    if(status==="submitted")return !parentReport?"consent":row.job_state==="ready"||row.job_state==="running"?"reporting":null;
    if(status==="published"&&!parentReport)return "consent";
    if(status==="queued"&&!parentReport&&(!triad||roundReady))return "consent";
    if(!triad||status!=="queued")return null;
    return row.triad_round_id&&row.triad_job_id?"reporting":"waiting";
  };
  const scopedReports=reports.map(r=>reportSummary(r,locale));
  const privacyHeldReports=new Set(scopedReports.filter(report=>report.privacyRefreshRequired).map(report=>String(report.id)));
  const scopedAssessments=assessments.map(a=>{
    const parentReport=a.has_consent===true;
    const privacyRefreshRequired=care&&parentReport&&typeof a.report_id==="string"&&privacyHeldReports.has(a.report_id);
    const ownReport=care&&parentReport&&a.report_id&&!privacyRefreshRequired?String(a.report_id):null;
    const status=a.status;
    const syntheticTest=status==="pending"?syntheticFamilies.has(a.family_id):a.synthetic_test===true;
    const responseBlockedReason=status==="pending"&&!syntheticTest?instrumentWriteBlockReason(a.definition as ScaleDefinition,getConfig().mode):null;
    const family=familyById.get(a.family_id);
    const canRetryReport=!!family&&canManageFamilyReports(actor,family)&&status==="failed"&&reportRetryBlocker({status,jobState:a.job_state??null,hasSnapshot:a.has_snapshot===true,hasAnswers:a.has_answers===true,hasSubmission:a.has_submission===true,isTriad:a.is_triad===true,hasRoundSources:a.has_round_sources===true,hasConsent:a.has_consent===true})===null;
    const reviewFlags=team&&Array.isArray(a.review_flags)?a.review_flags.filter((flag:unknown):flag is "age_mismatch"=>flag==="age_mismatch"):[];
    const statedAge=reviewFlags.includes("age_mismatch")&&typeof a.stated_age==="number"&&Number.isInteger(a.stated_age)?a.stated_age:undefined;
    return {roundId:a.triad_round_id??null,respondentContext:a.respondent_context??"family_member",id:a.id,familyId:a.family_id,childName:a.child_name,respondentId:a.respondent_id,respondentName:a.respondent_name,respondentRole:a.respondent_role,scaleVersionId:a.scale_version_id,scaleTitle:text((a.definition as ScaleDefinition).title,locale),status,phase:reportPhase(a,status),createdAt:iso(a.created_at),submittedAt:iso(a.submitted_at),reportId:ownReport,...(privacyRefreshRequired?{privacyRefreshRequired:true}:{}),canRespond:a.respondent_id===actor.id&&a.status==="pending"&&!responseBlockedReason,...(responseBlockedReason?{responseBlockedReason}:{}),...(syntheticTest?{syntheticTest:true}:{}),canRetryReport,reviewFlags,statedAge};
  });
  const reportJobs=revisionJobs.map(job=>{
    const family=familyById.get(job.family_id),hasConsent=grantedScopes(scopesByFamily.get(job.family_id)??[]).has("parent_report");
    return {id:job.id,familyId:job.family_id,roundId:job.triad_round_id,version:Number(job.report_version),sourceRoles:assessments.filter(task=>(job.source_assessment_ids as string[]).includes(task.id)).map(task=>task.respondent_role),state:hasConsent?job.state:"paused",reportId:hasConsent?job.report_id??null:null,canRetry:hasConsent&&job.state==="failed"&&!!family&&canManageFamilyReports(actor,family)};
  });
  return {reportJobs,user:actor,region:actor.region,mode:getConfig().mode,families:scopedFamilies,assessments:scopedAssessments,reports:scopedReports,
    scales:scales.filter(s=>(s.definition as ScaleDefinition).regions.includes(actor.region)).map(s=>{const d=s.definition as ScaleDefinition;return {...(d.bundle===TRIAD_BUNDLE?{reportWorkflow:Object.values(stagedTriadScaleIds).includes(s.id)?"parent_first_v1":"legacy_triad"}:{}),id:s.id,scaleId:s.scale_id,version:s.version,title:text(d.title,locale),description:text(d.description,locale),demo:effectiveDemo(d),minAge:d.minAge,maxAge:d.maxAge,roles:d.roles,retakeDays:d.retakeDays,source:d.source,rights:d.rights,status:s.status,...(Object.values(stagedTriadScaleIds).includes(s.id)?{isDefaultVersion:true}:{})};}),
    goals:goals.map(g=>({id:g.id,familyId:g.family_id,title:g.title,detail:g.detail,status:g.status,createdAt:iso(g.created_at)})),
    observations:observations.map(o=>({id:o.id,familyId:o.family_id,body:o.body,createdAt:iso(o.created_at),authorName:o.author_name??""})),staff,
    contentVersions:content.map(c=>({id:c.id,kind:c.kind,version:c.version,libraryKey:typeof c.library_key==="string"?c.library_key:null,createdAt:iso(c.created_at)})),
    alerts:alerts.map(alert=>({id:alert.id,familyId:alert.family_id,childName:alert.child_name,createdAt:iso(alert.created_at),viewedAt:iso(alert.viewed_at??null)})),
    staffNotes:triadAnswers.flatMap(row=>staffOnlyText(row.definition as ScaleDefinition,(row.answers??{}) as Record<string,StoredAnswer>).map(note=>({familyId:row.family_id,assessmentId:typeof row.id==="string"?row.id:"",itemId:note.itemId,label:text(note.label,locale),value:note.value}))),
    ...(team?{staffIntakeResponses:triadAnswers.flatMap(row=>{
      const scale=row.definition as ScaleDefinition;
      const role=row.respondent_role;
      if(scale.resultMode!=="support-intake"||!row.submitted_at||!familyById.has(row.family_id)||!["parent","student","teacher"].includes(role))return [];
      return [{familyId:row.family_id as string,assessmentId:row.id as string,role:role as "parent"|"student"|"teacher",submittedAt:iso(row.submitted_at)!,sections:intakeResponseSections(scale,(row.answers??{}) as Record<string,StoredAnswer>,locale,typeof row.age==="number"?row.age:undefined)}];
    })}:{}),
    summary:{families:families.length,pendingAssessments:assessments.filter(a=>a.status==="pending").length,publishedReports:reports.length,activeGoals:goals.filter(g=>g.status==="active").length,riskReports:scopedReports.filter(r=>r.risk).length}
  };
}
