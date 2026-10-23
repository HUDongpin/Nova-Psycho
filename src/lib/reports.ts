import type { Actor, Locale, ReportPayload } from "../domain/types";
import { text } from "../domain/types";
import { reportShowsDemo } from "../domain/report-html";
import { isTriadReport, reportNeedsPrivacyRefresh, reportPrivacyNotice } from "../domain/report-privacy";
import { familyFor,iso } from "./access";
import { ACTIVE_CONSENT_ROWS_SQL, PARENT_REPORT_SCOPE, hasGranted } from "./consent";
import { query } from "./db";
import { HttpError,requireRole,validateId } from "./http";
export function reportSummary(row:Record<string,unknown>,locale:Locale){
  const p=row.payload as ReportPayload;
  const combined=isTriadReport(p);
  const title=combined?(p.triad?.title??{"zh-CN":"孩子的成长了解","zh-HK":"孩子的成長了解"}):p.template.content.title;
  return {id:row.id,familyId:row.family_id,childName:p.childName,title:text(title,locale),respondentRole:p.score.respondentRole,scaleTitle:combined?(locale==="zh-HK"?"孩子、家長與教師":"孩子、家长与教师"):text(p.scale.title,locale),combined,...(p.scale.resultMode?{resultMode:p.scale.resultMode}:{}),privacyRefreshRequired:reportNeedsPrivacyRefresh(p),createdAt:iso(row.created_at as Date),generationMode:p.generationMode,risk:Boolean(p.triad?.safety?.length)||p.score.risk,demo:reportShowsDemo(p),
    dimensions:p.score.dimensions.map(d=>({key:d.key,label:text(d.label,locale),raw:d.raw,max:d.max,band:d.band?text(d.band.label,locale):locale==="zh-HK"?"資料不足":"资料不足"})),
    assessmentId:row.assessment_id,comparison:{...p.comparison,changes:p.comparison.changes?.map(c=>({...c,label:text(c.label,locale)}))}};
}
export async function reportFor(actor:Actor,id:string,locale:Locale="zh-CN"){
  requireRole(actor.role,["admin","staff","parent"]);validateId(id);
  const rows=await query("SELECT * FROM reports WHERE id=$1 AND region=$2",[id,actor.region]);if(!rows[0])throw new HttpError(404,"未找到报告。","NOT_FOUND");
  await familyFor(actor,rows[0].family_id);
  const grants=await query<{scopes:unknown}>(ACTIVE_CONSENT_ROWS_SQL,[rows[0].family_id]);
  if(!hasGranted(grants,[PARENT_REPORT_SCOPE]))throw new HttpError(409,"请先取得向家长提供综合报告的同意。","GUARDIAN_CONSENT_REQUIRED");
  if(reportNeedsPrivacyRefresh(rows[0].payload as ReportPayload))throw new HttpError(409,reportPrivacyNotice[locale],"REPORT_PRIVACY_REFRESH_REQUIRED");
  return rows[0] as {id:string;family_id:string;assessment_id:string;region:string;payload:ReportPayload;pdf_keys:Record<Locale,string>;html_documents:Record<Locale,string>;created_at:Date};
}
export function reportDetail(row:Awaited<ReturnType<typeof reportFor>>,locale:Locale){return {...reportSummary(row,locale),html:row.html_documents[locale],downloadUrl:`/api/reports/${row.id}/pdf?locale=${locale}`};}
