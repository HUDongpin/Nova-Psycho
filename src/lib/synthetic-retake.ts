import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { Actor, AssessmentSnapshot, RespondentRole, ScaleDefinition } from "../domain/types";
import { scoreAssessment } from "../domain/scoring";
import { TRIAD_BUNDLE } from "../domain/triad-report";
import { ageAt } from "./access";
import { ACTIVE_CONSENT_ROWS_SQL, hasGranted } from "./consent";
import { lockContent } from "./content";
import { query, transaction } from "./db";
import { HttpError, validateId } from "./http";
import { getSyntheticTestFamilyMembers, type SyntheticTestMember } from "./synthetic-testing";

const roles = ["parent", "student", "teacher"] as const;
const inputSchema = z.object({ previousRoundId: z.string().uuid(), locale: z.enum(["zh-CN", "zh-HK"]) }).strict();
interface Round { id: string; created_at: Date | string }
interface Source {
  id: string; respondent_id: string; respondent_role: RespondentRole; scale_version_id: string;
  status: string; submitted_at: Date | string | null; snapshot: AssessmentSnapshot | null;
  definition: ScaleDefinition; scale_status: string;
}
export interface SyntheticRetakeResult { roundId: string; assessmentIds: Record<RespondentRole, string>; reused: boolean }

async function read<T extends Record<string, unknown>>(sql: string, values: unknown[], client?: PoolClient): Promise<T[]> {
  return client ? (await client.query<T>(sql, values)).rows : await query<T>(sql, values);
}
function denied(): never { throw new HttpError(403, "此入口仅供指定测试家庭的家长测试账号使用。", "SYNTHETIC_RETAKE_DENIED"); }
function incomplete(): never { throw new HttpError(409, "请先完成上一轮三方合成测试并等待报告生成。", "SYNTHETIC_RETAKE_NOT_READY"); }
async function membersFor(actor: Actor, familyId: string, client?: PoolClient): Promise<SyntheticTestMember[]> {
  if (actor.role !== "parent" || actor.sessionMethod !== "test") denied();
  const members = await getSyntheticTestFamilyMembers(familyId, actor.region, client);
  if (!members || !members.some(member => member.id === actor.id && member.role === "parent")) denied();
  const consents = await read<{ scopes: unknown }>(ACTIVE_CONSENT_ROWS_SQL, [familyId], client);
  if (!hasGranted(consents, ["assessment", "sensitive_data", "parent_report"])) {
    throw new HttpError(409, "请先完成测评、敏感资料和家长报告的监护人授权。", "GUARDIAN_CONSENT_REQUIRED");
  }
  return members;
}
async function roundSources(familyId: string, region: Actor["region"], roundId: string, client?: PoolClient): Promise<Source[]> {
  return await read(`SELECT a.id,a.respondent_id,a.respondent_role,a.scale_version_id,a.status,a.submitted_at,a.snapshot,
    s.definition,s.status AS scale_status FROM assessments a JOIN scales s ON s.id=a.scale_version_id
    WHERE a.triad_round_id=$1 AND a.family_id=$2 AND a.region=$3 ORDER BY a.respondent_role`, [roundId, familyId, region], client) as unknown as Source[];
}
function sourcesMatch(sources: Source[], members: SyntheticTestMember[]): boolean {
  return sources.length === 3 && new Set(sources.map(source => source.id)).size === 3 && roles.every(role => {
    const matching = sources.filter(source => source.respondent_role === role);
    return matching.length === 1 && members.some(member => member.role === role && member.id === matching[0].respondent_id) &&
      matching[0].definition.bundle === TRIAD_BUNDLE;
  });
}
async function publishedSources(actor: Actor, familyId: string, roundId: string, members: SyntheticTestMember[], client?: PoolClient): Promise<Source[]> {
  const sources = await roundSources(familyId, actor.region, roundId, client);
  if (!sourcesMatch(sources, members) || sources.some(source => source.status !== "published" || !source.submitted_at ||
    !source.snapshot || source.snapshot.scale.bundle !== TRIAD_BUNDLE || `${source.snapshot.scale.id}@${source.snapshot.scale.version}` !== source.scale_version_id)) incomplete();
  const parent = sources.find(source => source.respondent_role === "parent")!;
  const reports = await read(`SELECT j.source_assessment_ids FROM reports r JOIN report_jobs j ON j.assessment_id=r.assessment_id
    WHERE r.assessment_id=$1 AND r.family_id=$2 AND r.region=$3 AND j.state='done'
      AND r.payload->>'syntheticTest'='true' AND jsonb_typeof(r.payload->'triad')='object'`, [parent.id, familyId, actor.region], client);
  const pinned = reports[0]?.source_assessment_ids;
  if (reports.length !== 1 || !Array.isArray(pinned) || pinned.length !== 3 ||
    new Set(pinned).size !== 3 || sources.some(source => !pinned.includes(source.id))) incomplete();
  return sources;
}
function result(roundId: string, sources: Pick<Source, "id" | "respondent_role">[], reused: boolean): SyntheticRetakeResult {
  return { roundId, assessmentIds: Object.fromEntries(sources.map(source => [source.respondent_role, source.id])) as Record<RespondentRole, string>, reused };
}
function assertVersionsUsable(sources: Source[], age: number, region: Actor["region"]): void {
  if (sources.some(source => source.scale_status !== "active")) throw new HttpError(409, "上一轮使用的量表版本已停用。", "SCALE_RETIRED");
  if (sources.some(source => scoreAssessment(source.definition, {}, { age, region, role: source.respondent_role }).status === "ineligible")) {
    throw new HttpError(422, "上一轮问卷不再适用于当前年龄、地区或角色。", "INELIGIBLE");
  }
}

// A previous-round token pins the intended successor. Family serialization makes
// duplicate clicks return that same round without resetting or extending history.
export async function startSyntheticRetake(actor: Actor, familyId: string, input: unknown): Promise<SyntheticRetakeResult> {
  validateId(familyId);
  if (actor.role !== "parent" || actor.sessionMethod !== "test") denied();
  const data = inputSchema.parse(input);
  return transaction(async client => {
    const family = await client.query<{ birth_date: string }>("SELECT birth_date FROM families WHERE id=$1 AND region=$2 FOR UPDATE", [familyId, actor.region]);
    if (!family.rows[0]) throw new HttpError(404, "未找到该测试家庭。", "NOT_FOUND");
    const members = await membersFor(actor, familyId, client);
    const previous = await client.query<Round>("SELECT id,created_at FROM triad_rounds WHERE id=$1 AND family_id=$2 AND region=$3", [data.previousRoundId, familyId, actor.region]);
    if (!previous.rows[0]) incomplete();
    const sources = await publishedSources(actor, familyId, data.previousRoundId, members, client);
    const successor = await client.query<Round>(`SELECT next.id,next.created_at FROM triad_rounds next
      JOIN triad_rounds previous ON previous.id=$3 AND previous.family_id=$1 AND previous.region=$2
      WHERE next.family_id=$1 AND next.region=$2 AND (next.created_at,next.id)>(previous.created_at,previous.id)
      ORDER BY next.created_at,next.id LIMIT 1`, [familyId, actor.region, data.previousRoundId]);
    if (successor.rows[0]) {
      const existing = await roundSources(familyId, actor.region, successor.rows[0].id, client);
      if (!sourcesMatch(existing, members) || existing.some(source => source.scale_version_id !== sources.find(prior => prior.respondent_role === source.respondent_role)?.scale_version_id)) {
        throw new HttpError(409, "后续轮次已有不同任务，请先核对。", "SYNTHETIC_RETAKE_CONFLICT");
      }
      return result(successor.rows[0].id, existing, true);
    }
    const pending = await client.query("SELECT id FROM assessments WHERE family_id=$1 AND region=$2 AND status<>'published' LIMIT 1", [familyId, actor.region]);
    if (pending.rows[0]) incomplete();
    await lockContent(client);
    const currentSources = await roundSources(familyId, actor.region, data.previousRoundId, client);
    if (!sourcesMatch(currentSources, members)) incomplete();
    assertVersionsUsable(currentSources, ageAt(String(family.rows[0].birth_date).slice(0, 10)), actor.region);
    const roundId = randomUUID();
    await client.query("INSERT INTO triad_rounds(id,family_id,region,created_at) SELECT $1,$2,$3,GREATEST(clock_timestamp(),created_at+interval '1 microsecond') FROM triad_rounds WHERE id=$4 AND family_id=$2 AND region=$3", [roundId, familyId, actor.region, data.previousRoundId]);
    const created: Pick<Source, "id" | "respondent_role">[] = [];
    for (const source of currentSources) {
      const id = randomUUID();
      await client.query("INSERT INTO assessments(id,family_id,region,respondent_id,respondent_role,scale_version_id,locale,triad_round_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [id, familyId, actor.region, source.respondent_id, source.respondent_role, source.scale_version_id, data.locale, roundId]);
      created.push({ id, respondent_role: source.respondent_role });
    }
    await client.query("INSERT INTO audit_events(region,actor_id,action,entity_id) VALUES($1,$2,'synthetic.retake_created',$3)", [actor.region, actor.id, roundId]);
    return result(roundId, created, false);
  });
}

export async function syntheticRetakeCapability(actor: Actor, familyId: string): Promise<{ previousRoundId: string } | null> {
  if (actor.role !== "parent" || actor.sessionMethod !== "test") return null;
  try {
    const members = await membersFor(actor, familyId);
    const family = await query<{ birth_date: string }>("SELECT birth_date FROM families WHERE id=$1 AND region=$2", [familyId, actor.region]);
    const latest = await query<Round>("SELECT id,created_at FROM triad_rounds WHERE family_id=$1 AND region=$2 ORDER BY created_at DESC,id DESC LIMIT 1", [familyId, actor.region]);
    if (!family[0] || !latest[0]) return null;
    const sources = await publishedSources(actor, familyId, latest[0].id, members);
    const pending = await query("SELECT id FROM assessments WHERE family_id=$1 AND region=$2 AND status<>'published' LIMIT 1", [familyId, actor.region]);
    if (pending[0]) return null;
    assertVersionsUsable(sources, ageAt(String(family[0].birth_date).slice(0, 10)), actor.region);
    return { previousRoundId: latest[0].id };
  } catch (error) {
    if (error instanceof HttpError) return null;
    throw error;
  }
}
