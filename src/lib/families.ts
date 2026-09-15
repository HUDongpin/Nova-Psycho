import { randomBytes,randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor } from "../domain/types";
import { ageAt, familyFor } from "./access";
import { audit, hashPassword, hashToken } from "./auth";
import { getConfig } from "./config";
import { query, transaction } from "./db";
import { HttpError, requireRole } from "./http";
import { noticeVersion } from "./privacy";
const short=z.string().trim().min(1).max(100);
const familyInput=z.object({familyName:short,childName:short,birthDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),grade:short,guardianLabel:short,assignedTo:z.string().uuid().optional()}).strict();
export async function createFamily(actor:Actor,input:unknown){
  requireRole(actor.role,["admin","staff"]);const d=familyInput.parse(input);const age=ageAt(d.birthDate);
  if(!Number.isFinite(Date.parse(d.birthDate))||new Date(d.birthDate).toISOString().slice(0,10)!==d.birthDate||!Number.isInteger(age)||age<3||age>25)throw new HttpError(422,"请填写有效的孩子出生日期。","INVALID_BIRTHDATE");
  const assigned=actor.role==="staff"?actor.id:d.assignedTo??null;
  if(assigned && !(await query("SELECT id FROM users WHERE id=$1 AND region=$2 AND role IN ('staff','admin') AND NOT disabled",[assigned,actor.region])).length)throw new HttpError(422,"请选择本地区的服务人员。","INVALID_STAFF");
  const id=randomUUID();await query("INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label,assigned_to) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[id,actor.region,d.familyName,d.childName,d.birthDate,d.grade,d.guardianLabel,assigned]);await audit(actor,"family.created",id);return {id};
}
export async function recordConsent(actor:Actor,id:string,input:unknown){
  requireRole(actor.role,["admin","staff","parent"]);await familyFor(actor,id);
  const d=z.object({accepted:z.literal(true),guardianName:short,reference:z.string().trim().max(500).optional(),aiProcessing:z.boolean().optional().default(false)}).strict().parse(input);
  const offline=actor.role!=="parent";
  if(offline&&!d.reference)throw new HttpError(422,"请记录监护人已签署的线下授权凭据。","CONSENT_REFERENCE_REQUIRED");
  const scopes=["assessment","parent_report","sensitive_data",...(d.aiProcessing?["ai_processing"]:[])];
  await transaction(async client=>{
    const lock=await client.query("SELECT id FROM families WHERE id=$1 FOR UPDATE",[id]);
    if(!lock.rows[0])throw new HttpError(404,"该家庭已删除。","NOT_FOUND");
    await client.query("UPDATE consents SET revoked_at=now() WHERE family_id=$1 AND revoked_at IS NULL",[id]);
    await client.query("INSERT INTO consents(id,family_id,actor_id,guardian_name,method,reference,notice_version,scopes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[randomUUID(),id,actor.id,d.guardianName,offline?"offline_signed":"online_guardian",d.reference??null,noticeVersion,JSON.stringify(scopes)]);
  });await audit(actor,"consent.recorded",id);return {ok:true};
}
export async function deleteFamily(actor:Actor,id:string,input:unknown){
  requireRole(actor.role,["admin","parent"]);const family=await familyFor(actor,id);
  const d=z.object({confirmation:short}).strict().parse(input);if(d.confirmation!==family.child_name)throw new HttpError(422,"确认姓名不一致。","CONFIRMATION_MISMATCH");
  await transaction(async client=>{
    const lock=await client.query("SELECT id FROM families WHERE id=$1 FOR UPDATE",[id]);
    if(!lock.rows[0])throw new HttpError(404,"该家庭已删除。","NOT_FOUND");
    const members=await client.query("SELECT user_id FROM memberships WHERE family_id=$1",[id]);
    const files=await client.query("SELECT pdf_keys FROM reports WHERE family_id=$1",[id]);
    for(const row of files.rows)for(const key of Object.values(row.pdf_keys))await client.query("INSERT INTO file_deletion_jobs(file_key) VALUES($1) ON CONFLICT DO NOTHING",[key]);
    await client.query("DELETE FROM families WHERE id=$1 AND region=$2",[id,actor.region]);
    for(const row of members.rows){
      await client.query("DELETE FROM sessions WHERE user_id=$1",[row.user_id]);
      await client.query("DELETE FROM users WHERE id=$1 AND role IN ('parent','student','teacher') AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.user_id=users.id)",[row.user_id]);
    }
    await client.query("INSERT INTO audit_events(region,actor_id,action,entity_id) VALUES($1,$2,'family.deleted',$3)",[actor.region,actor.id,id]);
  });return {ok:true};
}
export async function createInvitation(actor:Actor,id:string,input:unknown){
  requireRole(actor.role,["admin","staff"]);await familyFor(actor,id);
  const {role}=z.object({role:z.enum(["parent","student","teacher"])}).strict().parse(input);
  const token=randomBytes(32).toString("hex"),expires=new Date(Date.now()+72*3600000);
  await transaction(async client=>{
    const lock=await client.query("SELECT id FROM families WHERE id=$1 FOR UPDATE",[id]);
    if(!lock.rows[0])throw new HttpError(404,"该家庭已删除。","NOT_FOUND");
    await client.query("INSERT INTO invitations(token_hash,family_id,role,expires_at,created_by) VALUES($1,$2,$3,$4,$5)",[hashToken(token),id,role,expires,actor.id]);
  });
  await audit(actor,"invitation.created",id);return {url:`${getConfig().publicUrl}/invite#token=${token}`,expiresAt:expires.toISOString()};
}
function invitationToken(token:unknown):string{if(typeof token!=="string"||!/^[a-f0-9]{64}$/.test(token))throw new HttpError(404,"邀请无效或已过期。","INVALID_INVITATION");return token;}
export async function invitationInfo(token:unknown){
  const rows=await query("SELECT f.family_name,i.role,f.region,i.expires_at FROM invitations i JOIN families f ON f.id=i.family_id WHERE i.token_hash=$1 AND i.expires_at>now() AND i.used_at IS NULL AND f.region=$2",[hashToken(invitationToken(token)),getConfig().region]);
  if(!rows[0])throw new HttpError(404,"邀请无效或已过期。","INVALID_INVITATION");
  const r=rows[0];return {familyName:r.family_name,role:r.role,region:r.region,expiresAt:r.expires_at};
}
export async function acceptInvitation(input:unknown):Promise<string>{
  const d=z.object({token:z.string(),name:short,username:z.string().trim().toLowerCase().regex(/^[a-z0-9_.@-]{3,100}$/),password:z.string().min(12).max(256)}).strict().parse(input);
  const tokenHash=hashToken(invitationToken(d.token));const passwordHash=await hashPassword(d.password);
  return transaction(async client=>{
    const candidate=await client.query("SELECT family_id FROM invitations WHERE token_hash=$1",[tokenHash]);
    if(!candidate.rows[0])throw new HttpError(404,"邀请无效或已过期。","INVALID_INVITATION");
    const familyLock=await client.query("SELECT id FROM families WHERE id=$1 AND region=$2 FOR UPDATE",[candidate.rows[0].family_id,getConfig().region]);
    if(!familyLock.rows[0])throw new HttpError(404,"邀请无效或已过期。","INVALID_INVITATION");
    const result=await client.query("SELECT i.* FROM invitations i JOIN families f ON f.id=i.family_id WHERE i.token_hash=$1 AND i.used_at IS NULL AND i.expires_at>now() AND f.region=$2 FOR UPDATE OF i",[tokenHash,getConfig().region]);
    const invite=result.rows[0];if(!invite)throw new HttpError(404,"邀请无效或已过期。","INVALID_INVITATION");
    const id=randomUUID();await client.query("INSERT INTO users(id,region,username,name,role,password_hash) VALUES($1,$2,$3,$4,$5,$6)",[id,getConfig().region,d.username,d.name,invite.role,passwordHash]);
    await client.query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,$3)",[invite.family_id,id,invite.role]);
    await client.query("UPDATE invitations SET used_at=now() WHERE token_hash=$1",[tokenHash]);return id;
  });
}
