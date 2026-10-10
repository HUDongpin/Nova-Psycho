import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { Model } from "survey-core";
import type { Actor } from "../src/domain/types";
import { scoreAssessment } from "../src/domain/scoring";
import { surveyDefinition } from "../src/domain/survey";
import { previewAnswers } from "../src/domain/triad-report";
import { childScale, parentScale, teacherScale } from "../src/domain/triad-scales";
import { parseScale } from "../src/domain/validation";
import { demoAdvice, demoTemplate } from "../src/domain/demo";
import { childScaleAt1_0_0 } from "./fixtures/child-scale-v1";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/content", () => ({ currentContent: vi.fn(), lockContent: vi.fn() }));
import { query, transaction } from "../src/lib/db";
import { currentContent } from "../src/lib/content";
import { submitAssessment } from "../src/lib/assessments";
import { ensureTriadInstruments } from "../src/lib/triad";

const familyId = "11111111-2222-4333-8444-555555555555";
const assessmentId = "22222222-3333-4444-8555-666666666666";
const userId = "33333333-4444-4555-8666-777777777777";
const roundId = "44444444-5555-4666-8777-888888888888";
const actor: Actor = { id: userId, name: "Synthetic", role: "student", region: "CN" };
const context = { age: 12, region: "CN" as const, role: "student" as const };
const opened = childScaleAt1_0_0();
const client = { query: vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>() };

beforeEach(() => {
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
afterEach(() => vi.unstubAllEnvs());

function openedAnswers(selected: 7 | 8) {
  const answers: Record<string, number | number[] | string> = { ...previewAnswers(opened, "calm"), c14: [selected] };
  delete answers.c15;
  delete answers.c16;
  return answers;
}

function setup(definition: typeof opened) {
  const assessment = { id: assessmentId, family_id: familyId, respondent_id: userId, respondent_role: "student", definition, status: "pending", draft_revision: 0, triad_round_id: roundId, snapshot: null };
  vi.mocked(query).mockImplementation(async (sql: string) => {
    if (sql.includes("FROM assessments a JOIN scales")) return [assessment];
    if (sql.includes("FROM families f WHERE")) return [{ id: familyId, child_name: "Synthetic child", birth_date: "2014-04-12", grade: "S2" }];
    return [];
  });
  client.query.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT id FROM families")) return { rows: [{ id: familyId }] };
    if (sql.includes("SELECT a.*,r.id AS report_id")) return { rows: [assessment] };
    if (sql.includes("AS scopes FROM consents WHERE family_id=$1")) return { rows: [{ scopes: ["assessment", "parent_report", "sensitive_data"] }] };
    if (sql.includes("INSERT INTO staff_alerts")) return { rows: [{ id: "new-alert" }] };
    return { rows: [] };
  });
}

describe("assessments opened on growth-child@1.0.0", () => {
  it("keeps the ed66f27 child safety contract", () => {
    expect(opened.demo).toBe(false);
    expect(opened.norm.validated).toBe(false);
    expect(() => parseScale(opened)).toThrow(/Unvalidated instruments must be labelled demo/);
    expect(opened.version).toBe("1.0.0");
    expect(opened.id).toBe("growth-child");
    const ids = opened.items.map(item => item.id);
    expect(ids.indexOf("c13_8")).toBeLessThan(ids.indexOf("c14"));
    expect(ids.indexOf("c16")).toBeLessThan(ids.indexOf("cs1"));
    const c14 = opened.items.find(item => item.id === "c14");
    const c15 = opened.items.find(item => item.id === "c15");
    expect(c14?.page).toBe("state");
    expect(c14?.choices.some(choice => choice.exclusive)).toBe(false);
    expect(c14?.noAutoAdvance).toBeUndefined();
    expect(c15?.showIf).toEqual({ itemId: "c14", anyOf: [1, 2, 3, 4, 5] });
    expect(opened.items.find(item => item.id === "c16")?.showIf).toEqual({ itemId: "c14", anyOf: [1, 2, 3, 4, 5] });
    expect(opened.riskRules.some(rule => rule.itemId === "c14" && rule.values.includes(7))).toBe(false);
    expect(opened.riskRules.some(rule => rule.itemId === "c14" && rule.values.includes(8))).toBe(false);
  });

  it.each([7, 8] as const)("still accepts c14=[%i] without the follow-up the old form hid", async selected => {
    const answers = openedAnswers(selected);
    const form = new Model(surveyDefinition(opened, "student", "zh-CN"));
    form.data = answers;
    expect(form.getQuestionByName("c15")?.isVisible).toBe(false);
    expect(form.validate()).toBe(true);
    const score = scoreAssessment(opened, answers, context);
    expect(score.status).toBe("valid");
    expect(score.reasons).toEqual([]);
    expect(score.scaleVersion).toBe("1.0.0");

    const sameFormNow = new Model(surveyDefinition(childScale, "student", "zh-CN"));
    sameFormNow.data = answers;
    expect(sameFormNow.getQuestionByName("c15")?.isVisible).toBe(true);
    expect(scoreAssessment(childScale, answers, context)).toMatchObject({ status: "incomplete", reasons: ["required_items_missing"] });

    setup(opened);
    const result = await submitAssessment(actor, assessmentId, { answers, acknowledged: true, revision: 0 });
    expect(result).toMatchObject({ status: "queued", safetyGuidance: false, phase: "waiting" });
    const saved = client.query.mock.calls.find(([sql]) => sql.includes("UPDATE assessments SET answers"));
    const snapshot = JSON.parse(String(saved?.[1]?.[1]));
    expect(snapshot.scale.version).toBe("1.0.0");
    expect(snapshot.score.status).toBe("valid");
    expect(client.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO staff_alerts"))).toBe(false);

    setup(childScale);
    await expect(submitAssessment(actor, assessmentId, { answers, acknowledged: true, revision: 0 })).rejects.toMatchObject({ status: 422, code: "INCOMPLETE_TRIAD" });
  });
});

describe("new triad assessments use the published definition", () => {
  it("inserts 1.2.0 and does not rewrite a stored definition", async () => {
    expect(`${childScale.id}@${childScale.version}`).toBe("growth-child@1.2.0");
    expect(`${parentScale.id}@${parentScale.version}`).toBe("growth-parent@1.2.0");
    expect(`${teacherScale.id}@${teacherScale.version}`).toBe("growth-teacher@1.2.0");
    expect(childScale.demo).toBe(true);
    expect(childScale.norm.validated).toBe(false);
    expect(childScale.items.find(item => item.id === "c15")?.showIf?.anyOf).toEqual([1, 2, 3, 4, 5, 7, 8]);
    vi.mocked(query).mockResolvedValue([]);
    await ensureTriadInstruments();
    const sql = vi.mocked(query).mock.calls.map(([text]) => String(text));
    expect(sql.some(text => text.includes("DO UPDATE SET definition"))).toBe(false);
    const inserts = vi.mocked(query).mock.calls.filter(([text]) => String(text).includes("INSERT INTO scales"));
    expect(inserts.map(([, values]) => values?.[0])).toEqual(["growth-child@1.2.0", "growth-parent@1.2.0", "growth-teacher@1.2.0"]);
    expect(inserts.every(([text]) => String(text).includes("ON CONFLICT(id) DO NOTHING"))).toBe(true);
    const stored = JSON.parse(String(inserts[0][1]?.[3]));
    expect(stored.version).toBe("1.2.0");
    expect(stored.demo).toBe(true);
    expect(stored.norm.validated).toBe(false);
    expect(stored.items.find((item: { id: string }) => item.id === "c15").showIf.anyOf).toEqual([1, 2, 3, 4, 5, 7, 8]);
    const retired = vi.mocked(query).mock.calls.filter(([text]) => String(text).includes("UPDATE scales SET status='retired'"));
    expect(retired.map(([, values]) => values?.[0])).toEqual([
      "growth-child@1.0.0", "growth-child@1.1.0",
      "growth-parent@1.0.0", "growth-parent@1.1.0",
      "growth-teacher@1.0.0", "growth-teacher@1.1.0"
    ]);
  });
});
