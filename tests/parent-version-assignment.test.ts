import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { Actor, ScaleDefinition } from "../src/domain/types";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/content", () => ({ getScale: vi.fn(), lockContent: vi.fn() }));
vi.mock("../src/lib/auth", () => ({ audit: vi.fn(), hashPassword: vi.fn(async () => "synthetic-hash"), limitLogin: vi.fn(async () => undefined) }));

import * as instruments from "../src/domain/triad-scales";
import { assessmentDetail, createAssessment } from "../src/lib/assessments";
import { getScale } from "../src/lib/content";
import { query, transaction } from "../src/lib/db";
import { createParentFamily, ensureTriadInstruments, joinTriadFamilyInTransaction, startParentCase } from "../src/lib/triad";
import { workspaceFor } from "../src/lib/workspace";
import { eligibleScales, type Family, type Scale } from "../src/components/api";

const familyId = "11111111-2222-4333-8444-555555555555", respondentId = "22222222-3333-4444-8555-666666666666";
const actor: Actor = { id: respondentId, name: "Synthetic parent", role: "parent", region: "CN" };
const family = { id: familyId, region: "CN", child_name: "Synthetic", birth_date: "2014-01-01", grade: "初中", guardian_label: "母亲", assigned_to: null, created_at: new Date("2026-01-01"), join_code: "TOPE-A2B3C4D5" };
type Task = { id: string; version: string; status: string; submitted_at: string | null; triad_round_id: string | null };
let definitions: Record<string, ScaleDefinition>;
let tasks: Task[];
let locked: boolean;
let revoked: boolean;
let replayFamily: boolean;
let missingDefault: boolean;
let detailScaleId: string;
const client = { query: vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>() };
const input = (version: string) => ({ familyId, respondentId, scaleVersionId: version, locale: "zh-CN" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
  vi.stubEnv("NOVA_REGION", "CN"); vi.stubEnv("NOVA_MODE", "demo");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova"); vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR", "work/test-private"); vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
  vi.clearAllMocks(); tasks = []; locked = revoked = replayFamily = missingDefault = false; detailScaleId = "growth-parent@1.1.0";
  const legacy = structuredClone(instruments.parentScaleV1 ?? instruments.parentScale); legacy.version = "1.0.0";
  const next = structuredClone(instruments.parentScale); next.version = "1.1.0";
  definitions = { "growth-parent@1.0.0": legacy, "growth-parent@1.1.0": next };
  vi.mocked(getScale).mockImplementation(async id => ({ id, status: "active", definition: definitions[id] }));
  vi.mocked(query).mockImplementation(async sql => {
    if (sql.includes("FROM assessments a JOIN scales s")) return [{ id: familyId, family_id: familyId, definition: definitions[detailScaleId], respondent_role: "parent", status: "pending", draft_answers: {}, draft_revision: 0, child_name: "Synthetic" }];
    if (sql.includes("FROM families f WHERE")) return [family];
    if (sql.includes("SELECT m.role FROM memberships")) return [{ role: "parent" }];
    if (sql.includes("FROM scales ORDER BY")) return Object.entries(definitions).map(([id, definition]) => ({ id, scale_id: definition.id, version: definition.version, definition, status: "active" }));
    return [];
  });
  client.query.mockImplementation(async (sql, values = []) => {
    if (sql.includes("SELECT id FROM families") && sql.includes("FOR UPDATE")) { locked = true; return { rows: [family] }; }
    if (sql.includes("FROM users WHERE id=$1")) return { rows: [{ ...actor, disabled: revoked, demo: false }] };
    if (sql.includes("FROM families f WHERE")) return { rows: [family] };
    if (sql.includes("SELECT m.role FROM memberships")) return { rows: [{ role: "parent" }] };
    if (sql.includes("creation_request_id=$2")) return { rows: replayFamily ? [family] : [] };
    if (sql.startsWith("SELECT status FROM scales")) return { rows: [{ status: "active" }] };
    if (sql.startsWith("SELECT id FROM scales")) return { rows: missingDefault ? [] : [{ id: values[0] }] };
    if (sql.includes("FROM assessments") && sql.includes("status='pending'")) {
      expect(locked).toBe(true);
      return { rows: tasks.filter(task => task.status === "pending" && (task.version === values[2] || definitions[task.version]?.id === values[2])).map(task => ({ id: task.id, triad_round_id: task.triad_round_id })) };
    }
    if (sql.includes("FROM assessments") && sql.includes("submitted_at IS NOT NULL") && sql.includes("ORDER BY")) {
      expect(locked).toBe(true);
      return { rows: tasks.filter(task => task.submitted_at && (task.version === values[2] || definitions[task.version]?.id === values[2])).sort((left, right) => String(right.submitted_at).localeCompare(String(left.submitted_at))).map(task => ({ submitted_at: task.submitted_at })) };
    }
    if (sql.startsWith("INSERT INTO assessments")) {
      tasks.push({ id: String(values[0]), version: String(values[sql.includes("'parent'") ? 4 : 5]), status: "pending", submitted_at: null, triad_round_id: String(values.at(-1)) });
    }
    if (sql.startsWith("UPDATE assessments SET triad_round_id")) {
      const task = tasks.find(candidate => candidate.id === values[1]); if (task) task.triad_round_id = String(values[0]);
    }
    return { rows: [] };
  });
  vi.mocked(transaction).mockImplementation(async fn => fn(client as unknown as PoolClient));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("parent version assignment compatibility", () => {
  it.each([["1.0.0", "1.1.0"], ["1.1.0", "1.0.0"]])("reuses %s pending when %s is requested without changing its version", async (existing, requested) => {
    tasks.push({ id: "existing-pending", version: `growth-parent@${existing}`, status: "pending", submitted_at: null, triad_round_id: "existing-round" });
    const before = structuredClone(tasks);
    expect(await createAssessment(actor, input(`growth-parent@${requested}`))).toEqual({ id: "existing-pending" });
    expect(tasks).toEqual(before);
  });

  it("adopts an unbound legacy pending task without creating a newer task", async () => {
    tasks.push({ id: "legacy-unbound", version: "growth-parent@1.0.0", status: "pending", submitted_at: null, triad_round_id: null });
    expect(await createAssessment(actor, input("growth-parent@1.1.0"))).toEqual({ id: "legacy-unbound" });
    expect(tasks).toHaveLength(1); expect(tasks[0].version).toBe("growth-parent@1.0.0"); expect(tasks[0].triad_round_id).not.toBeNull();
  });

  it.each([["1.0.0", "1.1.0", "published"], ["1.1.0", "1.0.0", "failed"], ["1.0.0", "1.1.0", "queued"]])("enforces 90 days from %s before assigning %s after a %s submission", async (existing, requested, status) => {
    tasks.push({ id: "prior-submitted", version: `growth-parent@${existing}`, status, submitted_at: "2026-10-14T00:00:00Z", triad_round_id: "old-round" });
    await expect(createAssessment(actor, input(`growth-parent@${requested}`))).rejects.toMatchObject({ code: "RETAKE_INTERVAL", status: 409 });
    expect(tasks).toHaveLength(1);
  });

  it("allows the explicitly selected old version after the cross-version interval", async () => {
    tasks.push({ id: "prior", version: "growth-parent@1.1.0", status: "published", submitted_at: "2026-07-01T00:00:00Z", triad_round_id: "old-round" });
    const created = await createAssessment(actor, input("growth-parent@1.0.0"));
    expect(tasks.find(task => task.id === created.id)?.version).toBe("growth-parent@1.0.0");
  });

  it("does not change other instruments' exact-version pending and retake policy", async () => {
    for (const version of ["1.0.0", "1.1.0"]) definitions[`custom@${version}`] = { ...structuredClone(definitions[`growth-parent@${version}`]), id: "custom", bundle: undefined };
    tasks.push({ id: "other-pending", version: "custom@1.0.0", status: "pending", submitted_at: null, triad_round_id: null });
    const created = await createAssessment(actor, input("custom@1.1.0"));
    expect(created.id).not.toBe("other-pending"); expect(tasks).toHaveLength(2);
  });

  it("does not return a pending task after the current account has been revoked", async () => {
    revoked = true;
    tasks.push({ id: "private-pending", version: "growth-parent@1.0.0", status: "pending", submitted_at: null, triad_round_id: "round" });
    await expect(createAssessment(actor, input("growth-parent@1.1.0"))).rejects.toMatchObject({ code: "ACCOUNT_REVOKED" });
  });
});

describe("new defaults without replacing historical records", () => {
  it("returns companion metadata only from the assigned new definition, never for legacy drafts", async () => {
    const detail = await assessmentDetail(actor, familyId, "zh-HK");
    expect(detail).toHaveProperty("supplements");
    expect(detail.supplements).toHaveLength(7);
    expect(detail.supplements).toContainEqual({ itemId: "p_curriculum_other", parentId: "p_curriculum", label: "其他課程體系（選填）", anyOf: [6], maxLength: 2000 });
    detailScaleId = "growth-parent@1.0.0";
    expect(await assessmentDetail(actor, familyId, "zh-HK")).not.toHaveProperty("supplements");
  });

  it("initial registration and authenticated new-family creation both select parent 1.1.0", async () => {
    await startParentCase({ parentName: "Synthetic", username: "synthetic.parent", password: "synthetic-password", relationship: "母亲", childName: "Synthetic", birthDate: "2014-01-01", grade: "初中", accepted: true }, "zh-CN");
    await createParentFamily(actor, { requestId: "33333333-4444-4555-8666-777777777777", relationship: "母亲", childName: "Synthetic", birthDate: "2014-01-01", grade: "初中", accepted: true }, "zh-CN");
    expect(tasks.map(task => task.version)).toEqual(["growth-parent@1.1.0", "growth-parent@1.1.0"]);
  });

  it("replays an existing family before looking up the new default or creating a task", async () => {
    replayFamily = true; missingDefault = true;
    await expect(createParentFamily(actor, { requestId: "33333333-4444-4555-8666-777777777777", relationship: "母亲", childName: "Synthetic", birthDate: "2014-01-01", grade: "初中", accepted: true }, "zh-CN")).resolves.toMatchObject({ familyId });
    expect(tasks).toEqual([]);
  });

  it("keeps the same original student/teacher task when a family join is retried", async () => {
    for (const role of ["student", "teacher"] as const) {
      const member = { ...actor, role };
      const joinClient = { query: vi.fn(async (sql: string) => ({ rows: sql.startsWith("SELECT user_id,role") ? [{ user_id: actor.id, role }] : sql.startsWith("SELECT id FROM assessments") ? [{ id: `original-${role}` }] : [] })) };
      expect(await joinTriadFamilyInTransaction(joinClient as unknown as PoolClient, member, { ...family, region: "CN" }, "zh-CN")).toMatchObject({ assessmentId: `original-${role}`, alreadyMember: true });
      expect(joinClient.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
    }
  });

  it("seeds four immutable definitions and never updates or retires a historical version", async () => {
    await ensureTriadInstruments();
    const inserts = vi.mocked(query).mock.calls.filter(([sql]) => sql.startsWith("INSERT INTO scales"));
    expect(inserts.map(([, values]) => values?.[0]).sort()).toEqual(["growth-child@1.0.0", "growth-parent@1.0.0", "growth-parent@1.1.0", "growth-teacher@1.0.0"]);
    expect(inserts.every(([sql]) => sql.includes("ON CONFLICT(id) DO NOTHING"))).toBe(true);
    expect(vi.mocked(query).mock.calls.some(([sql]) => sql.startsWith("UPDATE scales"))).toBe(false);
  });

  it("projects defaults from the canonical role map and preserves explicit historical choices", async () => {
    const workspace = await workspaceFor(actor, "zh-CN");
    expect(workspace.scales.find(scale => scale.id === "growth-parent@1.1.0")).toMatchObject({ isDefaultVersion: true, status: "active" });
    expect(workspace.scales.find(scale => scale.id === "growth-parent@1.0.0")?.isDefaultVersion).not.toBe(true);
    const uiFamily: Family = { id: familyId, familyName: "Synthetic", childName: "Synthetic", age: 12, birthDate: "2014-01-01", grade: "S1", region: "CN", guardianLabel: "Parent", assignedTo: null, createdAt: "2026-01-01", consent: true, canInviteMembers: false, members: [{ ...actor }] };
    const scales = workspace.scales as Scale[];
    const custom = { ...scales[0], id: "custom@1.0.0", scaleId: "custom", isDefaultVersion: undefined };
    const ordered = eligibleScales([scales[0], custom, scales[1]], uiFamily, actor.id);
    expect(ordered.map(scale => scale.id)).toEqual(["growth-parent@1.1.0", "growth-parent@1.0.0", "custom@1.0.0"]);
    expect(eligibleScales([{ ...scales[1], minAge: 16 }, scales[0]], uiFamily, actor.id).map(scale => scale.id)).toEqual(["growth-parent@1.0.0"]);
    expect(eligibleScales([{ ...scales[1], status: "retired" }, scales[0]], uiFamily, actor.id).map(scale => scale.id)).toEqual(["growth-parent@1.0.0"]);
  });
});
