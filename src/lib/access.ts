import type { PoolClient } from "pg";
import type { Actor } from "../domain/types";
import { ACTIVE_CONSENT_ROWS_SQL, PARTICIPATION_SCOPES, hasGranted } from "./consent";
import { getConfig } from "./config";
import { query } from "./db";
import { HttpError, validateId } from "./http";
export interface FamilyRow {
  id:string;region:"CN"|"HK";family_name:string;child_name:string;birth_date:string;grade:string;guardian_label:string;assigned_to:string|null;join_code?:string|null;created_at:Date;
}
export function canManageFamilyReports(actor:Actor,family:Pick<FamilyRow,"region"|"assigned_to">):boolean{
  return family.region===actor.region&&(actor.role==="admin"||(actor.role==="staff"&&family.assigned_to===actor.id));
}
export function canInviteFamilyMembers(actor:Actor,family:Pick<FamilyRow,"region"|"assigned_to">):boolean{
  return family.region===actor.region&&(actor.role==="admin"||(actor.role==="staff"&&family.assigned_to===actor.id));
}
export function familyScope(actor:Actor,start=1):{sql:string;values:unknown[]}{
  const region=`f.region=$${start}`;
  if(actor.role==="admin")return {sql:region,values:[actor.region]};
  // Assignee, or — only while the family has no assignee — regional staff during an unresolved alert.
  // Acknowledgement does not end that fallback; resolving the alert does. An alert never opens an assigned family to other staff.
  if(actor.role==="staff")return {sql:`${region} AND (f.assigned_to=$${start+1} OR (f.assigned_to IS NULL AND EXISTS(SELECT 1 FROM staff_alerts sa WHERE sa.family_id=f.id AND sa.region=$${start} AND sa.resolved_at IS NULL)))`,values:[actor.region,actor.id]};
  return {sql:`${region} AND EXISTS(SELECT 1 FROM memberships m WHERE m.family_id=f.id AND m.user_id=$${start+1} AND m.role=$${start+2})`,values:[actor.region,actor.id,actor.role]};
}
export async function familyFor(actor:Actor,id:string,client?:PoolClient):Promise<FamilyRow>{
  validateId(id);const scope=familyScope(actor,2);
  const sql=`SELECT f.* FROM families f WHERE f.id=$1 AND ${scope.sql}`,values=[id,...scope.values];
  const rows=client?(await client.query<FamilyRow>(sql,values)).rows:await query<FamilyRow>(sql,values);
  if(!rows[0])throw new HttpError(404,"未找到该家庭或没有访问权限。","NOT_FOUND");return rows[0];
}
const SERVICE_ZONE={CN:"Asia/Shanghai",HK:"Asia/Hong_Kong"} as const;
function localCalendar(at:Date,region:"CN"|"HK"):{year:number;month:number;day:number}{
  // CN and HK are UTC+8, so 16:00Z is already the next local morning. Age uses that
  // calendar date, never UTC and never a client-supplied age.
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:SERVICE_ZONE[region],calendar:"gregory",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(at);
  const value=(type:Intl.DateTimeFormatPartTypes)=>Number(parts.find(part=>part.type===type)?.value);
  return {year:value("year"),month:value("month"),day:value("day")};
}
export function ageAt(birthDate:string,at=new Date()):number{
  const region=getConfig().region;
  if(region!=="CN"&&region!=="HK")throw new Error("NOVA_REGION must be CN or HK");
  const today=localCalendar(at,region);
  const [year,month,day]=birthDate.slice(0,10).split("-").map(Number);
  let age=today.year-year;
  if(today.month<month||(today.month===month&&today.day<day))age-=1;
  return age;
}
export const iso=(value:Date|string|null):string|null=>value===null?null:new Date(value).toISOString();
// Answering stores the child's responses, so both participation and sensitive-data
// consent are required. A legacy combined row still satisfies both.
export async function consentFor(familyId:string):Promise<boolean>{
  const rows=await query<{scopes:unknown}>(ACTIVE_CONSENT_ROWS_SQL,[familyId]);
  return hasGranted(rows,PARTICIPATION_SCOPES);
}
