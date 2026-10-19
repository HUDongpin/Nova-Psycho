import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { Actor, Role } from "../src/domain/types";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
import { familyScope } from "../src/lib/access";
import { query, transaction } from "../src/lib/db";
import { recordConsent } from "../src/lib/families";

const FAMILY_ID = "11111111-2222-4333-8444-555555555555";
const USER_ID = "99999999-8888-4777-8666-555555555555";
const OTHER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const actor = (role: Role): Actor => ({ id: USER_ID, name: "Synthetic guardian", role, region: "CN" });
const consent = { action: "grant" as const, scope: "assessment" as const, guardianName: "Synthetic guardian", reference: "SYNTHETIC-REF" };
let current: Actor & { disabled: boolean; demo: boolean };
let assignedTo: string | null;
let parentMember: boolean;
let beforeLock: () => void;
let writes: string[];
const client = { query: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NOVA_REGION", "CN"); vi.stubEnv("NOVA_MODE", "demo");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR", "work/test-private"); vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
  current = { ...actor("parent"), disabled: false, demo: false };
  assignedTo = USER_ID; parentMember = true; beforeLock = () => {}; writes = [];
  vi.mocked(query).mockImplementation(async sql => {
    // A safety alert permits this regional family to be read even by unassigned staff.
    if (sql.includes("FROM families f WHERE")) return [{ id: FAMILY_ID, region: "CN", assigned_to: assignedTo }];
    if (sql.startsWith("INSERT INTO audit_events")) return [];
    throw new Error("Unexpected synthetic database query");
  });
  client.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("FROM families f") && sql.includes("FOR UPDATE")) {
      beforeLock();
      if (sql.includes("FROM memberships")) return { rows: parentMember ? [{ id: FAMILY_ID }] : [] };
      if (sql.includes("f.assigned_to=$3")) return { rows: assignedTo === params[2] ? [{ id: FAMILY_ID }] : [] };
      return { rows: [{ id: FAMILY_ID }] };
    }
    if (sql.includes("role=$2 AND region=$3 AND NOT disabled")) {
      if (current.disabled || current.role !== params[1] || current.region !== params[2]) return { rows: [] };
      return { rows: [{ id: current.id }] };
    }
    if (sql.includes("SELECT role, region, disabled FROM users")) return { rows: [{ role: current.role, region: current.region, disabled: current.disabled }] };
    if (sql.includes("AS scopes FROM consents")) return { rows: [] };
    if (sql.startsWith("UPDATE consents") || sql.startsWith("INSERT INTO consents")) { writes.push(sql); return { rows: [] }; }
    return { rows: [] };
  });
  vi.mocked(transaction).mockImplementation(async fn => fn(client as unknown as PoolClient));
});
afterEach(() => vi.unstubAllEnvs());

describe("consent mutation authorization under the family lock", () => {
  it.each(["parent", "staff", "admin"] as const)("allows a current authorized %s to record consent", async role => {
    current.role = role;
    await expect(recordConsent(actor(role), FAMILY_ID, consent)).resolves.toEqual({ ok: true });
    expect(writes.filter(sql => sql.startsWith("INSERT INTO consents"))).toHaveLength(1);
    expect(writes.filter(sql => sql.startsWith("UPDATE consents")).every(sql => sql.includes("consent_scope_revocations"))).toBe(true);
    const scope = familyScope(actor(role), 2);
    expect(client.query).toHaveBeenCalledWith(`SELECT f.id FROM families f WHERE f.id=$1 AND ${scope.sql} FOR UPDATE`, [FAMILY_ID, ...scope.values]);
  });
  it("does not let safety-alert visibility authorize an unassigned staff member to replace consent", async () => {
    current.role = "staff"; assignedTo = OTHER_ID;
    await expect(recordConsent(actor("staff"), FAMILY_ID, consent)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(writes).toEqual([]);
  });
  it("rechecks assignment after waiting for the family lock", async () => {
    current.role = "staff"; beforeLock = () => { assignedTo = OTHER_ID; };
    await expect(recordConsent(actor("staff"), FAMILY_ID, consent)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(writes).toEqual([]);
  });
  it("rechecks parent membership after waiting for the family lock", async () => {
    beforeLock = () => { parentMember = false; };
    await expect(recordConsent(actor("parent"), FAMILY_ID, consent)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(writes).toEqual([]);
  });
  it("rejects an account disabled while the request was waiting", async () => {
    beforeLock = () => { current.disabled = true; };
    await expect(recordConsent(actor("parent"), FAMILY_ID, consent)).rejects.toMatchObject({ code: "ACCOUNT_REVOKED" });
    expect(writes).toEqual([]);
  });
  it("rejects a role changed while the request was waiting", async () => {
    beforeLock = () => { current.role = "teacher"; };
    await expect(recordConsent(actor("parent"), FAMILY_ID, consent)).rejects.toMatchObject({ code: "ROLE_CONFLICT" });
    expect(writes).toEqual([]);
  });
  it("rejects a missing or foreign-region family before checking membership or writing consent", async () => {
    client.query.mockResolvedValueOnce({ rows: [] });
    await expect(recordConsent(actor("parent"), FAMILY_ID, consent)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const scope = familyScope(actor("parent"), 2);
    expect(client.query).toHaveBeenCalledExactlyOnceWith(`SELECT f.id FROM families f WHERE f.id=$1 AND ${scope.sql} FOR UPDATE`, [FAMILY_ID, ...scope.values]);
    expect(writes).toEqual([]);
  });
});
