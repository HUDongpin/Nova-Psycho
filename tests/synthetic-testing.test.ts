import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { Actor } from "../src/domain/types";
vi.mock("../src/lib/db", () => ({ query: vi.fn() }));
import { query } from "../src/lib/db";
import { getSyntheticTestFamilyMembers, getSyntheticTestObservationAuthor, isSyntheticTestActorForFamily } from "../src/lib/synthetic-testing";
const family = "aaaaaaaa-1111-4111-8111-111111111111";
const parent: Actor = { id: "parent", role: "parent", name: "Synthetic parent", region: "HK", sessionMethod: "test" };
const staff: Actor = { id: "staff", role: "staff", name: "Synthetic staff", region: "HK", sessionMethod: "test" };
const rows = ["parent", "student", "teacher"].map(role => ({ id: role, role, user_role: role, username: `synthetic.${role}`, region: "HK", family_region: "HK", disabled: false, demo: false, has_password: true }));
const observationAuthor = { id: staff.id, assigned_to: staff.id, user_role: "staff", username: "synthetic.staff", region: "HK", family_region: "HK", disabled: false, demo: false, has_password: true };
beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ NOVA_REGION: "HK", NOVA_MODE: "service", NOVA_AUTH_PROVIDER: "clerk", NOVA_TEST_ACCOUNT_USERNAMES: "synthetic.parent,synthetic.student,synthetic.teacher", NOVA_SYNTHETIC_TEST_FAMILY_IDS: family, DATABASE_URL: "postgresql://synthetic.invalid/nova", NOVA_PUBLIC_URL: "https://synthetic.example", NOVA_REPORT_STORAGE: "filesystem", NOVA_REPORT_DIR: "work/synthetic-tests", NOVA_REPORT_KEY: "0".repeat(64) })) vi.stubEnv(name, value);
  vi.mocked(query).mockResolvedValue(structuredClone(rows));
});
afterEach(() => vi.unstubAllEnvs());

describe("deployment-scoped synthetic staff observation authors", () => {
  beforeEach(() => {
    vi.stubEnv("NOVA_TEST_ACCOUNT_USERNAMES", "synthetic.parent,synthetic.student,synthetic.teacher,synthetic.staff");
    vi.mocked(query).mockImplementation(async sql => structuredClone(sql.includes("JOIN memberships") ? rows : [observationAuthor]));
  });

  it("returns only the assigned synthetic staff teacher-source identity and context", async () => {
    expect(await getSyntheticTestObservationAuthor(family, "HK")).toEqual({ id: staff.id, role: "teacher", context: "tope_staff" });
    const [sql, values] = vi.mocked(query).mock.calls[1];
    expect(sql).toContain("JOIN users u ON u.id=f.assigned_to");
    expect(sql).toContain("f.id=$1 AND f.region=$2");
    expect(values).toEqual([family, "HK"]);
  });

  it.each([
    { assigned_to: "another-staff" }, { assigned_to: null },
    { username: "ordinary.staff" }, { username: "synthetic.staff.extra" }, { username: null },
    { user_role: "teacher" }, { user_role: "admin" }, { disabled: true }, { demo: true },
    { region: "CN" }, { family_region: "CN" }, { has_password: false },
  ])("rejects an ineligible assigned author and its test session %#", async changed => {
    vi.mocked(query).mockImplementation(async sql => structuredClone(sql.includes("JOIN memberships") ? rows : [{ ...observationAuthor, ...changed }]));
    expect(await getSyntheticTestObservationAuthor(family, "HK")).toBeNull();
    expect(await isSyntheticTestActorForFamily(staff, family)).toBe(false);
  });

  it.each([{ authors: [] }, { authors: [observationAuthor, { ...observationAuthor, id: "another-staff" }] }])("rejects missing or ambiguous assigned-author results %#", async ({ authors }) => {
    vi.mocked(query).mockImplementation(async sql => structuredClone(sql.includes("JOIN memberships") ? rows : authors));
    expect(await getSyntheticTestObservationAuthor(family, "HK")).toBeNull();
  });

  it.each([
    ["NOVA_SYNTHETIC_TEST_FAMILY_IDS", ""],
    ["NOVA_SYNTHETIC_TEST_FAMILY_IDS", "bbbbbbbb-2222-4222-8222-222222222222"],
    ["NOVA_MODE", "demo"], ["NOVA_AUTH_PROVIDER", "local"], ["NOVA_TEST_ACCOUNT_USERNAMES", ""],
  ])("does not query an ordinary family or disabled synthetic deployment when %s changes", async (name, value) => {
    vi.stubEnv(name, value);
    if (name === "NOVA_MODE") vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3000");
    expect(await getSyntheticTestObservationAuthor(family, "HK")).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects a different requested region before reading accounts", async () => {
    expect(await getSyntheticTestObservationAuthor(family, "CN")).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    { members: rows.slice(0, 2) },
    { members: [...rows, { ...rows[2], id: "extra-teacher" }] },
    { members: [{ ...rows[0], disabled: true }, ...rows.slice(1)] },
  ])("requires the current strict three-member family before reading staff %#", async ({ members }) => {
    vi.mocked(query).mockImplementation(async sql => structuredClone(sql.includes("JOIN memberships") ? members : [observationAuthor]));
    expect(await getSyntheticTestObservationAuthor(family, "HK")).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("revalidates the exact staff username allowlist on each request", async () => {
    expect(await getSyntheticTestObservationAuthor(family, "HK")).toEqual({ id: staff.id, role: "teacher", context: "tope_staff" });
    vi.stubEnv("NOVA_TEST_ACCOUNT_USERNAMES", "synthetic.parent,synthetic.student,synthetic.teacher");
    expect(await getSyntheticTestObservationAuthor(family, "HK")).toBeNull();
  });

  it("does not give a normal staff session synthetic identity", async () => {
    expect(await isSyntheticTestActorForFamily({ ...staff, sessionMethod: undefined }, family)).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([{ id: "unassigned-staff" }, { role: "teacher" as const }, { role: "admin" as const }])("requires the exact assigned staff actor and staff role %#", async changed => {
    expect(await isSyntheticTestActorForFamily({ ...staff, ...changed }, family)).toBe(false);
  });

  it("locks the family, its memberships and all author accounts through the provided transaction", async () => {
    const client = { query: vi.fn(async (sql: string, _values: unknown[]) => ({ rows: structuredClone(sql.includes("JOIN memberships") ? rows : [observationAuthor]) })) };
    expect(await isSyntheticTestActorForFamily(staff, family, client as unknown as PoolClient)).toBe(true);
    expect(client.query.mock.calls).toHaveLength(2);
    expect(client.query.mock.calls[0][0]).toContain("FOR SHARE OF f,m,u");
    expect(client.query.mock.calls[1][0]).toContain("FOR SHARE OF f,u");
    expect(client.query.mock.calls[1][1]).toEqual([family, "HK"]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("deployment-scoped synthetic production families", () => {
  it("accepts only a complete eligible test family and its test-session member", async () => {
    expect(await getSyntheticTestFamilyMembers(family, "HK")).toEqual(rows.map(({ id, role }) => ({ id, role })));
    expect(await isSyntheticTestActorForFamily(parent, family)).toBe(true);
  });
  it.each([
    ["NOVA_SYNTHETIC_TEST_FAMILY_IDS", ""],
    ["NOVA_SYNTHETIC_TEST_FAMILY_IDS", "bbbbbbbb-2222-4222-8222-222222222222"],
    ["NOVA_AUTH_PROVIDER", "local"],
    ["NOVA_TEST_ACCOUNT_USERNAMES", ""],
  ])("does not query or admit when %s excludes this request", async (name, value) => {
    vi.stubEnv(name, value);
    expect(await isSyntheticTestActorForFamily(parent, family)).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects malformed configuration instead of treating it as a wildcard", async () => {
    vi.stubEnv("NOVA_SYNTHETIC_TEST_FAMILY_IDS", "*");
    await expect(isSyntheticTestActorForFamily(parent, family)).rejects.toThrow("exact family UUIDs");
  });
  it("rejects another region without reading it", async () => {
    expect(await getSyntheticTestFamilyMembers(family, "CN")).toBeNull(); expect(query).not.toHaveBeenCalled();
  });
  it("does not grant the exception to an ordinary Clerk actor with the same user id", async () => {
    const ordinary = { ...parent, sessionMethod: undefined };
    expect(await isSyntheticTestActorForFamily(ordinary, family)).toBe(false); expect(query).not.toHaveBeenCalled();
  });
  it.each([{ id: "outsider" }, { role: "teacher" as const }, { region: "CN" as const }])("rejects mismatched actor identity %#", async changed => {
    expect(await isSyntheticTestActorForFamily({ ...parent, ...changed }, family)).toBe(false);
  });
  it.each([
    { disabled: true }, { demo: true }, { has_password: false }, { username: "ordinary.parent" },
    { username: "synthetic.parent.extra" }, { user_role: "admin" }, { region: "CN" }, { family_region: "CN" },
  ])("invalidates the whole family when a member is ineligible %#", async changed => {
    vi.mocked(query).mockResolvedValue([{ ...rows[0], ...changed }, ...rows.slice(1)]);
    expect(await getSyntheticTestFamilyMembers(family, "HK")).toBeNull();
  });
  it.each([{ members: rows.slice(0, 2) }, { members: [...rows, { ...rows[0], id: "fourth" }] }, { members: [rows[0], rows[0], rows[2]] }])("rejects incomplete, mixed, duplicate-role or extra memberships %#", async ({ members }) => {
    vi.mocked(query).mockResolvedValue(members);
    expect(await getSyntheticTestFamilyMembers(family, "HK")).toBeNull();
  });
  it("revalidates current account allowlist instead of caching admission", async () => {
    expect(await isSyntheticTestActorForFamily(parent, family)).toBe(true);
    vi.stubEnv("NOVA_TEST_ACCOUNT_USERNAMES", "synthetic.parent,synthetic.student");
    expect(await isSyntheticTestActorForFamily(parent, family)).toBe(false);
  });
  it("locks family membership and user rows when checking inside a write transaction", async () => {
    const client = { query: vi.fn(async (_sql: string) => ({ rows })) };
    expect(await isSyntheticTestActorForFamily(parent, family, client as unknown as PoolClient)).toBe(true);
    expect(client.query.mock.calls[0][0]).toContain("FOR SHARE OF f,m,u");
    expect(query).not.toHaveBeenCalled();
  });
  it("admits an allowlisted assigned staff test session without changing the three family memberships", async () => {
    vi.stubEnv("NOVA_TEST_ACCOUNT_USERNAMES", "synthetic.parent,synthetic.student,synthetic.teacher,synthetic.staff");
    vi.mocked(query).mockImplementation(async sql => structuredClone(sql.includes("JOIN memberships") ? rows : [observationAuthor]));
    expect(await isSyntheticTestActorForFamily(staff, family)).toBe(true);
    expect(await getSyntheticTestFamilyMembers(family, "HK")).toEqual(rows.map(({ id, role }) => ({ id, role })));
  });
});
