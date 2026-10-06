import type { Actor,Locale,ScaleDefinition,StoredAnswer } from "../domain/types";
import { text } from "../domain/types";
import { TRIAD_BUNDLE,staffOnlyText } from "../domain/triad-report";
import { formatJoinCode } from "./triad";
import { ageAt,familyScope,iso,type FamilyRow } from "./access";
import { getConfig } from "./config";
import { query } from "./db";
import { reportSummary } from "./reports";

// The combined report row stays on the parent assessment. Child and teacher
// rows borrow that id once their trio is complete, so the list can show 已完成
// and 查看报告 without creating a second report.
type TriadRow={id:string;family_id:string;respondent_role:string;submitted_at:Date|string|null;report_id:string|null;definition:unknown};
function sharedTriadReports(rows:TriadRow[]){
  const assigned=new Map<string,string>();
  const grouped=new Map<string,typeof rows>();
  for(const row of rows){
    const definition=row.definition as ScaleDefinition;
    if(definition.bundle!==TRIAD_BUNDLE||!row.submitted_at)continue;
    const list=grouped.get(row.family_id)??[];
    list.push(row);grouped.set(row.family_id,list);
  }
  for(const list of grouped.values()){
    const waiting=new Map<string,typeof list>();
    const ordered=[...list].sort((a,b)=>new Date(a.submitted_at??0).getTime()-new Date(b.submitted_at??0).getTime()||String(a.id).localeCompare(String(b.id)));
    for(const row of ordered){
      const queue=waiting.get(row.respondent_role)??[];
      queue.push(row);waiting.set(row.respondent_role,queue);
      const student=waiting.get("student")?.[0],parent=waiting.get("parent")?.[0],teacher=waiting.get("teacher")?.[0];
      if(!student||!parent||!teacher||!parent.report_id)continue;
      const reportId=String(parent.report_id);
      assigned.set(student.id,reportId);assigned.set(parent.id,reportId);assigned.set(teacher.id,reportId);
      for(const role of ["student","parent","teacher"])waiting.get(role)!.shift();
    }
  }
  return assigned;
}
export async function workspaceFor(actor:Actor,locale:Locale){
  const scope=familyScope(actor),care=["admin","staff","parent"].includes(actor.role),team=["admin","staff"].includes(actor.role);
  const families=await query<FamilyRow>(`SELECT f.* FROM families f WHERE ${scope.sql} ORDER BY f.created_at DESC`,scope.values);
  const ids=families.map(f=>f.id);
  const [members,consents,assessments,reports,goals,observations,scales,staff,content,alerts,triadAnswers]=await Promise.all([
    query("SELECT m.family_id,u.id,u.name,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.family_id=ANY($1::uuid[]) AND NOT u.disabled",[ids]),
    query("SELECT DISTINCT family_id FROM consents WHERE family_id=ANY($1::uuid[]) AND revoked_at IS NULL",[ids]),
    query(`SELECT a.id,a.family_id,a.respondent_id,a.respondent_role,a.scale_version_id,a.status,a.created_at,a.submitted_at,f.child_name,u.name AS respondent_name,s.definition,r.id AS report_id FROM assessments a JOIN families f ON f.id=a.family_id JOIN users u ON u.id=a.respondent_id JOIN scales s ON s.id=a.scale_version_id LEFT JOIN reports r ON r.assessment_id=a.id WHERE a.family_id=ANY($1::uuid[]) AND a.region=$2 AND ($3::boolean OR a.respondent_id=$4) ORDER BY a.created_at DESC`,[ids,actor.region,care,actor.id]),
    care?query("SELECT * FROM reports WHERE family_id=ANY($1::uuid[]) AND region=$2 ORDER BY created_at DESC",[ids,actor.region]):Promise.resolve([]),
    care?query("SELECT * FROM goals WHERE family_id=ANY($1::uuid[]) ORDER BY created_at DESC, id ASC",[ids]):Promise.resolve([]),
    team?query("SELECT o.*,u.name AS author_name FROM observations o LEFT JOIN users u ON u.id=o.created_by WHERE o.family_id=ANY($1::uuid[]) ORDER BY o.created_at DESC",[ids]):Promise.resolve([]),
    query("SELECT * FROM scales ORDER BY created_at DESC"),
    team?query("SELECT id,name FROM users WHERE region=$1 AND role IN ('admin','staff') AND NOT disabled ORDER BY name",[actor.region]):Promise.resolve([]),
    actor.role==="admin"?query("SELECT id,kind,version,created_at FROM content_versions ORDER BY created_at DESC"):Promise.resolve([]),
    team?query("SELECT a.id,a.family_id,f.child_name,a.created_at FROM staff_alerts a JOIN families f ON f.id=a.family_id WHERE a.region=$1 AND a.viewed_at IS NULL ORDER BY a.created_at DESC",[actor.region]):Promise.resolve([]),
    team?query("SELECT a.family_id,a.answers,s.definition FROM assessments a JOIN scales s ON s.id=a.scale_version_id WHERE a.family_id=ANY($1::uuid[]) AND a.region=$2 AND a.answers IS NOT NULL AND s.definition->>'bundle'=$3",[ids,actor.region,TRIAD_BUNDLE]):Promise.resolve([])
  ]);
  const showCode=actor.role==="parent"||actor.role==="admin"||actor.role==="staff";
  const scopedFamilies=families.map(f=>({id:f.id,familyName:f.family_name,childName:f.child_name,age:ageAt(f.birth_date),birthDate:f.birth_date,grade:f.grade,region:f.region,guardianLabel:care?f.guardian_label:"",assignedTo:team?f.assigned_to:null,joinCode:showCode&&f.join_code?formatJoinCode(f.join_code):null,createdAt:iso(f.created_at),consent:consents.some(c=>c.family_id===f.id),members:members.filter(m=>m.family_id===f.id&&(care||m.id===actor.id)).map(m=>({id:m.id,name:m.name,role:m.role}))}));
  const triadPhase=(row:typeof assessments[number],status:string)=>{
    const definition=row.definition as ScaleDefinition;
    if(definition.bundle!==TRIAD_BUNDLE||status!=="queued")return null;
    const roles=new Set(assessments.filter(item=>item.family_id===row.family_id&&(item.definition as ScaleDefinition).bundle===TRIAD_BUNDLE&&item.submitted_at).map(item=>item.respondent_role));
    return roles.has("student")&&roles.has("parent")&&roles.has("teacher")?"reporting":"waiting";
  };
  const sharedReports=care?sharedTriadReports(assessments as TriadRow[]):new Map<string,string>();
  const scopedAssessments=assessments.map(a=>{
    const ownReport=care&&a.report_id?String(a.report_id):null;
    const sharedReport=!ownReport&&a.submitted_at&&(a.status==="published"||a.status==="queued")?sharedReports.get(a.id)??null:null;
    const status=sharedReport&&a.status==="queued"?"published":a.status;
    return {id:a.id,familyId:a.family_id,childName:a.child_name,respondentId:a.respondent_id,respondentName:a.respondent_name,respondentRole:a.respondent_role,scaleVersionId:a.scale_version_id,scaleTitle:text((a.definition as ScaleDefinition).title,locale),status,phase:triadPhase(a,status),createdAt:iso(a.created_at),submittedAt:iso(a.submitted_at),reportId:ownReport??(status==="published"?sharedReport:null),canRespond:a.respondent_id===actor.id&&a.status==="pending"};
  });
  const scopedReports=reports.map(r=>reportSummary(r,locale));
  return {user:actor,region:actor.region,mode:getConfig().mode,families:scopedFamilies,assessments:scopedAssessments,reports:scopedReports,
    scales:scales.filter(s=>(s.definition as ScaleDefinition).regions.includes(actor.region)).map(s=>{const d=s.definition as ScaleDefinition;return {id:s.id,scaleId:s.scale_id,version:s.version,title:text(d.title,locale),description:text(d.description,locale),demo:d.demo,minAge:d.minAge,maxAge:d.maxAge,roles:d.roles,retakeDays:d.retakeDays,source:d.source,rights:d.rights,status:s.status};}),
    goals:goals.map(g=>({id:g.id,familyId:g.family_id,title:g.title,detail:g.detail,status:g.status,createdAt:iso(g.created_at)})),
    observations:observations.map(o=>({id:o.id,familyId:o.family_id,body:o.body,createdAt:iso(o.created_at),authorName:o.author_name??""})),staff,
    contentVersions:content.map(c=>({id:c.id,kind:c.kind,version:c.version,createdAt:iso(c.created_at)})),
    alerts:alerts.map(alert=>({id:alert.id,familyId:alert.family_id,childName:alert.child_name,createdAt:iso(alert.created_at)})),
    staffNotes:triadAnswers.flatMap(row=>staffOnlyText(row.definition as ScaleDefinition,(row.answers??{}) as Record<string,StoredAnswer>).map(note=>({familyId:row.family_id,label:text(note.label,locale),value:note.value}))),
    summary:{families:families.length,pendingAssessments:assessments.filter(a=>a.status==="pending").length,publishedReports:reports.length,activeGoals:goals.filter(g=>g.status==="active").length,riskReports:scopedReports.filter(r=>r.risk).length}
  };
}
