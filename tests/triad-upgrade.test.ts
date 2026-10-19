import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { Actor, ScaleDefinition } from "../src/domain/types";
import { previewAnswers } from "../src/domain/triad-report";
import { childScaleSafety, parentScaleSafety, teacherScaleSafety } from "../src/domain/triad-scales";
import { parseScale } from "../src/domain/validation";
import { demoAdvice, demoTemplate } from "../src/domain/demo";
import { childScale as oldChild, parentScale as oldParent, teacherScale as oldTeacher } from "./fixtures/triad-scales-ed66f27";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/content", () => ({ currentContent: vi.fn(), lockContent: vi.fn(), getScale: vi.fn() }));
import { query, transaction } from "../src/lib/db";
import { currentContent, getScale } from "../src/lib/content";
import { createAssessment, submitAssessment } from "../src/lib/assessments";
import { ensureTriadInstruments, joinFamily } from "../src/lib/triad";
import { HttpError } from "../src/lib/http";

const REPLAY = "11111111-1111-4111-8111-111111111111";
const ASSIGNED = "22222222-2222-4222-8222-222222222222";
const FRESH = "33333333-3333-4333-8333-333333333333";
const STUDENT = "44444444-4444-4444-8444-444444444444";
const TEACHER = "55555555-5555-4555-8555-555555555555";
const ADMIN = "77777777-7777-4777-8777-777777777777";
const ASSIGNED_STUDENT = "88888888-8888-4888-8888-888888888888";
const FRESH_PARENT = "99999999-9999-4999-8999-999999999999";
const FRESH_STUDENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FRESH_TEACHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROUND = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OLD_STUDENT_TASK = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OLD_TEACHER_TASK = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CODE = "TOPE-A2B3C4D5";

type ScaleRow = { id: string; scale_id: string; version: string; definition: ScaleDefinition; status: "active" | "retired" };
type AssessmentRow = {
  id: string; family_id: string; region: string; respondent_id: string; respondent_role: string;
  scale_version_id: string; locale: string; status: string; draft_revision: number;
  triad_round_id: string | null; submitted_at: string | null; answers: unknown; snapshot: unknown; created_at: string;
};
type FamilyRow = {
  id: string; region: "CN"; family_name: string; child_name: string; birth_date: string; grade: string;
  guardian_label: string; assigned_to: null; join_code: string | null;
};

const scales: ScaleRow[] = [];
const assessments: AssessmentRow[] = [];
const rounds: { id: string; family_id: string; region: string }[] = [];
const families: FamilyRow[] = [];
const users: { id: string; name: string; role: string; region: "CN"; disabled: boolean; demo: boolean }[] = [];
const memberships: { family_id: string; user_id: string; role: string }[] = [];
const consented = new Set<string>();
const sqlLog: string[] = [];
const client = { query: vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>() };

function family(id: string, join: string | null): FamilyRow {
  return { id, region: "CN", family_name: "Synthetic family", child_name: "Synthetic child", birth_date: "2014-06-01", grade: "初中", guardian_label: "母亲", assigned_to: null, join_code: join };
}
function seedScale(definition: ScaleDefinition) {
  const parsed = JSON.parse(JSON.stringify(parseScale(definition))) as ScaleDefinition;
  scales.push({ id: `${parsed.id}@${parsed.version}`, scale_id: parsed.id, version: parsed.version, definition: parsed, status: "active" });
}
function seedTask(id: string, familyId: string, userId: string, role: string, scaleId: string, roundId: string) {
  assessments.push({
    id, family_id: familyId, region: "CN", respondent_id: userId, respondent_role: role, scale_version_id: scaleId,
    locale: "zh-CN", status: "pending", draft_revision: 0, triad_round_id: roundId, submitted_at: null, answers: null, snapshot: null,
    created_at: "2026-10-01T00:00:00.000Z"
  });
}
function apply(sql: string, values: unknown[] = []): Record<string, unknown>[] {
  sqlLog.push(sql);
  if (/^(ALTER|CREATE|UPDATE families|INSERT INTO content_versions|INSERT INTO audit_events|SELECT pg_advisory)/.test(sql) || sql.includes("FROM content_versions")) return [];
  if (sql.startsWith("INSERT INTO scales")) {
    const [id, scaleId, version, definition] = values as [string, string, string, string];
    if (!scales.some(row => row.id === id)) scales.push({ id, scale_id: scaleId, version, definition: JSON.parse(definition) as ScaleDefinition, status: "active" });
    return [];
  }
  if (sql.includes("UPDATE scales SET status='retired'")) {
    const row = scales.find(item => item.id === values[0] && item.status === "active");
    if (row) row.status = "retired";
    return [];
  }
  if (sql.includes("FROM families WHERE join_code=$1")) return families.filter(item => item.join_code === values[0] && item.region === values[1]);
  if (sql.includes("FROM families f WHERE f.id=$1") || sql.includes("SELECT id FROM families WHERE id=$1")) {
    const row = families.find(item => item.id === values[0]);
    return row ? [sql.includes("SELECT id FROM families") ? { id: row.id } : row] : [];
  }
  if (sql.includes("FROM users WHERE id=$1")) return users.filter(item => item.id === values[0]);
  if (sql.includes("FROM consents")) return consented.has(String(values[0])) ? [{ id: "consent", scopes: ["assessment", "parent_report", "sensitive_data"] }] : [];
  if (sql.includes("SELECT m.role FROM memberships")) {
    const member = memberships.find(item => item.family_id === values[0] && item.user_id === values[1]);
    return member ? [{ role: member.role }] : [];
  }
  if (sql.includes("FROM memberships WHERE family_id=$1")) return memberships.filter(item => item.family_id === values[0]);
  if (sql.includes("s.scale_id=$5")) {
    const hits = assessments.filter(item => item.family_id === values[0] && item.respondent_id === values[1] && item.respondent_role === values[2] && item.region === values[3] && scales.find(scale => scale.id === item.scale_version_id)?.scale_id === values[4]);
    hits.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    return hits.slice(0, 1).map(item => ({ id: item.id }));
  }
  if (sql.includes("m.role=$4")) {
    const row = assessments.find(item => item.id === values[0] && item.respondent_id === values[1] && item.region === values[2]);
    const scale = scales.find(item => item.id === row?.scale_version_id);
    const home = families.find(item => item.id === row?.family_id);
    const member = memberships.find(item => item.family_id === row?.family_id && item.user_id === row?.respondent_id && item.role === values[3]);
    return row && scale && home && member ? [{ ...row, definition: scale.definition, child_name: home.child_name, birth_date: home.birth_date }] : [];
  }
  if (sql.includes("triad_round_id IS NULL")) return [];
  if (sql.includes("FROM triad_rounds")) return rounds.filter(item => item.family_id === values[0] && item.region === values[1]).slice(-1);
  if (sql.includes("respondent_role,submitted_at")) return assessments.filter(item => item.triad_round_id === values[0]).map(item => ({ respondent_role: item.respondent_role, submitted_at: item.submitted_at }));
  if (sql.includes("submitted_at IS NOT NULL") && sql.includes("triad_round_id=$3")) return assessments.filter(item => item.family_id === values[0] && item.region === values[1] && item.triad_round_id === values[2] && item.submitted_at).map(item => ({ id: item.id, respondent_role: item.respondent_role }));
  if (sql.includes("status='pending'") && sql.includes("s.scale_id=$3")) {
    return assessments.filter(item => item.family_id === values[0] && item.respondent_id === values[1] && item.status === "pending" && scales.find(scale => scale.id === item.scale_version_id)?.scale_id === values[2]).map(item => ({ id: item.id, triad_round_id: item.triad_round_id }));
  }
  if (sql.includes("a.submitted_at") && sql.includes("s.scale_id=$3")) {
    return assessments.filter(item => item.family_id === values[0] && item.respondent_id === values[1] && item.submitted_at && scales.find(scale => scale.id === item.scale_version_id)?.scale_id === values[2]).slice(-1).map(item => ({ submitted_at: item.submitted_at }));
  }
  if (sql.includes("status='pending'") && sql.includes("scale_version_id=$3")) return assessments.filter(item => item.family_id === values[0] && item.respondent_id === values[1] && item.scale_version_id === values[2] && item.status === "pending").map(item => ({ id: item.id, triad_round_id: item.triad_round_id }));
  if (sql.includes("SELECT submitted_at FROM assessments")) return assessments.filter(item => item.family_id === values[0] && item.respondent_id === values[1] && item.scale_version_id === values[2] && item.submitted_at).slice(-1).map(item => ({ submitted_at: item.submitted_at }));
  if (sql.includes("SELECT status FROM scales")) {
    const row = scales.find(item => item.id === values[0]);
    return row ? [{ status: row.status }] : [];
  }
  if (sql.includes("status='active'")) {
    const row = scales.find(item => item.id === values[0] && item.status === "active");
    return row ? [{ id: row.id }] : [];
  }
  if (sql.startsWith("INSERT INTO triad_rounds")) {
    rounds.push({ id: String(values[0]), family_id: String(values[1]), region: String(values[2]) });
    return [];
  }
  if (sql.startsWith("INSERT INTO assessments")) {
    const [id, familyId, region, respondentId, role, scaleId, locale, roundId] = values as string[];
    assessments.push({ id, family_id: familyId, region, respondent_id: respondentId, respondent_role: role, scale_version_id: scaleId, locale, triad_round_id: roundId, status: "pending", draft_revision: 0, submitted_at: null, answers: null, snapshot: null, created_at: new Date().toISOString() });
    return [];
  }
  if (sql.startsWith("UPDATE assessments SET answers")) {
    const row = assessments.find(item => item.id === values[3]);
    if (!row) return [];
    row.answers = JSON.parse(String(values[0]));
    row.snapshot = JSON.parse(String(values[1]));
    row.status = "queued";
    row.submitted_at = String(values[2]);
    row.triad_round_id = String(values[4]);
    return [{ id: row.id }];
  }
  if (sql.includes("SELECT a.*,r.id AS report_id")) {
    const row = assessments.find(item => item.id === values[0] && item.respondent_id === values[1]);
    return row ? [{ ...row, report_id: null }] : [];
  }
  if (sql.includes("FROM report_jobs")) return [];
  throw new Error(`Unhandled SQL: ${sql}`);
}

function oldAnswers(selected: 7 | 8) {
  const answers: Record<string, number | number[] | string> = { ...previewAnswers(parseScale(oldChild), "calm"), c14: [selected] };
  delete answers.c15;
  delete answers.c16;
  return answers;
}

beforeEach(() => {
  vi.stubEnv("NOVA_REGION", "CN");
  vi.stubEnv("NOVA_MODE", "demo");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR", "work/test-private");
  vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
  scales.length = 0; assessments.length = 0; rounds.length = 0; families.length = 0; users.length = 0; memberships.length = 0; consented.clear(); sqlLog.length = 0;
  for (const definition of [oldChild, oldParent, oldTeacher]) seedScale(definition);
  families.push(family(REPLAY, CODE), family(ASSIGNED, null), family(FRESH, null));
  users.push(
    { id: ADMIN, name: "Synthetic admin", role: "admin", region: "CN", disabled: false, demo: false },
    { id: STUDENT, name: "Synthetic student", role: "student", region: "CN", disabled: false, demo: false },
    { id: TEACHER, name: "Synthetic teacher", role: "teacher", region: "CN", disabled: false, demo: false },
    { id: ASSIGNED_STUDENT, name: "Synthetic assigned", role: "student", region: "CN", disabled: false, demo: false },
    { id: FRESH_PARENT, name: "Synthetic parent", role: "parent", region: "CN", disabled: false, demo: false },
    { id: FRESH_STUDENT, name: "Synthetic fresh student", role: "student", region: "CN", disabled: false, demo: false },
    { id: FRESH_TEACHER, name: "Synthetic fresh teacher", role: "teacher", region: "CN", disabled: false, demo: false }
  );
  memberships.push(
    { family_id: REPLAY, user_id: STUDENT, role: "student" },
    { family_id: REPLAY, user_id: TEACHER, role: "teacher" },
    { family_id: ASSIGNED, user_id: ASSIGNED_STUDENT, role: "student" },
    { family_id: FRESH, user_id: FRESH_PARENT, role: "parent" },
    { family_id: FRESH, user_id: FRESH_STUDENT, role: "student" },
    { family_id: FRESH, user_id: FRESH_TEACHER, role: "teacher" }
  );
  consented.add(REPLAY); consented.add(ASSIGNED); consented.add(FRESH);
  rounds.push({ id: ROUND, family_id: REPLAY, region: "CN" });
  seedTask(OLD_STUDENT_TASK, REPLAY, STUDENT, "student", "growth-child@1.0.0", ROUND);
  seedTask(OLD_TEACHER_TASK, REPLAY, TEACHER, "teacher", "growth-teacher@1.0.0", ROUND);
  vi.mocked(query).mockImplementation(async (sql, values) => apply(String(sql), values ?? []));
  vi.mocked(transaction).mockImplementation(fn => fn(client as unknown as PoolClient));
  client.query.mockImplementation(async (sql, values) => ({ rows: apply(String(sql), values ?? []) }));
  vi.mocked(getScale).mockImplementation(async (id: string) => {
    const row = scales.find(item => item.id === id);
    if (!row) throw new HttpError(404, "未找到量表版本。", "SCALE_NOT_FOUND");
    return { id: row.id, definition: row.definition, status: row.status };
  });
  vi.mocked(currentContent).mockImplementation((async (kind: string) => ({ id: kind, version: "1.0.0", content: kind === "advice" ? demoAdvice : demoTemplate })) as typeof currentContent);
});
afterEach(() => vi.unstubAllEnvs());

const admin: Actor = { id: ADMIN, name: "Synthetic admin", role: "admin", region: "CN" };
const student: Actor = { id: STUDENT, name: "Synthetic student", role: "student", region: "CN" };
const teacher: Actor = { id: TEACHER, name: "Synthetic teacher", role: "teacher", region: "CN" };
const assignedStudent: Actor = { id: ASSIGNED_STUDENT, name: "Synthetic assigned", role: "student", region: "CN" };

describe("ed66f27 triad upgrade", () => {
  it("keeps old tasks and joins, and opens new child, parent and teacher tasks on the safety revisions", async () => {
    const preserved = new Map(scales.map(row => [row.id, JSON.stringify(row.definition)]));
    const assigned = await createAssessment(admin, { familyId: ASSIGNED, respondentId: ASSIGNED_STUDENT, scaleVersionId: "growth-child@1.0.0", locale: "zh-CN" });
    expect(assessments.find(row => row.id === assigned.id)?.scale_version_id).toBe("growth-child@1.0.0");

    await ensureTriadInstruments();
    expect(sqlLog.some(sql => sql.includes("DO UPDATE SET definition"))).toBe(false);
    for (const [id, definition] of preserved) {
      const row = scales.find(item => item.id === id);
      expect(JSON.stringify(row?.definition)).toBe(definition);
    }
    expect(scales.find(row => row.id === "growth-child@1.0.0")?.status).toBe("retired");
    expect(scales.find(row => row.id === "growth-teacher@1.0.0")?.status).toBe("retired");
    expect(scales.find(row => row.id === "growth-parent@1.0.0")?.status).toBe("active");
    for (const current of [childScaleSafety, parentScaleSafety, teacherScaleSafety]) {
      const row = scales.find(item => item.id === `${current.id}@${current.version}`);
      expect(row?.status).toBe("active");
      expect(JSON.stringify(row?.definition)).toBe(JSON.stringify(parseScale(current)));
    }
    expect(scales.find(row => row.id === "growth-child@1.1.0")?.definition.items.find(item => item.id === "c15")?.showIf?.anyOf).toEqual([1, 2, 3, 4, 5, 7, 8]);
    expect(scales.find(row => row.id === "growth-parent@1.2.0")?.definition.items.find(item => item.id === "q22")?.choices.some(choice => choice.exclusive)).toBe(true);
    expect(scales.find(row => row.id === "growth-parent@1.1.0")?.definition.items.find(item => item.id === "q22")?.choices.some(choice => choice.exclusive)).not.toBe(true);
    expect(scales.find(row => row.id === "growth-teacher@1.1.0")?.definition.items.find(item => item.id === "t15")?.choices.some(choice => choice.exclusive)).toBe(true);
    expect(scales.find(row => row.id === "growth-child@1.0.0")?.definition.items.find(item => item.id === "c15")?.showIf?.anyOf).toEqual([1, 2, 3, 4, 5]);

    const beforeJoins = assessments.length;
    const first = await joinFamily(student, { code: CODE }, "zh-CN");
    const replay = await joinFamily(student, { code: CODE }, "zh-CN");
    const teacherReplay = await joinFamily(teacher, { code: CODE }, "zh-CN");
    expect(first).toMatchObject({ alreadyMember: true, assessmentId: OLD_STUDENT_TASK });
    expect(replay).toMatchObject({ alreadyMember: true, assessmentId: OLD_STUDENT_TASK });
    expect(teacherReplay).toMatchObject({ alreadyMember: true, assessmentId: OLD_TEACHER_TASK });
    expect(assessments).toHaveLength(beforeJoins);
    const lookup = client.query.mock.calls.find(([sql]) => String(sql).includes("s.scale_id=$5"));
    expect(lookup?.[1]?.[4]).toBe("growth-child");

    for (const [task, who, selected] of [[assigned.id, assignedStudent, 7], [OLD_STUDENT_TASK, student, 8]] as const) {
      const result = await submitAssessment(who, task, { answers: oldAnswers(selected), acknowledged: true, revision: 0 });
      expect(result).toMatchObject({ status: "queued", safetyGuidance: false });
      const row = assessments.find(item => item.id === task);
      expect(row?.scale_version_id).toBe("growth-child@1.0.0");
      expect(row?.status).toBe("queued");
      expect((row?.snapshot as { scale: { version: string }; score: { status: string } }).scale.version).toBe("1.0.0");
      expect((row?.snapshot as { score: { status: string } }).score.status).toBe("valid");
    }

    await expect(createAssessment(admin, { familyId: FRESH, respondentId: FRESH_STUDENT, scaleVersionId: "growth-child@1.0.0", locale: "zh-CN" })).rejects.toMatchObject({ code: "SCALE_RETIRED" });
    const created = {
      parent: await createAssessment(admin, { familyId: FRESH, respondentId: FRESH_PARENT, scaleVersionId: "growth-parent@1.2.0", locale: "zh-CN" }),
      student: await createAssessment(admin, { familyId: FRESH, respondentId: FRESH_STUDENT, scaleVersionId: "growth-child@1.1.0", locale: "zh-CN" }),
      teacher: await createAssessment(admin, { familyId: FRESH, respondentId: FRESH_TEACHER, scaleVersionId: "growth-teacher@1.1.0", locale: "zh-CN" })
    };
    expect(assessments.find(row => row.id === created.parent.id)?.scale_version_id).toBe("growth-parent@1.2.0");
    expect(assessments.find(row => row.id === created.student.id)?.scale_version_id).toBe("growth-child@1.1.0");
    expect(assessments.find(row => row.id === created.teacher.id)?.scale_version_id).toBe("growth-teacher@1.1.0");
    expect(new Set(Object.values(created).map(item => assessments.find(row => row.id === item.id)?.triad_round_id)).size).toBe(1);
  });
});
