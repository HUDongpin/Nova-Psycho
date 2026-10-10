import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor, ScaleDefinition } from "../src/domain/types";
import { previewAnswers } from "../src/domain/triad-report";
import { childScale } from "../src/domain/triad-scales";
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

const parentActor: Actor = { id: PARENT, name: "Synthetic parent", role: "parent", region: "CN" };
const studentActor: Actor = { id: STUDENT, name: "Synthetic student", role: "student", region: "CN" };
const parentBody = { parentName: "Synthetic parent", username: "synthetic.parent", password: "synthetic-password-1", relationship: "母亲" as const, childName: "Synthetic child", birthDate: "2014-06-01", grade: "初中" as const, accepted: true as const };
const familyBody = { requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", relationship: "母亲" as const, childName: "Synthetic child", birthDate: "2014-06-01", grade: "初中" as const, accepted: true as const };
const familyRow = { id: FAMILY, region: "CN", family_name: "Synthetic family", child_name: "Synthetic child", birth_date: "2014-06-01", grade: "初中", guardian_label: "母亲", assigned_to: null, join_code: CODE, created_at: new Date("2026-10-01T00:00:00Z") };

const statements: string[] = [];
let savedAnswers: unknown = null;

function scaleRow(id: string): { id: string; definition: ScaleDefinition; status: "active" } | null {
  if (id === CURRENT) return { id, definition: childScale, status: "active" };
  if (id === LEGACY) return { id, definition: oldChild, status: "active" };
  return null;
}

function rowsFor(sql: string, values: unknown[] = []): Record<string, unknown>[] {
  statements.push(sql);
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
  if (sql.includes("FROM assessments a JOIN scales")) return [{ id: TASK, status: "pending", definition: oldChild, draft_answers: {}, draft_revision: 0, family_id: FAMILY, child_name: "Synthetic child", birth_date: "2014-06-01", respondent_role: "student", region: "CN", respondent_id: STUDENT, triad_round_id: null, snapshot: null }];
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
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
  statements.length = 0;
  savedAnswers = null;
  vi.clearAllMocks();
  vi.mocked(query).mockImplementation(async (sql, values) => rowsFor(String(sql), values ?? []));
  vi.mocked(transaction).mockImplementation(async fn => fn({ query: async (sql: string, values?: unknown[]) => ({ rows: rowsFor(String(sql), values ?? []) }) } as never));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("service mode refuses every unvalidated triad path", () => {
  const refused = { status: 409, code: "UNVALIDATED_INSTRUMENT" };

  beforeEach(() => stub("service"));

  it("refuses anonymous parent registration without writing", async () => {
    await expect(startParentCase(parentBody, "zh-CN")).rejects.toMatchObject(refused);
    expect(writes()).toEqual([]);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses logged-in family creation without writing", async () => {
    await expect(createParentFamily(parentActor, familyBody, "zh-CN")).rejects.toMatchObject(refused);
    expect(writes()).toEqual([]);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses anonymous join without writing", async () => {
    await expect(joinWithCode({ code: CODE, role: "teacher", name: "Synthetic teacher", username: "synthetic.teacher", password: "synthetic-password-1" }, "zh-CN")).rejects.toMatchObject(refused);
    expect(writes()).toEqual([]);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses an existing member join without writing", async () => {
    await expect(joinFamily(studentActor, { code: CODE }, "zh-CN")).rejects.toMatchObject(refused);
    expect(writes()).toEqual([]);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses assignment of the current triad and of a non-demo unvalidated scale", async () => {
    const input = { familyId: FAMILY, respondentId: STUDENT, locale: "zh-CN" as const };
    await expect(createAssessment(parentActor, { ...input, scaleVersionId: CURRENT })).rejects.toMatchObject(refused);
    await expect(createAssessment(parentActor, { ...input, scaleVersionId: LEGACY })).rejects.toMatchObject(refused);
    expect(oldChild.demo).toBe(false);
    expect(oldChild.norm.validated).toBe(false);
    expect(writes()).toEqual([]);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a draft on a pending growth-child@1.0.0 task without changing it", async () => {
    await expect(saveDraft(studentActor, TASK, { answers: previewAnswers(oldChild, "calm"), acknowledged: true, revision: 0 })).rejects.toMatchObject(refused);
    expect(writes()).toEqual([]);
  });

  it("refuses submit of that pending growth-child@1.0.0 task without queueing it", async () => {
    await expect(submitAssessment(studentActor, TASK, { answers: previewAnswers(oldChild, "calm"), acknowledged: true, revision: 0 })).rejects.toMatchObject(refused);
    expect(savedAnswers).toBeNull();
    expect(writes()).toEqual([]);
    expect(transaction).not.toHaveBeenCalled();
    expect(statements.some(sql => sql.includes("report_jobs") || sql.includes("staff_alerts"))).toBe(false);
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
