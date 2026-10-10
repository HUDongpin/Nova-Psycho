import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Actor, Locale, RespondentRole } from "../domain/types";
import { z } from "zod";
import { triadScales } from "../domain/triad-scales";
import { TRIAD_BUNDLE, triadRolesReady } from "../domain/triad-report";
import { pair } from "../domain/zh-pair";
import { parseAdvice, parseScale, parseTemplate } from "../domain/validation";
import { ageAt, familyFor } from "./access";
import { audit, hashPassword, limitLogin } from "./auth";
import { getConfig } from "./config";
import { query, transaction } from "./db";
import { HttpError, requireRole, validateId } from "./http";
import { noticeVersion } from "./privacy";
import type { VerifiedClerkIdentity } from "./clerk-auth";
import { formatJoinCode, joinCodeFormatMessage, parseJoinCode, registrationName, registrationPassword, registrationUsername } from "../domain/registration";
export { formatJoinCode } from "../domain/registration";

const SCALE_ID = { parent: "growth-parent@1.0.0", student: "growth-child@1.0.0", teacher: "growth-teacher@1.0.0" } as const;
const short = registrationName;
const username = registrationUsername;
const password = registrationPassword;
const grades = ["学前大班", "小学一至三年级", "小学四至六年级", "初中", "高中", "其他"] as const;
const relationships = ["母亲", "父亲", "祖父母或外祖父母", "其他主要照顾者"] as const;

function normalizeCode(code: string): string {
  const parsed = parseJoinCode(code);
  if (!parsed) throw new HttpError(422, joinCodeFormatMessage, "INVALID_JOIN_CODE_FORMAT", "code");
  return parsed;
}
function makeCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const body = [...randomBytes(8)].map(value => alphabet[value % alphabet.length]).join("");
  return `TOPE-${body}`;
}
function assertChildAge(birthDate: string): number {
  if (!Number.isFinite(Date.parse(birthDate)) || new Date(birthDate).toISOString().slice(0, 10) !== birthDate) throw new HttpError(422, "请填写有效的孩子出生日期。", "INVALID_BIRTHDATE");
  const age = ageAt(birthDate);
  if (!Number.isInteger(age) || age < 8 || age > 17) throw new HttpError(422, "孩子自查适用于 8 至 17 岁。三份问卷都要完成，请填写这个年龄范围内的出生日期。", "CHILD_AGE");
  return age;
}

export interface RegistrationFamily {
  id: string;
  region: "CN" | "HK";
  birth_date: string;
  join_code: string | null;
}

export async function lockRegistrationActor(client: PoolClient, actor: Actor): Promise<Actor> {
  const config = getConfig();
  if (actor.region !== config.region) throw new HttpError(403, "请使用账号所属地区的入口。", "REGION_MISMATCH");
  const result = await client.query<Actor & { disabled: boolean; demo: boolean }>("SELECT id,name,role,region,disabled,demo FROM users WHERE id=$1 FOR UPDATE", [actor.id]);
  const current = result.rows[0];
  if (!current || current.disabled || (config.mode !== "demo" && current.demo)) throw new HttpError(403, "账号已停用，请联系服务人员。", "ACCOUNT_REVOKED");
  if (current.region !== actor.region) throw new HttpError(403, "请使用账号所属地区的入口。", "REGION_MISMATCH");
  if (current.role !== actor.role) throw new HttpError(409, "账号角色已变更，请重新登录。", "ROLE_CONFLICT");
  return { id: current.id, name: current.name, role: current.role, region: current.region };
}

export async function requireRegistrationConsent(client: PoolClient, familyId: string): Promise<void> {
  const consent = await client.query("SELECT id FROM consents WHERE family_id=$1 AND revoked_at IS NULL AND scopes @> '[\"assessment\",\"parent_report\",\"sensitive_data\"]'::jsonb LIMIT 1", [familyId]);
  if (!consent.rows[0]) throw new HttpError(409, "请先由家长完成监护人授权。", "GUARDIAN_CONSENT_REQUIRED");
}

export async function assertTriadRegistrationReady(client: PoolClient, family: RegistrationFamily): Promise<void> {
  if (family.region !== getConfig().region) throw new HttpError(404, "家庭编号不正确或已失效。", "INVALID_JOIN_CODE");
  assertChildAge(String(family.birth_date).slice(0, 10));
  await requireRegistrationConsent(client, family.id);
}

async function familyByJoinCode(client: PoolClient, code: string): Promise<RegistrationFamily> {
  const result = await client.query<RegistrationFamily>("SELECT id,region,birth_date,join_code FROM families WHERE join_code=$1 AND region=$2 FOR UPDATE", [code, getConfig().region]);
  if (!result.rows[0] || result.rows[0].region !== getConfig().region) throw new HttpError(404, "家庭编号不正确或已失效。", "INVALID_JOIN_CODE");
  return result.rows[0];
}

export interface FamilyJoinResult { userId: string; familyId: string; assessmentId: string; alreadyMember: boolean }

// The caller holds the family lock and has validated the current account and consent.
export async function joinTriadFamilyInTransaction(client: PoolClient, actor: Actor, family: RegistrationFamily, locale: Locale): Promise<FamilyJoinResult> {
  requireRole(actor.role, ["student", "teacher"]);
  if (actor.region !== family.region || actor.region !== getConfig().region) throw new HttpError(404, "家庭编号不正确或已失效。", "INVALID_JOIN_CODE");
  const role = actor.role as "student" | "teacher";
  const members = await client.query<{ user_id: string; role: RespondentRole }>("SELECT user_id,role FROM memberships WHERE family_id=$1", [family.id]);
  const own = members.rows.find(member => member.user_id === actor.id);
  if (own && own.role !== role) throw new HttpError(409, "这个账号在家庭中的角色不一致，请联系服务人员。", "ROLE_CONFLICT");
  if (members.rows.some(member => member.role === role && member.user_id !== actor.id)) throw new HttpError(409, role === "student" ? "这个家庭已经有孩子进入了。" : "这个家庭已经有老师进入了。", "ROLE_TAKEN");
  if (own) {
    const existing = await client.query<{ id: string }>("SELECT id FROM assessments WHERE family_id=$1 AND respondent_id=$2 AND respondent_role=$3 AND scale_version_id=$4 AND region=$5 ORDER BY created_at DESC,id DESC LIMIT 1", [family.id, actor.id, role, SCALE_ID[role], actor.region]);
    if (existing.rows[0]) return { userId: actor.id, familyId: family.id, assessmentId: existing.rows[0].id, alreadyMember: true };
  }
  const scale = await client.query("SELECT id FROM scales WHERE id=$1 AND status='active'", [SCALE_ID[role]]);
  if (!scale.rows[0]) throw new HttpError(409, "问卷还没有准备好。", "SCALE_NOT_FOUND");
  const roundId = await triadRoundFor(client, family.id, role);
  if (!own) await client.query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,$3)", [family.id, actor.id, role]);
  const assessmentId = randomUUID();
  await client.query("INSERT INTO assessments(id,family_id,region,respondent_id,respondent_role,scale_version_id,locale,triad_round_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [assessmentId, family.id, actor.region, actor.id, role, SCALE_ID[role], locale, roundId]);
  await client.query("INSERT INTO audit_events(region,actor_id,action,entity_id) VALUES($1,$2,$3,$4)", [actor.region, actor.id, own ? "triad.initial_assessment_created" : "triad.member_joined", family.id]);
  return { userId: actor.id, familyId: family.id, assessmentId, alreadyMember: Boolean(own) };
}

export async function joinFamily(actor: Actor, input: unknown, locale: Locale): Promise<FamilyJoinResult> {
  requireRole(actor.role, ["student", "teacher"]);
  const data = z.object({ code: z.string() }).strict().parse(input);
  const code = normalizeCode(data.code);
  return transaction(async client => {
    const family = await familyByJoinCode(client, code);
    const current = await lockRegistrationActor(client, actor);
    await assertTriadRegistrationReady(client, family);
    return joinTriadFamilyInTransaction(client, current, family, locale);
  });
}

export async function joinClerkStudent(principal: VerifiedClerkIdentity, input: unknown, locale: Locale): Promise<FamilyJoinResult> {
  const data = z.object({ code: z.string(), name: short, role: z.literal("student") }).strict().parse(input);
  const code = normalizeCode(data.code);
  if (principal.region !== getConfig().region) throw new HttpError(403, "请使用账号所属地区的入口。", "REGION_MISMATCH");
  return transaction(async client => {
    const family = await familyByJoinCode(client, code);
    await assertTriadRegistrationReady(client, family);
    const { createClerkUserInTransaction } = await import("./clerk-auth");
    const actor = await createClerkUserInTransaction(client, principal, data.name, "student");
    const current = await lockRegistrationActor(client, actor);
    return joinTriadFamilyInTransaction(client, current, family, locale);
  });
}

export async function createParentFamily(actor: Actor, input: unknown, locale: Locale): Promise<{ userId: string; familyId: string; joinCode: string }> {
  requireRole(actor.role, ["parent"]);
  const data = z.object({ requestId: z.string().uuid(), relationship: z.enum(relationships), childName: short, birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), grade: z.enum(grades), accepted: z.literal(true) }).strict().parse(input);
  assertChildAge(data.birthDate);
  return transaction(async client => {
    const current = await lockRegistrationActor(client, actor);
    const existing = await client.query<{ id: string; join_code: string; child_name: string; birth_date: string; grade: string; guardian_label: string }>("SELECT id,join_code,child_name,birth_date,grade,guardian_label FROM families WHERE created_by=$1 AND creation_request_id=$2 AND region=$3", [current.id, data.requestId, current.region]);
    if (existing.rows[0]) {
      const prior = existing.rows[0];
      if (prior.child_name !== data.childName || String(prior.birth_date).slice(0, 10) !== data.birthDate || prior.grade !== data.grade || prior.guardian_label !== data.relationship) throw new HttpError(409, "这个创建请求已完成，但家庭资料与本次填写不同。请刷新并核对已有家庭。", "REQUEST_ID_CONFLICT");
      return { userId: current.id, familyId: prior.id, joinCode: formatJoinCode(prior.join_code) };
    }
    const scale = await client.query("SELECT id FROM scales WHERE id=$1 AND status='active'", [SCALE_ID.parent]);
    if (!scale.rows[0]) throw new HttpError(409, "家长问卷还没有准备好。", "SCALE_NOT_FOUND");
    const joinCode = await freshCode(client), familyId = randomUUID();
    await client.query("INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label,join_code,created_by,creation_request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [familyId, current.region, `${data.childName}的家庭`, data.childName, data.birthDate, data.grade, data.relationship, joinCode, current.id, data.requestId]);
    await client.query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,'parent')", [familyId, current.id]);
    await client.query("INSERT INTO consents(id,family_id,actor_id,guardian_name,method,notice_version,scopes) VALUES($1,$2,$3,$4,'online_guardian',$5,$6)", [randomUUID(), familyId, current.id, current.name, noticeVersion, JSON.stringify(["assessment", "parent_report", "sensitive_data"])]);
    const roundId = await triadRoundFor(client, familyId, "parent");
    await client.query("INSERT INTO assessments(id,family_id,region,respondent_id,respondent_role,scale_version_id,locale,triad_round_id) VALUES($1,$2,$3,$4,'parent',$5,$6,$7)", [randomUUID(), familyId, current.region, current.id, SCALE_ID.parent, locale, roundId]);
    await client.query("INSERT INTO audit_events(region,actor_id,action,entity_id) VALUES($1,$2,'triad.parent_started',$3)", [current.region, current.id, familyId]);
    return { userId: current.id, familyId, joinCode };
  });
}

export async function ensureTriadInstruments(): Promise<void> {
  await query("ALTER TABLE families ADD COLUMN IF NOT EXISTS join_code text");
  await query("CREATE UNIQUE INDEX IF NOT EXISTS families_join_code ON families(join_code) WHERE join_code IS NOT NULL");
  await query("UPDATE families SET join_code = 'TOPE-' || join_code WHERE join_code IS NOT NULL AND join_code !~ '^TOPE-'");
  await query("CREATE TABLE IF NOT EXISTS staff_alerts(id uuid PRIMARY KEY,family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,region text NOT NULL,assessment_id uuid,created_at timestamptz NOT NULL DEFAULT now(),viewed_at timestamptz,viewed_by uuid)");
  await query("ALTER TABLE staff_alerts ADD COLUMN IF NOT EXISTS viewed_at timestamptz");
  await query("ALTER TABLE staff_alerts ADD COLUMN IF NOT EXISTS viewed_by uuid");
  await query("CREATE UNIQUE INDEX IF NOT EXISTS staff_alerts_assessment ON staff_alerts(assessment_id) WHERE assessment_id IS NOT NULL");
  for (const scale of triadScales) {
    const parsed = parseScale(scale);
    await query("INSERT INTO scales(id,scale_id,version,definition) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING", [`${parsed.id}@${parsed.version}`, parsed.id, parsed.version, JSON.stringify(parsed)]);
  }
  const advice = parseAdvice({ title: pair("三方了解说明"), blocks: [{ id: "triad_context", title: pair("先看具体情境"), body: pair("这份报告把孩子、家长和老师的观察放在一起，不合成一个总分，也不做诊断。"), source: "Nova growth triad intake, 2026-10", dimensionKeys: ["cognition"] }] });
  const template = parseTemplate({ title: pair("孩子的成长了解"), introduction: pair("这份报告给家长阅读。它把孩子、家长和老师各自看到的情况放在一起。"), limitation: pair("这不是诊断，也没有临床常模。三方说法不同时，不代表有人说了谎。香港繁体文本是便于阅读的字形转换，不是另行验证的译本。"), nextStep: pair("可以挑一个小变化，和孩子一起试四周。如果报告开头有安全提示，请先处理安全。") });
  const existingAdvice = await query("SELECT id FROM content_versions WHERE kind='advice' LIMIT 1");
  if (!existingAdvice.length) await query("INSERT INTO content_versions(id,kind,version,content) VALUES($1,'advice','1.0.0',$2) ON CONFLICT(kind,version) DO NOTHING", [randomUUID(), JSON.stringify(advice)]);
  const existingTemplate = await query("SELECT id FROM content_versions WHERE kind='template' LIMIT 1");
  if (!existingTemplate.length) await query("INSERT INTO content_versions(id,kind,version,content) VALUES($1,'template','1.0.0',$2) ON CONFLICT(kind,version) DO NOTHING", [randomUUID(), JSON.stringify(template)]);
}

async function freshCode(client: PoolClient): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = makeCode();
    const taken = await client.query("SELECT 1 FROM families WHERE join_code=$1", [candidate]);
    if (!taken.rows[0]) return candidate;
  }
  throw new HttpError(503, "暂时无法分配家庭编号，请再试一次。", "JOIN_CODE");
}

// Callers hold the family lock, including when adopting a pre-round pending task.
export async function triadRoundFor(client: PoolClient, familyId: string, role: RespondentRole): Promise<string> {
  const region = getConfig().region;
  const legacy = await client.query("SELECT a.id FROM assessments a JOIN scales s ON s.id=a.scale_version_id WHERE a.family_id=$1 AND a.region=$2 AND a.triad_round_id IS NULL AND a.submitted_at IS NOT NULL AND a.status<>'published' AND s.definition->>'bundle'=$3 LIMIT 1", [familyId, region, TRIAD_BUNDLE]);
  if (legacy.rows[0]) throw new HttpError(409, "旧三方问卷的轮次尚未核实，请联系服务团队处理后再开始。", "TRIAD_LEGACY_REVIEW_REQUIRED");
  const latest = await client.query("SELECT id FROM triad_rounds WHERE family_id=$1 AND region=$2 ORDER BY created_at DESC,id DESC LIMIT 1", [familyId, region]);
  if (latest.rows[0]) {
    const roundId = String(latest.rows[0].id);
    const members = await client.query("SELECT respondent_role,submitted_at FROM assessments WHERE triad_round_id=$1", [roundId]);
    if (!triadRolesReady(members.rows.filter(row => row.submitted_at).map(row => String(row.respondent_role)))) {
      if (members.rows.some(row => row.respondent_role === role)) throw new HttpError(409, "本轮仍在等待其他成员完成，请先完成本轮三方问卷。", "TRIAD_ROUND_IN_PROGRESS");
      return roundId;
    }
  }
  const id = randomUUID();
  await client.query("INSERT INTO triad_rounds(id,family_id,region) VALUES($1,$2,$3)", [id, familyId, region]);
  return id;
}

export async function startParentCase(input: unknown, locale: "zh-CN" | "zh-HK"): Promise<{ userId: string; familyId: string; joinCode: string }> {
  const data = z.object({ parentName: short, username, password, relationship: z.enum(relationships), childName: short, birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), grade: z.enum(grades), accepted: z.literal(true) }).strict().parse(input);
  assertChildAge(data.birthDate);
  await limitLogin(data.username);
  const passwordHash = await hashPassword(data.password);
  const created = await transaction(async client => {
    const scale = await client.query("SELECT id FROM scales WHERE id=$1 AND status='active'", [SCALE_ID.parent]);
    if (!scale.rows[0]) throw new HttpError(409, "家长问卷还没有准备好。", "SCALE_NOT_FOUND");
    const joinCode = await freshCode(client);
    const userId = randomUUID();
    const familyId = randomUUID();
    try {
      await client.query("INSERT INTO users(id,region,username,name,role,password_hash) VALUES($1,$2,$3,$4,'parent',$5)", [userId, getConfig().region, data.username, data.parentName, passwordHash]);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "23505") throw new HttpError(409, "这个用户名已注册，请登录后加入家庭。", "USERNAME_TAKEN", "username");
      throw error;
    }
    await client.query("INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label,join_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [familyId, getConfig().region, `${data.childName}的家庭`, data.childName, data.birthDate, data.grade, data.relationship, joinCode]);
    await client.query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,'parent')", [familyId, userId]);
    await client.query("INSERT INTO consents(id,family_id,actor_id,guardian_name,method,notice_version,scopes) VALUES($1,$2,$3,$4,'online_guardian',$5,$6)", [randomUUID(), familyId, userId, data.parentName, noticeVersion, JSON.stringify(["assessment", "parent_report", "sensitive_data"])]);
    const roundId = await triadRoundFor(client, familyId, "parent");
    await client.query("INSERT INTO assessments(id,family_id,region,respondent_id,respondent_role,scale_version_id,locale,triad_round_id) VALUES($1,$2,$3,$4,'parent',$5,$6,$7)", [randomUUID(), familyId, getConfig().region, userId, SCALE_ID.parent, locale, roundId]);
    await client.query("INSERT INTO audit_events(region,actor_id,action,entity_id) VALUES($1,$2,'triad.parent_started',$3)", [getConfig().region, userId, familyId]);
    return { userId, familyId, joinCode: formatJoinCode(joinCode) };
  });
  return created;
}

export async function joinWithCode(input: unknown, locale: "zh-CN" | "zh-HK"): Promise<{ userId: string }> {
  const data = z.object({ code: z.string(), role: z.enum(["student", "teacher"]), name: short, username, password }).strict().parse(input);
  const code = normalizeCode(data.code);
  await limitLogin(data.username);
  const passwordHash = await hashPassword(data.password);
  return transaction(async client => {
    const family = await client.query("SELECT id,birth_date FROM families WHERE join_code=$1 AND region=$2 FOR UPDATE", [code, getConfig().region]);
    if (!family.rows[0]) throw new HttpError(404, "家庭编号不正确或已失效。", "INVALID_JOIN_CODE");
    assertChildAge(String(family.rows[0].birth_date).slice(0, 10));
    await requireRegistrationConsent(client, family.rows[0].id);
    const taken = await client.query("SELECT 1 FROM memberships WHERE family_id=$1 AND role=$2", [family.rows[0].id, data.role]);
    if (taken.rows[0]) throw new HttpError(409, data.role === "student" ? "这个家庭已经有孩子进入了。" : "这个家庭已经有老师进入了。", "ROLE_TAKEN");
    const scaleId = SCALE_ID[data.role];
    const scale = await client.query("SELECT id FROM scales WHERE id=$1 AND status='active'", [scaleId]);
    if (!scale.rows[0]) throw new HttpError(409, "问卷还没有准备好。", "SCALE_NOT_FOUND");
    const userId = randomUUID();
    try {
      await client.query("INSERT INTO users(id,region,username,name,role,password_hash) VALUES($1,$2,$3,$4,$5,$6)", [userId, getConfig().region, data.username, data.name, data.role, passwordHash]);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "23505") throw new HttpError(409, "这个用户名已注册，请登录后加入家庭。", "USERNAME_TAKEN", "username");
      throw error;
    }
    await client.query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,$3)", [family.rows[0].id, userId, data.role]);
    const roundId = await triadRoundFor(client, family.rows[0].id, data.role);
    await client.query("INSERT INTO assessments(id,family_id,region,respondent_id,respondent_role,scale_version_id,locale,triad_round_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [randomUUID(), family.rows[0].id, getConfig().region, userId, data.role, scaleId, locale, roundId]);
    await client.query("INSERT INTO audit_events(region,actor_id,action,entity_id) VALUES($1,$2,'triad.member_joined',$3)", [getConfig().region, userId, family.rows[0].id]);
    return { userId };
  });
}

export async function queueTriadReport(client: PoolClient, familyId: string, roundId: string): Promise<void> {
  const region = getConfig().region;
  const rows = await client.query("SELECT id,respondent_role FROM assessments WHERE family_id=$1 AND region=$2 AND triad_round_id=$3 AND submitted_at IS NOT NULL ORDER BY respondent_role", [familyId, region, roundId]);
  if (!triadRolesReady(rows.rows.map(row => String(row.respondent_role)))) return;
  const parent = rows.rows.find(row => row.respondent_role === "parent");
  if (!parent) return;
  await client.query("INSERT INTO report_jobs(id,assessment_id,source_assessment_ids) VALUES($1,$2,$3) ON CONFLICT(assessment_id) DO NOTHING", [randomUUID(), parent.id, rows.rows.map(row => row.id)]);
}

export async function acknowledgeSafetyAlert(actor: Actor, alertId: string) {
  requireRole(actor.role, ["admin", "staff"]);
  validateId(alertId);
  const rows = await query<{ id: string; family_id: string; viewed_at: Date | string | null }>("SELECT id,family_id,viewed_at FROM staff_alerts WHERE id=$1 AND region=$2", [alertId, actor.region]);
  if (!rows[0]) throw new HttpError(404, "未找到这条安全提示。", "NOT_FOUND");
  await familyFor(actor, rows[0].family_id);
  if (rows[0].viewed_at) return { ok: true };
  const updated = await query("UPDATE staff_alerts SET viewed_at=now(),viewed_by=$1 WHERE id=$2 AND region=$3 AND viewed_at IS NULL RETURNING id", [actor.id, alertId, actor.region]);
  if (updated[0]) await audit(actor, "safety.viewed", alertId);
  return { ok: true };
}
