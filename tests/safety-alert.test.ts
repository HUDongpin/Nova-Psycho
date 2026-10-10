import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../src/lib/db", () => ({ query: vi.fn() }));
import { query } from "../src/lib/db";
import { acknowledgeSafetyAlert } from "../src/lib/triad";
import { Dashboard, FamilyView } from "../src/components/workspace-views";
import type { Family, Workspace as ClientWorkspace } from "../src/components/api";
import type { Actor, Role } from "../src/domain/types";

const mockQuery = vi.mocked(query);
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
});
afterEach(() => vi.unstubAllEnvs());

const sqls = () => mockQuery.mock.calls.map(call => String(call[0]));
const familyRecord = { id: FAMILY_ID, region: "CN" as const, family_name: "Synthetic", child_name: "Synthetic child", birth_date: "2013-04-12", grade: "S2", guardian_label: "Mother", assigned_to: ACTOR_ID, created_at: new Date() };

describe("acknowledge safety alert", () => {
  it("refuses parents, students and teachers before looking anything up", async () => {
    for (const role of ["parent", "student", "teacher"] as const) {
      await expect(acknowledgeSafetyAlert(actor(role), ALERT_ID)).rejects.toMatchObject({ code: "ROLE_DENIED" });
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it("rejects a malformed id before querying", async () => {
    await expect(acknowledgeSafetyAlert(actor("staff"), "nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it("returns not found when this region has no such alert", async () => {
    mockQuery.mockImplementation((async () => []) as never);
    await expect(acknowledgeSafetyAlert(actor("admin"), ALERT_ID)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(sqls().some(sql => sql.startsWith("UPDATE"))).toBe(false);
  });
  it("does not mark an alert for a family the caller cannot reach", async () => {
    mockQuery.mockImplementation((async (sql: string) => {
      if (String(sql).includes("FROM staff_alerts WHERE id=$1")) return [{ id: ALERT_ID, family_id: FAMILY_ID, viewed_at: null }];
      return [];
    }) as never);
    await expect(acknowledgeSafetyAlert(actor("staff"), ALERT_ID)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(sqls().some(sql => sql.startsWith("UPDATE"))).toBe(false);
    expect(sqls().some(sql => sql.includes("safety.viewed"))).toBe(false);
  });
  it("records who viewed an open alert", async () => {
    mockQuery.mockImplementation((async (sql: string) => {
      const text = String(sql);
      if (text.includes("FROM staff_alerts WHERE id=$1")) return [{ id: ALERT_ID, family_id: FAMILY_ID, viewed_at: null }];
      if (text.includes("FROM families f WHERE f.id=$1")) return [familyRecord];
      if (text.startsWith("UPDATE staff_alerts")) return [{ id: ALERT_ID }];
      return [];
    }) as never);
    await expect(acknowledgeSafetyAlert(actor("staff"), ALERT_ID)).resolves.toEqual({ ok: true });
    const update = mockQuery.mock.calls.find(call => String(call[0]).startsWith("UPDATE staff_alerts"));
    expect(update?.[1]).toEqual([ACTOR_ID, ALERT_ID, "CN"]);
    const recorded = mockQuery.mock.calls.find(call => String(call[0]).includes("INSERT INTO audit_events"));
    expect(recorded?.[1]).toEqual(["CN", ACTOR_ID, "safety.viewed", ALERT_ID]);
  });
  it("does not write again when the alert was already viewed", async () => {
    mockQuery.mockImplementation((async (sql: string) => {
      const text = String(sql);
      if (text.includes("FROM staff_alerts WHERE id=$1")) return [{ id: ALERT_ID, family_id: FAMILY_ID, viewed_at: new Date("2026-10-06T00:00:00Z") }];
      if (text.includes("FROM families f WHERE f.id=$1")) return [familyRecord];
      return [];
    }) as never);
    await expect(acknowledgeSafetyAlert(actor("admin"), ALERT_ID)).resolves.toEqual({ ok: true });
    expect(sqls().some(sql => sql.startsWith("UPDATE"))).toBe(false);
    expect(sqls().some(sql => sql.includes("safety.viewed"))).toBe(false);
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
    expect(html).toContain("工作台上的提示会收起");
  });
  it("does not offer 已查看 to a parent", () => {
    const workspace = clientWorkspace("parent", [openAlert]);
    const html = markup(createElement(FamilyView, { workspace, family: workspace.families[0], locale: "zh-CN", navigate: () => undefined, openForm: () => undefined, onRefresh: async () => undefined, openPrivacy: () => undefined }));
    expect(html).not.toContain("已查看");
  });
});
