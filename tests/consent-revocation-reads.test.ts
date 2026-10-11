import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/pdf", () => ({ renderPdf: vi.fn(async () => Buffer.from("%PDF")), closePdfBrowser: vi.fn() }));
vi.mock("../src/lib/storage", () => ({ writePrivatePdf: vi.fn(async () => undefined), removePrivatePdf: vi.fn(async () => "done"), listPrivatePdfKeys: vi.fn(async () => []) }));
vi.mock("../src/domain/narrative", () => ({ selectNarrative: vi.fn(async () => ({ selectedAdviceIds: [], generationMode: "template", fallbackReason: "ai_disabled", aiModel: null })) }));

import { query, transaction } from "../src/lib/db";
import { consentFor } from "../src/lib/access";
import { saveDraft, submitAssessment, retryReport } from "../src/lib/assessments";
import { ACTIVE_CONSENT_ROWS_SQL, consentScopeGrantedSql, consentScopePredicate, effectiveScopesSelect } from "../src/lib/consent";
import { reportFor } from "../src/lib/reports";
import { processOneJob, processReportJob } from "../src/lib/worker";
import { workspaceFor } from "../src/lib/workspace";
import { demoAdvice, demoScale, demoTemplate } from "../src/domain/demo";
import { scoreAssessment } from "../src/domain/scoring";
import type { Actor, AssessmentSnapshot } from "../src/domain/types";

const mockQuery = vi.mocked(query);
const mockTransaction = vi.mocked(transaction);
const FAMILY_ID = "11111111-2222-4333-8444-555555555555";
const ACTOR_ID = "99999999-8888-4777-8666-555555555555";
const ASSESSMENT_ID = "22222222-3333-4444-8555-666666666666";
const REPORT_ID = "33333333-4444-4555-8666-777777777777";
const parent: Actor = { id: ACTOR_ID, name: "Synthetic", role: "parent", region: "CN" };
const admin: Actor = { id: ACTOR_ID, name: "Synthetic", role: "admin", region: "CN" };
const revokedLegacy = [{ scopes: ["assessment", "sensitive_data"] }];
const publishedSnapshot: AssessmentSnapshot = {
  scale: demoScale,
  advice: { id: "a", version: "1.0.0", content: demoAdvice },
  template: { id: "t", version: "1.0.0", content: demoTemplate },
  score: scoreAssessment(demoScale, { q1: 1, q2: 2, q3: 1, q4: 2, q5: 1, q6: 2, q7: 1, q8: 2, q9: 0 }, { age: 12, region: "CN", role: "student" }),
  childName: "Synthetic child",
  grade: "S2",
  submittedAt: "2026-10-01T00:00:00.000Z",
  aiConsented: false
};

function env() {
  vi.stubEnv("NOVA_REGION", "CN");
  vi.stubEnv("NOVA_MODE", "demo");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR", "work/test-private");
  vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
  vi.stubEnv("NOVA_REPORT_STORAGE", "database");
}

beforeEach(() => {
  env();
  mockQuery.mockReset();
  mockTransaction.mockReset();
});

describe("one revocation predicate for every consent read", () => {
  it("builds the active-row, family-list, existence, and AI checks from the same exclusion", () => {
    const exclusion = "consent_scope_revocations";
    expect(ACTIVE_CONSENT_ROWS_SQL).toBe(`SELECT ${effectiveScopesSelect("consents")} AS scopes FROM consents WHERE family_id=$1 AND revoked_at IS NULL`);
    expect(ACTIVE_CONSENT_ROWS_SQL).toContain(exclusion);
    expect(consentScopeGrantedSql("a.family_id", "parent_report")).toContain(consentScopePredicate("c", "parent_report"));
    expect(consentScopeGrantedSql("$1", "ai_processing")).toContain(exclusion);
    expect(consentScopePredicate("c", "sensitive_data")).toContain(exclusion);
    expect(effectiveScopesSelect("c")).toContain(exclusion);
  });

  it("does not treat a revoked parent-report purpose as granted for participation-only reads", async () => {
    mockQuery.mockImplementation((async (sql: string) => {
      if (String(sql) === ACTIVE_CONSENT_ROWS_SQL) return revokedLegacy;
      return [];
    }) as never);
    await expect(consentFor(FAMILY_ID)).resolves.toBe(true);
    expect(mockQuery.mock.calls[0][0]).toBe(ACTIVE_CONSENT_ROWS_SQL);
  });

  it("hides a stored report when the effective rows omit parent_report", async () => {
    mockQuery.mockImplementation((async (sql: string) => {
      const text = String(sql);
      if (text.includes("FROM reports WHERE id=$1")) return [{ id: REPORT_ID, family_id: FAMILY_ID, region: "CN" }];
      if (text.includes("FROM families f WHERE f.id=$1")) return [{ id: FAMILY_ID, region: "CN", assigned_to: null }];
      if (text === ACTIVE_CONSENT_ROWS_SQL) return revokedLegacy;
      return [];
    }) as never);
    await expect(reportFor(parent, REPORT_ID)).rejects.toMatchObject({ status: 409, code: "GUARDIAN_CONSENT_REQUIRED" });
    expect(mockQuery.mock.calls.some(([sql]) => sql === ACTIVE_CONSENT_ROWS_SQL)).toBe(true);
  });

  it("does not queue a report from submit when the legacy parent-report purpose is revoked", async () => {
    const submission = { answers: { q1: 1, q2: 2, q3: 1, q4: 2, q5: 1, q6: 2, q7: 1, q8: 2, q9: 0 }, acknowledged: true as const, revision: 0 };
    const student: Actor = { ...parent, role: "student" };
    mockQuery.mockImplementation((async (sql: string) => {
      const text = String(sql);
      if (text.includes("FROM assessments a JOIN scales s")) return [{ id: ASSESSMENT_ID, status: "pending", definition: demoScale, draft_answers: {}, draft_revision: 0, family_id: FAMILY_ID, child_name: "Synthetic child", birth_date: "2013-04-12", respondent_role: "student", region: "CN" }];
      if (text.includes("FROM families f WHERE f.id=$1")) return [{ id: FAMILY_ID, region: "CN", family_name: "Synthetic", child_name: "Synthetic child", birth_date: "2013-04-12", grade: "S2", guardian_label: "Synthetic guardian", assigned_to: null, created_at: new Date() }];
      return [];
    }) as never);
    const clientSql: string[] = [];
    mockTransaction.mockImplementation((async (fn: (client: { query: (sql: string) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => fn({
      query: async (sql: string, params?: unknown[]) => {
        clientSql.push(sql);
        if (sql.includes("SELECT id FROM families")) return { rows: [{ id: FAMILY_ID }] };
        if (sql.includes("SELECT a.*,r.id AS report_id")) return { rows: [{ id: ASSESSMENT_ID, status: "pending", draft_revision: 0, family_id: FAMILY_ID, respondent_id: ACTOR_ID, respondent_role: "student" }] };
        if (sql === ACTIVE_CONSENT_ROWS_SQL) return { rows: revokedLegacy };
        if (sql.includes("content_versions")) return { rows: [{ id: params?.[0] === "advice" ? "a" : "t", version: "1.0.0", content: params?.[0] === "advice" ? demoAdvice : demoTemplate }] };
        return { rows: [] };
      }
    })) as never);
    await expect(submitAssessment(student, ASSESSMENT_ID, submission)).resolves.toMatchObject({ status: "queued", reportId: null, phase: "consent" });
    expect(clientSql).toContain(ACTIVE_CONSENT_ROWS_SQL);
    expect(clientSql.some(sql => sql.includes("INSERT INTO report_jobs"))).toBe(false);
  });

  it("refuses a draft and a report retry when the effective consent rows omit the required purpose", async () => {
    mockQuery.mockImplementation((async (sql: string) => {
      const text = String(sql);
      if (text.includes("FROM assessments a JOIN scales s")) return [{ id: ASSESSMENT_ID, status: "pending", definition: demoScale, draft_answers: {}, draft_revision: 0, family_id: FAMILY_ID, child_name: "Synthetic child", birth_date: "2013-04-12", respondent_role: "student", region: "CN" }];
      if (text.includes("SELECT family_id FROM assessments")) return [{ family_id: FAMILY_ID }];
      if (text.includes("FROM families f WHERE f.id=$1")) return [{ id: FAMILY_ID, region: "CN", assigned_to: ACTOR_ID }];
      if (text === ACTIVE_CONSENT_ROWS_SQL) return [{ scopes: ["assessment"] }];
      return [];
    }) as never);
    const student: Actor = { ...parent, role: "student" };
    await expect(saveDraft(student, ASSESSMENT_ID, { answers: { q1: 1 }, acknowledged: true, revision: 0 })).rejects.toMatchObject({ code: "GUARDIAN_CONSENT_REQUIRED" });
    expect(mockQuery.mock.calls.some(([sql]) => sql === ACTIVE_CONSENT_ROWS_SQL)).toBe(true);
    mockTransaction.mockImplementation((async (fn: (client: { query: (sql: string) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => fn({
      query: async (sql: string) => {
        if (sql.includes("FROM families") && sql.includes("FOR UPDATE")) return { rows: [{ id: FAMILY_ID, region: "CN", assigned_to: ACTOR_ID }] };
        if (sql.includes("SELECT * FROM assessments")) return { rows: [{ id: ASSESSMENT_ID, family_id: FAMILY_ID, status: "failed", snapshot: {}, answers: {}, submitted_at: new Date() }] };
        if (sql.includes("SELECT * FROM report_jobs")) return { rows: [{ id: "job", state: "failed" }] };
        if (sql === ACTIVE_CONSENT_ROWS_SQL) return { rows: revokedLegacy };
        return { rows: [] };
      }
    })) as never);
    await expect(retryReport(admin, ASSESSMENT_ID)).rejects.toMatchObject({ code: "GUARDIAN_CONSENT_REQUIRED" });
  });

  it("keeps a revoked parent-report purpose out of the worker claim and the publication re-check", async () => {
    const claimSql: string[] = [];
    mockQuery.mockImplementation((async (sql: string) => {
      claimSql.push(String(sql));
      return [];
    }) as never);
    await expect(processOneJob()).resolves.toBe(false);
    expect(claimSql[0]).toContain(consentScopeGrantedSql("a.family_id", "parent_report"));
    const events: string[] = [];
    mockQuery.mockImplementation((async (sql: string) => {
      if (String(sql).includes("WITH candidate")) return [{ id: REPORT_ID, assessment_id: ASSESSMENT_ID, attempts: 1 }];
      if (String(sql).includes("FROM assessments WHERE id=$1")) return [{ id: ASSESSMENT_ID, family_id: FAMILY_ID, snapshot: publishedSnapshot, submitted_at: publishedSnapshot.submittedAt }];
      if (String(sql).includes("ai_processing")) return [];
      return [];
    }) as never);
    mockTransaction.mockImplementation((async (fn: (client: { query: (sql: string) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => fn({
      query: async (sql: string) => {
        events.push(sql);
        if (sql === ACTIVE_CONSENT_ROWS_SQL) return { rows: revokedLegacy };
        return { rows: [{ id: "locked" }] };
      }
    })) as never);
    await expect(processReportJob(REPORT_ID)).resolves.toEqual({ status: "paused" });
    const consentAt = events.findIndex(sql => sql === ACTIVE_CONSENT_ROWS_SQL);
    const familyAt = events.findIndex(sql => sql.includes("FROM families") && sql.includes("FOR UPDATE"));
    expect(consentAt).toBeGreaterThan(familyAt);
    expect(events.some(sql => sql.includes("INSERT INTO reports"))).toBe(false);
  });

  it("does not advertise a report from the workspace when the granted-scope helper is false", async () => {
    mockQuery.mockImplementation((async (sql: string) => {
      const text = String(sql);
      if (text.includes("FROM families f WHERE")) return [{ id: FAMILY_ID, region: "CN", family_name: "Synthetic", child_name: "Synthetic child", birth_date: "2013-04-12", grade: "S2", guardian_label: "Synthetic guardian", assigned_to: null, created_at: new Date(), assigned_name: null }];
      if (text.includes("AS scopes FROM consents c")) return [{ family_id: FAMILY_ID, scopes: ["assessment", "sensitive_data"] }];
      if (text.includes("FROM assessments a JOIN families f")) return [{ id: ASSESSMENT_ID, family_id: FAMILY_ID, respondent_id: ACTOR_ID, respondent_role: "parent", status: "published", created_at: new Date(), submitted_at: new Date(), child_name: "Synthetic child", respondent_name: "Synthetic", definition: demoScale, report_id: REPORT_ID, has_consent: false }];
      return [];
    }) as never);
    const workspace = await workspaceFor(parent, "zh-CN");
    expect(workspace.assessments[0]).toMatchObject({ reportId: null, phase: "consent" });
    expect(workspace.families[0].consents?.parentReport).toBe(false);
    const assessmentSql = String(mockQuery.mock.calls.find(([sql]) => String(sql).includes("FROM assessments a JOIN families f"))?.[0]);
    expect(assessmentSql).toContain(consentScopeGrantedSql("a.family_id", "parent_report"));
    const listSql = String(mockQuery.mock.calls.find(([sql]) => String(sql).includes("AS scopes FROM consents c"))?.[0]);
    expect(listSql).toContain(effectiveScopesSelect("c"));
  });
});
