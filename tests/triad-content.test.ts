import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { Actor } from "../src/domain/types";
import { demoAdvice, demoScale, demoTemplate } from "../src/domain/demo";
import { previewAnswers } from "../src/domain/triad-report";
import { childScale } from "../src/domain/triad-scales";
import { contentCanonical, nextContentPatch, TRIAD_LIBRARY_KEY, upsertSeededContent } from "../src/lib/content-seed";
import { currentContent } from "../src/lib/content";
import { triadAdvice, triadTemplate } from "../src/lib/triad";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
import { query, transaction } from "../src/lib/db";
import { ensureTriadInstruments } from "../src/lib/triad";
import { submitAssessment } from "../src/lib/assessments";

type ContentRow = { id: string; kind: string; version: string; content: unknown; library_key: string | null; origin: string; created_at: string };
const rows: ContentRow[] = [];
const sqlLog: string[] = [];
let clock = 0;

function stamp(): string { clock += 1; return `2026-10-11T00:00:${String(clock).padStart(2, "0")}.000Z`; }
function latest(kind: string, libraryKey: string | null): ContentRow | undefined {
  return rows.filter(row => row.kind === kind && row.library_key === libraryKey).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0];
}
function apply(sql: string, values: unknown[] = []): Record<string, unknown>[] {
  sqlLog.push(sql);
  if (/^(ALTER|CREATE|UPDATE families|INSERT INTO scales|UPDATE scales|INSERT INTO audit_events|SELECT pg_advisory)/.test(sql)) return [];
  if (sql.includes("FROM content_versions WHERE kind=$1 AND library_key=$2")) {
    const row = latest(String(values[0]), String(values[1]));
    return row ? [row] : [];
  }
  if (sql.includes("FROM content_versions WHERE kind=$1 AND library_key IS NULL")) {
    const row = latest(String(values[0]), null);
    return row ? [row] : [];
  }
  if (sql.startsWith("INSERT INTO content_versions")) {
    const libraryKey = values.length > 4 ? String(values[4]) : null;
    rows.push({ id: String(values[0]), kind: String(values[1]), version: String(values[2]), content: JSON.parse(String(values[3])), library_key: libraryKey, origin: sql.includes("'seed'") ? "seed" : "staff", created_at: stamp() });
    return [];
  }
  return [];
}

beforeEach(() => {
  vi.stubEnv("NOVA_REGION", "CN");
  vi.stubEnv("NOVA_MODE", "demo");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR", "work/test-private");
  vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
  rows.length = 0; sqlLog.length = 0; clock = 0;
  vi.mocked(query).mockImplementation(async (sql, values) => apply(String(sql), values ?? []));
  vi.mocked(transaction).mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("triad narrative seeding", () => {
  it("inserts the triad library even when the general library is already present, and does not rewrite it", async () => {
    rows.push(
      { id: "general-advice", kind: "advice", version: "1.0.0", content: demoAdvice, library_key: null, origin: "staff", created_at: stamp() },
      { id: "general-template", kind: "template", version: "1.0.0", content: demoTemplate, library_key: null, origin: "staff", created_at: stamp() }
    );
    const before = JSON.stringify(rows);
    await ensureTriadInstruments();
    expect(sqlLog.some(sql => sql.includes("UPDATE content_versions"))).toBe(false);
    expect(JSON.stringify(rows.filter(row => row.library_key === null))).toBe(before);
    expect(latest("advice", TRIAD_LIBRARY_KEY)?.content).toEqual(triadAdvice);
    expect(latest("template", TRIAD_LIBRARY_KEY)?.content).toEqual(triadTemplate);
    expect(latest("advice", TRIAD_LIBRARY_KEY)?.origin).toBe("seed");
    const seeded = rows.length;
    await ensureTriadInstruments();
    expect(rows).toHaveLength(seeded);
    expect(await currentContent("advice")).toMatchObject({ id: "general-advice", version: "1.0.0" });
    expect(await currentContent("template")).toMatchObject({ id: "general-template" });
    expect((await currentContent("advice")).content).toEqual(demoAdvice);
  });

  it("publishes a new immutable version when the seed changes, and leaves a staff-origin row in place", async () => {
    expect(nextContentPatch("1.2.0")).toBe("1.2.1");
    await upsertSeededContent("advice", TRIAD_LIBRARY_KEY, triadAdvice);
    const changed = { ...triadAdvice, title: { "zh-CN": "合成三方说明修订", "zh-HK": "合成三方說明修訂" } };
    rows[0].content = changed;
    expect(await upsertSeededContent("advice", TRIAD_LIBRARY_KEY, triadAdvice)).toBe("inserted");
    expect(rows.map(row => row.version)).toEqual(["1.0.0", "1.0.1"]);
    expect(contentCanonical(rows[0].content)).toBe(contentCanonical(changed));
    expect(latest("advice", TRIAD_LIBRARY_KEY)?.version).toBe("1.0.1");
    rows.push({ id: "staff-edit", kind: "advice", version: "2.0.0", content: { ...triadAdvice, title: { "zh-CN": "工作人员发布的三方说明", "zh-HK": "工作人員發佈的三方說明" } }, library_key: TRIAD_LIBRARY_KEY, origin: "staff", created_at: stamp() });
    const count = rows.length;
    expect(await upsertSeededContent("advice", TRIAD_LIBRARY_KEY, triadAdvice)).toBe("kept_staff");
    expect(rows).toHaveLength(count);
    expect(latest("advice", TRIAD_LIBRARY_KEY)?.id).toBe("staff-edit");
  });
});

describe("triad submission freezes the triad library", () => {
  const FAMILY = "11111111-2222-4333-8444-555555555555";
  const TASK = "22222222-3333-4444-8555-666666666666";
  const STUDENT = "33333333-4444-4555-8666-777777777777";
  const actor: Actor = { id: STUDENT, name: "Synthetic student", role: "student", region: "CN" };
  const client = { query: vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>() };

  it("stores the keyed triad template instead of the newer general library", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
    const assessment = { id: TASK, family_id: FAMILY, respondent_id: STUDENT, respondent_role: "student", status: "pending", draft_revision: 0, triad_round_id: "44444444-5555-4666-8777-888888888888", snapshot: null };
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.includes("FROM assessments a JOIN scales")) return [{ ...assessment, definition: childScale }];
      if (sql.includes("FROM families f WHERE")) return [{ id: FAMILY, child_name: "Synthetic child", birth_date: "2014-10-11", grade: "初中" }];
      return [];
    });
    vi.mocked(transaction).mockImplementation(fn => fn(client as unknown as PoolClient));
    client.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("library_key=$2")) return { rows: [{ id: `keyed-${values[0]}`, version: "1.0.0", content: values[0] === "advice" ? triadAdvice : triadTemplate }] };
      if (sql.includes("library_key IS NULL")) return { rows: [{ id: `general-${values[0]}`, version: "9.0.0", content: values[0] === "advice" ? demoAdvice : demoTemplate }] };
      if (sql.includes("SELECT id FROM families")) return { rows: [{ id: FAMILY }] };
      if (sql.includes("SELECT a.*,r.id AS report_id")) return { rows: [assessment] };
      if (sql.includes("SELECT scopes FROM consents")) return { rows: [{ scopes: ["assessment", "parent_report", "sensitive_data"] }] };
      return { rows: [] };
    });
    const answers = previewAnswers(childScale);
    answers.c_age = 12;
    await submitAssessment(actor, TASK, { answers, acknowledged: true, revision: 0 });
    const saved = client.query.mock.calls.find(([sql]) => String(sql).includes("UPDATE assessments SET answers"));
    const snapshot = JSON.parse(String(saved?.[1]?.[1]));
    expect(snapshot.template).toMatchObject({ id: "keyed-template", content: triadTemplate });
    expect(snapshot.advice.id).toBe("keyed-advice");
    expect(snapshot.template.content.limitation["zh-CN"]).not.toBe(demoTemplate.limitation["zh-CN"]);
    const keyed = client.query.mock.calls.filter(([sql]) => String(sql).includes("library_key=$2"));
    expect(keyed.map(([, values]) => values)).toEqual([["advice", TRIAD_LIBRARY_KEY], ["template", TRIAD_LIBRARY_KEY]]);
    vi.useRealTimers();
  });

  it("still freezes the general library for a non-triad scale", async () => {
    const assessment = { id: TASK, family_id: FAMILY, respondent_id: STUDENT, respondent_role: "student", status: "pending", draft_revision: 0, triad_round_id: null, snapshot: null };
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.includes("FROM assessments a JOIN scales")) return [{ ...assessment, definition: demoScale }];
      if (sql.includes("FROM families f WHERE")) return [{ id: FAMILY, child_name: "Synthetic child", birth_date: "2014-10-11", grade: "初中" }];
      return [];
    });
    vi.mocked(transaction).mockImplementation(fn => fn(client as unknown as PoolClient));
    client.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("library_key IS NULL")) return { rows: [{ id: `general-${values[0]}`, version: "2.0.0", content: values[0] === "advice" ? demoAdvice : demoTemplate }] };
      if (sql.includes("SELECT id FROM families")) return { rows: [{ id: FAMILY }] };
      if (sql.includes("SELECT a.*,r.id AS report_id")) return { rows: [assessment] };
      if (sql.includes("SELECT scopes FROM consents")) return { rows: [{ scopes: ["assessment", "parent_report", "sensitive_data"] }] };
      if (sql.includes("FROM report_jobs")) return { rows: [] };
      return { rows: [] };
    });
    const answers = { q1: 0, q2: 0, q3: 0, q4: 0, q5: 0, q6: 0, q7: 0, q8: 0, q9: 0 };
    await submitAssessment(actor, TASK, { answers, acknowledged: true, revision: 0 });
    const saved = client.query.mock.calls.find(([sql]) => String(sql).includes("UPDATE assessments SET answers"));
    const snapshot = JSON.parse(String(saved?.[1]?.[1]));
    expect(snapshot.advice.id).toBe("general-advice");
    expect(snapshot.template.id).toBe("general-template");
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("library_key=$2"))).toBe(false);
  });
});
