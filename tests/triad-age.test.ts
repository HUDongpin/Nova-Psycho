import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { Actor, ScaleDefinition } from "../src/domain/types";
import { statedAgeMismatch } from "../src/domain/age-review";
import { scoreAssessment } from "../src/domain/scoring";
import { surveyDefinition } from "../src/domain/survey";
import { composeTriad, previewAnswers, type TriadSource } from "../src/domain/triad-report";
import { childScaleBirthAge as childScale, childScaleSafety as legacyChild, childScaleStaffNotes, parentScale } from "../src/domain/triad-scales";
import { demoAdvice, demoTemplate } from "../src/domain/demo";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/content", () => ({ currentContent: vi.fn(), lockContent: vi.fn() }));
import { query, transaction } from "../src/lib/db";
import { currentContent } from "../src/lib/content";
import { assessmentDetail, submitAssessment } from "../src/lib/assessments";

const FAMILY = "11111111-2222-4333-8444-555555555555";
const TASK = "22222222-3333-4444-8555-666666666666";
const STUDENT = "33333333-4444-4555-8666-777777777777";
const PARENT = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const student: Actor = { id: STUDENT, name: "Synthetic student", role: "student", region: "CN" };
const parent: Actor = { id: PARENT, name: "Synthetic parent", role: "parent", region: "CN" };
const client = { query: vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>() };
const context = { region: "CN" as const, role: "student" as const };

function withoutYouth(answers: Record<string, unknown>) {
  for (const key of Object.keys(answers)) if (key.startsWith("c18_")) delete answers[key];
  return answers;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
  vi.stubEnv("NOVA_REGION", "CN");
  vi.stubEnv("NOVA_MODE", "demo");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR", "work/test-private");
  vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
  vi.mocked(query).mockReset();
  client.query.mockReset();
  vi.mocked(transaction).mockImplementation(fn => fn(client as unknown as PoolClient));
  vi.mocked(currentContent).mockImplementation((async (kind: string) => ({ id: kind, version: "1.0.0", content: kind === "advice" ? demoAdvice : demoTemplate })) as typeof currentContent);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("birth-date age is the only age used for the youth block", () => {
  it("shows the 12+ items from the birth-date age, not from c_age", () => {
    const young = JSON.stringify(surveyDefinition(childScale, "student", "zh-CN", { age: 11 }));
    const older = JSON.stringify(surveyDefinition(childScale, "student", "zh-CN", { age: 12 }));
    expect(young).not.toContain('"name":"c18_1"');
    expect(older).toContain('"name":"c18_1"');
    expect(older).not.toContain("{c_age} anyof [12");
    const legacy = JSON.stringify(surveyDefinition(legacyChild, "student", "zh-CN", { age: 11 }));
    expect(legacy).toContain("{c_age} anyof [12,13,14,15,16,17]");
    expect(scoreAssessment(childScale, {}, { ...context, age: 7 }).status).toBe("ineligible");
    expect(scoreAssessment(childScale, {}, { ...context, age: 12 }).reasons).not.toContain("instrument_age");
  });

  it("requires the youth block only when the birth-date age is at least 12", () => {
    const answered = previewAnswers(childScale);
    answered.c_age = 15;
    const young = scoreAssessment(childScale, answered, { ...context, age: 11 });
    expect(young).toMatchObject({ status: "valid", age: 11 });
    expect(young.dimensions.find(item => item.key === "c18")).toMatchObject({ raw: null, totalItems: 0 });
    const missing = withoutYouth(previewAnswers(childScale));
    missing.c_age = 10;
    expect(scoreAssessment(childScale, missing, { ...context, age: 12 }).status).toBe("incomplete");
    const complete = previewAnswers(childScale);
    complete.c_age = 10;
    const older = scoreAssessment(childScale, complete, { ...context, age: 12 });
    expect(older.status).toBe("valid");
    expect(older.dimensions.find(item => item.key === "c18")?.raw).not.toBeNull();

    const statedOlder = previewAnswers(legacyChild);
    statedOlder.c_age = 15;
    expect(scoreAssessment(legacyChild, statedOlder, { ...context, age: 11 }).status).toBe("incomplete");
    const statedYounger = previewAnswers(legacyChild);
    statedYounger.c_age = 11;
    const legacy = scoreAssessment(legacyChild, statedYounger, { ...context, age: 15 });
    expect(legacy).toMatchObject({ status: "valid", age: 15 });
  });

  it("compares only c_age with the birth-date age", () => {
    expect(statedAgeMismatch(childScale, { c_age: 11 }, 12)).toBe(true);
    expect(statedAgeMismatch(childScale, { c_age: 12 }, 12)).toBe(false);
    expect(statedAgeMismatch(childScale, {}, 12)).toBe(false);
    expect(statedAgeMismatch(parentScale, { p_age: 10 }, 12)).toBe(false);
  });

  it("leaves the autonomy section out of a report when the birth-date age is under 12", () => {
    const source = (age: number): TriadSource => {
      const answers = previewAnswers(childScale);
      return { role: "student", scale: childScale, answers, score: scoreAssessment(childScale, answers, { ...context, age }), submittedAt: "2026-10-11T00:00:00.000Z" };
    };
    expect(composeTriad([source(11)]).domains.some(domain => domain.key === "autonomy")).toBe(false);
    expect(composeTriad([source(12)]).domains.some(domain => domain.key === "autonomy")).toBe(true);
  });
});

describe("showIf does not turn a hidden dimension into missing answers", () => {
  function source(scale: ScaleDefinition, age: number, answers = previewAnswers(scale)): TriadSource {
    return { role: "student", scale, answers, score: scoreAssessment(scale, answers, { ...context, age }), submittedAt: "2026-10-11T00:00:00.000Z" };
  }

  it("leaves growth-child 1.1.0 autonomy unscored and out of the report for an under-12 child", () => {
    const answers = previewAnswers(legacyChild);
    answers.c_age = 11;
    const row = source(legacyChild, 11, answers);
    expect(row.score.dimensions.find(item => item.key === "c18")).toMatchObject({ raw: null, totalItems: 0, missing: [] });
    expect(row.score.reasons).not.toContain("dimension_items_missing");
    const report = composeTriad([row]);
    expect(report.domains.some(domain => domain.key === "autonomy")).toBe(false);
    expect(JSON.stringify(report)).not.toContain("不到四分之三");
  });

  it("keeps birth-date youth items out under 12 and scores them from 12", () => {
    expect(childScale.version).toBe("1.2.0");
    expect(childScaleStaffNotes.version).toBe("1.3.0");
    for (const scale of [childScale, childScaleStaffNotes]) {
      expect(scale.items.find(item => item.id === "c18_1")?.visibleFromAge).toBe(12);
      const young = source(scale, 11);
      expect(young.score.status).toBe("valid");
      expect(young.score.dimensions.find(item => item.key === "c18")).toMatchObject({ raw: null, totalItems: 0, missing: [] });
      expect(composeTriad([young]).domains.some(domain => domain.key === "autonomy")).toBe(false);
      expect(JSON.stringify(composeTriad([young]))).not.toContain("不到四分之三");

      const older = source(scale, 12);
      const autonomy = older.score.dimensions.find(item => item.key === "c18");
      expect(older.score.status).toBe("valid");
      expect(autonomy).toMatchObject({ totalItems: 6, answered: 6, missing: [] });
      expect(autonomy?.raw).not.toBeNull();
      const olderReport = composeTriad([older]);
      expect(olderReport.domains.some(domain => domain.key === "autonomy")).toBe(true);
      expect(JSON.stringify(olderReport.domains.find(domain => domain.key === "autonomy"))).not.toContain("不到四分之三");
    }
  });
});

describe("staff review of a stated age that disagrees with the birth date", () => {
  function setup(definition: typeof childScale, birthDate: string, role: Actor["role"] = "student") {
    const assessment = { id: TASK, family_id: FAMILY, respondent_id: STUDENT, respondent_role: role, definition, status: "pending", draft_revision: 0, triad_round_id: "44444444-5555-4666-8777-888888888888", snapshot: null };
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.includes("FROM assessments a JOIN scales")) return [{ ...assessment, birth_date: birthDate, child_name: "Synthetic child", draft_answers: {} }];
      if (sql.includes("FROM families f WHERE")) return [{ id: FAMILY, child_name: "Synthetic child", birth_date: birthDate, grade: "初中" }];
      if (sql.includes("FROM consents")) return [{ id: "consent" }];
      return [];
    });
    client.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("FROM users WHERE id=$1")) {
        const id = String(values[0]);
        const actor = id === parent.id ? parent : student;
        return { rows: [{ id: actor.id, name: actor.name, role: actor.role, region: "CN", disabled: false, demo: false }] };
      }
      if (sql.includes("SELECT id FROM families")) return { rows: [{ id: FAMILY }] };
      if (sql.includes("FROM families")) return { rows: [{ id: FAMILY, child_name: "Synthetic child", birth_date: birthDate, grade: "初中", region: "CN" }] };
      if (sql.includes("SELECT a.*,r.id AS report_id")) return { rows: [assessment] };
      if (sql.includes("FROM consents")) return { rows: [{ scopes: ["assessment", "parent_report", "sensitive_data"] }] };
      return { rows: [] };
    });
  }

  it("opens the survey from the birth date and records a code-only mismatch", async () => {
    setup(childScale, "2015-10-12");
    const detail = await assessmentDetail(student, TASK, "zh-CN");
    expect(JSON.stringify(detail.surveyJson)).not.toContain('"name":"c18_1"');
    const answers = previewAnswers(childScale);
    answers.c_age = 15;
    const result = await submitAssessment(student, TASK, { answers, acknowledged: true, revision: 0 });
    expect(result).toMatchObject({ status: "queued", safetyGuidance: false });
    const saved = client.query.mock.calls.find(([sql]) => String(sql).includes("UPDATE assessments SET answers"));
    const snapshot = JSON.parse(String(saved?.[1]?.[1]));
    expect(snapshot.score).toMatchObject({ age: 10, reviewFlags: ["age_mismatch"] });
    expect(snapshot.scale.items.find((item: { id: string }) => item.id === "c18_1").visibleFromAge).toBe(12);
    const audit = client.query.mock.calls.find(([sql]) => String(sql).includes("triad.age_mismatch"));
    expect(audit?.[1]).toEqual(["CN", TASK]);
    expect(JSON.stringify(audit?.[1])).not.toMatch(/2015|岁|年齡|年龄/);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO staff_alerts"))).toBe(false);
  });

  it("does not flag a matching age or a parent age answer", async () => {
    setup(childScale, "2014-10-11");
    const answers = previewAnswers(childScale);
    answers.c_age = 12;
    await submitAssessment(student, TASK, { answers, acknowledged: true, revision: 0 });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("triad.age_mismatch"))).toBe(false);
    setup(parentScale, "2014-10-11", "parent");
    const parentAnswers = previewAnswers(parentScale);
    parentAnswers.p_age = 8;
    await submitAssessment(parent, TASK, { answers: parentAnswers, acknowledged: true, revision: 0 });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("triad.age_mismatch"))).toBe(false);
  });

  it("rejects a 12-year-old submission that skips the youth block even when c_age says 10", async () => {
    setup(childScale, "2014-10-11");
    const answers = withoutYouth(previewAnswers(childScale));
    answers.c_age = 10;
    await expect(submitAssessment(student, TASK, { answers, acknowledged: true, revision: 0 })).rejects.toMatchObject({ code: "INCOMPLETE_TRIAD" });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("triad.age_mismatch"))).toBe(false);
  });
});
