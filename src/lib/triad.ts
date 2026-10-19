import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Actor, Locale, RespondentRole, Role } from "../domain/types";
import { z } from "zod";
import { childScale, currentTriadScaleIds, teacherScale, triadScales } from "../domain/triad-scales";
import { TRIAD_BUNDLE, triadRolesReady } from "../domain/triad-report";
import { pair } from "../domain/zh-pair";
import { parseAdvice, parseStoredScale, parseTemplate } from "../domain/validation";
import { ageAt } from "./access";
import { hashPassword, limitLogin } from "./auth";
import { ACTIVE_CONSENT_ROWS_SQL, PARENT_REPORT_SCOPE, PARTICIPATION_SCOPES, hasGranted, insertConsentRecords, recordedScopes, rejectBundledConsent } from "./consent";
import { getConfig, isDemoMode } from "./config";
import { query, transaction } from "./db";
import { HttpError, requireRole, validateId } from "./http";
import { noticeVersion } from "./privacy";
import type { VerifiedClerkIdentity } from "./clerk-auth";
import { formatJoinCode, joinCodeFormatMessage, parseJoinCode, registrationName, registrationPassword, registrationUsername } from "../domain/registration";
export { formatJoinCode } from "../domain/registration";

const SCALE_ID = currentTriadScaleIds;
const short = registrationName;
const username = registrationUsername;
const password = registrationPassword;
const grades = ["学前大班", "小学一至三年级", "小学四至六年级", "初中", "高中", "其他"] as const;
const relationships = ["母亲", "父亲", "祖父母或外祖父母", "其他主要照顾者"] as const;
const clerkStudentJoinInput = z.object({ code: z.string(), name: short, role: z.literal("student") }).strict();

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

export async function lockRegistrationActor(client: PoolClient, actor: Actor, lockMode: "UPDATE" | "SHARE" = "UPDATE"): Promise<Actor> {
  const config = getConfig();
  if (actor.region !== config.region) throw new HttpError(403, "请使用账号所属地区的入口。", "REGION_MISMATCH");
  // Registration needs exclusivity for request replay. Other mutations can share
  // this lock, protecting account changes without blocking user foreign keys.
  const result = await client.query<Actor & { disabled: boolean; demo: boolean }>(`SELECT id,name,role,region,disabled,demo FROM users WHERE id=$1 FOR ${lockMode === "SHARE" ? "SHARE" : "UPDATE"}`, [actor.id]);
  const current = result.rows[0];
  if (!current || current.disabled || (config.mode !== "demo" && current.demo)) throw new HttpError(403, "账号已停用，请联系服务人员。", "ACCOUNT_REVOKED");
  if (current.region !== actor.region) throw new HttpError(403, "请使用账号所属地区的入口。", "REGION_MISMATCH");
  if (current.role !== actor.role) throw new HttpError(409, "账号角色已变更，请重新登录。", "ROLE_CONFLICT");
  return { id: current.id, name: current.name, role: current.role, region: current.region };
}

export async function requireRegistrationConsent(client: PoolClient, familyId: string): Promise<void> {
  const consent = await client.query(ACTIVE_CONSENT_ROWS_SQL, [familyId]);
  if (!hasGranted(consent.rows, PARTICIPATION_SCOPES)) throw new HttpError(409, "请先由家长完成测评与敏感资料授权。", "GUARDIAN_CONSENT_REQUIRED");
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

// Demo mode can open the unvalidated triad. Service mode refuses while any
// version these routes assign still has norm.validated !== true.
export function assertPublicTriadOpen(): void {
  if (isDemoMode()) return;
  const assignedIds = new Set<string>(Object.values(currentTriadScaleIds));
  const assigned = triadScales.filter(scale => assignedIds.has(`${scale.id}@${scale.version}`));
  if (assigned.length !== assignedIds.size || assigned.some(scale => scale.norm.validated !== true)) throw new HttpError(409, "正式服务尚未提供已验证常模的三方问卷，暂时不能创建或加入家庭。", "UNVALIDATED_INSTRUMENT");
  if (assigned.some(scale => scale.demo)) throw new HttpError(409, "正式服务环境不能使用演示问卷创建或加入家庭。", "DEMO_INSTRUMENT");
}

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
    // Any version of this role's triad scale. A member who already has a task gets
    // that task back instead of opening the version now assigned to new members.
    const scaleFamily = role === "student" ? childScale.id : teacherScale.id;
    const existing = await client.query<{ id: string }>("SELECT a.id FROM assessments a JOIN scales s ON s.id=a.scale_version_id WHERE a.family_id=$1 AND a.respondent_id=$2 AND a.respondent_role=$3 AND a.region=$4 AND s.scale_id=$5 ORDER BY a.created_at DESC,a.id DESC LIMIT 1", [family.id, actor.id, role, actor.region, scaleFamily]);
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
  assertPublicTriadOpen();
  requireRole(actor.role, ["student", "teacher"]);
  const authenticatedInput = z.object({ code: z.string() }).strict();
  // A lost onboarding response can be retried after Clerk resolves the new student.
  const data = (actor.role === "student" ? z.union([authenticatedInput, clerkStudentJoinInput]) : authenticatedInput).parse(input);
  const code = normalizeCode(data.code);
  return transaction(async client => {
    const family = await familyByJoinCode(client, code);
    const current = await lockRegistrationActor(client, actor);
    await assertTriadRegistrationReady(client, family);
    return joinTriadFamilyInTransaction(client, current, family, locale);
  });
}

export async function joinClerkStudent(principal: VerifiedClerkIdentity, input: unknown, locale: Locale): Promise<FamilyJoinResult> {
  assertPublicTriadOpen();
  const data = clerkStudentJoinInput.parse(input);
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
  assertPublicTriadOpen();
  requireRole(actor.role, ["parent"]);
  rejectBundledConsent(input);
  const data = z.object({ requestId: z.string().uuid(), relationship: z.enum(relationships), childName: short, birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), grade: z.enum(grades), assessment: z.literal(true), sensitiveData: z.literal(true), parentReport: z.boolean() }).strict().parse(input);
  assertChildAge(data.birthDate);
  return transaction(async client => {
    const current = await lockRegistrationActor(client, actor);
    const existing = await client.query<{ id: string; join_code: string; child_name: string; birth_date: string; grade: string; guardian_label: string }>("SELECT id,join_code,child_name,birth_date,grade,guardian_label FROM families WHERE created_by=$1 AND creation_request_id=$2 AND region=$3", [current.id, data.requestId, current.region]);
    if (existing.rows[0]) {
      const prior = existing.rows[0];
      if (prior.child_name !== data.childName || String(prior.birth_date).slice(0, 10) !== data.birthDate || prior.grade !== data.grade || prior.guardian_label !== data.relationship) throw new HttpError(409, "这个创建请求已完成，但家庭资料与本次填写不同。请刷新并核对已有家庭。", "REQUEST_ID_CONFLICT");
      const priorConsent = await client.query(ACTIVE_CONSENT_ROWS_SQL, [prior.id]);
      if (!hasGranted(priorConsent.rows, PARTICIPATION_SCOPES) || hasGranted(priorConsent.rows, [PARENT_REPORT_SCOPE]) !== data.parentReport) throw new HttpError(409, "这个创建请求已完成，但同意选择与本次不同。请在家庭里单独更新同意。", "CONSENT_CHOICE_CONFLICT");
      return { userId: current.id, familyId: prior.id, joinCode: formatJoinCode(prior.join_code) };
    }
    const scale = await client.query("SELECT id FROM scales WHERE id=$1 AND status='active'", [SCALE_ID.parent]);
    if (!scale.rows[0]) throw new HttpError(409, "家长问卷还没有准备好。", "SCALE_NOT_FOUND");
    const joinCode = await freshCode(client), familyId = randomUUID();
    await client.query("INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label,join_code,created_by,creation_request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [familyId, current.region, `${data.childName}的家庭`, data.childName, data.birthDate, data.grade, data.relationship, joinCode, current.id, data.requestId]);
    await client.query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,'parent')", [familyId, current.id]);
    await insertConsentRecords(client, { familyId, actorId: current.id, guardianName: current.name, method: "online_guardian", noticeVersion, scopes: recordedScopes(data) });
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
  await query("CREATE TABLE IF NOT EXISTS staff_alerts(id uuid PRIMARY KEY,family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,region text NOT NULL,assessment_id uuid,created_at timestamptz NOT NULL DEFAULT now(),viewed_at timestamptz,viewed_by uuid,resolved_at timestamptz,resolved_by uuid)");
  await query("ALTER TABLE staff_alerts ADD COLUMN IF NOT EXISTS viewed_at timestamptz");
  await query("ALTER TABLE staff_alerts ADD COLUMN IF NOT EXISTS viewed_by uuid");
  await query("ALTER TABLE staff_alerts ADD COLUMN IF NOT EXISTS resolved_at timestamptz");
  await query("ALTER TABLE staff_alerts ADD COLUMN IF NOT EXISTS resolved_by uuid");
  await query("CREATE UNIQUE INDEX IF NOT EXISTS staff_alerts_assessment ON staff_alerts(assessment_id) WHERE assessment_id IS NOT NULL");
  for (const scale of triadScales) {
    const parsed = parseStoredScale(scale);
    const id = `${parsed.id}@${parsed.version}`;
    // Insert only. scales_immutable rejects definition rewrites, and an open assessment scores the row it was opened with.
    await query("INSERT INTO scales(id,scale_id,version,definition) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING", [id, parsed.id, parsed.version, JSON.stringify(parsed)]);
    // Child and teacher 1.0.0 stay stored for open forms, but new assignments use the safety revision.
    // Parent 1.0.0 and 1.1.0 remain active so an explicit historical choice is still accepted.
    if ((parsed.id === "growth-child" || parsed.id === "growth-teacher") && parsed.version !== "1.0.0") {
      await query("UPDATE scales SET status='retired' WHERE id=$1 AND status='active'", [`${parsed.id}@1.0.0`]);
    }
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
  assertPublicTriadOpen();
  rejectBundledConsent(input);
  const data = z.object({ parentName: short, username, password, relationship: z.enum(relationships), childName: short, birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), grade: z.enum(grades), assessment: z.literal(true), sensitiveData: z.literal(true), parentReport: z.boolean() }).strict().parse(input);
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
    await insertConsentRecords(client, { familyId, actorId: userId, guardianName: data.parentName, method: "online_guardian", noticeVersion, scopes: recordedScopes(data) });
    const roundId = await triadRoundFor(client, familyId, "parent");
    await client.query("INSERT INTO assessments(id,family_id,region,respondent_id,respondent_role,scale_version_id,locale,triad_round_id) VALUES($1,$2,$3,$4,'parent',$5,$6,$7)", [randomUUID(), familyId, getConfig().region, userId, SCALE_ID.parent, locale, roundId]);
    await client.query("INSERT INTO audit_events(region,actor_id,action,entity_id) VALUES($1,$2,'triad.parent_started',$3)", [getConfig().region, userId, familyId]);
    return { userId, familyId, joinCode: formatJoinCode(joinCode) };
  });
  return created;
}

export async function joinWithCode(input: unknown, locale: "zh-CN" | "zh-HK"): Promise<{ userId: string }> {
  assertPublicTriadOpen();
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

export async function queueTriadReport(client: PoolClient, familyId: string, roundId: string): Promise<string | null> {
  const region = getConfig().region;
  const rows = await client.query("SELECT id,respondent_role FROM assessments WHERE family_id=$1 AND region=$2 AND triad_round_id=$3 AND submitted_at IS NOT NULL ORDER BY respondent_role", [familyId, region, roundId]);
  if (!triadRolesReady(rows.rows.map(row => String(row.respondent_role)))) return null;
  const parent = rows.rows.find(row => row.respondent_role === "parent");
  if (!parent) return null;
  const consent = await client.query(ACTIVE_CONSENT_ROWS_SQL, [familyId]);
  if (!hasGranted(consent.rows, [PARENT_REPORT_SCOPE])) return null;
  await client.query("INSERT INTO report_jobs(id,assessment_id,source_assessment_ids) VALUES($1,$2,$3) ON CONFLICT(assessment_id) DO NOTHING", [randomUUID(), parent.id, rows.rows.map(row => row.id)]);
  return String(parent.id);
}

// Submissions can be stored before the guardian agrees to the parent report.
// Call this only after that consent is active, while the family lock is held.
export async function enqueueReportsHeldForConsent(client: PoolClient, familyId: string): Promise<string[]> {
  const region = getConfig().region;
  const ids = new Set<string>();
  const held = await client.query("SELECT a.id FROM assessments a JOIN scales s ON s.id=a.scale_version_id WHERE a.family_id=$1 AND a.region=$2 AND a.status='queued' AND a.submitted_at IS NOT NULL AND COALESCE(s.definition->>'bundle','')<>$3 AND NOT EXISTS (SELECT 1 FROM report_jobs j WHERE j.assessment_id=a.id) AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.assessment_id=a.id)", [familyId, region, TRIAD_BUNDLE]);
  for (const row of held.rows) {
    await client.query("INSERT INTO report_jobs(id,assessment_id) VALUES($1,$2) ON CONFLICT(assessment_id) DO NOTHING", [randomUUID(), row.id]);
    ids.add(String(row.id));
  }
  const resumed = await client.query("UPDATE report_jobs j SET state='ready', available_at=now(), lease_until=NULL, claim_token=NULL, last_error_code=NULL FROM assessments a WHERE a.id=j.assessment_id AND a.family_id=$1 AND a.region=$2 AND j.state='paused' AND j.last_error_code='PARENT_REPORT_CONSENT_REQUIRED' AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.assessment_id=a.id) RETURNING a.id", [familyId, region]);
  for (const row of resumed.rows) ids.add(String(row.id));
  const ready = await client.query("SELECT a.id FROM report_jobs j JOIN assessments a ON a.id=j.assessment_id WHERE a.family_id=$1 AND a.region=$2 AND j.state='ready' AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.assessment_id=a.id)", [familyId, region]);
  for (const row of ready.rows) ids.add(String(row.id));
  const rounds = await client.query("SELECT DISTINCT triad_round_id FROM assessments WHERE family_id=$1 AND region=$2 AND triad_round_id IS NOT NULL AND submitted_at IS NOT NULL", [familyId, region]);
  for (const row of rounds.rows) {
    const parentId = await queueTriadReport(client, familyId, String(row.triad_round_id));
    if (parentId) ids.add(parentId);
  }
  return [...ids];
}

// Alert handling is not report management: an unassigned family's regional staff may
// acknowledge or resolve, but canManageFamilyReports stays assignee-or-admin only.
function mayHandleSafetyAlert(role: Role, assignedTo: string | null, actorId: string, resolvedAt: Date | string | null): boolean {
  if (role === "admin") return true;
  if (role !== "staff") return false;
  if (assignedTo === actorId) return true;
  return assignedTo === null && resolvedAt === null;
}

// Family, then the actor, then the alert. deleteFamily locks the family and the actor
// before DELETE cascades into staff_alerts; locking the alert first deadlocks with that.
// The unlocked read only discovers family_id. Authority is decided after the family lock.
async function settleSafetyAlert(actor: Actor, alertId: string, action: "viewed" | "resolved") {
  requireRole(actor.role, ["admin", "staff"]);
  validateId(alertId);
  return transaction(async client => {
    const located = await client.query<{ family_id: string }>("SELECT family_id FROM staff_alerts WHERE id=$1 AND region=$2", [alertId, actor.region]);
    if (!located.rows[0]) throw new HttpError(404, "未找到这条安全提示。", "NOT_FOUND");
    const families = await client.query<{ id: string; region: "CN" | "HK"; assigned_to: string | null }>("SELECT id,region,assigned_to FROM families WHERE id=$1 AND region=$2 FOR UPDATE", [located.rows[0].family_id, actor.region]);
    const family = families.rows[0];
    if (!family) throw new HttpError(404, "未找到该家庭或没有访问权限。", "NOT_FOUND");
    const current = await lockRegistrationActor(client, actor, "SHARE");
    if (current.region !== family.region) throw new HttpError(403, "请使用账号所属地区的入口。", "REGION_MISMATCH");
    const alerts = await client.query<{ id: string; family_id: string; resolved_at: Date | string | null; viewed_at: Date | string | null }>("SELECT id,family_id,resolved_at,viewed_at FROM staff_alerts WHERE id=$1 AND region=$2 FOR UPDATE", [alertId, current.region]);
    const alert = alerts.rows[0];
    if (!alert || alert.family_id !== family.id) throw new HttpError(404, "未找到这条安全提示。", "NOT_FOUND");
    if (!mayHandleSafetyAlert(current.role, family.assigned_to, current.id, alert.resolved_at)) throw new HttpError(403, "您没有执行此操作的权限。", "ROLE_DENIED");
    if (action === "resolved") {
      if (alert.resolved_at) return { ok: true };
      const updated = await client.query("UPDATE staff_alerts SET resolved_at=now(),resolved_by=$1 WHERE id=$2 AND region=$3 AND resolved_at IS NULL RETURNING id", [current.id, alertId, current.region]);
      if (updated.rows[0]) await client.query("INSERT INTO audit_events(region,actor_id,action,entity_id) VALUES($1,$2,$3,$4)", [current.region, current.id, "safety.resolved", alertId]);
      return { ok: true };
    }
    if (alert.viewed_at) return { ok: true };
    const updated = await client.query("UPDATE staff_alerts SET viewed_at=now(),viewed_by=$1 WHERE id=$2 AND region=$3 AND viewed_at IS NULL RETURNING id", [current.id, alertId, current.region]);
    if (updated.rows[0]) await client.query("INSERT INTO audit_events(region,actor_id,action,entity_id) VALUES($1,$2,$3,$4)", [current.region, current.id, "safety.viewed", alertId]);
    return { ok: true };
  });
}

export async function acknowledgeSafetyAlert(actor: Actor, alertId: string) {
  return settleSafetyAlert(actor, alertId, "viewed");
}

export async function resolveSafetyAlert(actor: Actor, alertId: string) {
  return settleSafetyAlert(actor, alertId, "resolved");
}
