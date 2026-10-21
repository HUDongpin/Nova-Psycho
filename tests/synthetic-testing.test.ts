import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { Actor } from "../src/domain/types";
vi.mock("../src/lib/db", () => ({ query: vi.fn() }));
import { query } from "../src/lib/db";
import { getSyntheticTestFamilyMembers, isSyntheticTestActorForFamily } from "../src/lib/synthetic-testing";
const family = "aaaaaaaa-1111-4111-8111-111111111111";
const parent: Actor = { id: "parent", role: "parent", name: "Synthetic parent", region: "HK", sessionMethod: "test" };
const rows = ["parent", "student", "teacher"].map(role => ({ id: role, role, user_role: role, username: `synthetic.${role}`, region: "HK", family_region: "HK", disabled: false, demo: false, has_password: true }));
beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ NOVA_REGION: "HK", NOVA_MODE: "service", NOVA_AUTH_PROVIDER: "clerk", NOVA_TEST_ACCOUNT_USERNAMES: "synthetic.parent,synthetic.student,synthetic.teacher", NOVA_SYNTHETIC_TEST_FAMILY_IDS: family, DATABASE_URL: "postgresql://synthetic.invalid/nova", NOVA_PUBLIC_URL: "https://synthetic.example", NOVA_REPORT_STORAGE: "filesystem", NOVA_REPORT_DIR: "work/synthetic-tests", NOVA_REPORT_KEY: "0".repeat(64) })) vi.stubEnv(name, value);
  vi.mocked(query).mockResolvedValue(structuredClone(rows));
});
afterEach(() => vi.unstubAllEnvs());

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
});
