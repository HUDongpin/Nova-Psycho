import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { Actor } from "../src/domain/types";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/auth", () => ({ audit: vi.fn(), hashPassword: vi.fn(), limitLogin: vi.fn() }));
vi.mock("../src/lib/config", () => ({ getConfig: () => ({ region: "CN", mode: "demo" }), isDemoMode: () => true }));
vi.mock("../src/lib/clerk-auth", () => ({ createClerkUserInTransaction: vi.fn() }));

import { transaction } from "../src/lib/db";
import { createClerkUserInTransaction } from "../src/lib/clerk-auth";
import { joinClerkStudent, joinFamily } from "../src/lib/triad";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FAMILY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const input = { code: "TOPE-A2B3C4D5", name: "Synthetic student", role: "student" as const };
const principal = { subject: "user_synthetic", issuer: "https://synthetic.clerk.invalid", sessionId: "sess_synthetic", region: "CN" as const, emailVerified: true as const };
const family = { id: FAMILY, region: "CN", join_code: input.code, birth_date: "2014-01-01" };
let user: (Actor & { disabled: boolean; demo: boolean }) | null;
let members: { user_id: string; role: string }[];
let tasks: { id: string; respondent_id: string; respondent_role: string }[];

const sql = vi.fn(async (text: string, values: unknown[] = []) => {
  if (text.includes("FROM families WHERE join_code=$1")) return { rows: values[0] === input.code ? [family] : [] };
  if (text.includes("FROM users WHERE id=$1")) return { rows: user ? [{ ...user }] : [] };
  if (text.includes("FROM consents WHERE family_id=$1")) return { rows: [{ scopes: ["assessment", "sensitive_data", "parent_report"] }] };
  if (text.includes("FROM memberships WHERE family_id=$1")) return { rows: members };
  if (text.includes("s.scale_id=$5")) return { rows: tasks.filter(task => task.respondent_id === values[1] && task.respondent_role === values[2]) };
  if (text.startsWith("SELECT id FROM scales")) return { rows: [{ id: "growth-child@1.0.0" }] };
  if (text.startsWith("INSERT INTO memberships")) members.push({ user_id: String(values[1]), role: String(values[2]) });
  if (text.startsWith("INSERT INTO assessments")) tasks.push({ id: String(values[0]), respondent_id: String(values[3]), respondent_role: String(values[4]) });
  return { rows: [] };
});

beforeEach(() => {
  vi.clearAllMocks(); user = null; members = []; tasks = [];
  vi.mocked(transaction).mockImplementation(async operation => operation({ query: sql } as unknown as PoolClient));
  vi.mocked(createClerkUserInTransaction).mockImplementation(async (_client, _principal, name, role) => {
    user = { id: USER, name, role, region: "CN", disabled: false, demo: false };
    return user;
  });
});

describe("Clerk student join response-loss replay", () => {
  it("replays the original onboarding body through the now-authenticated branch without duplicating data", async () => {
    const first = await joinClerkStudent(principal, input, "zh-CN");
    // Once the first transaction commits, the route resolves this mapped actor.
    const retry = await joinFamily(user!, input, "zh-CN");
    expect(retry).toEqual({ ...first, alreadyMember: true });
    expect(createClerkUserInTransaction).toHaveBeenCalledTimes(1);
    expect(members).toEqual([{ user_id: USER, role: "student" }]);
    expect(tasks).toHaveLength(1);
    expect(sql.mock.calls.filter(([text]) => text.startsWith("INSERT INTO assessments"))).toHaveLength(1);
  });
  it("does not let a student-onboarding payload change a teacher's identity", async () => {
    const teacher: Actor = { id: USER, name: "Synthetic teacher", role: "teacher", region: "CN" };
    await expect(joinFamily(teacher, input, "zh-CN")).rejects.toHaveProperty("name", "ZodError");
    expect(transaction).not.toHaveBeenCalled();
    expect(createClerkUserInTransaction).not.toHaveBeenCalled();
  });
  it.each([{ region: "HK" }, { userId: "another-account" }, { password: "synthetic-only" }])("rejects unrecognized replay fields %#", async extra => {
    await joinClerkStudent(principal, input, "zh-CN");
    const calls = sql.mock.calls.length;
    await expect(joinFamily(user!, { ...input, ...extra }, "zh-CN")).rejects.toHaveProperty("name", "ZodError");
    expect(sql.mock.calls).toHaveLength(calls);
    expect(createClerkUserInTransaction).toHaveBeenCalledTimes(1);
  });
  it("still rejects a student revoked between the two requests", async () => {
    await joinClerkStudent(principal, input, "zh-CN");
    user!.disabled = true;
    await expect(joinFamily(user!, input, "zh-CN")).rejects.toMatchObject({ code: "ACCOUNT_REVOKED" });
    expect(members).toHaveLength(1); expect(tasks).toHaveLength(1);
  });
});
