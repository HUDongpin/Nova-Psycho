import type { Actor, Locale, ReportPayload } from "../domain/types";
import { text } from "../domain/types";
import { familyFor,iso } from "./access";
import { query } from "./db";
import { HttpError,requireRole,validateId } from "./http";
export function reportSummary(row:Record<string,unknown>,locale:Locale){
  const p=row.payload as ReportPayload;
  return {id:row.id,familyId:row.family_id,childName:p.childName,title:text(p.template.content.title,locale),respondentRole:p.score.respondentRole,scaleTitle:text(p.scale.title,locale),createdAt:iso(row.created_at as Date),generationMode:p.generationMode,risk:p.score.risk,demo:p.score.demo,
    dimensions:p.score.dimensions.map(d=>({key:d.key,label:text(d.label,locale),raw:d.raw,max:d.max,band:d.band?text(d.band.label,locale):locale==="zh-HK"?"資料不足":"资料不足"})),
    assessmentId:row.assessment_id,comparison:{...p.comparison,changes:p.comparison.changes?.map(c=>({...c,label:text(c.label,locale)}))}};
}
export async function reportFor(actor:Actor,id:string){
  requireRole(actor.role,["admin","staff","parent"]);validateId(id);
  const rows=await query("SELECT * FROM reports WHERE id=$1 AND region=$2",[id,actor.region]);if(!rows[0])throw new HttpError(404,"未找到报告。","NOT_FOUND");
  await familyFor(actor,rows[0].family_id);return rows[0] as {id:string;family_id:string;assessment_id:string;region:string;payload:ReportPayload;pdf_keys:Record<Locale,string>;html_documents:Record<Locale,string>;created_at:Date};
}
export function reportDetail(row:Awaited<ReturnType<typeof reportFor>>,locale:Locale){return {...reportSummary(row,locale),html:row.html_documents[locale],downloadUrl:`/api/reports/${row.id}/pdf?locale=${locale}`};}
