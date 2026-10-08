import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Actor, RespondentRole } from "../domain/types";
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

const SCALE_ID = { parent: "growth-parent@1.0.0", student: "growth-child@1.0.0", teacher: "growth-teacher@1.0.0" } as const;
const short = z.string().trim().min(1).max(100);
const username = z.string().trim().toLowerCase().regex(/^[a-z0-9_.@-]{3,100}$/);
const password = z.string().min(12).max(256);
const grades = ["学前大班", "小学一至三年级", "小学四至六年级", "初中", "高中", "其他"] as const;
const relationships = ["母亲", "父亲", "祖父母或外祖父母", "其他主要照顾者"] as const;

const JOIN_BRAND = "TOPE";
function parseJoinCode(code: string): string | null {
  const compact = code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const body = compact.startsWith(JOIN_BRAND) && compact.length === JOIN_BRAND.length + 8 ? compact.slice(JOIN_BRAND.length) : compact;
  return /^[A-Z0-9]{8}$/.test(body) ? `${JOIN_BRAND}-${body}` : null;
}
export function formatJoinCode(code: string): string {
  return parseJoinCode(code) ?? code.trim().toUpperCase();
}
function normalizeCode(code: string): string {
  const parsed = parseJoinCode(code);
  if (!parsed) throw new HttpError(404, "家庭编号不正确。请向家长索取 TOPE- 开头的编号。", "INVALID_JOIN_CODE");
  return parsed;
}
function makeCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const body = [...randomBytes(8)].map(value => alphabet[value % alphabet.length]).join("");
  return `${JOIN_BRAND}-${body}`;
}
function assertChildAge(birthDate: string): number {
  if (!Number.isFinite(Date.parse(birthDate)) || new Date(birthDate).toISOString().slice(0, 10) !== birthDate) throw new HttpError(422, "请填写有效的孩子出生日期。", "INVALID_BIRTHDATE");
  const age = ageAt(birthDate);
  if (!Number.isInteger(age) || age < 8 || age > 17) throw new HttpError(422, "孩子自查适用于 8 至 17 岁。三份问卷都要完成，请填写这个年龄范围内的出生日期。", "CHILD_AGE");
  return age;
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
  await ensureTriadInstruments();
  const passwordHash = await hashPassword(data.password);
  const created = await transaction(async client => {
    const scale = await client.query("SELECT id FROM scales WHERE id=$1 AND status='active'", [SCALE_ID.parent]);
    if (!scale.rows[0]) throw new HttpError(409, "家长问卷还没有准备好。", "SCALE_NOT_FOUND");
    const joinCode = await freshCode(client);
    const userId = randomUUID();
    const familyId = randomUUID();
    await client.query("INSERT INTO users(id,region,username,name,role,password_hash) VALUES($1,$2,$3,$4,'parent',$5)", [userId, getConfig().region, data.username, data.parentName, passwordHash]);
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
  const data = z.object({ code: z.string().trim().min(8).max(32), role: z.enum(["student", "teacher"]), name: short, username, password }).strict().parse(input);
  const code = normalizeCode(data.code);
  await limitLogin(data.username);
  await ensureTriadInstruments();
  const passwordHash = await hashPassword(data.password);
  return transaction(async client => {
    const family = await client.query("SELECT id,birth_date FROM families WHERE join_code=$1 AND region=$2 FOR UPDATE", [code, getConfig().region]);
    if (!family.rows[0]) throw new HttpError(404, "家庭编号不正确或已失效。", "INVALID_JOIN_CODE");
    assertChildAge(String(family.rows[0].birth_date).slice(0, 10));
    const taken = await client.query("SELECT 1 FROM memberships WHERE family_id=$1 AND role=$2", [family.rows[0].id, data.role]);
    if (taken.rows[0]) throw new HttpError(409, data.role === "student" ? "这个家庭已经有孩子进入了。" : "这个家庭已经有老师进入了。", "ROLE_TAKEN");
    const scaleId = SCALE_ID[data.role];
    const scale = await client.query("SELECT id FROM scales WHERE id=$1 AND status='active'", [scaleId]);
    if (!scale.rows[0]) throw new HttpError(409, "问卷还没有准备好。", "SCALE_NOT_FOUND");
    const userId = randomUUID();
    await client.query("INSERT INTO users(id,region,username,name,role,password_hash) VALUES($1,$2,$3,$4,$5,$6)", [userId, getConfig().region, data.username, data.name, data.role, passwordHash]);
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
