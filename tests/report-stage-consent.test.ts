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
  const state = { parentReport: true, aiProcessing: true, familyLocked: false, withdrawalWaiting: false, scopeReads: 0, published: false, paused: false, transactions: 0, failCommitAt: 0 };
  const withdraw = () => { if (state.familyLocked) state.withdrawalWaiting = true; else state.parentReport = false; };
  const scopes = () => [...(state.parentReport ? ["parent_report"] : []), ...(state.aiProcessing ? ["ai_processing"] : [])];
  const read = async (sql: string, locked: boolean): Promise<Record<string, unknown>[]> => {
    if (sql.includes("WITH candidate AS")) return [{ id: JOB, assessment_id: ASSESSMENT, attempts: 1 }];
    if (sql.includes("SELECT * FROM assessments WHERE id=")) return [{ id: ASSESSMENT, family_id: FAMILY, snapshot, submitted_at: snapshot.submittedAt }];
    if (sql.includes("SELECT id FROM families") && /FOR (UPDATE|SHARE)/.test(sql)) { state.familyLocked = locked; return [{ id: FAMILY }]; }
    if (sql.includes("FROM report_jobs") && sql.includes("claim_token")) return [{ id: JOB }];
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
    const count = ++state.transactions;
    const client = { query: async (sql: string) => ({ rows: await read(sql, true) }) } as unknown as PoolClient;
    try {
      const result = await fn(client);
      if (count === state.failCommitAt) throw new Error("Synthetic admission COMMIT response lost");
      return result;
    }
    finally {
      state.familyLocked = false;
      if (state.withdrawalWaiting) { state.parentReport = false; state.withdrawalWaiting = false; }
    }
  });
  return { state, withdraw };
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
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
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

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

  it("starts narrative under the family lock and releases it before awaiting in-flight work", async () => {
    const { state, withdraw } = database();
    const entered = deferred<void>(), finished = deferred<Awaited<ReturnType<typeof selectNarrative>>>();
    let lockedAtStart = false;
    vi.mocked(selectNarrative).mockImplementation(() => {
      lockedAtStart = state.familyLocked;
      entered.resolve();
      return finished.promise;
    });
    const job = processReportJob(JOB);
    await entered.promise;
    expect(lockedAtStart).toBe(true);
    await expect.poll(() => state.familyLocked).toBe(false);
    withdraw();
    expect(state.parentReport).toBe(false);
    finished.resolve({ selectedAdviceIds: ["listen"], generationMode: "template", fallbackReason: "ai_disabled", aiModel: null });
    await expect(job).resolves.toEqual({ status: "paused" });
    expect(renderPdf).not.toHaveBeenCalled();
  });

  it("issues the real narrative selector's request under the current consent lock", async () => {
    const { state, withdraw } = database();
    const actual = await vi.importActual<typeof import("../src/domain/narrative")>("../src/domain/narrative");
    vi.mocked(selectNarrative).mockImplementation(actual.selectNarrative);
    vi.stubEnv("NOVA_AI_ENABLED", "true"); vi.stubEnv("NOVA_AI_BASE_URL", "https://api.deepseek.com");
    vi.stubEnv("NOVA_AI_MODEL", "deepseek-flash"); vi.stubEnv("NOVA_AI_DEPLOYMENT_SCOPE", "CN"); vi.stubEnv("NOVA_AI_API_KEY", "synthetic-unused-key");
    const requestPermissions: boolean[] = [];
    const fetcher = vi.fn(async () => {
      requestPermissions.push(state.familyLocked && state.parentReport && state.aiProcessing);
      withdraw();
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ adviceIds: actual.eligibleAdviceIds(snapshot) }) } }] }));
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(processReportJob(JOB)).resolves.toEqual({ status: "paused" });
    expect(requestPermissions).toEqual([true]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(renderPdf).not.toHaveBeenCalled();
  });

  it("starts each PDF under the family lock and refuses publication after final-render withdrawal", async () => {
    const { state, withdraw } = database();
    const locks: boolean[] = [];
    vi.mocked(renderPdf).mockImplementation(async () => {
      locks.push(state.familyLocked);
      if (locks.length === 2) withdraw();
      return Buffer.from("%PDF-1.4 synthetic");
    });
    await expect(processReportJob(JOB)).resolves.toEqual({ status: "paused" });
    expect(locks).toEqual([true, true]);
    expect(state.published).toBe(false);
    expect(removePrivatePdf).toHaveBeenCalledTimes(2);
  });

  it.each(["resolve", "reject"] as const)("drains an in-flight PDF that will %s after the admission COMMIT fails", async result => {
    const { state } = database();
    state.failCommitAt = 2;
    const entered = deferred<void>(), render = deferred<Buffer>();
    vi.mocked(renderPdf).mockImplementation(() => { entered.resolve(); return render.promise; });
    let settled = false;
    const job = processReportJob(JOB).then(value => { settled = true; return value; });
    await entered.promise;
    await expect.poll(() => state.familyLocked).toBe(false);
    expect(settled).toBe(false);
    expect(writePrivatePdf).not.toHaveBeenCalled();
    if (result === "resolve") render.resolve(Buffer.from("%PDF-1.4 synthetic"));
    else render.reject(new Error("Synthetic late renderer failure"));
    await expect(job).resolves.toMatchObject({ status: "retry_at" });
    expect(renderPdf).toHaveBeenCalledTimes(1);
    expect(writePrivatePdf).not.toHaveBeenCalled();
    expect(state.published).toBe(false);
  });
});
