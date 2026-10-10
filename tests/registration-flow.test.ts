import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor, Role } from "../src/domain/types";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/auth", () => ({ audit: vi.fn(), hashPassword: vi.fn(), hashToken: (value: string) => value, limitLogin: vi.fn() }));
vi.mock("../src/lib/config", () => ({ getConfig: () => ({ region: "CN", mode: "demo" }) }));
vi.mock("../src/lib/clerk-auth", () => ({ createClerkUserInTransaction: vi.fn() }));

import { transaction } from "../src/lib/db";
import * as triad from "../src/lib/triad";
import * as families from "../src/lib/families";
import { createClerkUserInTransaction } from "../src/lib/clerk-auth";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FAMILY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_FAMILY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_USER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const REQUEST = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CODE = "TOPE-A2B3C4D5";
const TOKEN = "a".repeat(64);
const actor = (role: Role): Actor => ({ id: USER, name: "Synthetic adult", role, region: "CN" });
const principal = { subject: "user_synthetic", issuer: "https://synthetic.clerk.invalid", sessionId: "sess_synthetic", region: "CN" as const, emailVerified: true as const };
const parentInput = { requestId: REQUEST, relationship: "母亲", childName: "Synthetic child", birthDate: "2014-01-01", grade: "小学四至六年级", accepted: true };
type Member = { family_id: string; user_id: string; role: Role };
type Task = { id: string; family_id: string; respondent_id: string; respondent_role: Role };
let user: Actor & { disabled: boolean; demo: boolean };
let consent: boolean;
let scaleActive: boolean;
let currentFamily: { id: string; birth_date: string; join_code: string | null; region: string };
let members: Member[];
let tasks: Task[];
let createdFamily: { id: string; join_code: string; child_name: string; birth_date: string; grade: string; guardian_label: string } | null;
let invite: { family_id: string; role: Role; used_at: string | null; accepted_by: string | null; expires_at: Date };

const sql = vi.fn(async (text: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> => {
  if (text.includes("FROM users WHERE id=$1")) return { rows: [{ ...user }] };
  if (text.includes("FROM families WHERE created_by=$1")) return { rows: createdFamily ? [createdFamily] : [] };
  if (text.startsWith("INSERT INTO families")) {
    createdFamily = { id: String(values[0]), join_code: String(values[7]), child_name: String(values[3]), birth_date: String(values[4]), grade: String(values[5]), guardian_label: String(values[6]) };
    return { rows: [] };
  }
  if (text.includes("FROM families WHERE join_code=$1")) return { rows: values[0] === CODE ? [currentFamily] : [] };
  if (text.includes("FROM families WHERE id=$1")) return { rows: values[0] === currentFamily.id ? [currentFamily] : [] };
  if (text.includes("FROM consents WHERE family_id=$1")) return { rows: consent ? [{ id: "consent" }] : [] };
  if (text.includes("FROM memberships WHERE family_id=$1")) return { rows: members.filter(row => row.family_id === values[0]) };
  if (text.startsWith("INSERT INTO memberships")) {
    members.push({ family_id: String(values[0]), user_id: String(values[1]), role: (values[2] ?? "parent") as Role });
    return { rows: [] };
  }
  if (text.startsWith("SELECT id FROM assessments WHERE family_id=$1")) return { rows: tasks.filter(row => row.family_id === values[0] && row.respondent_id === values[1] && row.respondent_role === values[2]) };
  if (text.startsWith("INSERT INTO assessments")) {
    tasks.push({ id: String(values[0]), family_id: String(values[1]), respondent_id: String(values[3]), respondent_role: (text.includes("'parent'") ? "parent" : values[4]) as Role });
    return { rows: [] };
  }
  if (text.startsWith("SELECT id FROM scales")) return { rows: scaleActive ? [{ id: "scale" }] : [] };
  if (text.includes("SELECT family_id FROM invitations")) return { rows: [{ family_id: invite.family_id }] };
  if (text.includes("FOR UPDATE OF i")) return { rows: [invite] };
  if (text.startsWith("UPDATE invitations SET used_at")) {
    invite.used_at = new Date().toISOString(); invite.accepted_by = String(values[1]);
    return { rows: [] };
  }
  return { rows: [] };
});

beforeEach(() => {
  vi.clearAllMocks();
  user = { ...actor("teacher"), disabled: false, demo: false };
  consent = scaleActive = true;
  currentFamily = { id: FAMILY, birth_date: "2014-01-01", join_code: CODE, region: "CN" };
  members = []; tasks = []; createdFamily = null;
  invite = { family_id: FAMILY, role: "teacher", used_at: null, accepted_by: null, expires_at: new Date(Date.now() + 3600000) };
  vi.mocked(transaction).mockImplementation((async (fn: (client: unknown) => Promise<unknown>) => fn({ query: sql })) as never);
  vi.mocked(createClerkUserInTransaction).mockImplementation(async (_client, _principal, name, role) => {
    user = { ...actor(role), name, disabled: false, demo: false };
    return user;
  });
});

describe("independent accounts joining families", () => {
  it("uses the same authenticated teacher for two families without creating another account", async () => {
    expect(triad).toHaveProperty("joinFamily", expect.any(Function));
    const first = await triad.joinFamily(actor("teacher"), { code: CODE }, "zh-CN");
    currentFamily.id = OTHER_FAMILY;
    const second = await triad.joinFamily(actor("teacher"), { code: CODE }, "zh-CN");
    expect([first.userId, second.userId]).toEqual([USER, USER]);
    expect(members.map(row => row.family_id)).toEqual([FAMILY, OTHER_FAMILY]);
    expect(sql.mock.calls.some(([text]) => text.startsWith("INSERT INTO users"))).toBe(false);
  });
  it("returns the existing task on repeated joins without opening another round", async () => {
    expect(triad).toHaveProperty("joinFamily", expect.any(Function));
    members = [{ family_id: FAMILY, user_id: USER, role: "teacher" }];
    tasks = [{ id: "finished-task", family_id: FAMILY, respondent_id: USER, respondent_role: "teacher" }];
    const result = await triad.joinFamily(actor("teacher"), { code: CODE }, "zh-CN");
    expect(result).toMatchObject({ alreadyMember: true, assessmentId: "finished-task", userId: USER });
    expect(sql.mock.calls.some(([text]) => text.startsWith("INSERT"))).toBe(false);
  });
  it("keeps another teacher from occupying a filled teacher slot", async () => {
    expect(triad).toHaveProperty("joinFamily", expect.any(Function));
    members = [{ family_id: FAMILY, user_id: OTHER_USER, role: "teacher" }];
    await expect(triad.joinFamily(actor("teacher"), { code: CODE }, "zh-CN")).rejects.toMatchObject({ code: "ROLE_TAKEN" });
  });
  it.each(["disabled", "region", "role"] as const)("rechecks a changed actor %s inside the transaction", async change => {
    expect(triad).toHaveProperty("joinFamily", expect.any(Function));
    if (change === "disabled") user.disabled = true;
    if (change === "region") user.region = "HK";
    if (change === "role") user.role = "parent";
    await expect(triad.joinFamily(actor("teacher"), { code: CODE }, "zh-CN")).rejects.toBeInstanceOf(Error);
    expect(sql.mock.calls.some(([text]) => text.startsWith("INSERT"))).toBe(false);
  });
  it("requires all guardian scopes before adding a family member", async () => {
    expect(triad).toHaveProperty("joinFamily", expect.any(Function));
    consent = false;
    await expect(triad.joinFamily(actor("teacher"), { code: CODE }, "zh-CN")).rejects.toMatchObject({ code: "GUARDIAN_CONSENT_REQUIRED" });
    expect(sql.mock.calls.some(([text]) => text.startsWith("INSERT"))).toBe(false);
  });
  it("does not trust a client-supplied role or region", async () => {
    expect(triad).toHaveProperty("joinFamily", expect.any(Function));
    await expect(triad.joinFamily(actor("teacher"), { code: CODE, role: "parent", region: "HK" }, "zh-CN")).rejects.toHaveProperty("name", "ZodError");
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("existing parent creates a family", () => {
  it("replays the same request without duplicating the family, consent or questionnaire", async () => {
    expect(triad).toHaveProperty("createParentFamily", expect.any(Function));
    user.role = "parent";
    const first = await triad.createParentFamily(actor("parent"), parentInput, "zh-CN");
    const second = await triad.createParentFamily(actor("parent"), parentInput, "zh-CN");
    expect(second).toEqual(first);
    expect(sql.mock.calls.filter(([text]) => text.startsWith("INSERT INTO families"))).toHaveLength(1);
    expect(sql.mock.calls.filter(([text]) => text.startsWith("INSERT INTO consents"))).toHaveLength(1);
    expect(sql.mock.calls.some(([text]) => text.startsWith("INSERT INTO users"))).toBe(false);
  });
  it("refuses teacher identity and omitted guardian acceptance", async () => {
    expect(triad).toHaveProperty("createParentFamily", expect.any(Function));
    await expect(triad.createParentFamily(actor("teacher"), parentInput, "zh-CN")).rejects.toMatchObject({ code: "ROLE_DENIED" });
    await expect(triad.createParentFamily(actor("parent"), { ...parentInput, accepted: false }, "zh-CN")).rejects.toHaveProperty("name", "ZodError");
  });
  it("does not silently reuse a request ID after the child details are edited", async () => {
    user.role = "parent";
    await triad.createParentFamily(actor("parent"), parentInput, "zh-CN");
    await expect(triad.createParentFamily(actor("parent"), { ...parentInput, childName: "Another synthetic child" }, "zh-CN")).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT", status: 409 });
    expect(sql.mock.calls.filter(([text]) => text.startsWith("INSERT INTO families"))).toHaveLength(1);
  });
});

describe("authenticated invitation acceptance", () => {
  it("adds an existing teacher and its initial triad task then safely replays the same token", async () => {
    expect(families).toHaveProperty("acceptInvitationForActor", expect.any(Function));
    expect(await families.acceptInvitationForActor(actor("teacher"), { token: TOKEN })).toBe(USER);
    expect(members).toEqual([{ family_id: FAMILY, user_id: USER, role: "teacher" }]);
    expect(tasks).toHaveLength(1);
    expect(invite.accepted_by).toBe(USER);
    expect(await families.acceptInvitationForActor(actor("teacher"), { token: TOKEN })).toBe(USER);
    expect(tasks).toHaveLength(1);
    expect(sql.mock.calls.some(([text]) => text.startsWith("INSERT INTO users"))).toBe(false);
  });
  it("cannot use an invitation to change an existing account role", async () => {
    expect(families).toHaveProperty("acceptInvitationForActor", expect.any(Function));
    invite.role = "student";
    await expect(families.acceptInvitationForActor(actor("teacher"), { token: TOKEN })).rejects.toMatchObject({ code: "ROLE_CONFLICT" });
    expect(sql.mock.calls.some(([text]) => text.startsWith("INSERT") || text.startsWith("UPDATE invitations"))).toBe(false);
  });
  it("keeps staff-managed non-triad invitation semantics without an automatic task", async () => {
    expect(families).toHaveProperty("acceptInvitationForActor", expect.any(Function));
    currentFamily.join_code = null;
    await families.acceptInvitationForActor(actor("teacher"), { token: TOKEN });
    expect(members).toHaveLength(1); expect(tasks).toHaveLength(0);
  });
  it("rejects a used token accepted by another account", async () => {
    expect(families).toHaveProperty("acceptInvitationForActor", expect.any(Function));
    invite.used_at = new Date().toISOString(); invite.accepted_by = OTHER_USER;
    await expect(families.acceptInvitationForActor(actor("teacher"), { token: TOKEN })).rejects.toMatchObject({ code: "INVALID_INVITATION" });
  });
  it("does not recreate a membership revoked after invitation acceptance", async () => {
    invite.used_at = new Date().toISOString(); invite.accepted_by = USER;
    await expect(families.acceptInvitationForActor(actor("teacher"), { token: TOKEN })).rejects.toMatchObject({ code: "INVALID_INVITATION" });
    expect(sql.mock.calls.some(([text]) => text.startsWith("INSERT"))).toBe(false);
  });
  it("refuses an expired unconsumed invitation", async () => {
    invite.expires_at = new Date(Date.now() - 1000);
    await expect(families.acceptInvitationForActor(actor("teacher"), { token: TOKEN })).rejects.toMatchObject({ code: "INVALID_INVITATION" });
    expect(sql.mock.calls.some(([text]) => text.startsWith("INSERT"))).toBe(false);
  });
  it("provisions only the invitation role from a verified Clerk principal", async () => {
    expect(families).toHaveProperty("acceptClerkInvitation", expect.any(Function));
    invite.role = "student";
    const result = await families.acceptClerkInvitation(principal, { token: TOKEN, name: "Synthetic student" }, "zh-HK");
    expect(result).toBe(USER);
    expect(createClerkUserInTransaction).toHaveBeenCalledWith(expect.anything(), principal, "Synthetic student", "student");
    expect(members).toEqual([{ family_id: FAMILY, user_id: USER, role: "student" }]);
    const assessment = sql.mock.calls.find(([text]) => text.startsWith("INSERT INTO assessments"));
    expect(assessment?.[1]?.[6]).toBe("zh-HK");
  });
  it("rejects a cross-region invitation before creating any Clerk profile", async () => {
    currentFamily.region = "HK";
    await expect(families.acceptClerkInvitation(principal, { token: TOKEN, name: "Synthetic student" }, "zh-CN")).rejects.toMatchObject({ code: "INVALID_INVITATION" });
    expect(createClerkUserInTransaction).not.toHaveBeenCalled();
  });
  it("gives a newly invited local student the initial triad questionnaire too", async () => {
    invite.role = "student";
    const result = await families.acceptInvitation({ token: TOKEN, name: "Synthetic student", username: "new.student", password: "synthetic-long-password" });
    expect(members).toEqual([{ family_id: FAMILY, user_id: result, role: "student" }]);
    expect(tasks).toHaveLength(1);
    expect(createClerkUserInTransaction).not.toHaveBeenCalled();
  });
  it("cannot bypass an occupied triad teacher slot using the legacy invitation payload", async () => {
    members = [{ family_id: FAMILY, user_id: OTHER_USER, role: "teacher" }];
    await expect(families.acceptInvitation({ token: TOKEN, name: "Synthetic teacher", username: "another.teacher", password: "synthetic-long-password" })).rejects.toMatchObject({ code: "ROLE_TAKEN" });
    expect(members).toHaveLength(1);
  });
  it.each(["existing", "clerk"] as const)("lets an invited %s parent enter before recording guardian consent", async mode => {
    invite.role = "parent"; user.role = "parent"; consent = false; currentFamily.join_code = null;
    const result = mode === "existing"
      ? await families.acceptInvitationForActor(actor("parent"), { token: TOKEN })
      : await families.acceptClerkInvitation(principal, { token: TOKEN, name: "Synthetic parent" }, "zh-CN");
    expect(result).toBe(USER);
    expect(members).toEqual([{ family_id: FAMILY, user_id: USER, role: "parent" }]);
    expect(tasks).toHaveLength(0);
  });
  it.each(["student", "teacher"] as const)("requires consent before a legacy %s joins a staff-managed family", async role => {
    invite.role = role; consent = false; currentFamily.join_code = null;
    await expect(families.acceptInvitation({ token: TOKEN, name: "Synthetic member", username: `new.${role}`, password: "synthetic-long-password" })).rejects.toMatchObject({ code: "GUARDIAN_CONSENT_REQUIRED" });
    expect(sql.mock.calls.some(([text]) => text.startsWith("INSERT INTO users"))).toBe(false);
  });
});

describe("student Clerk onboarding remains invitation-gated", () => {
  it("rejects an unknown family before provisioning a local student", async () => {
    expect(triad).toHaveProperty("joinClerkStudent", expect.any(Function));
    await expect(triad.joinClerkStudent(principal, { code: "TOPE-Z9Z9Z9Z9", name: "Synthetic student", role: "student" }, "zh-CN")).rejects.toMatchObject({ code: "INVALID_JOIN_CODE" });
    expect(sql.mock.calls.some(([text]) => text.startsWith("INSERT"))).toBe(false);
    expect(createClerkUserInTransaction).not.toHaveBeenCalled();
  });
  it("rejects missing guardian consent before provisioning a local student", async () => {
    expect(triad).toHaveProperty("joinClerkStudent", expect.any(Function));
    consent = false;
    await expect(triad.joinClerkStudent(principal, { code: CODE, name: "Synthetic student", role: "student" }, "zh-CN")).rejects.toMatchObject({ code: "GUARDIAN_CONSENT_REQUIRED" });
    expect(sql.mock.calls.some(([text]) => text.startsWith("INSERT"))).toBe(false);
    expect(createClerkUserInTransaction).not.toHaveBeenCalled();
  });
  it("creates a student profile and initial task only after a valid regional invitation", async () => {
    const result = await triad.joinClerkStudent(principal, { code: CODE, name: "Synthetic student", role: "student" }, "zh-CN");
    expect(result).toMatchObject({ userId: USER, familyId: FAMILY, alreadyMember: false });
    expect(createClerkUserInTransaction).toHaveBeenCalledTimes(1);
    const consentIndex = sql.mock.calls.findIndex(([text]) => text.includes("FROM consents"));
    expect(sql.mock.invocationCallOrder[consentIndex]).toBeLessThan(vi.mocked(createClerkUserInTransaction).mock.invocationCallOrder[0]);
    expect(members[0].role).toBe("student"); expect(tasks).toHaveLength(1);
  });
  it("rejects an out-of-age family before creating the student", async () => {
    currentFamily.birth_date = "2000-01-01";
    await expect(triad.joinClerkStudent(principal, { code: CODE, name: "Synthetic student", role: "student" }, "zh-CN")).rejects.toMatchObject({ code: "CHILD_AGE" });
    expect(createClerkUserInTransaction).not.toHaveBeenCalled();
  });
});
