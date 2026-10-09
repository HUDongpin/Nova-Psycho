import { randomBytes,randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import type { Actor, Locale, RespondentRole } from "../domain/types";
import { ageAt, canInviteFamilyMembers, familyFor } from "./access";
import { audit, hashPassword, hashToken } from "./auth";
import { getConfig } from "./config";
import { query, transaction } from "./db";
import { HttpError, requireRole, validateId } from "./http";
import { noticeVersion } from "./privacy";
import type { VerifiedClerkIdentity } from "./clerk-auth";
import { assertTriadRegistrationReady, joinTriadFamilyInTransaction, lockRegistrationActor, requireRegistrationConsent, type RegistrationFamily } from "./triad";
import { registrationName, registrationPassword, registrationUsername } from "../domain/registration";
const short=registrationName;
const familyInput=z.object({familyName:short,childName:short,birthDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),grade:short,guardianLabel:short,assignedTo:z.string().uuid().optional()}).strict();
export async function createFamily(actor:Actor,input:unknown){
  requireRole(actor.role,["admin","staff"]);const d=familyInput.parse(input);const age=ageAt(d.birthDate);
  if(!Number.isFinite(Date.parse(d.birthDate))||new Date(d.birthDate).toISOString().slice(0,10)!==d.birthDate||!Number.isInteger(age)||age<3||age>25)throw new HttpError(422,"请填写有效的孩子出生日期。","INVALID_BIRTHDATE");
  const assigned=actor.role==="staff"?actor.id:d.assignedTo??null;
  if(assigned && !(await query("SELECT id FROM users WHERE id=$1 AND region=$2 AND role='staff' AND NOT disabled",[assigned,actor.region])).length)throw new HttpError(422,"请选择本地区的有效工作人员。","INVALID_STAFF");
  const id=randomUUID();await query("INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label,assigned_to) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[id,actor.region,d.familyName,d.childName,d.birthDate,d.grade,d.guardianLabel,assigned]);await audit(actor,"family.created",id);return {id};
}
export async function assignFamily(actor:Actor,id:string,input:unknown){
  requireRole(actor.role,["admin"]);validateId(id);
  const {assignedTo}=z.object({assignedTo:z.string().uuid()}).strict().parse(input);
  return transaction(async client=>{
    const family=await client.query("SELECT id FROM families WHERE id=$1 AND region=$2 FOR UPDATE",[id,actor.region]);
    if(!family.rows[0])throw new HttpError(404,"未找到该家庭或没有访问权限。","NOT_FOUND");
    const staff=await client.query("SELECT id FROM users WHERE id=$1 AND region=$2 AND role='staff' AND NOT disabled FOR SHARE",[assignedTo,actor.region]);
    if(!staff.rows[0])throw new HttpError(422,"请选择本地区的有效工作人员。","INVALID_STAFF");
    await client.query("UPDATE families SET assigned_to=$1 WHERE id=$2 AND region=$3",[assignedTo,id,actor.region]);
    await client.query("INSERT INTO audit_events(region,actor_id,action,entity_id) VALUES($1,$2,'family.assigned',$3)",[actor.region,actor.id,id]);
    return {id,assignedTo};
  });
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
    const lock=await client.query("SELECT id FROM families WHERE id=$1 AND region=$2 FOR UPDATE",[id,actor.region]);
    if(!lock.rows[0])throw new HttpError(404,"该家庭已删除。","NOT_FOUND");
    const current=await lockRegistrationActor(client,actor);
    if(current.role==="parent"){
      const membership=await client.query("SELECT 1 FROM memberships WHERE family_id=$1 AND user_id=$2 AND role='parent'",[id,current.id]);
      if(!membership.rows[0])throw new HttpError(404,"未找到该家庭或没有访问权限。","NOT_FOUND");
    }
    if(getConfig().reportStorage==="filesystem"){
      const files=await client.query("SELECT pdf_keys FROM reports WHERE family_id=$1",[id]);
      for(const row of files.rows)for(const key of Object.values(row.pdf_keys))await client.query("INSERT INTO file_deletion_jobs(file_key) VALUES($1) ON CONFLICT DO NOTHING",[key]);
    }
    await client.query("DELETE FROM families WHERE id=$1 AND region=$2",[id,actor.region]);
    await client.query("INSERT INTO audit_events(region,actor_id,action,entity_id) VALUES($1,$2,'family.deleted',$3)",[actor.region,actor.id,id]);
  });return {ok:true};
}
export async function createInvitation(actor:Actor,id:string,input:unknown){
  requireRole(actor.role,["admin","staff"]);validateId(id);
  const {role}=z.object({role:z.enum(["parent","student","teacher"])}).strict().parse(input);
  const token=randomBytes(32).toString("hex"),expires=new Date(Date.now()+72*3600000);
  await transaction(async client=>{
    const lock=await client.query("SELECT id,region,assigned_to FROM families WHERE id=$1 AND region=$2 FOR UPDATE",[id,actor.region]);
    if(!lock.rows[0]||!canInviteFamilyMembers(actor,lock.rows[0]))throw new HttpError(404,"未找到该家庭或没有访问权限。","NOT_FOUND");
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
export async function acceptInvitation(input:unknown,locale:Locale="zh-CN"):Promise<string>{
  const d=z.object({token:z.string(),name:short,username:registrationUsername,password:registrationPassword}).strict().parse(input);
  const tokenHash=hashToken(invitationToken(d.token));const passwordHash=await hashPassword(d.password);
  return transaction(async client=>{
    const candidate=await client.query("SELECT family_id FROM invitations WHERE token_hash=$1",[tokenHash]);
    if(!candidate.rows[0])throw new HttpError(404,"邀请无效或已过期。","INVALID_INVITATION");
    const familyLock=await client.query<RegistrationFamily>("SELECT id,region,birth_date,join_code FROM families WHERE id=$1 AND region=$2 FOR UPDATE",[candidate.rows[0].family_id,getConfig().region]);
    if(!familyLock.rows[0])throw new HttpError(404,"邀请无效或已过期。","INVALID_INVITATION");
    const result=await client.query("SELECT i.* FROM invitations i JOIN families f ON f.id=i.family_id WHERE i.token_hash=$1 AND i.used_at IS NULL AND i.expires_at>now() AND f.region=$2 FOR UPDATE OF i",[tokenHash,getConfig().region]);
    const invite=result.rows[0];if(!invite)throw new HttpError(404,"邀请无效或已过期。","INVALID_INVITATION");
    if(invite.role!=="parent"){
      if(familyLock.rows[0].join_code)await assertTriadRegistrationReady(client,familyLock.rows[0]);
      else await requireRegistrationConsent(client,familyLock.rows[0].id);
    }
    const id=randomUUID();
    try {
      await client.query("INSERT INTO users(id,region,username,name,role,password_hash) VALUES($1,$2,$3,$4,$5,$6)",[id,getConfig().region,d.username,d.name,invite.role,passwordHash]);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "23505") throw new HttpError(409, "这个用户名已注册，请登录后接受邀请。", "USERNAME_TAKEN", "username");
      throw error;
    }
    return bindInvitedActor(client,{id,name:d.name,role:invite.role,region:getConfig().region},tokenHash,invite as LockedInvitation,familyLock.rows[0],locale);
  });
}

interface LockedInvitation {
  family_id: string;
  role: RespondentRole;
  used_at: Date | string | null;
  expires_at: Date | string;
  accepted_by: string | null;
}

async function lockInvitation(client: PoolClient, tokenHash: string): Promise<{ invite: LockedInvitation; family: RegistrationFamily }> {
  const candidate = await client.query<{ family_id: string }>("SELECT family_id FROM invitations WHERE token_hash=$1", [tokenHash]);
  if (!candidate.rows[0]) throw new HttpError(404, "邀请无效或已过期。", "INVALID_INVITATION");
  const family = await client.query<RegistrationFamily>("SELECT id,region,birth_date,join_code FROM families WHERE id=$1 AND region=$2 FOR UPDATE", [candidate.rows[0].family_id, getConfig().region]);
  if (!family.rows[0] || family.rows[0].region !== getConfig().region) throw new HttpError(404, "邀请无效或已过期。", "INVALID_INVITATION");
  const result = await client.query<LockedInvitation>("SELECT i.* FROM invitations i JOIN families f ON f.id=i.family_id WHERE i.token_hash=$1 AND f.region=$2 FOR UPDATE OF i", [tokenHash, getConfig().region]);
  const invite = result.rows[0];
  if (!invite || (!invite.used_at && new Date(invite.expires_at).getTime() <= Date.now())) throw new HttpError(404, "邀请无效或已过期。", "INVALID_INVITATION");
  return { invite, family: family.rows[0] };
}

async function bindInvitedActor(client: PoolClient, actor: Actor, tokenHash: string, invite: LockedInvitation, family: RegistrationFamily, locale: Locale): Promise<string> {
  if (actor.role !== invite.role) throw new HttpError(409, "邀请角色与当前账号不一致，请使用对应账号。", "ROLE_CONFLICT");
  const members = await client.query<{ user_id: string; role: RespondentRole }>("SELECT user_id,role FROM memberships WHERE family_id=$1", [family.id]);
  const own = members.rows.find(member => member.user_id === actor.id);
  if (invite.used_at) {
    if (invite.accepted_by !== actor.id || own?.role !== invite.role) throw new HttpError(404, "邀请无效或已过期。", "INVALID_INVITATION");
    return actor.id;
  }
  if (own && own.role !== actor.role) throw new HttpError(409, "这个账号在家庭中的角色不一致，请联系服务人员。", "ROLE_CONFLICT");
  if (actor.role !== "parent" && members.rows.some(member => member.role === actor.role && member.user_id !== actor.id)) throw new HttpError(409, actor.role === "student" ? "这个家庭已经有孩子进入了。" : "这个家庭已经有老师进入了。", "ROLE_TAKEN");
  if (family.join_code && actor.role !== "parent") {
    await assertTriadRegistrationReady(client, family);
    await joinTriadFamilyInTransaction(client, actor, family, locale);
  } else if (!own) {
    await client.query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,$3)", [family.id, actor.id, actor.role]);
  }
  await client.query("UPDATE invitations SET used_at=now(),accepted_by=$2 WHERE token_hash=$1", [tokenHash, actor.id]);
  await client.query("INSERT INTO audit_events(region,actor_id,action,entity_id) VALUES($1,$2,'invitation.accepted',$3)", [actor.region, actor.id, family.id]);
  return actor.id;
}

export async function acceptInvitationForActor(actor: Actor, input: unknown, locale: Locale = "zh-CN"): Promise<string> {
  requireRole(actor.role, ["parent", "student", "teacher"]);
  const { token } = z.object({ token: z.string() }).strict().parse(input);
  const tokenHash = hashToken(invitationToken(token));
  return transaction(async client => {
    const { invite, family } = await lockInvitation(client, tokenHash);
    const current = await lockRegistrationActor(client, actor);
    if (invite.role !== "parent") await requireRegistrationConsent(client, family.id);
    return bindInvitedActor(client, current, tokenHash, invite, family, locale);
  });
}

export async function acceptClerkInvitation(principal: VerifiedClerkIdentity, input: unknown, locale: Locale): Promise<string> {
  const data = z.object({ token: z.string(), name: short }).strict().parse(input);
  const tokenHash = hashToken(invitationToken(data.token));
  if (principal.region !== getConfig().region) throw new HttpError(403, "请使用账号所属地区的入口。", "REGION_MISMATCH");
  return transaction(async client => {
    const { invite, family } = await lockInvitation(client, tokenHash);
    if (invite.role !== "parent") await requireRegistrationConsent(client, family.id);
    if (family.join_code && invite.role !== "parent") await assertTriadRegistrationReady(client, family);
    const { createClerkUserInTransaction } = await import("./clerk-auth");
    const actor = await createClerkUserInTransaction(client, principal, data.name, invite.role);
    const current = await lockRegistrationActor(client, actor);
    return bindInvitedActor(client, current, tokenHash, invite, family, locale);
  });
}
