import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type Session, type Workspace } from "../src/components/api";
import { TriadEntry } from "../src/components/triad-entry";
import { FamilyEntry } from "../src/components/family-entry";
import { FamilyView } from "../src/components/workspace-views";
import { Login } from "../src/components/login";
import { clearPendingInvitation, pendingInvitation } from "../src/components/link-token";

const common = { locale: "zh-CN" as const, onBack() {}, async onDone() {}, openPrivacy() {} };
afterEach(() => vi.unstubAllGlobals());
describe("separate account and family forms", () => {
  it.each(["parent", "teacher"] as const)("lets a local %s register without a family code or child record", door => {
    const html = renderToStaticMarkup(createElement(TriadEntry, { ...common, door }));
    expect(html).toContain('name="name"'); expect(html).toContain('name="username"'); expect(html).toContain('name="password"');
    expect(html).not.toContain('name="code"'); expect(html).not.toContain('name="childName"');
    expect(html).toContain("已有账号？请登录后加入家庭");
  });
  it("requires a family invitation for student profile creation and leaves credentials with Clerk", () => {
    const html = renderToStaticMarkup(createElement(TriadEntry, { ...common, door: "student", authProvider: "clerk" }));
    expect(html).toContain('name="code"'); expect(html).toContain('name="name"');
    expect(html).not.toContain('name="username"'); expect(html).not.toContain('name="password"');
    expect(html).toContain("请输入家长提供的完整家庭编号");
  });
  it("gives an unassigned teacher an actionable empty workspace without requesting another identity", () => {
    const html = renderToStaticMarkup(createElement(FamilyEntry, { ...common, user: { id: "t", name: "教师", role: "teacher", region: "CN" }, hasFamilies: false }));
    expect(html).toContain("尚未加入家庭"); expect(html).toContain('name="code"');
    expect(html).not.toContain('name="username"'); expect(html).not.toContain('name="password"'); expect(html).not.toContain('name="name"');
  });
  it("keeps joining another family available for an existing teacher", () => {
    const html = renderToStaticMarkup(createElement(FamilyEntry, { ...common, user: { id: "t", name: "教师", role: "teacher", region: "CN" }, hasFamilies: true }));
    expect(html).toContain("加入另一个家庭"); expect(html).toContain("加入家庭");
  });
  it("uses provider-specific signed-out controls", () => {
    const session: Session = { user: null, region: "CN", mode: "service", demoAccounts: [], siblingUrl: null, authProvider: "clerk", identityState: "signed_out" };
    const html = renderToStaticMarkup(createElement(Login, { session, locale: "zh-CN", setLocale() {}, async onLogin() {} }));
    expect(html).toContain('href="/sign-up"'); expect(html).toContain('href="/sign-in"'); expect(html).not.toContain('name="password"');
  });
  it.each(["zh-CN", "zh-HK"] as const)("omits the removed identity hosting paragraph in %s", locale => {
    for (const authProvider of ["local", "clerk"] as const) {
      const session: Session = { user: null, region: "HK", mode: "service", demoAccounts: [], siblingUrl: null, authProvider, identityState: "signed_out" };
      const html = renderToStaticMarkup(createElement(Login, { session, locale, setLocale() {}, async onLogin() {} }));
      expect(html).not.toContain("Clerk");
      expect(html).not.toContain(locale === "zh-HK" ? "身分資料在美國託管" : "身份数据在美国托管");
    }
  });
  it("keeps retained drafts on their current page when authenticating with Clerk", () => {
    const session: Session = { user: null, region: "CN", mode: "service", demoAccounts: [], siblingUrl: null, authProvider: "clerk", identityState: "signed_out" };
    const html = renderToStaticMarkup(createElement(Login, { session, locale: "zh-CN", setLocale() {}, async onLogin() {}, recovery: { mismatch: false, onReturn() {}, async onDiscard() {} } }));
    expect(html).toContain('href="/sign-in" target="_blank" rel="noopener noreferrer"'); expect(html).toContain("我已验证，继续");
  });
});
describe("invitation persistence stays bounded and local", () => {
  function storage(value: string | null) { const removeItem = vi.fn(); vi.stubGlobal("sessionStorage", { getItem: () => value, removeItem }); return removeItem; }
  it("recovers a valid same-tab token without placing it into a URL", () => {
    storage(JSON.stringify({ token: "test-invitation", expiresAt: Date.now() + 10000 })); expect(pendingInvitation()).toBe("test-invitation");
  });
  it("discards expired or malformed invitation state", () => {
    const remove = storage(JSON.stringify({ token: "test-invitation", expiresAt: Date.now() - 1 })); expect(pendingInvitation()).toBeNull(); expect(remove).toHaveBeenCalled();
    storage("{broken"); expect(pendingInvitation()).toBeNull();
  });
  it("clears consumed invitation state and tolerates blocked storage", () => {
    const remove = storage(null); clearPendingInvitation(); expect(remove).toHaveBeenCalled();
    vi.stubGlobal("sessionStorage", { getItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } });
    expect(pendingInvitation()).toBeNull(); expect(() => clearPendingInvitation()).not.toThrow();
  });
});
it("preserves server field errors for the relevant input", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "编号格式不正确", code: "INVALID_JOIN_CODE_FORMAT", field: "code" }), { status: 422 })));
  await expect(api("/api/triad/join", "zh-CN")).rejects.toMatchObject({ status: 422, code: "INVALID_JOIN_CODE_FORMAT", field: "code" });
});

describe("recovery controls follow the active identity provider", () => {
  it.each(["local", "clerk"] as const)("renders only the supported recovery action for %s", authProvider => {
    const family = { id: "f", familyName: "Synthetic family", childName: "Synthetic child", age: 12, birthDate: "2014-01-01", grade: "小学", region: "CN" as const, guardianLabel: "Parent", assignedTo: null, createdAt: "2026-01-01T00:00:00Z", consent: true, members: [{ id: "p", name: "Parent", role: "parent" as const }], canInviteMembers: true };
    const workspace: Workspace = { user: { id: "a", name: "Admin", role: "admin", region: "CN" }, region: "CN", mode: "demo", families: [family], assessments: [], reports: [], scales: [], goals: [], observations: [], staff: [], contentVersions: [], alerts: [], staffNotes: [], summary: {} };
    const html = renderToStaticMarkup(createElement(FamilyView, { family, workspace, locale: "zh-CN", authProvider, navigate() {}, openForm() {}, async onRefresh() {}, openPrivacy() {} }));
    if (authProvider === "clerk") { expect(html).toContain("请让账号本人在邮箱登录页"); expect(html).not.toContain('class="text-link">密码恢复</button>'); }
    else { expect(html).toContain('class="text-link">密码恢复</button>'); expect(html).not.toContain("请让账号本人在邮箱登录页"); }
  });
});
