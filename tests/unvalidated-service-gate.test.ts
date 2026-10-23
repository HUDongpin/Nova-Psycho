import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor, ScaleDefinition } from "../src/domain/types";
import { previewAnswers } from "../src/domain/triad-report";
import { childScaleSupportIntake as childScale, parentScaleStaffNotes } from "../src/domain/triad-scales";
import { demoAdvice, demoTemplate } from "../src/domain/demo";
import { childScale as oldChild } from "./fixtures/triad-scales-ed66f27";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/auth", () => ({ audit: vi.fn(), hashPassword: vi.fn(async () => "synthetic-hash"), limitLogin: vi.fn(async () => undefined) }));

import { query, transaction } from "../src/lib/db";
import { createParentFamily, joinFamily, joinWithCode, startParentCase } from "../src/lib/triad";
import { assessmentDetail, createAssessment, saveDraft, submitAssessment } from "../src/lib/assessments";

const FAMILY = "22222222-3333-4444-8555-666666666666";
const PARENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STUDENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TASK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CODE = "TOPE-A2B3C4D5";
const CURRENT = `${childScale.id}@${childScale.version}`;
const LEGACY = "growth-child@1.0.0";
const unsupportedChild = { ...oldChild, id: "unsupported-child" };
const UNSUPPORTED = `${unsupportedChild.id}@${unsupportedChild.version}`;

const parentActor: Actor = { id: PARENT, name: "Synthetic parent", role: "parent", region: "CN" };
const studentActor: Actor = { id: STUDENT, name: "Synthetic student", role: "student", region: "CN" };
const parentBody = { parentName: "Synthetic parent", username: "synthetic.parent", password: "synthetic-password-1", relationship: "母亲" as const, childName: "Synthetic child", birthDate: "2014-06-01", grade: "初中" as const, assessment: true as const, sensitiveData: true as const, parentReport: true };
const familyBody = { requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", relationship: "母亲" as const, childName: "Synthetic child", birthDate: "2014-06-01", grade: "初中" as const, assessment: true as const, sensitiveData: true as const, parentReport: true };
const familyRow = { id: FAMILY, region: "CN", family_name: "Synthetic family", child_name: "Synthetic child", birth_date: "2014-06-01", grade: "初中", guardian_label: "母亲", assigned_to: null, join_code: CODE, created_at: new Date("2026-10-01T00:00:00Z") };

const statements: string[] = [];
let savedAnswers: unknown = null;
let legacyRound = false;
let syntheticMembers: Record<string, unknown>[] = [];
let taskScale: ScaleDefinition = oldChild;

function scaleRow(id: string): { id: string; definition: ScaleDefinition; status: "active" } | null {
  if (id === CURRENT) return { id, definition: childScale, status: "active" };
  if (id === LEGACY) return { id, definition: oldChild, status: "active" };
  if (id === UNSUPPORTED) return { id, definition: unsupportedChild, status: "active" };
  return null;
}

function rowsFor(sql: string, values: unknown[] = []): Record<string, unknown>[] {
  statements.push(sql);
  if(sql.includes("f.region AS family_region"))return syntheticMembers;
  if (sql.includes("FROM content_versions")) return [{ id: values[0], version: "1.0.0", content: values[0] === "advice" ? demoAdvice : demoTemplate }];
  if (sql.includes("definition->>'demo'") || sql.includes("triad_round_id IS NULL")) return [];
  if (sql.startsWith("SELECT id,definition,status FROM scales")) {
    const row = scaleRow(String(values[0]));
    return row ? [row] : [];
  }
  if (sql.includes("SELECT status FROM scales")) return [{ status: "active" }];
  if (sql.startsWith("SELECT id FROM scales")) return [{ id: String(values[0] ?? CURRENT) }];
  if (sql.includes("FROM users WHERE id=$1")) {
    const id = String(values[0]);
    const actor = id === PARENT ? parentActor : studentActor;
    return [{ ...actor, disabled: false, demo: false }];
  }
  if (sql.includes("FROM families f WHERE f.id=$1")) return [familyRow];
  if (sql.includes("FROM families WHERE created_by")) return [];
  if (sql.includes("SELECT 1 FROM families WHERE join_code")) return [];
  if (sql.includes("FROM families WHERE join_code") || sql.includes("SELECT id,birth_date FROM families") || sql.startsWith("SELECT id FROM families")) return [familyRow];
  if (sql.includes("FROM consents")) return [{ id: "consent", scopes: ["assessment", "parent_report", "sensitive_data"] }];
  if (sql.includes("s.scale_id=$5")) return [{ id: TASK }];
  if (sql.includes("SELECT 1 FROM memberships")) return [];
  if (sql.includes("SELECT user_id,role FROM memberships")) return [{ user_id: STUDENT, role: "student" }];
  if (sql.includes("SELECT m.role FROM memberships")) return [{ role: "student" }];
  if (sql.includes("status='pending'") && sql.includes("s.scale_id=$3")) return [];
  if (sql.includes("submitted_at IS NOT NULL") && sql.includes("s.scale_id=$3")) return [];
  if (sql.includes("FROM triad_rounds")) return legacyRound ? [{ id: "legacy-round" }] : [];
  if (sql.includes("respondent_role,submitted_at")) return legacyRound ? [{ respondent_role: "parent", submitted_at: null, definition: parentScaleStaffNotes }] : [];
  if (sql.includes("FROM assessments a JOIN scales")) return [{ id: TASK, status: "pending", definition: taskScale, draft_answers: {}, draft_revision: 0, family_id: FAMILY, child_name: "Synthetic child", birth_date: "2014-06-01", respondent_role: "student", region: "CN", respondent_id: STUDENT, triad_round_id: null, snapshot: null }];
  if (sql.includes("SELECT a.*,r.id AS report_id")) return [{ id: TASK, status: "pending", draft_revision: 0, family_id: FAMILY, respondent_id: STUDENT, respondent_role: "student", report_id: null, triad_round_id: null, snapshot: null }];
  if (sql.startsWith("UPDATE assessments SET draft_answers")) return [{ id: TASK, draft_revision: 1 }];
  if (sql.startsWith("UPDATE assessments SET answers")) { savedAnswers = JSON.parse(String(values[1])); return []; }
  return [];
}

function writes(): string[] {
  return statements.filter(sql => /^\s*(insert|update|delete)/i.test(sql));
}

function stub(mode: "demo" | "service") {
  vi.stubEnv("NOVA_REGION", "CN");
  vi.stubEnv("NOVA_MODE", mode);
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL", mode === "demo" ? "http://127.0.0.1:3100" : "https://nova.example.invalid");
  vi.stubEnv("NOVA_REPORT_DIR", "work/test-private");
  vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
}

beforeEach(() => {
  legacyRound = false;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
  statements.length = 0;
  savedAnswers = null;
  syntheticMembers = [];
  taskScale = oldChild;
  vi.clearAllMocks();
  vi.mocked(query).mockImplementation(async (sql, values) => rowsFor(String(sql), values ?? []));
  vi.mocked(transaction).mockImplementation(async fn => fn({ query: async (sql: string, values?: unknown[]) => ({ rows: rowsFor(String(sql), values ?? []) }) } as never));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("service mode admits the known non-clinical triad", () => {
  beforeEach(() => stub("service"));

  it("registers a parent and opens the assigned questionnaire", async () => {
    await expect(startParentCase(parentBody, "zh-CN")).resolves.toHaveProperty("familyId");
    expect(writes().some(sql => sql.startsWith("INSERT INTO assessments"))).toBe(true);
  });

  it("creates a family and opens the assigned questionnaire for an existing parent", async () => {
    await expect(createParentFamily(parentActor, familyBody, "zh-CN")).resolves.toHaveProperty("familyId");
    expect(writes().some(sql => sql.startsWith("INSERT INTO assessments"))).toBe(true);
  });

  it("registers an invited teacher and opens the assigned questionnaire", async () => {
    await expect(joinWithCode({ code: CODE, role: "teacher", name: "Synthetic teacher", username: "synthetic.teacher", password: "synthetic-password-1" }, "zh-CN")).resolves.toHaveProperty("userId");
    expect(writes().some(sql => sql.startsWith("INSERT INTO assessments"))).toBe(true);
  });

  it("returns an existing member's original questionnaire without writing", async () => {
    await expect(joinFamily(studentActor, { code: CODE }, "zh-CN")).resolves.toMatchObject({ assessmentId: TASK, alreadyMember: true });
    expect(writes()).toEqual([]);
  });

  it("assigns the known triad without claiming validated norms", async () => {
    const input = { familyId: FAMILY, respondentId: STUDENT, locale: "zh-CN" as const };
    await expect(createAssessment(parentActor, { ...input, scaleVersionId: CURRENT })).resolves.toHaveProperty("id");
    legacyRound = true;
    await expect(createAssessment(parentActor, { ...input, scaleVersionId: LEGACY })).resolves.toHaveProperty("id");
    expect(oldChild.demo).toBe(false);
    expect(oldChild.norm.validated).toBe(false);
    expect(writes().filter(sql => sql.startsWith("INSERT INTO assessments"))).toHaveLength(2);
  });

  it("opens a pending known legacy questionnaire while retaining its demo label", async () => {
    const record = await assessmentDetail(studentActor, TASK, "zh-CN");
    expect(record).toMatchObject({ status: "pending", demo: true });
    expect(record).not.toHaveProperty("responseBlockedReason");
    expect(writes()).toEqual([]);
  });

  it("saves a draft on a pending known legacy task", async () => {
    await expect(saveDraft(studentActor, TASK, { answers: previewAnswers(oldChild, "calm"), acknowledged: true, revision: 0 })).resolves.toEqual({ ok: true, revision: 1 });
    expect(writes().filter(sql => sql.startsWith("UPDATE assessments SET draft_answers"))).toHaveLength(1);
  });

  it("submits the known legacy task without changing its norm or pretending it is synthetic", async () => {
    await expect(submitAssessment(studentActor, TASK, { answers: previewAnswers(oldChild, "calm"), acknowledged: true, revision: 0 })).resolves.toMatchObject({ status: "queued" });
    expect(savedAnswers).toMatchObject({ scale: { id: oldChild.id, version: oldChild.version, norm: { validated: false } } });
    expect(savedAnswers).not.toHaveProperty("syntheticTest");
  });
});

describe("service mode still refuses unknown unvalidated instruments", () => {
  beforeEach(() => {
  legacyRound = false; stub("service"); taskScale = unsupportedChild; });
  it("exposes the blocker and refuses draft, submission and assignment without writing", async () => {
    const refused = { status: 409, code: "UNVALIDATED_INSTRUMENT" };
    await expect(assessmentDetail(studentActor, TASK, "zh-CN")).resolves.toMatchObject({ responseBlockedReason: "UNVALIDATED_INSTRUMENT" });
    await expect(saveDraft(studentActor, TASK, { answers: {}, acknowledged: true, revision: 0 })).rejects.toMatchObject(refused);
    await expect(submitAssessment(studentActor, TASK, { answers: previewAnswers(unsupportedChild, "calm"), acknowledged: true, revision: 0 })).rejects.toMatchObject(refused);
    await expect(createAssessment(parentActor, { familyId: FAMILY, respondentId: STUDENT, scaleVersionId: UNSUPPORTED, locale: "zh-CN" })).rejects.toMatchObject(refused);
    expect(writes()).toEqual([]);
    expect(transaction).not.toHaveBeenCalled();
    expect(savedAnswers).toBeNull();
  });
});

describe("demo mode still lets the same unvalidated paths finish", () => {
  beforeEach(() => stub("demo"));

  it("opens anonymous parent registration and logged-in family creation", async () => {
    await expect(startParentCase(parentBody, "zh-CN")).resolves.toHaveProperty("familyId");
    await expect(createParentFamily(parentActor, familyBody, "zh-CN")).resolves.toHaveProperty("joinCode");
    expect(statements.some(sql => sql.startsWith("INSERT INTO users"))).toBe(true);
    expect(statements.some(sql => sql.startsWith("INSERT INTO families"))).toBe(true);
  });

  it("opens anonymous join and returns an existing member's original task", async () => {
    await expect(joinWithCode({ code: CODE, role: "teacher", name: "Synthetic teacher", username: "synthetic.teacher", password: "synthetic-password-1" }, "zh-CN")).resolves.toHaveProperty("userId");
    await expect(joinFamily(studentActor, { code: CODE }, "zh-CN")).resolves.toMatchObject({ alreadyMember: true, assessmentId: TASK });
  });

  it("assigns the current triad and a non-demo unvalidated scale", async () => {
    const input = { familyId: FAMILY, respondentId: STUDENT, locale: "zh-CN" as const };
    await expect(createAssessment(parentActor, { ...input, scaleVersionId: CURRENT })).resolves.toHaveProperty("id");
    legacyRound = true;
    await expect(createAssessment(parentActor, { ...input, scaleVersionId: LEGACY })).resolves.toHaveProperty("id");
    const inserted = statements.filter(sql => sql.startsWith("INSERT INTO assessments"));
    expect(inserted.length).toBeGreaterThanOrEqual(2);
  });

  it("saves a draft and submits the original growth-child@1.0.0 definition", async () => {
    const answers = previewAnswers(oldChild, "calm");
    await expect(assessmentDetail(studentActor, TASK, "zh-CN")).resolves.toMatchObject({ demo: true });
    await expect(saveDraft(studentActor, TASK, { answers, acknowledged: true, revision: 0 })).resolves.toMatchObject({ ok: true, revision: 1 });
    const submitted = await submitAssessment(studentActor, TASK, { answers, acknowledged: true, revision: 0 });
    expect(submitted).toMatchObject({ status: "queued" });
    expect(savedAnswers).toMatchObject({ scale: { version: "1.0.0", demo: false }, score: { status: "valid", demo: false } });
  });
});


describe("designated synthetic production assessment admission", () => {
  const designated = { ...studentActor, sessionMethod: "test" as const };
  beforeEach(() => {
  legacyRound = false;
    stub("service");
    vi.stubEnv("NOVA_AUTH_PROVIDER", "clerk");
    vi.stubEnv("NOVA_TEST_ACCOUNT_USERNAMES", "synthetic.parent,synthetic.student,synthetic.teacher");
    vi.stubEnv("NOVA_SYNTHETIC_TEST_FAMILY_IDS", FAMILY);
    syntheticMembers = [
      { id: PARENT, role: "parent" }, { id: STUDENT, role: "student" }, { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", role: "teacher" },
    ].map(member => ({ ...member, user_role: member.role, username: `synthetic.${member.role}`, region: "CN", family_region: "CN", disabled: false, demo: false, has_password: true }));
  });
  it("discloses the synthetic scope and permits draft without changing the legacy norm", async () => {
    const record = await assessmentDetail(designated, TASK, "zh-CN");
    expect(record).toMatchObject({ syntheticTest: true, status: "pending", demo: true });
    expect(record).not.toHaveProperty("responseBlockedReason");
    await expect(saveDraft(designated, TASK, { answers: previewAnswers(oldChild, "calm"), acknowledged: true, revision: 0 })).resolves.toEqual({ ok: true, revision: 1 });
    expect(oldChild.norm.validated).toBe(false);
    expect(statements.some(sql => sql.includes("FOR SHARE OF f,m,u"))).toBe(true);
  });
  it("pins synthetic provenance and forces AI off in the submitted snapshot", async () => {
    await expect(submitAssessment(designated, TASK, { answers: previewAnswers(oldChild, "calm"), acknowledged: true, revision: 0 })).resolves.toMatchObject({ status: "queued" });
    expect(savedAnswers).toMatchObject({ syntheticTest: true, aiConsented: false, score: { demo: true, status: "valid" }, scale: { norm: { validated: false }, demo: false } });
  });
  it("keeps ordinary Clerk participation distinct from synthetic-test provenance", async () => {
    const record = await assessmentDetail(studentActor, TASK, "zh-CN");
    expect(record).not.toHaveProperty("syntheticTest");
    expect(record).not.toHaveProperty("responseBlockedReason");
    await expect(submitAssessment(studentActor, TASK, { answers: previewAnswers(oldChild, "calm"), acknowledged: true, revision: 0 })).resolves.toMatchObject({ status: "queued" });
    expect(savedAnswers).not.toHaveProperty("syntheticTest");
  });
  it.each(["draft", "submit", "assign"] as const)("rechecks the synthetic exception under the family lock before %s of an unsupported instrument", async action => {
    taskScale = unsupportedChild;
    vi.mocked(transaction).mockImplementation(async fn => {
      vi.stubEnv("NOVA_SYNTHETIC_TEST_FAMILY_IDS", "");
      return fn({ query: async (sql: string, values?: unknown[]) => ({ rows: rowsFor(String(sql), values ?? []) }) } as never);
    });
    const operation = action === "draft" ? saveDraft(designated, TASK, { answers: {}, acknowledged: true, revision: 0 })
      : action === "submit" ? submitAssessment(designated, TASK, { answers: previewAnswers(oldChild, "calm"), acknowledged: true, revision: 0 })
      : createAssessment({ ...parentActor, sessionMethod: "test" }, { familyId: FAMILY, respondentId: STUDENT, scaleVersionId: UNSUPPORTED, locale: "zh-CN" });
    await expect(operation).rejects.toMatchObject({ code: "UNVALIDATED_INSTRUMENT" });
    expect(writes()).toEqual([]);
  });

  it("still requires guardian participation consent for synthetic draft and submit", async () => {
    vi.mocked(query).mockImplementation(async (sql, values) => String(sql).includes("FROM consents") ? [] : rowsFor(String(sql), values ?? []));
    vi.mocked(transaction).mockImplementation(async fn => fn({ query: async (sql: string, values?: unknown[]) => ({ rows: sql.includes("FROM consents") ? [] : rowsFor(sql, values ?? []) }) } as never));
    await expect(saveDraft(designated, TASK, { answers: {}, acknowledged: true, revision: 0 })).rejects.toMatchObject({ code: "GUARDIAN_CONSENT_REQUIRED" });
    await expect(submitAssessment(designated, TASK, { answers: previewAnswers(oldChild, "calm"), acknowledged: true, revision: 0 })).rejects.toMatchObject({ code: "GUARDIAN_CONSENT_REQUIRED" });
    expect(writes()).toEqual([]);
  });
  it("will not accept a client-authored synthetic marker", async () => {
    await expect(saveDraft(designated, TASK, { answers: {}, acknowledged: true, revision: 0, syntheticTest: true })).rejects.toThrow();
    await expect(submitAssessment(designated, TASK, { answers: {}, acknowledged: true, revision: 0, syntheticTest: true })).rejects.toThrow();
    expect(writes()).toEqual([]);
  });
});
