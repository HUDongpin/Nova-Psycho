import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { Actor, RespondentRole } from "../src/domain/types";
import type { VerifiedClerkIdentity } from "../src/lib/clerk-auth";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
import { query, transaction } from "../src/lib/db";
import { acceptClerkInvitation, acceptInvitationForActor } from "../src/lib/families";

const FAMILY_ID = "11111111-2222-4333-8444-555555555555";
const TOKEN = "a".repeat(64);
const issuer = "https://synthetic.clerk.accounts.dev";
const principal: VerifiedClerkIdentity = { subject: "user_synthetic", issuer, sessionId: "sess_synthetic", region: "CN", emailVerified: true };
let user: (Actor & { disabled: boolean; demo: boolean }) | null;
let linked: boolean;
let identities: number;
let invite: { family_id: string; role: RespondentRole; used_at: string | null; accepted_by: string | null; expires_at: Date };
let members: { user_id: string; role: RespondentRole }[];
let tasks: { id: string }[];
let admissionAudits: number;
const client = { query: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NOVA_AUTH_PROVIDER", "clerk"); vi.stubEnv("NOVA_REGION", "CN"); vi.stubEnv("NOVA_MODE", "demo");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova"); vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR", "work/test-private"); vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
  vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", `pk_test_${Buffer.from("synthetic.clerk.accounts.dev$").toString("base64")}`);
  vi.stubEnv("CLERK_SECRET_KEY", "sk_test_synthetic_not_real"); vi.stubEnv("NOVA_CLERK_ISSUER", undefined);
  user = null; linked = false; identities = 0; members = []; tasks = []; admissionAudits = 0;
  invite = { family_id: FAMILY_ID, role: "student", used_at: null, accepted_by: null, expires_at: new Date(Date.now() + 3600000) };
  vi.mocked(query).mockImplementation(async () => { throw new Error("Unexpected nontransactional query"); });
  client.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
    if (sql.includes("SELECT family_id FROM invitations")) return { rows: [{ family_id: FAMILY_ID }] };
    if (sql.includes("FROM families WHERE id=$1")) return { rows: [{ id: FAMILY_ID, region: "CN", birth_date: "2014-01-01", join_code: "TOPE-A2B3C4D5" }] };
    if (sql.includes("FOR UPDATE OF i")) return { rows: [invite] };
    if (sql.includes("FROM consents")) return { rows: [{ scopes: ["assessment", "sensitive_data", "parent_report"] }] };
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("FROM external_identities i")) return { rows: linked && user ? [user] : [] };
    if (sql.startsWith("INSERT INTO users")) {
      user = { id: String(values[0]), region: "CN", name: String(values[2]), role: values[3] as RespondentRole, disabled: false, demo: false };
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO external_identities")) { linked = true; identities++; return { rows: [] }; }
    if (sql.includes("FROM users WHERE id=$1")) return { rows: user?.id === values[0] ? [user] : [] };
    if (sql.includes("FROM memberships")) return { rows: members };
    if (sql.startsWith("INSERT INTO memberships")) { members.push({ user_id: String(values[1]), role: values[2] as RespondentRole }); return { rows: [] }; }
    if (sql.startsWith("SELECT id FROM scales")) return { rows: [{ id: "synthetic-scale" }] };
    if (sql.startsWith("SELECT id FROM assessments")) return { rows: tasks };
    if (sql.startsWith("SELECT a.id FROM assessments")) return { rows: [] };
    if (sql.includes("FROM triad_rounds")) return { rows: [] };
    if (sql.startsWith("INSERT INTO triad_rounds")) return { rows: [] };
    if (sql.startsWith("INSERT INTO assessments")) { tasks.push({ id: String(values[0]) }); return { rows: [] }; }
    if (sql.startsWith("UPDATE invitations")) { invite.used_at = new Date().toISOString(); invite.accepted_by = String(values[1]); return { rows: [] }; }
    if (sql.startsWith("INSERT INTO audit_events")) { if (sql.includes("'invitation.accepted'")) admissionAudits++; return { rows: [] }; }
    throw new Error(`Unexpected synthetic SQL: ${sql}`);
  });
  vi.mocked(transaction).mockImplementation(async fn => fn(client as unknown as PoolClient));
});
afterEach(() => vi.unstubAllEnvs());

describe("Clerk invitation retry after account mapping has committed", () => {
  it.each(["parent", "student", "teacher"] as const)("replays the same %s payload through the authenticated branch without duplicate enrollment", async role => {
    invite.role = role;
    const input = { token: TOKEN, name: "Synthetic invitee" };
    // The first branch commits successfully, but the client never receives its response.
    const firstId = await acceptClerkInvitation(principal, input, "zh-HK");
    expect(user).not.toBeNull();
    const mappedActor = { ...user! };
    // actorOf now resolves the newly mapped account, so the unchanged request
    // enters acceptInvitationForActor rather than acceptClerkInvitation.
    await expect(acceptInvitationForActor(mappedActor, input, "zh-HK")).resolves.toBe(firstId);
    expect(user!.id).toBe(firstId); expect(identities).toBe(1);
    expect(members).toEqual([{ user_id: firstId, role }]);
    expect(tasks).toHaveLength(role === "parent" ? 0 : 1);
    expect(admissionAudits).toBe(1);
  });
  it("does not let a retry name replace the mapped profile", async () => {
    await acceptClerkInvitation(principal, { token: TOKEN, name: "Synthetic original name" }, "zh-CN");
    await acceptInvitationForActor({ ...user! }, { token: TOKEN, name: "Synthetic replacement name" });
    expect(user!.name).toBe("Synthetic original name");
    expect(identities).toBe(1); expect(tasks).toHaveLength(1);
  });
  it("still rejects role and identity fields supplied with a retry", async () => {
    await acceptClerkInvitation(principal, { token: TOKEN, name: "Synthetic invitee" }, "zh-CN");
    const before = client.query.mock.calls.length;
    await expect(acceptInvitationForActor({ ...user! }, { token: TOKEN, name: "Synthetic invitee", role: "admin" })).rejects.toThrow();
    await expect(acceptInvitationForActor({ ...user! }, { token: TOKEN, name: "Synthetic invitee", userId: "another-account" })).rejects.toThrow();
    expect(client.query).toHaveBeenCalledTimes(before);
    expect(user!.role).toBe("student"); expect(identities).toBe(1);
  });
});
