import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { Actor, ScaleDefinition } from "../src/domain/types";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/config", () => ({ getConfig: () => ({ region: "CN", mode: "demo" }), isDemoMode: () => true }));
vi.mock("../src/lib/auth", () => ({ audit: vi.fn(), hashPassword: vi.fn(async () => "synthetic-hash"), limitLogin: vi.fn() }));
vi.mock("../src/lib/content", () => ({ getScale: vi.fn(), lockContent: vi.fn(), currentContent: vi.fn() }));
vi.mock("../src/domain/triad-scales", async original => ({
  ...await original<typeof import("../src/domain/triad-scales")>(),
  currentTriadScaleIds: { parent: "growth-parent@2.0.0", student: "growth-child@2.0.0", teacher: "growth-teacher@2.0.0" },
  legacyTriadScaleIds: { parent: "growth-parent@1.3.0", student: "growth-child@1.3.0", teacher: "growth-teacher@1.2.0" },
}));

import { query, transaction } from "../src/lib/db";
import { getScale } from "../src/lib/content";
import { joinFamily, joinWithCode } from "../src/lib/triad";
import { createAssessment } from "../src/lib/assessments";
import { childScaleStaffNotes, parentScaleStaffNotes, teacherScaleStaffNotes } from "../src/domain/triad-scales";

const familyId = "11111111-1111-4111-8111-111111111111";
const respondentId = "22222222-2222-4222-8222-222222222222";
const roundId = "33333333-3333-4333-8333-333333333333";
const existingId = "44444444-4444-4444-8444-444444444444";
const admin: Actor = { id: "55555555-5555-4555-8555-555555555555", name: "Synthetic admin", role: "admin", region: "CN" };
const student: Actor = { id: respondentId, name: "Synthetic student", role: "student", region: "CN" };
const family = { id: familyId, region: "CN", birth_date: "2014-06-01", join_code: "TOPE-A2B3C4D5", child_name: "Synthetic child", grade: "初中", assigned_to: null };
const short = (scale: ScaleDefinition) => ({ ...scale, version: "2.0.0", resultMode: "support-intake" } as ScaleDefinition);
const definitions = [childScaleStaffNotes, parentScaleStaffNotes, teacherScaleStaffNotes, ...[childScaleStaffNotes, parentScaleStaffNotes, teacherScaleStaffNotes].map(short)];
type Task = { id: string; respondent_role: string; submitted_at: string | null; scale_version_id: string; definition: ScaleDefinition; triad_round_id: string | null };
let tasks: Task[], unbound: Task[], latest: boolean, own: boolean, pending: Task | undefined, unresolved: boolean;
const writes: { sql: string; values: unknown[] }[] = [];
const task = (role: string, scale: ScaleDefinition, submitted = false): Task => ({ id: existingId, respondent_role: role, submitted_at: submitted ? "2026-10-01" : null, scale_version_id: `${scale.id}@${scale.version}`, definition: scale, triad_round_id: roundId });
async function read(sql: string, values: unknown[] = []): Promise<Record<string, unknown>[]> {
  if (/^(INSERT|UPDATE)/.test(sql)) { writes.push({ sql, values }); return []; }
  if (sql.includes("FROM families")) return [family];
  if (sql.includes("FROM users WHERE id")) return [{ ...(values[0] === admin.id ? admin : student), disabled: false, demo: false }];
  if (sql.includes("FROM consents")) return [{ scopes: ["assessment", "sensitive_data", "parent_report"] }];
  if (sql.includes("SELECT m.role FROM memberships")) return [{ role: "student" }];
  if (sql.includes("FROM memberships")) return own ? [{ user_id: respondentId, role: "student" }] : [];
  if (sql.includes("s.scale_id=$5")) return own && pending ? [{ id: pending.id }] : [];
  if (sql.includes("triad_round_id IS NULL") && sql.includes("submitted_at IS NOT NULL")) return unresolved ? [{ id: "unresolved" }] : [];
  if (sql.includes("triad_round_id IS NULL") && sql.includes("status='pending'")) return unbound;
  if (sql.includes("FROM triad_rounds")) return latest ? [{ id: roundId }] : [];
  if (sql.includes("respondent_role,submitted_at") || sql.includes("a.respondent_role,a.submitted_at")) return tasks;
  if (sql.includes("status='pending'")) return pending && (!sql.includes("scale_version_id=$3") || pending.scale_version_id === values[2]) ? [pending] : [];
  if (sql.includes("submitted_at IS NOT NULL")) return [];
  if (sql.includes("FROM scales")) return [{ id: values[0], status: "active" }];
  return [];
}
const client = { query: async (sql: string, values?: unknown[]) => ({ rows: await read(sql, values) }) } as PoolClient;
beforeEach(() => {
  tasks = []; unbound = []; latest = false; own = false; pending = undefined; unresolved = false; writes.length = 0;
  vi.mocked(query).mockImplementation(read as never);
  vi.mocked(transaction).mockImplementation((async (fn: (client: PoolClient) => Promise<unknown>) => fn(client)) as never);
  vi.mocked(getScale).mockImplementation(async id => ({ status: "active", definition: definitions.find(scale => `${scale.id}@${scale.version}` === id)! }) as never);
});
const join = () => joinFamily(student, { code: family.join_code }, "zh-CN");
const assign = (scaleVersionId = "growth-child@2.0.0") => createAssessment(admin, { familyId, respondentId, scaleVersionId, locale: "zh-CN" });
const assigned = () => writes.find(write => write.sql.startsWith("INSERT INTO assessments"))?.values;

describe("support intake generation routing", () => {
  it("routes a signed-in late join to the frozen legacy generation", async () => {
    latest = true; tasks = [task("parent", parentScaleStaffNotes, true)];
    await join();
    expect(assigned()?.slice(5)).toEqual(["growth-child@1.3.0", "zh-CN", roundId]);
  });
  it("routes password registration into the same legacy generation", async () => {
    latest = true; tasks = [task("parent", parentScaleStaffNotes, true)];
    await joinWithCode({ code: family.join_code, role: "teacher", name: "Synthetic teacher", username: "synthetic.teacher", password: "synthetic-password" }, "zh-CN");
    expect(assigned()?.slice(5)).toEqual(["growth-teacher@1.2.0", "zh-CN", roundId]);
  });
  it("uses a pre-round legacy pending parent to route a late join", async () => {
    unbound = [{ ...task("parent", parentScaleStaffNotes), triad_round_id: null }];
    await join();
    expect(assigned()?.[5]).toBe("growth-child@1.3.0");
    expect(writes.some(write => write.sql.startsWith("UPDATE assessments"))).toBe(false);
  });
  it("starts a new generation after all three legacy respondents submitted", async () => {
    latest = true; tasks = [task("parent", parentScaleStaffNotes, true), task("student", childScaleStaffNotes, true), task("teacher", teacherScaleStaffNotes, true)];
    await join();
    expect(assigned()?.[5]).toBe("growth-child@2.0.0");
    expect(assigned()?.[7]).not.toBe(roundId);
  });
  it("rejects an explicit new version inside a legacy round", async () => {
    latest = true; tasks = [task("parent", parentScaleStaffNotes, true)];
    await expect(assign()).rejects.toMatchObject({ code: "TRIAD_GENERATION_MISMATCH" });
    expect(assigned()).toBeUndefined();
  });
  it("rejects an explicit legacy version when starting a new round", async () => {
    await expect(assign("growth-child@1.3.0")).rejects.toMatchObject({ code: "TRIAD_GENERATION_MISMATCH" });
    expect(assigned()).toBeUndefined();
  });
  it("refuses an already mixed incomplete round", async () => {
    latest = true; tasks = [task("parent", parentScaleStaffNotes, true), task("teacher", short(teacherScaleStaffNotes), true)];
    await expect(join()).rejects.toMatchObject({ code: "TRIAD_GENERATION_MISMATCH" });
    expect(assigned()).toBeUndefined();
  });
  it("preserves a bound old pending task when an admin requests the new version", async () => {
    pending = task("student", childScaleStaffNotes); latest = true; tasks = [pending];
    await expect(assign()).resolves.toEqual({ id: existingId });
    expect(writes).toEqual([]);
  });
  it("adopts an unbound old task without rewriting its questionnaire", async () => {
    pending = { ...task("student", childScaleStaffNotes), triad_round_id: null };
    await expect(assign()).resolves.toEqual({ id: existingId });
    expect(writes.map(write => write.sql)).toEqual(["INSERT INTO triad_rounds(id,family_id,region) VALUES($1,$2,$3)", "UPDATE assessments SET triad_round_id=$1 WHERE id=$2"]);
  });
  it("does not adopt an old task into a new-generation round", async () => {
    latest = true; tasks = [task("parent", short(parentScaleStaffNotes), true)];
    pending = { ...task("student", childScaleStaffNotes), triad_round_id: null };
    await expect(assign()).rejects.toMatchObject({ code: "TRIAD_GENERATION_MISMATCH" });
    expect(writes).toEqual([]);
  });
  it("keeps member replay and unresolved legacy safeguards", async () => {
    own = true; pending = task("student", childScaleStaffNotes);
    await expect(join()).resolves.toMatchObject({ assessmentId: existingId, alreadyMember: true });
    expect(writes).toEqual([]);
    own = false; pending = undefined; unresolved = true;
    await expect(join()).rejects.toMatchObject({ code: "TRIAD_LEGACY_REVIEW_REQUIRED" });
  });
});
