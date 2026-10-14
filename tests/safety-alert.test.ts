import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
import { query, transaction } from "../src/lib/db";
import { acknowledgeSafetyAlert, resolveSafetyAlert } from "../src/lib/triad";
import { Dashboard, FamilyView } from "../src/components/workspace-views";
import type { Family, Workspace as ClientWorkspace } from "../src/components/api";
import type { Actor, Role } from "../src/domain/types";

const mockQuery = vi.mocked(query);
const mockTransaction = vi.mocked(transaction);
const FAMILY_ID = "22222222-3333-4444-8555-666666666666";
const ALERT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ACTOR_ID = "99999999-8888-4777-8666-555555555555";
const actor = (role: Role): Actor => ({ id: ACTOR_ID, name: "Synthetic", role, region: "CN" });

beforeEach(() => {
  vi.stubEnv("NOVA_REGION", "CN");
  vi.stubEnv("NOVA_MODE", "demo");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR", "work/test-private");
  vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
  mockQuery.mockReset();
  mockTransaction.mockReset();
  mockTransaction.mockImplementation((async (fn: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => fn({
    query: async (sql: string, params?: unknown[]) => ({ rows: await mockQuery(sql, params) })
  })) as never);
});
afterEach(() => vi.unstubAllEnvs());

const sqls = () => mockQuery.mock.calls.map(call => String(call[0]));
const OTHER_ID = "77777777-6666-4555-8444-333333333333";

function stage(options: { role?: Role; assignedTo?: string | null; resolvedAt?: Date | null; viewedAt?: Date | null; disabled?: boolean; userRole?: Role; family?: boolean; alert?: boolean } = {}) {
  const role = options.userRole ?? options.role ?? "staff";
  mockQuery.mockImplementation((async (sql: string) => {
    const text = String(sql);
    if (text.includes("FROM staff_alerts WHERE id=$1")) {
      if (options.alert === false) return [];
      return [{ id: ALERT_ID, family_id: FAMILY_ID, resolved_at: options.resolvedAt ?? null, viewed_at: options.viewedAt ?? null }];
    }
    if (text.includes("FROM families WHERE id=$1")) {
      if (options.family === false) return [];
      return [{ id: FAMILY_ID, region: "CN", assigned_to: options.assignedTo === undefined ? ACTOR_ID : options.assignedTo }];
    }
    if (text.includes("FROM users WHERE id=$1")) return [{ id: ACTOR_ID, role, region: "CN", disabled: options.disabled === true }];
    if (text.startsWith("UPDATE staff_alerts")) return [{ id: ALERT_ID }];
    return [];
  }) as never);
}

function expectLockedRecheckBeforeWrite() {
  const order = sqls();
  const unlocked = order.findIndex(sql => sql.includes("FROM staff_alerts") && !sql.includes("FOR UPDATE"));
  const familyLock = order.findIndex(sql => sql.includes("FROM families") && sql.includes("FOR UPDATE"));
  const userLock = order.findIndex(sql => sql.includes("FROM users") && sql.includes("FOR SHARE"));
  const alertLock = order.findIndex(sql => sql.includes("FROM staff_alerts") && sql.includes("FOR UPDATE"));
  const update = order.findIndex(sql => sql.startsWith("UPDATE"));
  expect(unlocked).toBeGreaterThanOrEqual(0);
  expect(familyLock).toBeGreaterThan(unlocked);
  expect(order[familyLock]).toContain("region=$2 FOR UPDATE");
  expect(userLock).toBeGreaterThan(familyLock);
  expect(alertLock).toBeGreaterThan(userLock);
  expect(update).toBeGreaterThan(alertLock);
  expect(mockTransaction).toHaveBeenCalledTimes(1);
}

describe("acknowledge safety alert", () => {
  it("refuses parents, students and teachers before looking anything up", async () => {
    for (const role of ["parent", "student", "teacher"] as const) {
      await expect(acknowledgeSafetyAlert(actor(role), ALERT_ID)).rejects.toMatchObject({ code: "ROLE_DENIED" });
    }
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });
  it("rejects a malformed id before querying", async () => {
    await expect(acknowledgeSafetyAlert(actor("staff"), "nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });
  it("returns not found when this region has no such alert", async () => {
    stage({ alert: false, role: "admin" });
    await expect(acknowledgeSafetyAlert(actor("admin"), ALERT_ID)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(sqls().some(sql => sql.startsWith("UPDATE"))).toBe(false);
  });
  it("does not mark an alert when the locked family is assigned to someone else", async () => {
    stage({ assignedTo: OTHER_ID });
    await expect(acknowledgeSafetyAlert(actor("staff"), ALERT_ID)).rejects.toMatchObject({ status: 403, code: "ROLE_DENIED" });
    expect(sqls().some(sql => sql.includes("FROM families") && sql.includes("FOR UPDATE"))).toBe(true);
    expect(sqls().some(sql => sql.startsWith("UPDATE"))).toBe(false);
    expect(sqls().some(sql => sql.includes("INSERT INTO audit_events"))).toBe(false);
  });
  it("returns not found when the family row is gone before the lock", async () => {
    stage({ family: false });
    await expect(acknowledgeSafetyAlert(actor("staff"), ALERT_ID)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(sqls().some(sql => sql.startsWith("UPDATE"))).toBe(false);
  });
  it("lets regional staff acknowledge an unassigned family's open alert", async () => {
    stage({ assignedTo: null });
    await expect(acknowledgeSafetyAlert(actor("staff"), ALERT_ID)).resolves.toEqual({ ok: true });
    expectLockedRecheckBeforeWrite();
    expect(mockQuery.mock.calls.find(call => String(call[0]).startsWith("UPDATE staff_alerts"))?.[1]).toEqual([ACTOR_ID, ALERT_ID, "CN"]);
  });
  it("records who viewed an open alert", async () => {
    stage();
    await expect(acknowledgeSafetyAlert(actor("staff"), ALERT_ID)).resolves.toEqual({ ok: true });
    const update = mockQuery.mock.calls.find(call => String(call[0]).startsWith("UPDATE staff_alerts"));
    expect(update?.[1]).toEqual([ACTOR_ID, ALERT_ID, "CN"]);
    const recorded = mockQuery.mock.calls.find(call => String(call[0]).includes("INSERT INTO audit_events"));
    expect(recorded?.[1]).toEqual(["CN", ACTOR_ID, "safety.viewed", ALERT_ID]);
  });
  it("does not write again when the alert was already viewed", async () => {
    stage({ role: "admin", viewedAt: new Date("2026-10-06T00:00:00Z") });
    await expect(acknowledgeSafetyAlert(actor("admin"), ALERT_ID)).resolves.toEqual({ ok: true });
    expect(sqls().some(sql => sql.startsWith("UPDATE"))).toBe(false);
    expect(sqls().some(sql => sql.includes("INSERT INTO audit_events"))).toBe(false);
  });
  it("refuses when the locked alert no longer belongs to that family", async () => {
    let locked = false;
    mockQuery.mockImplementation((async (sql: string) => {
      const text = String(sql);
      if (text.includes("FROM staff_alerts") && text.includes("FOR UPDATE")) return [{ id: ALERT_ID, family_id: OTHER_ID, resolved_at: null, viewed_at: null }];
      if (text.includes("FROM staff_alerts")) return [{ family_id: FAMILY_ID }];
      if (text.includes("FROM families WHERE id=$1")) { locked = true; return [{ id: FAMILY_ID, region: "CN", assigned_to: ACTOR_ID }]; }
      if (text.includes("FROM users WHERE id=$1")) return [{ id: ACTOR_ID, role: "staff", region: "CN", disabled: false }];
      if (text.startsWith("UPDATE staff_alerts")) return [{ id: ALERT_ID }];
      return [];
    }) as never);
    await expect(acknowledgeSafetyAlert(actor("staff"), ALERT_ID)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(locked).toBe(true);
    const familyLock = sqls().findIndex(sql => sql.includes("FROM families") && sql.includes("FOR UPDATE"));
    const alertLock = sqls().findIndex(sql => sql.includes("FROM staff_alerts") && sql.includes("FOR UPDATE"));
    expect(alertLock).toBeGreaterThan(familyLock);
    expect(sqls().some(sql => sql.startsWith("UPDATE"))).toBe(false);
  });
  it("refuses a disabled account after locking the actor row", async () => {
    stage({ disabled: true });
    await expect(acknowledgeSafetyAlert(actor("staff"), ALERT_ID)).rejects.toMatchObject({ status: 403, code: "ACCOUNT_REVOKED" });
    expect(sqls().some(sql => sql.startsWith("UPDATE"))).toBe(false);
  });
});

describe("resolve safety alert", () => {
  it("refuses parents, students and teachers before looking anything up", async () => {
    for (const role of ["parent", "student", "teacher"] as const) {
      await expect(resolveSafetyAlert(actor(role), ALERT_ID)).rejects.toMatchObject({ code: "ROLE_DENIED" });
    }
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });
  it("rejects a malformed id before querying", async () => {
    await expect(resolveSafetyAlert(actor("admin"), "nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it("returns not found when this region has no such alert", async () => {
    stage({ alert: false, role: "admin" });
    await expect(resolveSafetyAlert(actor("admin"), ALERT_ID)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(sqls().some(sql => sql.startsWith("UPDATE"))).toBe(false);
  });
  it("does not resolve an alert when the locked family is assigned to someone else", async () => {
    stage({ assignedTo: OTHER_ID });
    await expect(resolveSafetyAlert(actor("staff"), ALERT_ID)).rejects.toMatchObject({ status: 403, code: "ROLE_DENIED" });
    const familyLock = sqls().findIndex(sql => sql.includes("FROM families") && sql.includes("FOR UPDATE"));
    const update = sqls().findIndex(sql => sql.startsWith("UPDATE"));
    expect(familyLock).toBeGreaterThanOrEqual(0);
    expect(update).toBe(-1);
    expect(sqls().some(sql => sql.includes("INSERT INTO audit_events"))).toBe(false);
  });
  it("returns not found when the family row is gone", async () => {
    stage({ family: false });
    await expect(resolveSafetyAlert(actor("staff"), ALERT_ID)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(sqls().some(sql => sql.startsWith("UPDATE"))).toBe(false);
  });
  it("lets regional staff close an unassigned family's open alert", async () => {
    stage({ assignedTo: null });
    await expect(resolveSafetyAlert(actor("staff"), ALERT_ID)).resolves.toEqual({ ok: true });
    expectLockedRecheckBeforeWrite();
    expect(mockQuery.mock.calls.find(call => String(call[0]).startsWith("UPDATE staff_alerts"))?.[1]).toEqual([ACTOR_ID, ALERT_ID, "CN"]);
    expect(mockQuery.mock.calls.find(call => String(call[0]).includes("INSERT INTO audit_events"))?.[1]).toEqual(["CN", ACTOR_ID, "safety.resolved", ALERT_ID]);
  });
  it("lets the assigned staff member close the alert", async () => {
    stage();
    await expect(resolveSafetyAlert(actor("staff"), ALERT_ID)).resolves.toEqual({ ok: true });
    const update = mockQuery.mock.calls.find(call => String(call[0]).startsWith("UPDATE staff_alerts"));
    expect(String(update?.[0])).toContain("resolved_at=now()");
    expect(String(update?.[0])).toContain("resolved_at IS NULL");
    expect(update?.[1]).toEqual([ACTOR_ID, ALERT_ID, "CN"]);
    expect(mockQuery.mock.calls.find(call => String(call[0]).includes("INSERT INTO audit_events"))?.[1]).toEqual(["CN", ACTOR_ID, "safety.resolved", ALERT_ID]);
  });
  it("lets an administrator close an alert assigned to someone else", async () => {
    stage({ role: "admin", assignedTo: OTHER_ID });
    await expect(resolveSafetyAlert(actor("admin"), ALERT_ID)).resolves.toEqual({ ok: true });
    expect(mockQuery.mock.calls.find(call => String(call[0]).includes("INSERT INTO audit_events"))?.[1]).toEqual(["CN", ACTOR_ID, "safety.resolved", ALERT_ID]);
  });
  it("does not write again when the alert is already resolved", async () => {
    stage({ resolvedAt: new Date("2026-10-08T00:00:00Z") });
    await expect(resolveSafetyAlert(actor("staff"), ALERT_ID)).resolves.toEqual({ ok: true });
    expect(sqls().some(sql => sql.startsWith("UPDATE"))).toBe(false);
    expect(sqls().some(sql => sql.includes("INSERT INTO audit_events"))).toBe(false);
  });
  it("refuses fallback staff once the locked alert is already resolved", async () => {
    stage({ assignedTo: null, resolvedAt: new Date("2026-10-08T00:00:00Z") });
    await expect(resolveSafetyAlert(actor("staff"), ALERT_ID)).rejects.toMatchObject({ status: 403, code: "ROLE_DENIED" });
    expect(sqls().some(sql => sql.startsWith("UPDATE"))).toBe(false);
  });
  it("refuses when the locked actor row is no longer staff", async () => {
    stage({ userRole: "parent" });
    await expect(resolveSafetyAlert(actor("staff"), ALERT_ID)).rejects.toMatchObject({ status: 409, code: "ROLE_CONFLICT" });
    expect(sqls().some(sql => sql.startsWith("UPDATE"))).toBe(false);
  });
});

const clientFamily = (over: Partial<Family> = {}): ClientWorkspace["families"][number] => ({
  id: FAMILY_ID, familyName: "合成家庭", childName: "小林", age: 12, birthDate: "2014-01-02", grade: "小学", region: "CN", guardianLabel: "母亲", assignedTo: null, canInviteMembers: false, createdAt: "2026-01-01T00:00:00.000Z", consent: true, members: [], ...over,
});
const clientWorkspace = (role: Role, alerts: ClientWorkspace["alerts"]): ClientWorkspace => ({
  user: { id: ACTOR_ID, name: "合成人员", role, region: "CN" }, region: "CN", mode: "demo", families: [clientFamily()], assessments: [], reports: [], scales: [], goals: [], observations: [], staff: [], contentVersions: [], alerts, staffNotes: [], summary: {},
});
const openAlert = { id: ALERT_ID, familyId: FAMILY_ID, childName: "小林", createdAt: "2026-10-06T00:00:00.000Z" };
const markup = (node: ReactNode) => renderToStaticMarkup(node);

describe("safety alert controls", () => {
  it("lists an unassigned family's alert for staff", () => {
    const html = markup(createElement(Dashboard, { workspace: clientWorkspace("staff", [openAlert]), locale: "zh-CN", navigate: () => undefined, openForm: () => undefined, onRefresh: async () => undefined }));
    expect(clientWorkspace("staff", [openAlert]).families[0].assignedTo).toBeNull();
    expect(html).toContain("需要人工查看");
    expect(html).toContain("小林");
  });
  it("puts 已查看 next to the child name on the workbench", () => {
    const html = markup(createElement(Dashboard, { workspace: clientWorkspace("staff", [openAlert]), locale: "zh-CN", navigate: () => undefined, openForm: () => undefined, onRefresh: async () => undefined }));
    expect(html).toContain("小林");
    expect(html).toContain("已查看");
    expect(html).toContain(`已查看 · 小林`);
  });
  it("hides the workbench prompt when there is no open alert", () => {
    const html = markup(createElement(Dashboard, { workspace: clientWorkspace("staff", []), locale: "zh-CN", navigate: () => undefined, openForm: () => undefined, onRefresh: async () => undefined }));
    expect(html).not.toContain("已查看");
    expect(html).not.toContain("需要人工查看");
  });
  it("offers 已查看 on the family archive for staff", () => {
    const workspace = clientWorkspace("staff", [openAlert]);
    const html = markup(createElement(FamilyView, { workspace, family: workspace.families[0], locale: "zh-CN", navigate: () => undefined, openForm: () => undefined, onRefresh: async () => undefined, openPrivacy: () => undefined }));
    expect(html).toContain("已查看");
    expect(html).toContain("直到结案");
  });
  it("does not offer 已查看 to a parent", () => {
    const workspace = clientWorkspace("parent", [openAlert]);
    const html = markup(createElement(FamilyView, { workspace, family: workspace.families[0], locale: "zh-CN", navigate: () => undefined, openForm: () => undefined, onRefresh: async () => undefined, openPrivacy: () => undefined }));
    expect(html).not.toContain("已查看");
    expect(html).not.toContain("已处理");
  });
  it("keeps an acknowledged alert on the workbench without asking to acknowledge it again", () => {
    const html = markup(createElement(Dashboard, { workspace: clientWorkspace("staff", [{ ...openAlert, viewedAt: "2026-10-07T00:00:00.000Z" }]), locale: "zh-CN", navigate: () => undefined, openForm: () => undefined, onRefresh: async () => undefined }));
    expect(html).toContain("需要人工查看");
    expect(html).toContain("小林");
    expect(html).not.toContain("已查看 · 小林");
  });
  it("shows an assigned family's alert to other staff without a detail link or acknowledge button", () => {
    const workspace = clientWorkspace("staff", [openAlert]);
    workspace.families = [];
    const html = markup(createElement(Dashboard, { workspace, locale: "zh-CN", navigate: () => undefined, openForm: () => undefined, onRefresh: async () => undefined }));
    expect(html).toContain("小林");
    expect(html).toContain("需要人工查看");
    expect(html).not.toContain("已查看");
    expect(html).not.toContain("母亲");
    expect(html).not.toContain(`class="text-link">小林`);
  });
  it("lets unassigned-family fallback staff close the alert from the family archive", () => {
    const workspace = clientWorkspace("staff", [openAlert]);
    const html = markup(createElement(FamilyView, { workspace, family: workspace.families[0], locale: "zh-CN", navigate: () => undefined, openForm: () => undefined, onRefresh: async () => undefined, openPrivacy: () => undefined }));
    expect(workspace.families[0].assignedTo).toBeNull();
    expect(html).toContain("已查看");
    expect(html).toContain("已处理");
    expect(html).toContain("没有负责人的同事不能再查看");
  });
  it("offers 已处理 to an administrator, including after acknowledgement", () => {
    const viewed = clientWorkspace("admin", [{ ...openAlert, viewedAt: "2026-10-07T00:00:00.000Z" }]);
    const html = markup(createElement(FamilyView, { workspace: viewed, family: viewed.families[0], locale: "zh-CN", navigate: () => undefined, openForm: () => undefined, onRefresh: async () => undefined, openPrivacy: () => undefined }));
    expect(html).toContain("已处理");
    expect(html).toContain("没有负责人的同事不能再查看");
    expect(html).not.toContain("已查看");
  });
  it("offers 已处理 to the assigned staff member", () => {
    const workspace = clientWorkspace("staff", [openAlert]);
    workspace.families[0] = clientFamily({ assignedTo: ACTOR_ID });
    const html = markup(createElement(FamilyView, { workspace, family: workspace.families[0], locale: "zh-HK", navigate: () => undefined, openForm: () => undefined, onRefresh: async () => undefined, openPrivacy: () => undefined }));
    expect(html).toContain("已處理");
    expect(html).toContain("沒有負責人的同事不能再查看");
  });
});
