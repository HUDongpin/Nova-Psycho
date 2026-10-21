import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { AssessmentSnapshot } from "../src/domain/types";
import { demoAdvice, demoScale, demoTemplate } from "../src/domain/demo";
import { scoreAssessment } from "../src/domain/scoring";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/pdf", () => ({ renderPdf: vi.fn() }));
vi.mock("../src/lib/storage", () => ({ writePrivatePdf: vi.fn(), removePrivatePdf: vi.fn(), listPrivatePdfKeys: vi.fn(), cleanAbandonedPrivatePdfTemps: vi.fn() }));
vi.mock("../src/domain/narrative", () => ({ selectNarrative: vi.fn() }));

import { query, transaction } from "../src/lib/db";
import { renderPdf } from "../src/lib/pdf";
import { removePrivatePdf, writePrivatePdf } from "../src/lib/storage";
import { selectNarrative } from "../src/domain/narrative";
import { processReportJob } from "../src/lib/worker";

const JOB = "55555555-5555-4555-8555-555555555555";
const ASSESSMENT = "11111111-2222-4333-8444-555555555555";
const FAMILY = "22222222-2222-4222-8222-222222222222";
const snapshot: AssessmentSnapshot = {
  scale: demoScale, advice: { id: "a", version: "1.0.0", content: demoAdvice }, template: { id: "t", version: "1.0.0", content: demoTemplate },
  score: scoreAssessment(demoScale, { q1: 1, q2: 2, q3: 1, q4: 2, q5: 1, q6: 2, q7: 1, q8: 2, q9: 0 }, { age: 12, region: "CN", role: "student" }),
  childName: "Synthetic child", grade: "S2", submittedAt: "2026-09-15T00:00:00.000Z", aiConsented: true,
};

function database(withdrawOnFirstScopeRead = false) {
  const state = { parentReport: true, aiProcessing: true, familyLocked: false, withdrawalWaiting: false, scopeReads: 0, published: false, paused: false };
  const withdraw = () => { if (state.familyLocked) state.withdrawalWaiting = true; else state.parentReport = false; };
  const scopes = () => [...(state.parentReport ? ["parent_report"] : []), ...(state.aiProcessing ? ["ai_processing"] : [])];
  const read = async (sql: string, locked: boolean): Promise<Record<string, unknown>[]> => {
    if (sql.includes("WITH candidate AS")) return [{ id: JOB, assessment_id: ASSESSMENT, attempts: 1 }];
    if (sql.includes("SELECT * FROM assessments WHERE id=")) return [{ id: ASSESSMENT, family_id: FAMILY, snapshot, submitted_at: snapshot.submittedAt }];
    if (sql.includes("SELECT id FROM families") && /FOR (UPDATE|SHARE)/.test(sql)) { state.familyLocked = locked; return [{ id: FAMILY }]; }
    if (sql.includes("SELECT id FROM report_jobs") && sql.includes("claim_token")) return [{ id: JOB }];
    if (sql.includes("AS scopes FROM consents")) {
      const rows = [{ scopes: scopes() }];
      state.scopeReads += 1;
      if (withdrawOnFirstScopeRead && state.scopeReads === 1) withdraw();
      return rows;
    }
    if (sql.includes("ai_processing") && sql.includes("FROM consents")) return state.aiProcessing ? [{ id: "synthetic-ai-grant" }] : [];
    if (sql.includes("SET state='paused'")) { state.paused = true; return [{ id: JOB }]; }
    if (sql.includes("INSERT INTO reports")) state.published = true;
    if (sql.includes("UPDATE report_jobs SET state=$1")) return [{ assessment_id: ASSESSMENT, available_at: new Date().toISOString() }];
    return [];
  };
  vi.mocked(query).mockImplementation((async (sql: string) => read(sql, false)) as typeof query);
  vi.mocked(transaction).mockImplementation(async fn => {
    const client = { query: async (sql: string) => ({ rows: await read(sql, true) }) } as unknown as PoolClient;
    try { return await fn(client); }
    finally {
      state.familyLocked = false;
      if (state.withdrawalWaiting) { state.parentReport = false; state.withdrawalWaiting = false; }
    }
  });
  return { state, withdraw };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NOVA_REGION", "CN"); vi.stubEnv("NOVA_MODE", "demo"); vi.stubEnv("NOVA_AI_ENABLED", "false");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova"); vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_STORAGE", "filesystem"); vi.stubEnv("NOVA_REPORT_DIR", "work/report-stage-test"); vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
  vi.mocked(renderPdf).mockResolvedValue(Buffer.from("%PDF-1.4 synthetic"));
  vi.mocked(selectNarrative).mockResolvedValue({ selectedAdviceIds: ["listen"], generationMode: "template", fallbackReason: "ai_disabled", aiModel: null });
  vi.mocked(removePrivatePdf).mockResolvedValue("done");
});
afterEach(() => vi.unstubAllEnvs());

describe("report stage consent admission", () => {
  it("does not start narrative after withdrawal commits between consent read and invocation", async () => {
    const { state } = database(true);
    const narrativePermissions: boolean[] = [];
    vi.mocked(selectNarrative).mockImplementation(async () => {
      narrativePermissions.push(state.parentReport);
      return { selectedAdviceIds: ["listen"], generationMode: "template", fallbackReason: "ai_disabled", aiModel: null };
    });
    await expect(processReportJob(JOB)).resolves.toEqual({ status: "paused" });
    expect(narrativePermissions).not.toContain(false);
    expect(state.paused).toBe(true);
    expect(state.published).toBe(false);
    expect(renderPdf).not.toHaveBeenCalled();
  });

  it("does not admit the second locale after withdrawal during the first PDF", async () => {
    const { state, withdraw } = database();
    const renderPermissions: boolean[] = [];
    vi.mocked(renderPdf).mockImplementation(async () => {
      renderPermissions.push(state.parentReport);
      withdraw();
      return Buffer.from("%PDF-1.4 synthetic");
    });
    await expect(processReportJob(JOB)).resolves.toEqual({ status: "paused" });
    expect(renderPermissions).toEqual([true]);
    expect(state.published).toBe(false);
    expect(writePrivatePdf).toHaveBeenCalledTimes(1);
    expect(removePrivatePdf).toHaveBeenCalledTimes(1);
  });

  it("reads current AI consent at narrative admission", async () => {
    const { state } = database();
    state.aiProcessing = false;
    await expect(processReportJob(JOB)).resolves.toEqual({ status: "published" });
    expect(selectNarrative).toHaveBeenCalledWith(expect.objectContaining({ aiConsented: false }), expect.anything());
    expect(renderPdf).toHaveBeenCalledTimes(2);
  });
});
