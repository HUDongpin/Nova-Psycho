import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { Actor, Role } from "../src/domain/types";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
import { query, transaction } from "../src/lib/db";
import { recordConsent } from "../src/lib/families";

const FAMILY_ID = "11111111-2222-4333-8444-555555555555";
const USER_ID = "99999999-8888-4777-8666-555555555555";
const OTHER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const actor = (role: Role): Actor => ({ id: USER_ID, name: "Synthetic guardian", role, region: "CN" });
const consent = { accepted: true, guardianName: "Synthetic guardian", reference: "SYNTHETIC-REF", aiProcessing: true };
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
  client.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM families") && sql.includes("FOR UPDATE")) {
      beforeLock();
      return { rows: [{ id: FAMILY_ID, region: "CN", assigned_to: assignedTo }] };
    }
    if (sql.includes("FROM users")) return { rows: [current] };
    if (sql.includes("FROM memberships")) return { rows: parentMember ? [{ exists: true }] : [] };
    if (sql.startsWith("UPDATE consents") || sql.startsWith("INSERT INTO consents")) { writes.push(sql); return { rows: [] }; }
    throw new Error("Unexpected synthetic transaction query");
  });
  vi.mocked(transaction).mockImplementation(async fn => fn(client as unknown as PoolClient));
});
afterEach(() => vi.unstubAllEnvs());

describe("consent mutation authorization under the family lock", () => {
  it.each(["parent", "staff", "admin"] as const)("allows a current authorized %s to record consent", async role => {
    current.role = role;
    await expect(recordConsent(actor(role), FAMILY_ID, consent)).resolves.toEqual({ ok: true });
    expect(writes).toHaveLength(2);
    if (role === "parent") expect(client.query).toHaveBeenCalledWith("SELECT 1 FROM memberships WHERE family_id=$1 AND user_id=$2 AND role='parent'", [FAMILY_ID, USER_ID]);
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
    expect(client.query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("region=$2 FOR UPDATE"), [FAMILY_ID, "CN"]);
    expect(writes).toEqual([]);
  });
});
