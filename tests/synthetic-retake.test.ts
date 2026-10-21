import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../src/domain/types";
import { childScale, parentScale, teacherScale } from "../src/domain/triad-scales";
vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/synthetic-testing", () => ({ getSyntheticTestFamilyMembers: vi.fn() }));
vi.mock("../src/lib/access", () => ({ ageAt: vi.fn(() => 13) }));
import { query, transaction } from "../src/lib/db";
import { getSyntheticTestFamilyMembers } from "../src/lib/synthetic-testing";
import { ageAt } from "../src/lib/access";
import { startSyntheticRetake, syntheticRetakeCapability } from "../src/lib/synthetic-retake";

const family = "10000000-0000-4000-8000-000000000001", previous = "20000000-0000-4000-8000-000000000001";
const actor: Actor = { id: "parent", name: "Synthetic", role: "parent", region: "HK", sessionMethod: "test" };
const roles = ["parent", "student", "teacher"] as const;
const scales = [parentScale, childScale, teacherScale];
const input = { previousRoundId: previous, locale: "zh-HK" };
let sources: Record<string, unknown>[];
let newSources: Record<string, unknown>[];
let roundId: string | undefined;
let consent: string[];
let reportIds: string[];
let reportPresent: boolean;
let priorExists: boolean;
let otherPending: boolean;
let calls: { sql: string; values: unknown[] }[];
const read = async (sql: string, values: unknown[] = []) => {
  calls.push({ sql, values });
  if (sql.includes("FROM families WHERE")) return [{ birth_date: "2013-01-01" }];
  if (sql.includes("AS scopes FROM consents")) return [{ scopes: consent }];
  if (sql.startsWith("SELECT id,created_at FROM triad_rounds WHERE id=")) return priorExists ? [{ id: previous, created_at: new Date("2026-10-20T01:00:00Z") }] : [];
  if (sql.includes("ORDER BY created_at DESC,id DESC")) return [{ id: roundId ?? previous, created_at: new Date("2026-10-20T01:00:00Z") }];
  if (sql.includes("FROM assessments a JOIN scales")) return values[0] === previous ? sources : newSources;
  if (sql.includes("FROM reports r JOIN report_jobs")) return reportPresent ? [{ source_assessment_ids: reportIds }] : [];
  if (sql.includes("FROM triad_rounds next")) return roundId ? [{ id: roundId }] : [];
  if (sql.includes("status<>'published'")) return otherPending ? [{ id: "unrelated" }] : [];
  if (sql.startsWith("INSERT INTO triad_rounds")) { roundId = String(values[0]); return []; }
  if (sql.startsWith("INSERT INTO assessments")) { newSources.push({ id: values[0], respondent_id: values[3], respondent_role: values[4], scale_version_id: values[5], definition: scales[roles.indexOf(values[4] as typeof roles[number])], status: "pending" }); return []; }
  return [];
};
const writes = () => calls.filter(call => /^\s*(INSERT|UPDATE|DELETE)/.test(call.sql));
beforeEach(() => {
  vi.clearAllMocks();
  sources = roles.map((role, index) => ({ id: `source-${role}`, respondent_id: role, respondent_role: role, scale_version_id: `${scales[index].id}@${scales[index].version}`, status: "published", submitted_at: new Date(), snapshot: { scale: scales[index] }, definition: scales[index], scale_status: "active" }));
  newSources = []; roundId = undefined; consent = ["assessment", "sensitive_data", "parent_report"]; reportIds = sources.map(source => String(source.id)); reportPresent = true; priorExists = true; otherPending = false; calls = [];
  vi.mocked(ageAt).mockReturnValue(13);
  vi.mocked(getSyntheticTestFamilyMembers).mockResolvedValue(roles.map(role => ({ id: role, role })));
  vi.mocked(query).mockImplementation(read as never);
  vi.mocked(transaction).mockImplementation((async fn => fn({ query: async (sql: string, values: unknown[]) => ({ rows: await read(sql, values) }) } as never)) as typeof transaction);
});

describe("bounded synthetic retake", () => {
  it("creates exactly three same-version empty tasks in one new round", async () => {
    const result = await startSyntheticRetake(actor, family, input);
    expect(result.reused).toBe(false);
    expect(Object.keys(result.assessmentIds).sort()).toEqual([...roles].sort());
    const inserts = calls.filter(call => call.sql.startsWith("INSERT INTO assessments"));
    expect(inserts).toHaveLength(3);
    expect(inserts.map(call => call.values[5])).toEqual(sources.map(source => source.scale_version_id));
    expect(inserts.every(call => call.values[7] === result.roundId && call.values[6] === "zh-HK")).toBe(true);
    expect(calls.some(call => /^UPDATE|^DELETE/.test(call.sql))).toBe(false);
    expect(getSyntheticTestFamilyMembers).toHaveBeenCalledWith(family, "HK", expect.any(Object));
    expect(calls.find(call => call.sql.includes("FOR UPDATE"))?.values).toEqual([family, "HK"]);
  });
  it("repeated previous-round tokens reuse the same successor without more tasks", async () => {
    const first = await startSyntheticRetake(actor, family, input);
    const second = await startSyntheticRetake(actor, family, input);
    expect(second).toEqual({ ...first, reused: true });
    expect(calls.filter(call => call.sql.startsWith("INSERT INTO triad_rounds"))).toHaveLength(1);
    expect(calls.filter(call => call.sql.startsWith("INSERT INTO assessments"))).toHaveLength(3);
  });
  it.each([
    { ...actor, sessionMethod: undefined },
    { ...actor, role: "student" as const, id: "student" },
    { ...actor, role: "teacher" as const, id: "teacher" },
  ])("denies ordinary or non-parent actors before a transaction", async other => {
    await expect(startSyntheticRetake(other, family, input)).rejects.toMatchObject({ status: 403, code: "SYNTHETIC_RETAKE_DENIED" });
    expect(transaction).not.toHaveBeenCalled();
  });
  it("rejects client override fields", async () => {
    await expect(startSyntheticRetake(actor, family, { ...input, bypassInterval: true })).rejects.toMatchObject({ name: "ZodError" });
    expect(transaction).not.toHaveBeenCalled();
  });
  it("fails closed if the current scoped membership is absent", async () => {
    vi.mocked(getSyntheticTestFamilyMembers).mockResolvedValue(null);
    await expect(startSyntheticRetake(actor, family, input)).rejects.toMatchObject({ status: 403 });
    expect(writes()).toHaveLength(0);
  });
  it.each(["assessment", "sensitive_data", "parent_report"])("requires %s consent", async scope => {
    consent = consent.filter(value => value !== scope);
    await expect(startSyntheticRetake(actor, family, input)).rejects.toMatchObject({ code: "GUARDIAN_CONSENT_REQUIRED" });
    expect(writes()).toHaveLength(0);
  });
  it.each(["pending-source", "wrong-member", "wrong-pinned-ids", "no-report", "foreign-round", "other-pending", "retired-scale", "changed-snapshot-version"])("rejects %s without creating a round", async issue => {
    if (issue === "pending-source") sources[1].status = "pending";
    if (issue === "wrong-member") sources[1].respondent_id = "other-student";
    if (issue === "wrong-pinned-ids") reportIds[1] = "other-source";
    if (issue === "no-report") reportPresent = false;
    if (issue === "foreign-round") priorExists = false;
    if (issue === "other-pending") otherPending = true;
    if (issue === "retired-scale") sources[1].scale_status = "retired";
    if (issue === "changed-snapshot-version") sources[1].snapshot = { scale: { ...childScale, version: "different" } };
    await expect(startSyntheticRetake(actor, family, input)).rejects.toMatchObject({ status: 409 });
    expect(writes()).toHaveLength(0);
  });
  it("keeps current age and role eligibility", async () => {
    vi.mocked(ageAt).mockReturnValue(3);
    await expect(startSyntheticRetake(actor, family, input)).rejects.toMatchObject({ code: "INELIGIBLE" });
    expect(writes()).toHaveLength(0);
  });
  it("does not reuse a successor with different pinned members or versions", async () => {
    await startSyntheticRetake(actor, family, input);
    newSources[1].scale_version_id = "different@1.0.0";
    const before = writes().length;
    await expect(startSyntheticRetake(actor, family, input)).rejects.toMatchObject({ code: "SYNTHETIC_RETAKE_CONFLICT" });
    expect(writes()).toHaveLength(before);
  });
  it("only exposes capability for a ready latest published round", async () => {
    expect(await syntheticRetakeCapability(actor, family)).toEqual({ previousRoundId: previous });
    await startSyntheticRetake(actor, family, input);
    expect(await syntheticRetakeCapability(actor, family)).toBeNull();
    expect(await syntheticRetakeCapability({ ...actor, sessionMethod: undefined }, family)).toBeNull();
  });
});
