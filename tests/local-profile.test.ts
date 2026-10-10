import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
import { query, transaction } from "../src/lib/db";
import { checkPassword, createLocalProfile } from "../src/lib/auth";

const client = { query: vi.fn() };
const profile = { name: "合成教师", role: "teacher", username: "Synthetic.Teacher", password: "synthetic-long-password" };
beforeEach(() => {
  vi.stubEnv("NOVA_AUTH_PROVIDER", "local"); vi.stubEnv("NOVA_REGION", "CN"); vi.stubEnv("NOVA_MODE", "demo");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova"); vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR", "work/test-private"); vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
  vi.clearAllMocks();
  vi.mocked(query).mockResolvedValue([{ attempts: 1 }]);
  client.query.mockResolvedValue({ rows: [] });
  vi.mocked(transaction).mockImplementation(async fn => fn(client as unknown as PoolClient));
});
afterEach(() => vi.unstubAllEnvs());

describe("standalone local profile registration", () => {
  it("creates a teacher without a family code and stores a verifiable password digest", async () => {
    const result = await createLocalProfile(profile);
    expect(result).toMatchObject({ name: profile.name, role: "teacher", region: "CN" });
    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO users"));
    expect(insert?.[1]).toEqual([result.id, "CN", "synthetic.teacher", profile.name, "teacher", expect.any(String), false]);
    const digest = insert?.[1][5] as string;
    expect(digest).not.toContain(profile.password);
    await expect(checkPassword(profile.password, digest)).resolves.toBe(true);
    expect(client.query.mock.calls.some(([sql]) => /INSERT INTO (families|memberships|sessions)/.test(String(sql)))).toBe(false);
  });
  it.each(["parent", "teacher"])("does not grant public demo-login eligibility to a registered %s in demo mode", async role => {
    const result = await createLocalProfile({ ...profile, role });
    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO users"));
    // Both public demo enumeration and /auth/demo require users.demo=true.
    // Deployment-level synthetic-data classification must not set that flag.
    expect(insert?.[0]).toContain("password_hash,demo");
    expect(insert?.[1][6]).toBe(false);
    expect(insert?.[1][0]).toBe(result.id);
  });
  it.each(["admin", "staff", "student"])("refuses autonomous %s registration before querying", async role => {
    await expect(createLocalProfile({ ...profile, role })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
  it("refuses unknown fields rather than trusting a client-supplied region or id", async () => {
    await expect(createLocalProfile({ ...profile, region: "HK" })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it("reports a duplicate username with a stable field-specific error", async () => {
    client.query.mockRejectedValue(Object.assign(new Error("synthetic private constraint detail"), { code: "23505", constraint: "users_username_key" }));
    await expect(createLocalProfile(profile)).rejects.toMatchObject({ status: 409, code: "USERNAME_TAKEN", field: "username" });
  });
  it("rate limits new registrations before password work and insertion", async () => {
    vi.mocked(query).mockResolvedValue([{ attempts: 301 }]);
    await expect(createLocalProfile(profile)).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });
    expect(transaction).not.toHaveBeenCalled();
  });
  it("disallows local profile creation while Clerk owns authentication", async () => {
    vi.stubEnv("NOVA_AUTH_PROVIDER", "clerk");
    await expect(createLocalProfile(profile)).rejects.toMatchObject({ code: "AUTH_PROVIDER_MISMATCH" });
    expect(query).not.toHaveBeenCalled();
  });
});
