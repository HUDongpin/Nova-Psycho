import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { Actor } from "../src/domain/types";
import { demoAdvice, demoScale, demoTemplate } from "../src/domain/demo";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/auth", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/content", () => ({ getScale: vi.fn(), currentContent: vi.fn(), lockContent: vi.fn() }));
import { query, transaction } from "../src/lib/db";
import { currentContent, getScale } from "../src/lib/content";
import { createAssessment, retryReport, saveDraft, submitAssessment } from "../src/lib/assessments";

const actorId = "11111111-2222-4333-8444-555555555555";
const familyId = "33333333-4444-4555-8666-777777777777";
const respondentId = "44444444-5555-4666-8777-888888888888";
const assessmentId = "55555555-6666-4777-8888-999999999999";
const family = { id: familyId, region: "CN", child_name: "Synthetic child", birth_date: "2013-04-12", grade: "S2", assigned_to: actorId };
const scale = { ...demoScale, demo: false };
const answers = { q1: 1, q2: 2, q3: 1, q4: 2, q5: 1, q6: 2, q7: 1, q8: 2, q9: 0 };
const input = { answers, acknowledged: true, revision: 0 };
const client = { query: vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>() };
const writes: string[] = [];
type Operation = "create" | "save" | "submit" | "retry";

beforeEach(() => {
  vi.stubEnv("NOVA_REGION", "CN"); vi.stubEnv("NOVA_MODE", "demo");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR", "work/test-private"); vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
  vi.mocked(query).mockReset(); client.query.mockReset(); writes.length = 0;
  vi.mocked(transaction).mockImplementation(fn => fn(client as unknown as PoolClient));
  vi.mocked(getScale).mockResolvedValue({ id: `${scale.id}@${scale.version}`, status: "active", definition: scale } as never);
  vi.mocked(currentContent).mockImplementation((async (kind: string) => kind === "advice"
    ? { id: "advice", version: "1.0.0", content: demoAdvice }
    : { id: "template", version: "1.0.0", content: demoTemplate }) as never);
});
afterEach(() => vi.unstubAllEnvs());

function setup(operation: Operation, changed: Record<string, unknown> = {}, options: { replay?: boolean; respondentChanged?: boolean } = {}) {
  const actor: Actor = { id: actorId, name: "Synthetic account", role: operation === "create" || operation === "retry" ? "staff" : "student", region: "CN" };
  const assessment = { id: assessmentId, family_id: familyId, region: "CN", respondent_id: actorId, respondent_role: "student", definition: scale, status: options.replay ? "queued" : operation === "retry" ? "failed" : "pending", draft_revision: 0, snapshot: {}, answers: {}, submitted_at: new Date() };
  const read = (sql: string, values: unknown[] = [], locked: boolean) => {
    if (sql.startsWith("UPDATE") || sql.startsWith("INSERT")) { writes.push(sql); return sql.startsWith("UPDATE assessments SET draft_answers") ? [{ id: assessmentId, draft_revision: 1 }] : []; }
    if (sql.includes("FROM users WHERE id=$1")) return [{ ...actor, disabled: false, demo: false, ...changed }];
    if (sql.includes("FROM families")) return [family];
    if (sql.includes("SELECT m.role FROM memberships")) return locked && options.respondentChanged ? [] : [{ role: "student" }];
    if (sql.includes("FROM assessments a JOIN scales")) return [assessment];
    if (sql.includes("SELECT family_id FROM assessments")) return [{ family_id: familyId }];
    if (sql.includes("SELECT a.*,r.id AS report_id") || sql.includes("SELECT * FROM assessments")) return [assessment];
    if (sql.includes("SELECT * FROM report_jobs")) return [{ id: "synthetic-job", state: options.replay ? "ready" : "failed" }];
    if (sql.includes("FROM consents")) return [{ id: "synthetic-consent", scopes: ["assessment", "parent_report", "sensitive_data"] }];
    if (sql.includes("SELECT status FROM scales")) return [{ status: "active" }];
    void values;
    return [];
  };
  vi.mocked(query).mockImplementation(async (sql, values) => read(sql, values, false) as never);
  client.query.mockImplementation(async (sql, values) => ({ rows: read(sql, values, true) }));
  const run = () => operation === "create" ? createAssessment(actor, { familyId, respondentId, scaleVersionId: `${scale.id}@${scale.version}`, locale: "zh-CN" })
    : operation === "save" ? saveDraft(actor, assessmentId, input)
      : operation === "submit" ? submitAssessment(actor, assessmentId, input) : retryReport(actor, assessmentId);
  return { run };
}

describe.each<Operation>(["create", "save", "submit", "retry"])("%s rejects stale account authorization", operation => {
  it.each([
    [{ disabled: true }, "ACCOUNT_REVOKED"],
    [{ role: "teacher" }, "ROLE_CONFLICT"],
    [{ region: "HK" }, "REGION_MISMATCH"]
  ] as const)("checks current account %j before writing", async (change, code) => {
    const { run } = setup(operation, change);
    await expect(run()).rejects.toMatchObject({ code });
    expect(writes).toEqual([]);
  });
  it("allows an unchanged account and holds a shared user lock through the write", async () => {
    const { run } = setup(operation);
    await expect(run()).resolves.toBeDefined();
    expect(writes.length).toBeGreaterThan(0);
    expect(client.query.mock.calls.some(([sql]) => sql.includes("FROM users WHERE id=$1 FOR SHARE"))).toBe(true);
  });
});

it.each<Operation>(["submit", "retry"])("%s does not return a saved result to a newly disabled account", async operation => {
  const { run } = setup(operation, { disabled: true }, { replay: true });
  await expect(run()).rejects.toMatchObject({ code: "ACCOUNT_REVOKED" });
  expect(writes).toEqual([]);
});

it("does not assign a task when the respondent becomes ineligible after the preflight read", async () => {
  const { run } = setup("create", {}, { respondentChanged: true });
  await expect(run()).rejects.toMatchObject({ code: "INVALID_RESPONDENT" });
  expect(writes).toEqual([]);
});
