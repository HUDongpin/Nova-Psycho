import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/content", () => ({ currentContent: vi.fn(), lockContent: vi.fn(), getScale: vi.fn() }));

import { demoAdvice, demoTemplate } from "../src/domain/demo";
import { previewAnswers } from "../src/domain/triad-report";
import { parentScale } from "../src/domain/triad-scales";
import type { Actor, ScaleDefinition } from "../src/domain/types";
import { assessmentDetail, submitAssessment } from "../src/lib/assessments";
import { currentContent } from "../src/lib/content";
import { query, transaction } from "../src/lib/db";
import { handle, HttpError, json } from "../src/lib/http";

const assessmentId = "11111111-2222-4333-8444-555555555555";
const familyId = "22222222-3333-4444-8555-666666666666";
const actor: Actor = { id: "99999999-8888-4777-8666-555555555555", name: "Synthetic parent", role: "parent", region: "CN" };
let scale: ScaleDefinition;
let owned: boolean;
let revoked: boolean;
let consent: boolean;
let revision: number;
let status: string;
const client = { query: vi.fn(async (_sql: string, _values?: unknown[]): Promise<{ rows: unknown[] }> => ({ rows: [] })) };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
  vi.stubEnv("NOVA_REGION", "CN");
  vi.stubEnv("NOVA_MODE", "demo");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR", "work/test-private");
  vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
  vi.clearAllMocks();
  scale = structuredClone(parentScale);
  owned = true; revoked = false; consent = true; revision = 0; status = "pending";
  vi.mocked(query).mockImplementation((async (sql: string) => {
    if (sql.includes("FROM assessments a JOIN scales s")) return owned ? [{ id: assessmentId, definition: scale, status, draft_answers: {}, draft_revision: revision, family_id: familyId, child_name: "Synthetic child", birth_date: "2014-04-12", respondent_role: "parent", region: "CN" }] : [];
    if (sql.includes("FROM families f WHERE f.id=$1")) return [{ id: familyId, region: "CN", child_name: "Synthetic child", birth_date: "2014-04-12", grade: "S1", assigned_to: null }];
    if (sql.includes("SELECT id FROM consents")) return consent ? [{ id: "consent" }] : [];
    return [];
  }) as typeof query);
  client.query.mockImplementation(async sql => {
    if (sql.includes("FROM users WHERE id=$1")) return { rows: [{ ...actor, disabled: revoked, demo: false }] };
    if (sql.includes("SELECT id FROM families")) return { rows: [{ id: familyId }] };
    if (sql.includes("SELECT a.*,r.id AS report_id")) return { rows: [{ id: assessmentId, status, draft_revision: revision, family_id: familyId, respondent_role: "parent", triad_round_id: "synthetic-round", report_id: status === "published" ? "existing-report" : null }] };
    if (sql.includes("SELECT scopes FROM consents")) return { rows: consent ? [{ scopes: ["assessment", "parent_report", "sensitive_data"] }] : [] };
    return { rows: [] };
  });
  vi.mocked(transaction).mockImplementation(async fn => fn(client as unknown as PoolClient));
  vi.mocked(currentContent).mockImplementation((async (kind: string) => ({ id: kind, version: "1.0.0", content: kind === "advice" ? demoAdvice : demoTemplate })) as typeof currentContent);
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function submit(answers: Record<string, unknown>) {
  return handle(async () => json(await submitAssessment(actor, assessmentId, { answers, acknowledged: true, revision: 0 })));
}

describe("assessment completion API", () => {
  it("returns completion rules from the assigned triad version without answer content", async () => {
    scale.version = "1.0.9";
    scale.dimensions[0].maxMissing = 2;
    const detail = await assessmentDetail(actor, assessmentId, "zh-HK");
    expect(detail).toHaveProperty("completionRules.dimensions.0", {
      key: "q14", label: scale.dimensions[0].label, itemIds: scale.dimensions[0].items, maxMissing: 2
    });
    expect(detail).toHaveProperty("completionRules.items.0", { id: "p_assent", kind: "single", required: true });
  });

  it("does not add triad completion rules to a different instrument", async () => {
    delete scale.bundle;
    expect(await assessmentDetail(actor, assessmentId, "zh-CN")).not.toHaveProperty("completionRules");
  });

  it("returns both missing required items and insufficient coverage without raw answers or logging", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const answers: Record<string, unknown> = { ...previewAnswers(scale), q14_1: -1, q14_2: -1, q40: "SYNTHETIC_PRIVATE_CONTACT" };
    delete answers.p_worry;
    const before = structuredClone(answers);
    const response = await submit(answers);
    const data = await response.json();
    expect(response.status).toBe(422);
    expect(data).toMatchObject({ code: "INCOMPLETE_TRIAD", error: "请查看未完成的题目或资料不足的部分。", completionIssues: [
      { kind: "required_missing", itemId: "p_worry" },
      { kind: "insufficient_coverage", dimensionKey: "q14", itemIds: scale.dimensions[0].items, answered: 4, required: 5, total: 6, unansweredItemIds: [], excludedItemIds: ["q14_1", "q14_2"] }
    ] });
    expect(JSON.stringify(data)).not.toContain("SYNTHETIC_PRIVATE_CONTACT");
    expect(data).not.toHaveProperty("answers");
    expect(answers).toEqual(before);
    expect(log).not.toHaveBeenCalled();
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE assessments") || sql.startsWith("INSERT INTO report_jobs"))).toBe(false);
  });

  it.each(["owner", "account", "consent", "revision", "region"] as const)("checks %s before returning completion details", async guard => {
    if (guard === "owner") owned = false;
    if (guard === "account") revoked = true;
    if (guard === "consent") consent = false;
    if (guard === "revision") revision = 1;
    if (guard === "region") vi.stubEnv("NOVA_REGION", "HK");
    const response = await submit({});
    const data = await response.json();
    const codes = { owner: "NOT_FOUND", account: "ACCOUNT_REVOKED", consent: "GUARDIAN_CONSENT_REQUIRED", revision: "DRAFT_CONFLICT", region: "REGION_MISMATCH" };
    expect(data.code).toBe(codes[guard]);
    expect(data).not.toHaveProperty("completionIssues");
  });

  it("does not disclose rules for an assessment outside the respondent lookup", async () => {
    owned = false;
    const response = await handle(async () => json(await assessmentDetail(actor, assessmentId, "zh-CN")));
    expect(response.status).toBe(404);
    expect(await response.json()).not.toHaveProperty("completionRules");
  });

  it("keeps invalid-answer and entry-gate failures distinct from completion issues", async () => {
    const invalid = await submit({ ...previewAnswers(scale), q14_1: 999 });
    expect(await invalid.json()).toEqual({ code: "INVALID_ANSWERS", error: "答案格式不符合量表要求。" });
    const declined = await submit({ ...previewAnswers(scale), p_assent: 0 });
    expect(await declined.json()).toEqual({ code: "ENTRY_GATE", error: "需要先同意参加这次了解，才能提交。" });
  });

  it("preserves an accepted replay instead of diagnosing the new request", async () => {
    status = "published";
    const response = await submit({});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: assessmentId, status: "published", reportId: "existing-report" });
  });

  it("continues accepting incomplete non-triad instruments under their existing scoring policy", async () => {
    delete scale.bundle;
    const response = await submit({ p_assent: 1 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "queued" });
  });

  it("keeps valid triad safety selections on the existing alert path", async () => {
    const response = await submit(previewAnswers(scale, "risk"));
    expect(response.status).toBe(200);
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO staff_alerts"))).toBe(true);
  });
});

describe("completion error serialization", () => {
  const issues = [{ kind: "required_missing" as const, itemId: "p_worry" }];
  it("serializes the structured field only for INCOMPLETE_TRIAD", async () => {
    const response = await handle(async () => { throw new HttpError(422, "Incomplete", "INCOMPLETE_TRIAD", undefined, issues); });
    expect(await response.json()).toEqual({ error: "Incomplete", code: "INCOMPLETE_TRIAD", completionIssues: issues });
  });
  it("preserves the existing field argument and omits completion details for other error codes", async () => {
    const response = await handle(async () => { throw new HttpError(409, "Denied", "OTHER_ERROR", "knownField", issues); });
    expect(await response.json()).toEqual({ error: "Denied", code: "OTHER_ERROR", field: "knownField" });
  });
});
