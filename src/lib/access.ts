import type { Actor } from "../domain/types";
import { query } from "./db";
import { HttpError, validateId } from "./http";
export interface FamilyRow {
  id:string;region:"CN"|"HK";family_name:string;child_name:string;birth_date:string;grade:string;guardian_label:string;assigned_to:string|null;created_at:Date;
}
export function familyScope(actor:Actor,start=1):{sql:string;values:unknown[]}{
  const region=`f.region=$${start}`;
  if(actor.role==="admin")return {sql:region,values:[actor.region]};
  if(actor.role==="staff")return {sql:`${region} AND f.assigned_to=$${start+1}`,values:[actor.region,actor.id]};
  return {sql:`${region} AND EXISTS(SELECT 1 FROM memberships m WHERE m.family_id=f.id AND m.user_id=$${start+1} AND m.role=$${start+2})`,values:[actor.region,actor.id,actor.role]};
}
export async function familyFor(actor:Actor,id:string):Promise<FamilyRow>{
  validateId(id);const scope=familyScope(actor,2);
  const rows=await query<FamilyRow>(`SELECT f.* FROM families f WHERE f.id=$1 AND ${scope.sql}`,[id,...scope.values]);
  if(!rows[0])throw new HttpError(404,"未找到该家庭或没有访问权限。","NOT_FOUND");return rows[0];
}
export function ageAt(birthDate:string,at=new Date()):number{
  const birth=new Date(`${birthDate}T00:00:00Z`);
  let age=at.getUTCFullYear()-birth.getUTCFullYear();
  if(at.getUTCMonth()<birth.getUTCMonth()||(at.getUTCMonth()===birth.getUTCMonth()&&at.getUTCDate()<birth.getUTCDate()))age--;
  return age;
}
export const iso=(value:Date|string|null):string|null=>value===null?null:new Date(value).toISOString();
export async function consentFor(familyId:string):Promise<boolean>{
  const rows=await query("SELECT id FROM consents WHERE family_id=$1 AND revoked_at IS NULL AND scopes @> '[\"assessment\",\"parent_report\",\"sensitive_data\"]'::jsonb LIMIT 1",[familyId]);return rows.length>0;
}
