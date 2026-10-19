import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { Actor } from "../src/domain/types";
import { demoScale } from "../src/domain/demo";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/content", () => ({ getScale: vi.fn(), lockContent: vi.fn() }));
import { query, transaction } from "../src/lib/db";
import { getScale } from "../src/lib/content";
import { createAssessment } from "../src/lib/assessments";

const staffId = "11111111-2222-4333-8444-555555555555";
const nextStaffId = "22222222-3333-4444-8555-666666666666";
const familyId = "33333333-4444-4555-8666-777777777777";
const respondentId = "44444444-5555-4666-8777-888888888888";
const actor: Actor = { id: staffId, name: "Synthetic staff", role: "staff", region: "CN" };
const input = { familyId, respondentId, scaleVersionId: `${demoScale.id}@${demoScale.version}`, locale: "zh-CN" };
const family = { id: familyId, region: "CN", family_name: "Synthetic", child_name: "Synthetic child", birth_date: "2013-04-12", grade: "S2", guardian_label: "Parent", assigned_to: staffId };
const client = { query: vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>() };

beforeEach(() => {
  vi.stubEnv("NOVA_REGION", "CN"); vi.stubEnv("NOVA_MODE", "demo");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR", "work/test-private"); vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
  vi.mocked(query).mockReset(); client.query.mockReset();
  vi.mocked(transaction).mockImplementation(fn => fn(client as unknown as PoolClient));
  vi.mocked(getScale).mockResolvedValue({ id: input.scaleVersionId, status: "active", definition: demoScale } as never);
});
afterEach(() => vi.unstubAllEnvs());

function setup(currentStaffId: string, safetyAccess = false) {
  vi.mocked(query).mockImplementation(async sql => {
    if (sql.includes("FROM families f WHERE")) return [{ ...family }];
    if (sql.includes("SELECT m.role FROM memberships")) return [{ role: "student" }];
    return [];
  });
  client.query.mockImplementation(async sql => {
    const current = { ...family, assigned_to: currentStaffId };
    if (sql.includes("FROM users WHERE id=$1")) return { rows: [{ ...actor, disabled: false, demo: false }] };
    if (sql.includes("SELECT m.role FROM memberships")) return { rows: [{ role: "student" }] };
    if (sql.includes("FROM families f WHERE")) return { rows: currentStaffId === staffId || safetyAccess ? [current] : [] };
    if (sql.includes("SELECT id FROM families")) return { rows: [current] };
    if (sql.includes("SELECT status FROM scales")) return { rows: [{ status: "active" }] };
    return { rows: [] };
  });
}

describe("assessment assignment authorization under reassignment", () => {
  it("refuses staff whose family access was removed before the family lock", async () => {
    setup(nextStaffId);
    await expect(createAssessment(actor, input)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO assessments"))).toBe(false);
  });

  it("preserves assigned staff and existing safety-alert access", async () => {
    for (const [assignedTo, safetyAccess] of [[staffId, false], [nextStaffId, true]] as const) {
      setup(assignedTo, safetyAccess);
      await expect(createAssessment(actor, input)).resolves.toMatchObject({ id: expect.any(String) });
    }
    expect(client.query.mock.calls.filter(([sql]) => sql.startsWith("INSERT INTO assessments"))).toHaveLength(2);
  });
});
