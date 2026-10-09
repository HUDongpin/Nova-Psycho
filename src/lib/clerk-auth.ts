import { createHash, randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { z } from "zod";
import type { Actor, Region } from "../domain/types";
import { registrationName, registrationPassword, registrationUsername } from "../domain/registration";
import { getAuthProvider, getClerkConfig } from "./auth-provider";
import { getConfig } from "./config";
import { query, transaction } from "./db";
import { HttpError } from "./http";

export type IdentityState = "signed_out" | "email_unverified" | "profile_required" | "ready";
export interface AuthState {
  user: Actor | null;
  authProvider: "local" | "clerk";
  identityState: IdentityState;
  sessionMethod?: "test";
}
interface ClerkPrincipal {
  subject: string;
  issuer: string;
  sessionId: string;
  region: Region;
}
export interface VerifiedClerkIdentity extends ClerkPrincipal { emailVerified: true }
type UserRow = Actor & { disabled: boolean; demo: boolean };

// Clerk's ordinary session JWTs are short-lived. We deliberately refuse custom
// long-lived templates. Provider-side revocation can therefore leave at most
// 120 seconds (+ SDK clock tolerance) of an already-issued token's lifetime.
// Local logout also records the session digest, so it has no such local window.
export const MAX_CLERK_TOKEN_LIFETIME_SECONDS = 120;
const sessionDigest = (id: string) => createHash("sha256").update(id).digest("hex");
const unauthorized = () => new HttpError(401, "请先登录。", "UNAUTHENTICATED");
const unavailable = () => new HttpError(503, "身份验证服务暂时未能回应，请稍后重试。", "AUTH_PROVIDER_UNAVAILABLE");

function requireClerkMode(): void {
  if (getAuthProvider() !== "clerk") throw new HttpError(409, "当前入口未启用邮箱登录。", "AUTH_PROVIDER_MISMATCH");
}

async function clerkClient() {
  const { createClerkClient } = await import("@clerk/nextjs/server");
  const config = getClerkConfig();
  return createClerkClient({ publishableKey: config.publishableKey, secretKey: config.secretKey });
}

// Cache verification only for this exact Request object. Never cache a local
// user's role/disabled status or reuse an authentication result across requests.
const requestPrincipals = new WeakMap<Request, Promise<ClerkPrincipal | null>>();
async function verifyRequest(request: Request): Promise<ClerkPrincipal | null> {
  const config = getClerkConfig();
  let authenticated;
  try {
    const client = await clerkClient();
    authenticated = await client.authenticateRequest(request, { acceptsToken: "session_token", authorizedParties: config.authorizedParties });
  } catch {
    throw unavailable();
  }
  if (!authenticated.isAuthenticated) return null;
  const auth = authenticated.toAuth();
  if (auth.tokenType !== "session_token" || !auth.userId || !auth.sessionId || !auth.sessionClaims) return null;
  const claims = auth.sessionClaims;
  const now = Date.now() / 1000;
  if (claims.iss !== config.issuer || claims.sub !== auth.userId || claims.sid !== auth.sessionId ||
      !config.authorizedParties.includes(String(claims.azp)) || typeof claims.iat !== "number" || typeof claims.exp !== "number" ||
      !Number.isFinite(claims.iat) || !Number.isFinite(claims.exp) || claims.iat > now + 5 || claims.exp <= now ||
      claims.exp <= claims.iat || claims.exp - claims.iat > MAX_CLERK_TOKEN_LIFETIME_SECONDS || claims.sts === "pending") return null;
  return { subject: auth.userId, issuer: config.issuer, sessionId: auth.sessionId, region: getConfig().region };
}

async function principalOf(request: Request, allowRevoked = false): Promise<ClerkPrincipal | null> {
  requireClerkMode();
  let pending = requestPrincipals.get(request);
  if (!pending) { pending = verifyRequest(request); requestPrincipals.set(request, pending); }
  const principal = await pending;
  if (!principal) return null;
  if (!allowRevoked) {
    const rows = await query("SELECT 1 FROM clerk_session_revocations WHERE issuer=$1 AND session_id_hash=$2 AND region=$3", [principal.issuer, sessionDigest(principal.sessionId), principal.region]);
    if (rows[0]) return null;
  }
  return principal;
}

function actorFrom(row: UserRow): Actor {
  const config = getConfig();
  if (row.disabled || row.region !== config.region || (config.mode !== "demo" && row.demo)) {
    throw new HttpError(403, "账号已撤销或不属于当前服务区域。", "ACCOUNT_REVOKED");
  }
  return { id: row.id, name: row.name, role: row.role, region: row.region };
}

async function mappedUser(principal: ClerkPrincipal): Promise<Actor | null> {
  const rows = await query<UserRow>("SELECT u.id,u.name,u.role,u.region,u.disabled,u.demo FROM external_identities i JOIN users u ON u.id=i.user_id WHERE i.provider='clerk' AND i.issuer=$1 AND i.subject=$2 AND i.region=$3", [principal.issuer, principal.subject, principal.region]);
  return rows[0] ? actorFrom(rows[0]) : null;
}

async function emailIsVerified(principal: ClerkPrincipal): Promise<boolean> {
  let profile;
  try { profile = await (await clerkClient()).users.getUser(principal.subject); }
  catch { throw unavailable(); }
  if (profile.id !== principal.subject || profile.banned) throw new HttpError(403, "账号已撤销，请重新登录。", "ACCOUNT_REVOKED");
  // An arbitrary verified secondary address must not substitute for an
  // unverified primary login address. No email address is copied into Nova.
  return profile.emailAddresses.some(email => email.id === profile.primaryEmailAddressId && email.verification?.status === "verified");
}

export async function clerkAuthStateOf(request: Request): Promise<AuthState> {
  const principal = await principalOf(request);
  if (!principal) return { user: null, authProvider: "clerk", identityState: "signed_out" };
  const user = await mappedUser(principal);
  if (user) return { user, authProvider: "clerk", identityState: "ready" };
  return { user: null, authProvider: "clerk", identityState: await emailIsVerified(principal) ? "profile_required" : "email_unverified" };
}

export async function clerkActorOf(request: Request): Promise<Actor | null> {
  const principal = await principalOf(request);
  // Business APIs do not fetch a Clerk profile. They only accept an identity
  // whose verified email was established during an explicit profile/link flow.
  return principal ? mappedUser(principal) : null;
}

export async function getVerifiedClerkIdentity(request: Request): Promise<VerifiedClerkIdentity> {
  const principal = await principalOf(request);
  if (!principal) throw unauthorized();
  if (!await emailIsVerified(principal)) throw new HttpError(403, "请先完成邮箱验证。", "EMAIL_NOT_VERIFIED");
  return { ...principal, emailVerified: true };
}

function assertVerified(principal: VerifiedClerkIdentity): void {
  requireClerkMode();
  if (principal.emailVerified !== true || principal.issuer !== getClerkConfig().issuer || principal.region !== getConfig().region || !principal.subject || !principal.sessionId) {
    throw unauthorized();
  }
}

async function lockIdentity(client: PoolClient, principal: VerifiedClerkIdentity): Promise<void> {
  // Serialize profile creation and linking even before an identity row exists.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`clerk:${principal.issuer}:${principal.subject}:${principal.region}`]);
}

async function mappedUserInTransaction(client: PoolClient, principal: VerifiedClerkIdentity): Promise<Actor | null> {
  const result = await client.query<UserRow>("SELECT u.id,u.name,u.role,u.region,u.disabled,u.demo FROM external_identities i JOIN users u ON u.id=i.user_id WHERE i.provider='clerk' AND i.issuer=$1 AND i.subject=$2 AND i.region=$3 FOR UPDATE OF u", [principal.issuer, principal.subject, principal.region]);
  return result.rows[0] ? actorFrom(result.rows[0]) : null;
}

async function insertIdentity(client: PoolClient, principal: VerifiedClerkIdentity, userId: string): Promise<void> {
  await client.query("INSERT INTO external_identities(provider,issuer,subject,region,user_id,email_verified_at) VALUES('clerk',$1,$2,$3,$4,now())", [principal.issuer, principal.subject, principal.region, userId]);
}

export async function createClerkUserInTransaction(client: PoolClient, principal: VerifiedClerkIdentity, name: string, role: "parent" | "teacher" | "student"): Promise<Actor> {
  assertVerified(principal);
  const parsedName = registrationName.parse(name);
  const parsedRole = z.enum(["parent", "teacher", "student"]).parse(role);
  await lockIdentity(client, principal);
  const existing = await mappedUserInTransaction(client, principal);
  if (existing) {
    if (existing.role !== parsedRole) throw new HttpError(409, "该账号已登记为其他身份，请使用原有入口。", "ROLE_CONFLICT");
    return existing;
  }
  const actor: Actor = { id: randomUUID(), name: parsedName, role: parsedRole, region: principal.region };
  // Only explicitly seeded showcase accounts receive users.demo=true. Clerk
  // identities remain private even when tested in a synthetic demo deployment.
  await client.query("INSERT INTO users(id,region,username,name,role,password_hash,demo) VALUES($1,$2,NULL,$3,$4,NULL,$5)", [actor.id, actor.region, actor.name, actor.role, false]);
  await insertIdentity(client, principal, actor.id);
  await client.query("INSERT INTO audit_events(region,actor_id,action,entity_id) VALUES($1,$2,'user.profile_created',$3)", [actor.region, actor.id, actor.id]);
  return actor;
}

export async function createClerkProfile(request: Request, input: unknown): Promise<Actor> {
  const data = z.object({ name: registrationName, role: z.enum(["parent", "teacher"]) }).strict().parse(input);
  const principal = await getVerifiedClerkIdentity(request);
  return transaction(client => createClerkUserInTransaction(client, principal, data.name, data.role));
}

export async function linkLegacyIdentity(request: Request, input: unknown): Promise<Actor> {
  const data = z.object({ username: registrationUsername, password: registrationPassword }).strict().parse(input);
  const principal = await getVerifiedClerkIdentity(request);
  // Lazy import keeps local password helpers and external authentication from
  // forming a startup-time module cycle, including local-only deployments.
  const { checkPassword, limitLogin } = await import("./auth");
  await limitLogin(data.username);
  const config = getConfig();
  type LegacyRow = UserRow & QueryResultRow & { password_hash: string | null };
  const candidates = await query<LegacyRow>("SELECT id,name,role,region,disabled,demo,password_hash FROM users WHERE username=$1 AND region=$2", [data.username, config.region]);
  const candidate = candidates[0];
  const valid = await checkPassword(data.password, candidate?.password_hash ?? null);
  if (!candidate || !valid || candidate.disabled || (config.mode !== "demo" && candidate.demo)) throw new HttpError(401, "账号或密码不正确。", "INVALID_CREDENTIALS");
  return transaction(async client => {
    await lockIdentity(client, principal);
    const existing = await mappedUserInTransaction(client, principal);
    if (existing && existing.id !== candidate.id) throw new HttpError(409, "此邮箱账号已经关联其他账户。", "IDENTITY_ALREADY_LINKED");
    // Same user lock order as password recovery. Recheck the password digest in
    // a new statement snapshot after waiting, so recovery wins over stale proof.
    await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [candidate.id]);
    const current = await client.query<LegacyRow>("SELECT id,name,role,region,disabled,demo,password_hash FROM users WHERE id=$1", [candidate.id]);
    const row = current.rows[0];
    if (!row || row.password_hash !== candidate.password_hash || row.disabled || row.region !== principal.region || (config.mode !== "demo" && row.demo)) throw new HttpError(401, "账号或密码不正确。", "INVALID_CREDENTIALS");
    const links = await client.query("SELECT issuer,subject FROM external_identities WHERE user_id=$1 AND provider='clerk'", [row.id]);
    if (links.rows.some(link => link.issuer !== principal.issuer || link.subject !== principal.subject)) throw new HttpError(409, "原账户已关联其他邮箱账号。", "ACCOUNT_ALREADY_LINKED");
    if (!existing) {
      await insertIdentity(client, principal, row.id);
      await client.query("DELETE FROM sessions WHERE user_id=$1", [row.id]);
      await client.query("INSERT INTO audit_events(region,actor_id,action,entity_id) VALUES($1,$2,'user.identity_linked',$3)", [row.region, row.id, row.id]);
    }
    return actorFrom(row);
  });
}

export async function signOutClerk(request: Request): Promise<void> {
  const principal = await principalOf(request, true);
  if (!principal) return;
  // Write this first: a provider outage must never keep the signed JWT usable
  // in this deployment after a successful local sign-out request.
  await query("INSERT INTO clerk_session_revocations(issuer,session_id_hash,region) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [principal.issuer, sessionDigest(principal.sessionId), principal.region]);
  try { await (await clerkClient()).sessions.revokeSession(principal.sessionId); }
  catch (error) {
    // The SDK's API error exposes an HTTP status. Missing/gone is the desired
    // end state for this exact, already-verified session, including logout retry.
    // Do not inspect or log provider message text or error metadata.
    if (typeof error === "object" && error !== null && "status" in error && (error.status === 404 || error.status === 410)) return;
    throw unavailable();
  }
}
