import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/auth", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/report-dispatch", () => ({ dispatchAssessmentReport: vi.fn(async () => undefined) }));
vi.mock("../src/lib/pdf", () => ({ renderPdf: vi.fn(async () => Buffer.from("%PDF")), closePdfBrowser: vi.fn() }));
vi.mock("../src/lib/storage", () => ({ writePrivatePdf: vi.fn(async () => undefined), removePrivatePdf: vi.fn(async () => undefined), listPrivatePdfKeys: vi.fn(async () => []) }));
vi.mock("../src/domain/narrative", () => ({ selectNarrative: vi.fn(async () => ({ selectedAdviceIds: [], generationMode: "template", fallbackReason: "ai_disabled", aiModel: null })) }));

import { transaction, query } from "../src/lib/db";
import { dispatchAssessmentReport } from "../src/lib/report-dispatch";
import { recordConsent } from "../src/lib/families";
import { enqueueReportsHeldForConsent } from "../src/lib/triad";
import { processReportJob } from "../src/lib/worker";
import { demoAdvice, demoScale, demoTemplate } from "../src/domain/demo";
import { scoreAssessment } from "../src/domain/scoring";
import type { Actor, AssessmentSnapshot } from "../src/domain/types";

const FAMILY = "11111111-2222-4333-8444-555555555555";
const ASSESSMENT = "22222222-3333-4444-8555-666666666666";
const JOB = "33333333-4444-4555-8666-777777777777";
const actor: Actor = { id: "99999999-8888-4777-8666-555555555555", name: "Synthetic guardian", role: "parent", region: "CN" };
const snapshot: AssessmentSnapshot = {
  scale: demoScale, advice: { id: "a", version: "1.0.0", content: demoAdvice }, template: { id: "t", version: "1.0.0", content: demoTemplate },
  score: scoreAssessment(demoScale, { q1: 1, q2: 2, q3: 1, q4: 2, q5: 1, q6: 2, q7: 1, q8: 2, q9: 0 }, { age: 12, region: "CN", role: "student" }),
  childName: "Synthetic child", grade: "S2", submittedAt: "2026-10-08T00:00:00.000Z", aiConsented: false,
};

beforeEach(() => {
  vi.stubEnv("NOVA_REGION", "CN"); vi.stubEnv("NOVA_MODE", "demo");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR", "work/test-private"); vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
  vi.stubEnv("NOVA_REPORT_STORAGE", "database");
  vi.mocked(query).mockReset();
  vi.mocked(transaction).mockReset();
  vi.mocked(dispatchAssessmentReport).mockClear();
  vi.mocked(query).mockImplementation((async (sql: string) => {
    if (String(sql).includes("FROM families f WHERE f.id=$1")) return [{ id: FAMILY, region: "CN", family_name: "Synthetic", child_name: "Synthetic child", birth_date: "2014-01-01", grade: "S2", guardian_label: "Synthetic guardian", assigned_to: null, created_at: new Date() }];
    return [];
  }) as never);
  vi.mocked(transaction).mockImplementation((async (fn: (client: PoolClient) => Promise<unknown>) => fn({ query: async () => ({ rows: [] }) } as unknown as PoolClient)) as never);
});

describe("parent-report consent and exactly one report", () => {
  it("answers first, then one grant creates and dispatches exactly one job", async () => {
    const inserts: string[] = [];
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes("SELECT id FROM families")) return { rows: [{ id: FAMILY }] };
      if (sql.includes("SELECT scopes FROM consents")) return { rows: [{ scopes: ["assessment"] }, { scopes: ["sensitive_data"] }] };
      if (sql.includes("NOT EXISTS (SELECT 1 FROM report_jobs")) return { rows: inserts.length ? [] : [{ id: ASSESSMENT }] };
      if (sql.startsWith("INSERT INTO report_jobs")) { inserts.push(ASSESSMENT); return { rows: [] }; }
      if (sql.includes("j.state='paused'")) return { rows: [] };
      if (sql.includes("j.state='ready'")) return { rows: inserts.map(id => ({ id })) };
      if (sql.includes("triad_round_id IS NOT NULL")) return { rows: [] };
      return { rows: [] };
    }) };
    vi.mocked(transaction).mockImplementation((async (fn: (client: PoolClient) => Promise<unknown>) => fn(client as unknown as PoolClient)) as never);
    await recordConsent(actor, FAMILY, { action: "grant", scope: "parent_report", guardianName: "Synthetic guardian" });
    await recordConsent(actor, FAMILY, { action: "grant", scope: "parent_report", guardianName: "Synthetic guardian" });
    expect(inserts).toEqual([ASSESSMENT]);
    expect(vi.mocked(dispatchAssessmentReport).mock.calls.map(call => call[0])).toEqual([ASSESSMENT, ASSESSMENT]);
    expect(new Set(vi.mocked(dispatchAssessmentReport).mock.calls.map(call => call[0])).size).toBe(1);
  });

  it("pauses a claimed job when consent is withdrawn, then one re-consent resumes that same job", async () => {
    vi.mocked(query).mockImplementation((async (sql: string) => {
      const text = String(sql);
      if (text.includes("WITH candidate")) return [{ id: JOB, assessment_id: ASSESSMENT, attempts: 1 }];
      if (text.includes("FROM assessments WHERE id=$1")) return [{ id: ASSESSMENT, family_id: FAMILY, snapshot, submitted_at: snapshot.submittedAt }];
      if (text.includes("FROM families f WHERE f.id=$1")) return [{ id: FAMILY, region: "CN", family_name: "Synthetic", child_name: "Synthetic child", birth_date: "2014-01-01", grade: "S2", guardian_label: "Synthetic guardian", assigned_to: null, created_at: new Date() }];
      return [];
    }) as never);
    const publication: string[] = [];
    const paused = { query: vi.fn(async (sql: string) => {
      publication.push(sql);
      if (sql.includes("SELECT scopes FROM consents")) return { rows: [{ scopes: ["assessment"] }, { scopes: ["sensitive_data"] }] };
      return { rows: [{ id: "locked" }] };
    }) };
    vi.mocked(transaction).mockImplementationOnce((async (fn: (client: PoolClient) => Promise<unknown>) => fn(paused as unknown as PoolClient)) as never);
    await expect(processReportJob(JOB)).resolves.toEqual({ status: "paused" });
    expect(publication.some(sql => sql.includes("INSERT INTO reports"))).toBe(false);
    expect(publication.some(sql => sql.includes("PARENT_REPORT_CONSENT_REQUIRED"))).toBe(true);

    const resumed: string[] = [];
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes("SELECT id FROM families")) return { rows: [{ id: FAMILY }] };
      if (sql.includes("SELECT scopes FROM consents")) return { rows: [{ scopes: ["parent_report"] }] };
      if (sql.includes("NOT EXISTS (SELECT 1 FROM report_jobs")) return { rows: [] };
      if (sql.startsWith("INSERT INTO report_jobs")) { resumed.push("insert"); return { rows: [] }; }
      if (sql.includes("j.state='paused'")) return { rows: [{ id: ASSESSMENT }] };
      if (sql.includes("j.state='ready'")) return { rows: [{ id: ASSESSMENT }] };
      if (sql.includes("triad_round_id IS NOT NULL")) return { rows: [] };
      return { rows: [] };
    }) };
    vi.mocked(dispatchAssessmentReport).mockClear();
    vi.mocked(transaction).mockImplementationOnce((async (fn: (client: PoolClient) => Promise<unknown>) => fn(client as unknown as PoolClient)) as never);
    await recordConsent(actor, FAMILY, { action: "grant", scope: "parent_report", guardianName: "Synthetic guardian" });
    expect(resumed).toEqual([]);
    expect(vi.mocked(dispatchAssessmentReport).mock.calls.map(call => call[0])).toEqual([ASSESSMENT]);

    const published: string[] = [];
    const publishing = { query: vi.fn(async (sql: string) => {
      published.push(sql);
      if (sql.includes("SELECT scopes FROM consents")) return { rows: [{ scopes: ["parent_report"] }] };
      if (sql.includes("INSERT INTO reports")) return { rows: [{ id: ASSESSMENT }] };
      return { rows: [{ id: "locked" }] };
    }) };
    vi.mocked(transaction).mockImplementationOnce((async (fn: (client: PoolClient) => Promise<unknown>) => fn(publishing as unknown as PoolClient)) as never);
    await expect(processReportJob(JOB)).resolves.toEqual({ status: "published" });
    expect(published.filter(sql => sql.includes("INSERT INTO reports"))).toHaveLength(1);
  });

  it("dispatches an existing ready job once when consent returns, without inserting a second job", async () => {
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes("NOT EXISTS (SELECT 1 FROM report_jobs")) return { rows: [] };
      if (sql.startsWith("INSERT INTO report_jobs")) return { rows: [] };
      if (sql.includes("j.state='paused'")) return { rows: [] };
      if (sql.includes("j.state='ready'")) return { rows: [{ id: ASSESSMENT }] };
      if (sql.includes("triad_round_id")) return { rows: [] };
      return { rows: [] };
    }) };
    const ids = await enqueueReportsHeldForConsent(client as unknown as PoolClient, FAMILY);
    expect(ids).toEqual([ASSESSMENT]);
    expect(client.query.mock.calls.some(([sql]) => String(sql).startsWith("INSERT INTO report_jobs"))).toBe(false);
  });
});
