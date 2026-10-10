import { scryptSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import type { PoolClient } from "pg";

const clerk = vi.hoisted(() => ({ actor: vi.fn(), state: vi.fn() }));
vi.mock("../src/lib/clerk-auth", () => ({ clerkActorOf: clerk.actor, clerkAuthStateOf: clerk.state }));
vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
import { query, transaction } from "../src/lib/db";
import { getTestAccountUsernames, hasTestAccountLogin } from "../src/lib/auth-provider";
import { actorOf, authStateOf, endTestSession, hashToken, hasTestSession, setTestPasswordSession, testSessionActorOf } from "../src/lib/auth";

const actor = { id: "11111111-2222-4333-8444-555555555555", name: "Synthetic teacher", role: "teacher" as const, region: "HK" as const };
const password = "synthetic-test-password";
const digest = `synthetic-salt:${scryptSync(password, "synthetic-salt", 64).toString("hex")}`;
const token = "a".repeat(96);
const testCookie = `nova_hk_test_session=${token}`;
const request = (cookie = testCookie) => new Request("https://synthetic.example/api/session", { headers: { cookie } });
const client = { query: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NOVA_AUTH_PROVIDER", "clerk"); vi.stubEnv("NOVA_TEST_ACCOUNT_USERNAMES", "synthetic.teacher");
  vi.stubEnv("NOVA_REGION", "HK"); vi.stubEnv("NOVA_MODE", "service");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova"); vi.stubEnv("NOVA_PUBLIC_URL", "https://synthetic.example");
  vi.stubEnv("NOVA_REPORT_DIR", "work/test-private"); vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
  clerk.actor.mockResolvedValue(null);
  clerk.state.mockResolvedValue({ user: null, authProvider: "clerk", identityState: "signed_out" });
  vi.mocked(query).mockResolvedValue([]);
  client.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("FOR UPDATE") ? [{ id: actor.id }] : sql.startsWith("SELECT") ? [{ password_hash: digest }] : [] }));
  vi.mocked(transaction).mockImplementation(async fn => fn(client as unknown as PoolClient));
});
afterEach(() => vi.unstubAllEnvs());

describe("explicit test-account configuration", () => {
  it("is disabled by default and in local mode", () => {
    vi.stubEnv("NOVA_TEST_ACCOUNT_USERNAMES", undefined); expect(hasTestAccountLogin()).toBe(false);
    vi.stubEnv("NOVA_TEST_ACCOUNT_USERNAMES", "synthetic.teacher"); vi.stubEnv("NOVA_AUTH_PROVIDER", "local"); expect(hasTestAccountLogin()).toBe(false);
  });
  it("normalizes and deduplicates complete usernames without accepting patterns", () => {
    vi.stubEnv("NOVA_TEST_ACCOUNT_USERNAMES", " Synthetic.Teacher,synthetic.parent,synthetic.teacher ");
    expect(getTestAccountUsernames()).toEqual(["synthetic.teacher", "synthetic.parent"]);
    vi.stubEnv("NOVA_TEST_ACCOUNT_USERNAMES", "synthetic.*");
    expect(() => getTestAccountUsernames()).toThrow("NOVA_TEST_ACCOUNT_USERNAMES");
  });
});

describe("test password sessions alongside Clerk", () => {
  it("commits a password-proven session with a separate secure cookie and digest namespace", async () => {
    vi.mocked(query).mockResolvedValueOnce([{ id: actor.id, password_hash: digest }]);
    const response = NextResponse.json({ ok: true });
    await setTestPasswordSession(response, "synthetic.teacher", password);
    const cookie = response.cookies.get("nova_hk_test_session")!;
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 43200 });
    expect(response.cookies.get("nova_hk_session")).toBeUndefined();
    expect(client.query.mock.calls[0][0]).toContain("FOR UPDATE");
    expect(client.query.mock.calls[1][0]).toContain("username=ANY($4::text[])");
    expect(client.query.mock.calls[1][1]).toEqual([actor.id, "HK", false, ["synthetic.teacher"]]);
    expect(client.query.mock.calls[2][1]).toEqual([hashToken(`test:${cookie.value}`), actor.id, "HK"]);
    expect(client.query.mock.calls[2][1]).not.toContain(hashToken(cookie.value));
  });
  it.each(["ordinary.teacher", "synthetic.teacher.extra"])("rejects non-allowlisted %s with the same credential error", async username => {
    const response = NextResponse.json({});
    await expect(setTestPasswordSession(response, username, password)).rejects.toMatchObject({ status: 401, code: "INVALID_CREDENTIALS" });
    expect(query).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled(); expect(response.headers.get("set-cookie")).toBeNull();
  });
  it("rejects an incorrect password before taking the user lock", async () => {
    vi.mocked(query).mockResolvedValueOnce([{ id: actor.id, password_hash: digest }]);
    await expect(setTestPasswordSession(NextResponse.json({}), "synthetic.teacher", "incorrect")).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(transaction).not.toHaveBeenCalled();
  });
  it("enforces region, disabled, and service-mode demo restrictions in both credential reads", async () => {
    vi.mocked(query).mockResolvedValueOnce([{ id: actor.id, password_hash: digest }]);
    await setTestPasswordSession(NextResponse.json({}), "synthetic.teacher", password);
    for (const sql of [vi.mocked(query).mock.calls[0][0], client.query.mock.calls[1][0]]) {
      expect(sql).toContain("region=$2"); expect(sql).toContain("NOT disabled"); expect(sql).toContain("OR NOT demo"); expect(sql).toContain("username=ANY($4::text[])");
    }
  });
  it.each([{ rows: [] }, { rows: [{ password_hash: "changed-during-lock" }] }])("rechecks credentials and account eligibility after the user lock %#", async current => {
    vi.mocked(query).mockResolvedValueOnce([{ id: actor.id, password_hash: digest }]);
    client.query.mockResolvedValueOnce({ rows: [{ id: actor.id }] }).mockResolvedValueOnce(current);
    const response = NextResponse.json({});
    await expect(setTestPasswordSession(response, "synthetic.teacher", password)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(response.headers.get("set-cookie")).toBeNull(); expect(client.query).toHaveBeenCalledTimes(2);
  });
  it("does not issue cookies on a failed transaction", async () => {
    vi.mocked(query).mockResolvedValueOnce([{ id: actor.id, password_hash: digest }]);
    vi.mocked(transaction).mockRejectedValueOnce(new Error("Synthetic commit failure"));
    const response = NextResponse.json({});
    await expect(setTestPasswordSession(response, "synthetic.teacher", password)).rejects.toThrow("Synthetic commit failure");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
  it("refuses the dedicated endpoint when the feature is disabled", async () => {
    vi.stubEnv("NOVA_TEST_ACCOUNT_USERNAMES", "");
    await expect(setTestPasswordSession(NextResponse.json({}), "synthetic.teacher", password)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(query).not.toHaveBeenCalled();
  });
});

describe("test sessions remain separately revocable", () => {
  it("resolves only a scoped digest and revalidates the allowlist and account on every request", async () => {
    vi.mocked(query).mockResolvedValue([actor]);
    await expect(actorOf(request())).resolves.toEqual(actor);
    await expect(authStateOf(request())).resolves.toEqual({ user: actor, authProvider: "clerk", identityState: "ready", sessionMethod: "test" });
    const [sql, values] = vi.mocked(query).mock.calls[0];
    expect(values).toEqual([hashToken(`test:${token}`), "HK", false, ["synthetic.teacher"]]);
    for (const condition of ["s.region=$2", "u.region=$2", "s.expires_at>now()", "NOT u.disabled", "OR NOT u.demo", "u.username=ANY($4::text[])", "u.password_hash IS NOT NULL"]) expect(sql).toContain(condition);
    expect(query).toHaveBeenCalledTimes(2); expect(clerk.actor).not.toHaveBeenCalled(); expect(clerk.state).not.toHaveBeenCalled();
  });
  it("immediately stops resolving sessions when test login is disabled", async () => {
    vi.stubEnv("NOVA_TEST_ACCOUNT_USERNAMES", "");
    await expect(testSessionActorOf(request())).resolves.toBeNull(); expect(query).not.toHaveBeenCalled();
    await expect(authStateOf(request())).resolves.toMatchObject({ user: null, identityState: "signed_out", sessionMethod: "test" });
    expect(clerk.state).not.toHaveBeenCalled();
  });
  it.each(["expired", "allowlist removed"])("does not switch an %s test session into a coexisting Clerk identity", async reason => {
    clerk.actor.mockResolvedValue({ ...actor, id: "another-account" });
    clerk.state.mockResolvedValue({ user: { ...actor, id: "another-account" }, authProvider: "clerk", identityState: "ready" });
    if (reason === "allowlist removed") vi.stubEnv("NOVA_TEST_ACCOUNT_USERNAMES", "");
    await expect(actorOf(request(), false)).resolves.toBeNull();
    await expect(actorOf(request())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(authStateOf(request())).resolves.toMatchObject({ user: null, identityState: "signed_out", sessionMethod: "test" });
    expect(clerk.actor).not.toHaveBeenCalled(); expect(clerk.state).not.toHaveBeenCalled();
  });
  it("uses the current allowlist when an account has been removed", async () => {
    vi.stubEnv("NOVA_TEST_ACCOUNT_USERNAMES", "synthetic.other");
    await expect(testSessionActorOf(request())).resolves.toBeNull();
    expect(vi.mocked(query).mock.calls[0][1]).toEqual([hashToken(`test:${token}`), "HK", false, ["synthetic.other"]]);
  });
  it("ignores old local cookies and never revives old local sessions", async () => {
    await expect(authStateOf(request(`nova_hk_session=${token}`))).resolves.toMatchObject({ user: null, identityState: "signed_out" });
    expect(query).not.toHaveBeenCalled();
    await expect(testSessionActorOf(request())).resolves.toBeNull();
    expect(vi.mocked(query).mock.calls[0][1]?.[0]).not.toBe(hashToken(token));
  });
  it("does not convert a Clerk verification failure into a local session", async () => {
    clerk.actor.mockRejectedValueOnce(new Error("Synthetic Clerk unavailable"));
    await expect(actorOf(request(`nova_hk_session=${token}`))).rejects.toThrow("Synthetic Clerk unavailable");
    expect(query).not.toHaveBeenCalled();
  });
  it("does not accept malformed or other-region test cookies", async () => {
    for (const cookie of ["nova_hk_test_session=short", `nova_cn_test_session=${token}`, `nova_hk_test_session=${"z".repeat(96)}`]) {
      expect(hasTestSession(request(cookie))).toBe(false);
      await expect(testSessionActorOf(request(cookie))).resolves.toBeNull();
    }
    expect(query).not.toHaveBeenCalled();
  });
  it("removes a test session even after the allowlist is disabled and clears only its cookie", async () => {
    vi.stubEnv("NOVA_TEST_ACCOUNT_USERNAMES", "");
    const response = NextResponse.json({});
    expect(hasTestSession(request())).toBe(true);
    await endTestSession(request(), response);
    expect(query).toHaveBeenCalledWith("DELETE FROM sessions WHERE token_hash=$1 AND region=$2", [hashToken(`test:${token}`), "HK"]);
    expect(response.cookies.get("nova_hk_test_session")).toMatchObject({ value: "", maxAge: 0, secure: true, httpOnly: true });
    expect(response.cookies.get("nova_hk_session")).toBeUndefined();
  });
});
