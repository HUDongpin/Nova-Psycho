import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { Model } from "survey-core";
import type { Actor } from "../src/domain/types";
import { scoreAssessment } from "../src/domain/scoring";
import { surveyDefinition } from "../src/domain/survey";
import { previewAnswers } from "../src/domain/triad-report";
import { childScale, childScaleBirthAge, childScaleSafety, childScaleStaffNotes, parentScale, parentScaleSafety, parentScaleStaffNotes, parentScaleV1, teacherScale, teacherScaleSafety, teacherScaleStaffNotes } from "../src/domain/triad-scales";
import { parseScale, parseStoredScale } from "../src/domain/validation";
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
    if (sql.includes("FROM users WHERE id=$1")) return { rows: [{ id: userId, name: "Synthetic", role: "student", region: "CN", disabled: false, demo: false }] };
    if (sql.includes("SELECT id FROM families")) return { rows: [{ id: familyId }] };
    if (sql.includes("SELECT a.*,r.id AS report_id")) return { rows: [assessment] };
    if (sql.includes("AS scopes FROM consents") || sql.includes("SELECT scopes FROM consents")) return { rows: [{ scopes: ["assessment", "parent_report", "sensitive_data"] }] };
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

    const sameFormNow = new Model(surveyDefinition(childScaleSafety, "student", "zh-CN"));
    sameFormNow.data = answers;
    expect(sameFormNow.getQuestionByName("c15")?.isVisible).toBe(true);
    expect(scoreAssessment(childScaleSafety, answers, context)).toMatchObject({ status: "incomplete", reasons: ["required_items_missing"] });

    setup(opened);
    const result = await submitAssessment(actor, assessmentId, { answers, acknowledged: true, revision: 0 });
    expect(result).toMatchObject({ status: "queued", safetyGuidance: false, phase: "waiting" });
    const saved = client.query.mock.calls.find(([sql]) => sql.includes("UPDATE assessments SET answers"));
    const snapshot = JSON.parse(String(saved?.[1]?.[1]));
    expect(snapshot.scale.version).toBe("1.0.0");
    expect(snapshot.score.status).toBe("valid");
    expect(client.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO staff_alerts"))).toBe(false);

    setup(childScaleSafety);
    await expect(submitAssessment(actor, assessmentId, { answers, acknowledged: true, revision: 0 })).rejects.toMatchObject({ status: 422, code: "INCOMPLETE_TRIAD" });
  });
});

describe("new triad assessments use the published definition", () => {
  it("inserts frozen versions and the staff-note revisions without rewriting a stored definition", async () => {
    expect(`${childScale.id}@${childScale.version}`).toBe("growth-child@1.0.0");
    expect(`${childScaleSafety.id}@${childScaleSafety.version}`).toBe("growth-child@1.1.0");
    expect(`${childScaleBirthAge.id}@${childScaleBirthAge.version}`).toBe("growth-child@1.2.0");
    expect(`${childScaleStaffNotes.id}@${childScaleStaffNotes.version}`).toBe("growth-child@1.3.0");
    expect(`${parentScaleSafety.id}@${parentScaleSafety.version}`).toBe("growth-parent@1.2.0");
    expect(`${parentScaleStaffNotes.id}@${parentScaleStaffNotes.version}`).toBe("growth-parent@1.3.0");
    expect(`${teacherScaleSafety.id}@${teacherScaleSafety.version}`).toBe("growth-teacher@1.1.0");
    expect(`${teacherScaleStaffNotes.id}@${teacherScaleStaffNotes.version}`).toBe("growth-teacher@1.2.0");
    expect(childScaleSafety.demo).toBe(false);
    expect(childScaleBirthAge.demo).toBe(false);
    expect(childScaleStaffNotes.demo).toBe(false);
    expect(childScaleSafety.norm.validated).toBe(false);
    expect(() => parseScale(childScaleSafety)).toThrow(/Unvalidated instruments must be labelled demo/);
    expect(() => parseScale(childScaleBirthAge)).toThrow(/Unvalidated instruments must be labelled demo/);
    expect(() => parseScale(childScaleStaffNotes)).toThrow(/Unvalidated instruments must be labelled demo/);
    expect(childScaleSafety.items.find(item => item.id === "c15")?.showIf?.anyOf).toEqual([1, 2, 3, 4, 5, 7, 8]);
    expect(childScaleSafety.items.find(item => item.id === "c18_1")?.showIf).toEqual({ itemId: "c_age", anyOf: [12, 13, 14, 15, 16, 17] });
    expect(childScaleSafety.items.find(item => item.id === "c18_1")?.visibleFromAge).toBeUndefined();
    expect(childScaleBirthAge.items.find(item => item.id === "c18_1")?.visibleFromAge).toBe(12);
    expect(childScaleBirthAge.items.find(item => item.id === "c18_1")?.showIf).toBeUndefined();
    for (const id of ["c19", "c20", "c21", "c22"]) {
      expect(childScaleBirthAge.items.find(item => item.id === id)?.report).toBe("words");
      expect(childScaleStaffNotes.items.find(item => item.id === id)?.report).toBe("staff");
    }
    vi.mocked(query).mockResolvedValue([]);
    await ensureTriadInstruments();
    const sql = vi.mocked(query).mock.calls.map(([text]) => String(text));
    expect(sql.some(text => text.includes("DO UPDATE SET definition"))).toBe(false);
    expect(sql.some(text => text.includes("UPDATE content_versions"))).toBe(false);
    const inserts = vi.mocked(query).mock.calls.filter(([text]) => String(text).includes("INSERT INTO scales"));
    const published = [childScale, childScaleSafety, childScaleBirthAge, childScaleStaffNotes, parentScaleV1, parentScale, parentScaleSafety, parentScaleStaffNotes, teacherScale, teacherScaleSafety, teacherScaleStaffNotes];
    expect(inserts.map(([, values]) => values?.[0])).toEqual(published.map(scale => `${scale.id}@${scale.version}`));
    expect(inserts.every(([text]) => String(text).includes("ON CONFLICT(id) DO NOTHING"))).toBe(true);
    inserts.forEach(([, values], index) => {
      expect(values?.[3]).toBe(JSON.stringify(parseStoredScale(published[index])));
    });
    const storedSafety = JSON.parse(String(inserts[1][1]?.[3]));
    expect(storedSafety.version).toBe("1.1.0");
    expect(storedSafety.demo).toBe(false);
    expect(storedSafety.items.find((item: { id: string; visibleFromAge?: number }) => item.id === "c18_1").visibleFromAge).toBeUndefined();
    expect(storedSafety.items.find((item: { id: string; showIf?: { itemId: string } }) => item.id === "c18_1").showIf).toEqual({ itemId: "c_age", anyOf: [12, 13, 14, 15, 16, 17] });
    const storedBirth = JSON.parse(String(inserts[2][1]?.[3]));
    expect(storedBirth.version).toBe("1.2.0");
    expect(storedBirth.demo).toBe(false);
    expect(storedBirth.norm.validated).toBe(false);
    expect(storedBirth.items.find((item: { id: string; showIf: { anyOf: number[] } }) => item.id === "c15").showIf.anyOf).toEqual([1, 2, 3, 4, 5, 7, 8]);
    expect(storedBirth.items.find((item: { id: string; visibleFromAge?: number }) => item.id === "c18_1").visibleFromAge).toBe(12);
    expect(storedBirth.items.find((item: { id: string; showIf?: unknown }) => item.id === "c18_1").showIf).toBeUndefined();
    for (const id of ["c19", "c20", "c21", "c22"]) expect(storedBirth.items.find((item: { id: string; report?: string }) => item.id === id).report).toBe("words");
    const storedChild = JSON.parse(String(inserts[3][1]?.[3]));
    expect(storedChild.version).toBe("1.3.0");
    expect(storedChild.demo).toBe(false);
    for (const id of ["c19", "c20", "c21", "c22"]) expect(storedChild.items.find((item: { id: string; report?: string }) => item.id === id).report).toBe("staff");
    const storedParent = JSON.parse(String(inserts.find(([, values]) => values?.[0] === "growth-parent@1.3.0")?.[1]?.[3]));
    const storedPreviousParent = JSON.parse(String(inserts.find(([, values]) => values?.[0] === "growth-parent@1.2.0")?.[1]?.[3]));
    const storedTeacher = JSON.parse(String(inserts.find(([, values]) => values?.[0] === "growth-teacher@1.2.0")?.[1]?.[3]));
    const storedPreviousTeacher = JSON.parse(String(inserts.find(([, values]) => values?.[0] === "growth-teacher@1.1.0")?.[1]?.[3]));
    for (const id of ["q32", "q33", "q34", "q35", "q36", "q37", "q38"]) {
      expect(storedPreviousParent.items.find((item: { id: string; report?: string }) => item.id === id).report).toBe("words");
      expect(storedParent.items.find((item: { id: string; report?: string }) => item.id === id).report).toBe("staff");
    }
    expect(storedPreviousTeacher.items.find((item: { id: string; report?: string }) => item.id === "t23").report).toBe("words");
    expect(storedTeacher.items.find((item: { id: string; report?: string }) => item.id === "t23").report).toBe("staff");
    expect(storedParent.items.find((item: { id: string; report?: string }) => item.id === "q40").report).toBe("staff");
    expect(storedTeacher.items.find((item: { id: string; report?: string }) => item.id === "t16").report).toBe("staff");
    const retired = vi.mocked(query).mock.calls.filter(([text]) => String(text).includes("UPDATE scales SET status='retired'"));
    expect(retired.map(([, values]) => values)).toEqual([
      ["growth-child", "growth-child@1.3.0"],
      ["growth-teacher@1.0.0"],
      ["growth-teacher", "growth-teacher@1.2.0"]
    ]);
    expect(retired.some(([, values]) => String(values?.[0]).startsWith("growth-parent@"))).toBe(false);
  });
});
