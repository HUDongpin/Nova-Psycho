import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

const send = vi.hoisted(() => vi.fn());
vi.mock("@vercel/queue", () => ({ QueueClient: class { send = send; constructor(options: unknown) { void options; } } }));
vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));

import { query, transaction } from "../src/lib/db";
import { recordConsent } from "../src/lib/families";
import type { Actor } from "../src/domain/types";

const FAMILY = "11111111-2222-4333-8444-555555555555";
const ASSESSMENT = "22222222-3333-4444-8555-666666666666";
const JOB = "33333333-4444-4555-8666-777777777777";
const actor: Actor = { id: "99999999-8888-4777-8666-555555555555", name: "Synthetic guardian", role: "parent", region: "HK" };
const grant = { action: "grant" as const, scope: "parent_report" as const, guardianName: "Synthetic guardian" };
const withdraw = { action: "withdraw" as const, scope: "parent_report" as const, guardianName: "Synthetic guardian" };

function allowConsent(sql: string): { rows: unknown[] } | undefined {
  if (sql.includes("FROM families f WHERE f.id=$1") && sql.includes("FOR UPDATE")) return { rows: [{ id: FAMILY }] };
  if (sql.includes("role=$2 AND region=$3 AND NOT disabled FOR SHARE")) return { rows: [{ id: actor.id }] };
  return undefined;
}

function consentClient(activeScopes: string[][]) {
  return { query: vi.fn(async (sql: string) => {
    const allowed = allowConsent(sql);
    if (allowed) return allowed;
    if (sql.includes("AS scopes FROM consents WHERE family_id=$1")) return { rows: activeScopes.map(scopes => ({ scopes })) };
    if (sql.includes("FROM consents c WHERE c.family_id=$1")) return { rows: [{ id: "44444444-5555-4666-8777-888888888888" }] };
    if (sql.includes("NOT EXISTS (SELECT 1 FROM report_jobs")) return { rows: [{ id: ASSESSMENT }] };
    if (sql.startsWith("INSERT INTO report_jobs")) return { rows: [] };
    if (sql.includes("j.state='paused'")) return { rows: [] };
    if (sql.includes("j.state='ready'")) return { rows: [{ id: ASSESSMENT }] };
    if (sql.includes("triad_round_id IS NOT NULL")) return { rows: [] };
    return { rows: [] };
  }) };
}

function dispatchQueries(): unknown[][] {
  return vi.mocked(query).mock.calls.filter(([sql]) => String(sql).includes("FROM report_jobs j JOIN assessments a"));
}

beforeEach(() => {
  vi.stubEnv("NOVA_REGION", "HK");
  vi.stubEnv("NOVA_MODE", "demo");
  vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3101");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_REPORT_KEY", "ab".repeat(32));
  vi.stubEnv("NOVA_REPORT_STORAGE", "database");
  vi.stubEnv("NOVA_WORKER_MODE", "queue");
  vi.stubEnv("NOVA_QUEUE_REGION", "sin1");
  send.mockReset();
  vi.mocked(query).mockReset();
  vi.mocked(transaction).mockReset();
  vi.mocked(query).mockImplementation((async (sql: string) => {
    if (String(sql).includes("FROM families f WHERE f.id=$1")) return [{ id: FAMILY, region: "HK", family_name: "Synthetic", child_name: "Synthetic child", birth_date: "2014-01-01", grade: "S2", guardian_label: "Synthetic guardian", assigned_to: null, created_at: new Date() }];
    if (String(sql).includes("FROM report_jobs j JOIN assessments a")) return [{ id: JOB }];
    return [];
  }) as never);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function useClient(activeScopes: string[][], failFirst = false) {
  let inTransaction = false;
  let sentInside = false;
  let attempts = 0;
  send.mockImplementation(async () => {
    if (inTransaction) sentInside = true;
    attempts += 1;
    if (failFirst && attempts === 1) throw new Error("synthetic unavailable");
    return { messageId: "message" };
  });
  const client = consentClient(activeScopes);
  vi.mocked(transaction).mockImplementation((async (fn: (client: PoolClient) => Promise<unknown>) => {
    inTransaction = true;
    try { return await fn(client as unknown as PoolClient); }
    finally { inTransaction = false; }
  }) as never);
  return { sentInsideTransaction: () => sentInside, client };
}

describe("consent report dispatch retry", () => {
  it("registers one deferred retry when the first queue send fails after parent-report consent", async () => {
    const gate = useClient([["assessment"], ["sensitive_data"]], true);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deferred: (() => Promise<void>)[] = [];
    await expect(recordConsent(actor, FAMILY, grant, work => deferred.push(work))).resolves.toEqual({ ok: true });
    expect(gate.sentInsideTransaction()).toBe(false);
    expect(deferred).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(dispatchQueries()).toHaveLength(1);
    expect(dispatchQueries()[0][1]).toEqual([ASSESSMENT, "HK"]);
    expect(errors).toHaveBeenCalledWith("nova_report_dispatch_pending", { region: "HK" });
    await expect(deferred[0]()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    expect(dispatchQueries()).toHaveLength(2);
    expect(deferred).toHaveLength(1);
    expect(errors).not.toHaveBeenCalledWith("nova_report_dispatch_retry_pending", { region: "HK" });
  });

  it("dispatches a held report once when the queue accepts the first send", async () => {
    const gate = useClient([["assessment"], ["sensitive_data"]]);
    const deferred: (() => Promise<void>)[] = [];
    await expect(recordConsent(actor, FAMILY, grant, work => deferred.push(work))).resolves.toEqual({ ok: true });
    expect(gate.sentInsideTransaction()).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toEqual({ jobId: JOB, region: "HK" });
    expect(dispatchQueries()).toHaveLength(1);
    expect(deferred).toHaveLength(0);
  });

  it("does not dispatch when parent-report consent is withdrawn", async () => {
    const gate = useClient([["assessment"], ["sensitive_data"], ["parent_report"]]);
    const deferred: (() => Promise<void>)[] = [];
    await expect(recordConsent(actor, FAMILY, withdraw, work => deferred.push(work))).resolves.toEqual({ ok: true });
    expect(gate.sentInsideTransaction()).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(dispatchQueries()).toHaveLength(0);
    expect(deferred).toHaveLength(0);
    expect(gate.client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO consent_scope_revocations"))).toBe(true);
    expect(gate.client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO report_jobs"))).toBe(false);
  });
});
