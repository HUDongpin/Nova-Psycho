import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { Actor } from "../src/domain/types";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
import { query, transaction } from "../src/lib/db";
import { assignFamily, createInvitation } from "../src/lib/families";

const FAMILY_ID = "11111111-2222-4333-8444-555555555555";
const ACTOR_ID = "99999999-8888-4777-8666-555555555555";
const ASSIGNEE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const actor = (role: "admin" | "staff"): Actor => ({ id: ACTOR_ID, name: "Synthetic worker", role, region: "CN" });
let currentActor: Actor & { disabled: boolean; demo: boolean };
let beforeFamilyLock: () => void;
let mutations: string[];
const client = { query: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NOVA_REGION", "CN"); vi.stubEnv("NOVA_MODE", "demo");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova"); vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR", "work/test-private"); vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
  currentActor = { ...actor("admin"), disabled: false, demo: false };
  beforeFamilyLock = () => {}; mutations = [];
  vi.mocked(query).mockResolvedValue([]);
  client.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM families") && sql.includes("FOR UPDATE")) {
      beforeFamilyLock();
      return { rows: [{ id: FAMILY_ID, region: "CN", assigned_to: ACTOR_ID }] };
    }
    if (sql.includes("FROM users") && sql.includes("FOR UPDATE")) return { rows: [currentActor] };
    if (sql.includes("FROM users") && sql.includes("FOR SHARE")) return { rows: [{ id: ASSIGNEE_ID }] };
    if (sql.startsWith("INSERT INTO invitations") || sql.startsWith("UPDATE families")) mutations.push(sql);
    return { rows: [] };
  });
  vi.mocked(transaction).mockImplementation(async fn => fn(client as unknown as PoolClient));
});
afterEach(() => vi.unstubAllEnvs());

const operations = [
  { name: "administrator assignment", role: "admin", run: (user: Actor) => assignFamily(user, FAMILY_ID, { assignedTo: ASSIGNEE_ID }) },
  { name: "administrator invitation", role: "admin", run: (user: Actor) => createInvitation(user, FAMILY_ID, { role: "parent" }) },
  { name: "assigned worker invitation", role: "staff", run: (user: Actor) => createInvitation(user, FAMILY_ID, { role: "student" }) },
] as const;

describe.each(operations)("$name revalidates current account authority", operation => {
  it("continues to allow an active account with its current role", async () => {
    currentActor.role = operation.role;
    await operation.run(actor(operation.role));
    expect(mutations).toHaveLength(1);
  });
  it("does not mutate after the account is disabled while waiting for the family lock", async () => {
    currentActor.role = operation.role;
    beforeFamilyLock = () => { currentActor.disabled = true; };
    await expect(operation.run(actor(operation.role))).rejects.toMatchObject({ code: "ACCOUNT_REVOKED" });
    expect(mutations).toEqual([]);
  });
  it("does not use a role revoked while waiting for the family lock", async () => {
    currentActor.role = operation.role;
    beforeFamilyLock = () => { currentActor.role = "teacher"; };
    await expect(operation.run(actor(operation.role))).rejects.toMatchObject({ code: "ROLE_CONFLICT" });
    expect(mutations).toEqual([]);
  });
  it("does not continue after family deletion won the lock", async () => {
    currentActor.role = operation.role;
    client.query.mockResolvedValueOnce({ rows: [] });
    await expect(operation.run(actor(operation.role))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mutations).toEqual([]);
    expect(client.query).toHaveBeenCalledTimes(1);
  });
});
