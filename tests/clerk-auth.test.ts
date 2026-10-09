import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { Actor } from "../src/domain/types";
import { scryptSync } from "node:crypto";

const sdk = vi.hoisted(() => ({ authenticateRequest: vi.fn(), getUser: vi.fn(), revokeSession: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({ createClerkClient: vi.fn(() => ({ authenticateRequest: sdk.authenticateRequest, users: { getUser: sdk.getUser }, sessions: { revokeSession: sdk.revokeSession } })) }));
vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));

import { query, transaction } from "../src/lib/db";
import { actorOf, authStateOf, setPasswordSession } from "../src/lib/auth";
import { createClerkProfile, createClerkUserInTransaction, getVerifiedClerkIdentity, linkLegacyIdentity, signOutClerk, type VerifiedClerkIdentity } from "../src/lib/clerk-auth";

const issuer = "https://synthetic.clerk.accounts.dev";
const local: Actor & { disabled: boolean; demo: boolean } = { id: "11111111-2222-4333-8444-555555555555", name: "合成老师", role: "teacher", region: "CN", disabled: false, demo: false };
const identity: VerifiedClerkIdentity = { subject: "user_synthetic", issuer, sessionId: "sess_synthetic", region: "CN", emailVerified: true };
const request = () => new Request("http://127.0.0.1:3100/api/session", { headers: { cookie: `nova_cn_session=${"a".repeat(96)}` } });
const client = { query: vi.fn() };
const syntheticPassword = "synthetic-long-password";
const syntheticDigest = `synthetic-salt:${scryptSync(syntheticPassword, "synthetic-salt", 64).toString("hex")}`;
let mapped: typeof local | null;
let revoked: boolean;
let legacy: (typeof local & { password_hash: string | null }) | null;
let currentLegacy: (typeof local & { password_hash: string | null }) | null;
let links: { issuer: string; subject: string }[];

function setAuthentication(over: Record<string, unknown> = {}, authOver: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  sdk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => ({ tokenType: "session_token", userId: identity.subject, sessionId: identity.sessionId, sessionClaims: { iss: issuer, azp: "http://127.0.0.1:3100", sub: identity.subject, sid: identity.sessionId, iat: now, exp: now + 60, ...over }, ...authOver }),
  });
}

beforeEach(() => {
  vi.stubEnv("NOVA_AUTH_PROVIDER", "clerk"); vi.stubEnv("NOVA_REGION", "CN"); vi.stubEnv("NOVA_MODE", "demo");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova"); vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR", "work/test-private"); vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
  vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", `pk_test_${Buffer.from("synthetic.clerk.accounts.dev$").toString("base64")}`);
  vi.stubEnv("CLERK_SECRET_KEY", "sk_test_synthetic_not_a_real_key"); vi.stubEnv("NOVA_CLERK_ISSUER", undefined);
  vi.clearAllMocks();
  mapped = { ...local }; revoked = false; legacy = null; currentLegacy = null; links = [];
  setAuthentication();
  sdk.getUser.mockResolvedValue({ id: identity.subject, banned: false, primaryEmailAddressId: "email_primary", emailAddresses: [{ id: "email_primary", verification: { status: "verified" } }] });
  sdk.revokeSession.mockResolvedValue({});
  vi.mocked(query).mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT 1 FROM clerk_session_revocations")) return revoked ? [{ exists: true }] : [];
    if (sql.includes("INSERT INTO clerk_session_revocations")) { revoked = true; return []; }
    if (sql.includes("FROM external_identities i")) return mapped ? [mapped] : [];
    if (sql.includes("FROM users WHERE username=")) return legacy ? [legacy] : [];
    if (sql.includes("INSERT INTO login_attempts")) return [{ attempts: 1 }];
    throw new Error("Unexpected synthetic database read");
  });
  client.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM external_identities i")) return { rows: mapped ? [mapped] : [] };
    if (sql.includes("SELECT issuer,subject FROM external_identities")) return { rows: links };
    if (sql.includes("password_hash FROM users WHERE id=")) return { rows: currentLegacy ? [currentLegacy] : [] };
    return { rows: [] };
  });
  vi.mocked(transaction).mockImplementation(async fn => fn(client as unknown as PoolClient));
});
afterEach(() => vi.unstubAllEnvs());

describe("Clerk authentication and local authorization boundary", () => {
  it("uses only session tokens and this deployment's authorized origin", async () => {
    await expect(actorOf(request())).resolves.toEqual({ id: local.id, name: local.name, role: local.role, region: local.region });
    expect(sdk.authenticateRequest).toHaveBeenCalledWith(expect.any(Request), { acceptsToken: "session_token", authorizedParties: ["http://127.0.0.1:3100"] });
    expect(sdk.getUser).not.toHaveBeenCalled();
  });
  it("does not fall back to a valid-looking legacy cookie when Clerk is signed out", async () => {
    sdk.authenticateRequest.mockResolvedValue({ isAuthenticated: false });
    await expect(authStateOf(request())).resolves.toMatchObject({ user: null, authProvider: "clerk", identityState: "signed_out" });
    await expect(actorOf(request())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(query).not.toHaveBeenCalled();
  });
  it.each([
    { iss: "https://other.clerk.accounts.dev" }, { azp: "https://other.invalid" }, { azp: undefined },
    { sub: "user_other" }, { sid: "sess_other" }, { sts: "pending" },
    { iat: undefined }, { exp: undefined }, { iat: Number.NaN }, { exp: Number.POSITIVE_INFINITY },
  ])("rejects mismatched or incomplete verified claims %#", async claims => {
    setAuthentication(claims);
    await expect(actorOf(request())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects machine tokens even if an SDK result reports authentication", async () => {
    setAuthentication({}, { tokenType: "api_key" });
    await expect(actorOf(request())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
  it("refuses expired, future, and longer-than-120-second tokens", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const claims of [{ iat: now - 120, exp: now - 1 }, { iat: now + 10, exp: now + 70 }, { iat: now, exp: now + 121 }]) {
      setAuthentication(claims);
      await expect(actorOf(request())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    }
    expect(query).not.toHaveBeenCalled();
  });
  it("refuses a locally revoked session even while its JWT is valid", async () => {
    revoked = true;
    await expect(actorOf(request())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(sdk.getUser).not.toHaveBeenCalled();
  });
  it.each([{ disabled: true }, { region: "HK" as const }])("rechecks the local account on every request %#", async changes => {
    await actorOf(request());
    mapped = { ...local, ...changes };
    await expect(actorOf(request())).rejects.toMatchObject({ code: "ACCOUNT_REVOKED" });
    expect(sdk.getUser).not.toHaveBeenCalled();
  });
  it("refuses a demo account when the deployment is in service mode", async () => {
    vi.stubEnv("NOVA_MODE", "service"); vi.stubEnv("NOVA_PUBLIC_URL", "https://synthetic.invalid");
    mapped = { ...local, demo: true }; setAuthentication({ azp: "https://synthetic.invalid" });
    await expect(actorOf(request())).rejects.toMatchObject({ code: "ACCOUNT_REVOKED" });
  });
  it("keeps mapped session/bootstrap reads free of user-profile API requests", async () => {
    await expect(authStateOf(request())).resolves.toMatchObject({ identityState: "ready" });
    expect(sdk.getUser).not.toHaveBeenCalled();
  });
  it("reports profile_required for an unmapped verified email", async () => {
    mapped = null;
    await expect(authStateOf(request())).resolves.toEqual({ user: null, authProvider: "clerk", identityState: "profile_required" });
    expect(sdk.getUser).toHaveBeenCalledTimes(1);
    expect(transaction).not.toHaveBeenCalled();
  });
  it("does not treat a verified secondary email as verified primary email", async () => {
    mapped = null;
    sdk.getUser.mockResolvedValue({ id: identity.subject, primaryEmailAddressId: "unverified", emailAddresses: [{ id: "unverified", verification: { status: "unverified" } }, { id: "secondary", verification: { status: "verified" } }] });
    await expect(authStateOf(request())).resolves.toMatchObject({ identityState: "email_unverified" });
    await expect(getVerifiedClerkIdentity(request())).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(transaction).not.toHaveBeenCalled();
  });
  it("does not leak a provider exception through its stable unavailable error", async () => {
    sdk.authenticateRequest.mockRejectedValue(new Error("sensitive synthetic provider response"));
    await expect(actorOf(request())).rejects.toMatchObject({ code: "AUTH_PROVIDER_UNAVAILABLE", status: 503 });
    await expect(actorOf(request())).rejects.not.toThrow("sensitive synthetic provider response");
  });
  it("rejects a provider profile that belongs to someone else or is banned", async () => {
    for (const profile of [{ id: "other", banned: false }, { id: identity.subject, banned: true }]) {
      sdk.getUser.mockResolvedValue(profile);
      await expect(getVerifiedClerkIdentity(request())).rejects.toMatchObject({ code: "ACCOUNT_REVOKED" });
    }
  });
  it("does not issue legacy password sessions in Clerk mode", async () => {
    await expect(setPasswordSession({} as never, "synthetic", "synthetic-password")).rejects.toMatchObject({ code: "AUTH_PROVIDER_MISMATCH" });
  });
});

describe("Clerk profile creation and transaction helper", () => {
  it("creates a standalone teacher identity without a family or password", async () => {
    mapped = null;
    const actor = await createClerkProfile(request(), { name: " 合成老师 ", role: "teacher" });
    expect(actor).toMatchObject({ name: "合成老师", role: "teacher", region: "CN" });
    const calls = client.query.mock.calls.map(([sql]) => String(sql));
    expect(calls.findIndex(sql => sql.includes("pg_advisory_xact_lock"))).toBeLessThan(calls.findIndex(sql => sql.includes("INSERT INTO users")));
    expect(calls.some(sql => sql.includes("INSERT INTO families") || sql.includes("INSERT INTO memberships"))).toBe(false);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("NULL,$3,$4,NULL"), [actor.id, "CN", "合成老师", "teacher", false]);
  });
  it("replays a same-role profile without changing identity or duplicating records", async () => {
    await expect(createClerkProfile(request(), { name: "New name ignored", role: "teacher" })).resolves.toMatchObject({ id: local.id, name: local.name });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO"))).toBe(false);
  });
  it("does not change roles during profile replay", async () => {
    await expect(createClerkProfile(request(), { name: "Synthetic", role: "parent" })).rejects.toMatchObject({ code: "ROLE_CONFLICT" });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE users"))).toBe(false);
  });
  it.each(["student", "staff", "admin"])("does not permit independent %s registration", async role => {
    await expect(createClerkProfile(request(), { name: "Synthetic", role })).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
  it("allows a student only through the explicit transaction helper", async () => {
    mapped = null;
    const actor=await createClerkUserInTransaction(client as unknown as PoolClient, identity, "Synthetic student", "student");
    expect(actor).toMatchObject({ role: "student" });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO users"), [actor.id, "CN", "Synthetic student", "student", false]);
  });
  it("rechecks disabled/region under the transaction lock", async () => {
    mapped = { ...local, disabled: true };
    await expect(createClerkUserInTransaction(client as unknown as PoolClient, identity, "Synthetic", "teacher")).rejects.toMatchObject({ code: "ACCOUNT_REVOKED" });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE OF u"), expect.any(Array));
  });
  it("refuses another region's principal before creating anything", async () => {
    await expect(createClerkUserInTransaction(client as unknown as PoolClient, { ...identity, region: "HK" }, "Synthetic", "teacher")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe("legacy identity linking proves both identities", () => {
  beforeEach(() => {
    mapped = null;
    legacy = { ...local, password_hash: syntheticDigest };
    currentLegacy = { ...legacy };
  });
  const credentials = { username: "synthetic.teacher", password: syntheticPassword };
  it("preserves the original UUID and role and retires old local sessions", async () => {
    const actor = await linkLegacyIdentity(request(), credentials);
    expect(actor).toMatchObject({ id: local.id, role: local.role });
    expect(client.query).toHaveBeenCalledWith("DELETE FROM sessions WHERE user_id=$1", [local.id]);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO users"))).toBe(false);
  });
  it("rejects wrong credentials without disclosing whether the username exists", async () => {
    legacy = null;
    await expect(linkLegacyIdentity(request(), credentials)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(transaction).not.toHaveBeenCalled();
  });
  it("rejects a password reset that occurred while waiting for the user lock", async () => {
    currentLegacy = { ...legacy!, password_hash: "synthetic-digest-after" };
    await expect(linkLegacyIdentity(request(), credentials)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO external_identities"))).toBe(false);
  });
  it("rejects an account disabled after preliminary password verification", async () => {
    currentLegacy = { ...legacy!, disabled: true };
    await expect(linkLegacyIdentity(request(), credentials)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });
  it("never moves a Clerk identity already mapped to a different local UUID", async () => {
    mapped = { ...local, id: "22222222-2222-4333-8444-555555555555" };
    await expect(linkLegacyIdentity(request(), credentials)).rejects.toMatchObject({ code: "IDENTITY_ALREADY_LINKED" });
  });
  it("never steals a local account already linked to another Clerk subject", async () => {
    links = [{ issuer, subject: "user_other" }];
    await expect(linkLegacyIdentity(request(), credentials)).rejects.toMatchObject({ code: "ACCOUNT_ALREADY_LINKED" });
  });
  it("replays an already completed link without duplicating it", async () => {
    mapped = { ...local }; links = [{ issuer, subject: identity.subject }];
    await expect(linkLegacyIdentity(request(), credentials)).resolves.toMatchObject({ id: local.id });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO external_identities"))).toBe(false);
  });
});

describe("Clerk sign-out", () => {
  it("stores only the session digest before revoking the provider session", async () => {
    await signOutClerk(request());
    const insertion = vi.mocked(query).mock.calls.find(([sql]) => String(sql).includes("INSERT INTO clerk_session_revocations"));
    expect(insertion?.[1]).toEqual([issuer, expect.stringMatching(/^[a-f0-9]{64}$/), "CN"]);
    expect(insertion?.[1]).not.toContain(identity.sessionId);
    expect(sdk.revokeSession).toHaveBeenCalledWith(identity.sessionId);
    expect(vi.mocked(query).mock.invocationCallOrder[0]).toBeLessThan(sdk.revokeSession.mock.invocationCallOrder[0]);
    await expect(actorOf(request())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
  it("denies the session locally even if the remote revoke call fails", async () => {
    sdk.revokeSession.mockRejectedValue(new Error("synthetic outage"));
    await expect(signOutClerk(request())).rejects.toMatchObject({ code: "AUTH_PROVIDER_UNAVAILABLE" });
    await expect(actorOf(request())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
  it("can retry the provider revoke for an already locally revoked session", async () => {
    revoked = true;
    await signOutClerk(request());
    expect(sdk.revokeSession).toHaveBeenCalledTimes(1);
  });
  it.each([404, 410])("treats remote missing/gone status %s as successful idempotent logout", async status => {
    revoked = true;
    sdk.revokeSession.mockRejectedValue({ status, errors: [{ code: "resource_not_found" }] });
    await expect(signOutClerk(request())).resolves.toBeUndefined();
    await expect(actorOf(request())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
  it("does not swallow provider authorization failures", async () => {
    sdk.revokeSession.mockRejectedValue({ status: 403 });
    await expect(signOutClerk(request())).rejects.toMatchObject({ code: "AUTH_PROVIDER_UNAVAILABLE" });
  });
});
