import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { Actor } from "../src/domain/types";
import { demoAdvice, demoScale } from "../src/domain/demo";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/auth", () => ({ audit: vi.fn(), hashPassword: vi.fn(), limitLogin: vi.fn() }));
vi.mock("../src/lib/config", () => ({ getConfig: () => ({ region: "CN", mode: "demo" }), isDemoMode: () => true }));
import { query, transaction } from "../src/lib/db";
import { createAssessment } from "../src/lib/assessments";
import { setScaleStatus } from "../src/lib/content";

const actor: Actor = { id: "11111111-2222-4333-8444-555555555555", name: "Synthetic admin", role: "admin", region: "CN" };
const familyId = "33333333-4444-4555-8666-777777777777";
const respondentId = "44444444-5555-4666-8777-888888888888";
const respondent: Actor = { id: respondentId, name: "Synthetic student", role: "student", region: "CN" };
const demoId = `${demoScale.id}@${demoScale.version}`;
const officialId = "synthetic-official@1.0.0";
const officialScale = { ...demoScale, id: "synthetic-official", demo: false };
const family = { id: familyId, region: "CN", family_name: "Synthetic family", child_name: "Synthetic child", birth_date: `${new Date().getUTCFullYear() - 13}-01-01`, grade: "S2", guardian_label: "Parent", assigned_to: null, created_at: new Date() };
const input = { familyId, respondentId, scaleVersionId: demoId, locale: "zh-CN" };
const writes: unknown[][] = [];
const events: string[] = [];
let officialActive = false;
let beforeFamilyLock: () => Promise<void>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function rows(sql: string, values: unknown[] = []): Promise<Record<string, unknown>[]> {
  if (sql.includes("FROM families f WHERE")) return [family];
  if (sql.startsWith("SELECT id FROM families")) {
    await beforeFamilyLock();
    return [{ id: familyId }];
  }
  if (sql.includes("FROM users WHERE id=$1")) {
    const current = [actor, respondent].find(user => user.id === values[0]);
    return current ? [{ ...current, disabled: false, demo: false }] : [];
  }
  if (sql.includes("SELECT m.role FROM memberships")) return values[0] === familyId && values[1] === respondentId && values[2] === respondent.region
    ? [{ role: respondent.role }] : [];
  if (sql.includes("SELECT id,definition,status FROM scales")) return values[0] === demoId
    ? [{ id: demoId, definition: demoScale, status: "active" }]
    : [{ id: officialId, definition: officialScale, status: officialActive ? "active" : "retired" }];
  if (sql.includes("SELECT a.id FROM assessments a JOIN scales")) return [];
  if (sql.includes("FROM scales WHERE status='active'")) {
    events.push(`official-check:${officialActive ? "active" : "retired"}`);
    return officialActive ? [{ id: officialId }] : [];
  }
  if (sql.includes("pg_advisory_xact_lock")) { events.push("content-lock"); return []; }
  if (sql.includes("FROM content_versions")) return [{ id: "synthetic-advice", version: "1.0.0", content: demoAdvice }];
  if (sql.startsWith("UPDATE scales SET status")) {
    expect(values).toEqual(["active", officialId, actor.id, actor.region, true]);
    officialActive = true;
    events.push("official-activated");
    return [{ id: officialId }];
  }
  if (sql.includes("SELECT status FROM scales")) return [{ status: "active" }];
  if (sql.includes("SELECT id,triad_round_id FROM assessments") || sql.includes("SELECT submitted_at FROM assessments")) return [];
  if (sql.startsWith("INSERT INTO assessments")) {
    writes.push(values);
    events.push("demo-created");
    return [];
  }
  throw new Error(`Unexpected synthetic query: ${sql}`);
}

beforeEach(() => {
  officialActive = false;
  writes.length = 0;
  events.length = 0;
  beforeFamilyLock = async () => {};
  vi.mocked(query).mockImplementation(async (sql, values) => await rows(sql, values) as never);
  vi.mocked(transaction).mockImplementation(fn => fn({
    query: async (sql: string, values?: unknown[]) => { const result = await rows(sql, values); return { rows: result, rowCount: result.length }; }
  } as unknown as PoolClient));
});

describe("demo assignment during official scale activation", () => {
  it("allows a demo while no matching official scale is active", async () => {
    await expect(createAssessment(actor, input)).resolves.toHaveProperty("id");
    expect(writes).toHaveLength(1);
  });

  it("rejects a demo when a matching official scale is already active", async () => {
    await setScaleStatus(actor, officialId, { status: "active" });
    await expect(createAssessment(actor, input)).rejects.toMatchObject({ status: 409, code: "DEMO_NOT_ASSIGNABLE" });
    expect(writes).toEqual([]);
  });

  it("rechecks official availability after waiting for the assignment locks", async () => {
    const reachedFamilyLock = deferred(), releaseFamilyLock = deferred();
    beforeFamilyLock = async () => { reachedFamilyLock.resolve(); await releaseFamilyLock.promise; };
    // Model a family transaction holding this row: assignment's preflight has
    // passed, but assignment has not yet acquired the global content lock.
    const assignment = createAssessment(actor, input).then(value => ({ value }), error => ({ error }));
    await reachedFamilyLock.promise;
    expect(events).toEqual(["official-check:retired"]);

    // This is the real supported scale-activation service, not a direct fixture
    // mutation. It commits under the content lock while assignment is waiting.
    await setScaleStatus(actor, officialId, { status: "active" });
    expect(officialActive).toBe(true);
    releaseFamilyLock.resolve();

    const outcome = await assignment;
    expect(outcome, JSON.stringify({ events, taskWrites: writes.length })).toMatchObject({
      error: { status: 409, code: "DEMO_NOT_ASSIGNABLE" }
    });
    expect(writes).toEqual([]);
  });
});
