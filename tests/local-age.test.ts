import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { Actor } from "../src/domain/types";
import { ageAt } from "../src/lib/access";
import { childScale } from "../src/domain/triad-scales";
import { previewAnswers } from "../src/domain/triad-report";
import { demoAdvice, demoTemplate } from "../src/domain/demo";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/content", () => ({ currentContent: vi.fn(), lockContent: vi.fn(), getScale: vi.fn() }));
import { query, transaction } from "../src/lib/db";
import { getScale, currentContent } from "../src/lib/content";
import { assessmentDetail, createAssessment, submitAssessment } from "../src/lib/assessments";
import { startParentCase } from "../src/lib/triad";

const BEFORE = new Date("2026-10-10T15:59:59.000Z");
const AFTER = new Date("2026-10-10T16:00:00.000Z");
const FAMILY = "11111111-2222-4333-8444-555555555555";
const TASK = "22222222-3333-4444-8555-666666666666";
const USER = "33333333-4444-4555-8666-777777777777";
const parent: Actor = { id: USER, name: "Synthetic parent", role: "parent", region: "CN" };
const student: Actor = { id: USER, name: "Synthetic student", role: "student", region: "CN" };

function stub(region: "CN" | "HK") {
  vi.stubEnv("NOVA_REGION", region);
  vi.stubEnv("NOVA_MODE", "demo");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR", "work/test-private");
  vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
  parent.region = region;
  student.region = region;
}

function at(instant: Date) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(instant);
}

const births = [
  ["2018-10-11", 7, 8],
  ["2014-10-11", 11, 12],
  ["2008-10-11", 17, 18]
] as const;

describe("birth-date age uses the service region's local date", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it.each(["CN", "HK"] as const)("stays on the previous local day at 15:59:59Z and turns the birthday at 16:00:00Z in %s", region => {
    stub(region);
    for (const [birth, before, after] of births) {
      expect(ageAt(birth, BEFORE)).toBe(before);
      expect(ageAt(birth, AFTER)).toBe(after);
    }
    expect(childScale.version).toBe("1.3.0");
  });
});

describe("eligibility, visibility, score age and mismatch follow that local age", () => {
  const client = { query: vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>() };
  const signup = { parentName: "Synthetic parent", username: "synthetic.parent", password: "synthetic-password-1", relationship: "母亲" as const, childName: "Synthetic child", birthDate: "2018-10-11", grade: "初中" as const, accepted: true as const };

  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(transaction).mockReset();
    client.query.mockReset();
    vi.mocked(query).mockResolvedValue([{ attempts: 9 }] as never);
    vi.mocked(transaction).mockResolvedValue({ id: "created" } as never);
    vi.mocked(getScale).mockResolvedValue({ id: `${childScale.id}@${childScale.version}`, definition: childScale, status: "active" });
    vi.mocked(currentContent).mockImplementation((async (kind: string) => ({ id: kind, version: "1.0.0", content: kind === "advice" ? demoAdvice : demoTemplate })) as typeof currentContent);
    vi.mocked(transaction).mockImplementation(async fn => fn(client as unknown as PoolClient));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  function family(birthDate: string) {
    return { id: FAMILY, region: parent.region, family_name: "Synthetic family", child_name: "Synthetic child", birth_date: birthDate, grade: "初中", guardian_label: "母亲", assigned_to: null };
  }
  function wire(birthDate: string) {
    const assessment = { id: TASK, family_id: FAMILY, respondent_id: USER, respondent_role: "student", status: "pending", draft_revision: 0, triad_round_id: "44444444-5555-4666-8777-888888888888", snapshot: null, definition: childScale };
    vi.mocked(query).mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("definition->>'demo'")) return [];
      if (text.includes("FROM families f WHERE")) return [family(birthDate)];
      if (text.includes("FROM memberships")) return [{ role: "student" }];
      if (text.includes("FROM assessments a JOIN scales")) return [{ ...assessment, birth_date: birthDate, child_name: "Synthetic child", draft_answers: {} }];
      if (text.includes("FROM consents")) return [{ id: "consent" }];
      return [];
    });
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id FROM families")) return { rows: [{ id: FAMILY }] };
      if (sql.includes("SELECT status FROM scales")) return { rows: [{ status: "active" }] };
      if (sql.includes("SELECT a.*,r.id AS report_id")) return { rows: [assessment] };
      if (sql.includes("SELECT scopes FROM consents")) return { rows: [{ scopes: ["assessment", "parent_report", "sensitive_data"] }] };
      if (sql.includes("status='pending'")) return { rows: [] };
      if (sql.includes("SELECT submitted_at")) return { rows: [] };
      if (sql.includes("triad_round_id IS NULL")) return { rows: [] };
      if (sql.includes("FROM triad_rounds")) return { rows: [] };
      if (sql.startsWith("INSERT INTO triad_rounds")) return { rows: [] };
      if (sql.startsWith("INSERT INTO assessments")) return { rows: [] };
      return { rows: [] };
    });
  }

  it.each(["CN", "HK"] as const)("rejects age 7 and 18, and accepts 8 and 17, on the local birthday in %s", async region => {
    stub(region);
    at(BEFORE);
    await expect(startParentCase({ ...signup, birthDate: "2018-10-11" }, "zh-CN")).rejects.toMatchObject({ code: "CHILD_AGE" });
    await expect(startParentCase({ ...signup, birthDate: "2008-10-11" }, "zh-HK")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    at(AFTER);
    await expect(startParentCase({ ...signup, birthDate: "2008-10-11" }, "zh-CN")).rejects.toMatchObject({ code: "CHILD_AGE" });
    await expect(startParentCase({ ...signup, birthDate: "2018-10-11" }, "zh-HK")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it.each(["CN", "HK"] as const)("assigns and scores the 8 and 18 edges from the local date in %s", async region => {
    stub(region);
    at(BEFORE);
    wire("2018-10-11");
    await expect(createAssessment(parent, { familyId: FAMILY, respondentId: USER, scaleVersionId: `${childScale.id}@${childScale.version}`, locale: "zh-CN" })).rejects.toMatchObject({ code: "INELIGIBLE" });
    wire("2008-10-11");
    await expect(createAssessment(parent, { familyId: FAMILY, respondentId: USER, scaleVersionId: `${childScale.id}@${childScale.version}`, locale: "zh-CN" })).resolves.toHaveProperty("id");
    at(AFTER);
    wire("2008-10-11");
    await expect(createAssessment(parent, { familyId: FAMILY, respondentId: USER, scaleVersionId: `${childScale.id}@${childScale.version}`, locale: "zh-CN" })).rejects.toMatchObject({ code: "INELIGIBLE" });
    wire("2018-10-11");
    await expect(createAssessment(parent, { familyId: FAMILY, respondentId: USER, scaleVersionId: `${childScale.id}@${childScale.version}`, locale: "zh-CN" })).resolves.toHaveProperty("id");
  });

  it.each(["CN", "HK"] as const)("opens the 12+ block and stores the local age only after local midnight in %s", async region => {
    stub(region);
    at(BEFORE);
    wire("2014-10-11");
    const young = await assessmentDetail(student, TASK, "zh-CN");
    expect(JSON.stringify(young.surveyJson)).not.toContain('"name":"c18_1"');
    const early = previewAnswers(childScale);
    early.c_age = 11;
    const earlyResult = await submitAssessment(student, TASK, { answers: early, acknowledged: true, revision: 0 });
    expect(earlyResult).toMatchObject({ status: "queued" });
    const earlySnapshot = JSON.parse(String(client.query.mock.calls.find(([sql]) => String(sql).includes("UPDATE assessments SET answers"))?.[1]?.[1]));
    expect(earlySnapshot.score.age).toBe(11);
    expect(earlySnapshot.score.reviewFlags).toBeUndefined();
    const tooOld = previewAnswers(childScale);
    tooOld.c_age = 12;
    client.query.mockClear();
    await submitAssessment(student, TASK, { answers: tooOld, acknowledged: true, revision: 0 });
    const flagged = JSON.parse(String(client.query.mock.calls.find(([sql]) => String(sql).includes("UPDATE assessments SET answers"))?.[1]?.[1]));
    expect(flagged.score).toMatchObject({ age: 11, reviewFlags: ["age_mismatch"] });

    at(AFTER);
    wire("2014-10-11");
    const older = await assessmentDetail(student, TASK, "zh-HK");
    expect(JSON.stringify(older.surveyJson)).toContain('"name":"c18_1"');
    const stated = previewAnswers(childScale);
    stated.c_age = 12;
    client.query.mockClear();
    await submitAssessment(student, TASK, { answers: stated, acknowledged: true, revision: 0 });
    const matched = JSON.parse(String(client.query.mock.calls.find(([sql]) => String(sql).includes("UPDATE assessments SET answers"))?.[1]?.[1]));
    expect(matched.score.age).toBe(12);
    expect(matched.score.reviewFlags).toBeUndefined();
    const missingYouth = previewAnswers(childScale);
    for (const key of Object.keys(missingYouth)) if (key.startsWith("c18_")) delete missingYouth[key];
    missingYouth.c_age = 12;
    await expect(submitAssessment(student, TASK, { answers: missingYouth, acknowledged: true, revision: 0 })).rejects.toMatchObject({ code: "INCOMPLETE_TRIAD" });
    await expect(submitAssessment(student, TASK, { answers: stated, acknowledged: true, revision: 0, age: 40 } as never)).rejects.toThrow();
  });
});
