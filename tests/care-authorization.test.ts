import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { Actor } from "../src/domain/types";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
import { query, transaction } from "../src/lib/db";
import { addGoal, addObservation, updateGoal } from "../src/lib/care";

const FAMILY_ID = "11111111-2222-4333-8444-555555555555";
const GOAL_ID = "11111111-2222-4333-8444-555555555556";
const STAFF_ID = "99999999-8888-4777-8666-555555555555";
const OTHER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const staff: Actor = { id: STAFF_ID, name: "Synthetic worker", role: "staff", region: "CN" };
let assignedTo: string, alert: boolean, present: boolean;
let current: Actor & { disabled: boolean; demo: boolean };
let afterAuthorization: () => void;
let mutations: string[];
const client = { query: vi.fn() };
const operations = [
  { name: "goal creation", run: () => addGoal(staff, { familyId: FAMILY_ID, title: "Synthetic goal", detail: "" }) },
  { name: "goal status", run: () => updateGoal(staff, GOAL_ID, { status: "completed" }) },
  { name: "private observation", run: () => addObservation(staff, { familyId: FAMILY_ID, body: "Synthetic observation" }) },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NOVA_REGION", "CN"); vi.stubEnv("NOVA_MODE", "demo");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova"); vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR", "work/test-private"); vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
  assignedTo = STAFF_ID; alert = false; present = true; mutations = [];
  current = { ...staff, disabled: false, demo: false }; afterAuthorization = () => {};
  const execute = async (sql: string, transactional: boolean) => {
    if (sql.includes("FROM families") && sql.includes("FOR UPDATE")) {
      // A preceding reassignment/deletion wins while this mutation waits for the family.
      afterAuthorization();
      return present ? [{ id: FAMILY_ID, region: "CN", assigned_to: assignedTo }] : [];
    }
    if (sql.includes("FROM families f WHERE f.id=$1")) {
      const rows = present && (assignedTo === STAFF_ID || alert) ? [{ id: FAMILY_ID, region: "CN", assigned_to: assignedTo }] : [];
      if (!transactional) afterAuthorization();
      return rows;
    }
    if (sql.includes("SELECT family_id FROM goals")) return [{ family_id: FAMILY_ID }];
    if (sql.includes("FROM users")) return [current];
    if (/^(INSERT INTO (goals|observations)|UPDATE goals)/.test(sql)) mutations.push(sql);
    return [];
  };
  vi.mocked(query).mockImplementation((async (sql: string) => execute(sql, false)) as never);
  client.query.mockImplementation(async (sql: string) => ({ rows: await execute(sql, true) }));
  vi.mocked(transaction).mockImplementation(async fn => fn(client as unknown as PoolClient));
});
afterEach(() => vi.unstubAllEnvs());

describe.each(operations)("$name keeps family access current", operation => {
  it("allows its assigned active worker", async () => {
    await operation.run(); expect(mutations).toHaveLength(1);
  });
  it("rejects a worker after reassignment wins the family lock", async () => {
    afterAuthorization = () => { assignedTo = OTHER_ID; };
    await expect(operation.run()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mutations).toEqual([]);
  });
  it("preserves regional staff access to a safety-alert family after reassignment", async () => {
    alert = true; afterAuthorization = () => { assignedTo = OTHER_ID; };
    await operation.run(); expect(mutations).toHaveLength(1);
  });
  it("rejects a deleted family before writing", async () => {
    afterAuthorization = () => { present = false; };
    await expect(operation.run()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mutations).toEqual([]);
  });
  it("rejects an account disabled while waiting for the family lock", async () => {
    afterAuthorization = () => { current.disabled = true; };
    await expect(operation.run()).rejects.toMatchObject({ code: "ACCOUNT_REVOKED" });
    expect(mutations).toEqual([]);
  });
});
