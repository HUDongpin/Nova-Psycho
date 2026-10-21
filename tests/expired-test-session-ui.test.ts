// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/components/localized-clerk-provider", () => ({ useIdentityAuth: () => ({ enabled: true, signOut: async () => undefined, manageAccount: () => undefined }) }));
import NovaApp from "../src/components/nova-app";
import { AccountDraftStore } from "../src/components/account-drafts";
import type { User } from "../src/components/api";
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); document.body.replaceChildren(); });
describe("expired test session recovery", () => {
  it.each([["zh-CN", "test"], ["zh-HK", "test"], ["zh-CN", undefined], ["zh-HK", undefined]] as const)("shows the appropriate recovery controls after a 401 in %s (%s)", async (locale, sessionMethod) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.setItem("nova-locale", locale);
    window.location.hash = "#dashboard";
    const user = { id: "synthetic-parent", name: "Synthetic private parent", role: "parent", region: "HK" };
    let expired = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/session") return Response.json({ user, region: "HK", mode: "service", authProvider: "clerk", identityState: "ready", sessionMethod, testAccountLoginEnabled: true, demoAccounts: [], siblingUrl: null });
      if (path === "/api/workspace") return expired
        ? Response.json({ error: "Session expired", code: "UNAUTHENTICATED" }, { status: 401 })
        : Response.json({ user, region: "HK", mode: "service", families: [], assessments: [], reports: [], goals: [], observations: [], scales: [], staff: [], contentVersions: [], alerts: [], staffNotes: [], summary: { families: 0, pendingAssessments: 0, publishedReports: 0, activeGoals: 0, riskReports: 0 } });
      throw new Error(`Unexpected request ${path}`);
    }));
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => root!.render(createElement(NovaApp)));
    expect(host.querySelector(".sidebar-user")?.textContent).toContain(user.name);
    expired = true;
    await act(async () => (host.querySelector(".refresh-button") as HTMLButtonElement).click());
    expect(host.querySelector(".app-shell")).toBeNull();
    expect(host.textContent).not.toContain(user.name);
    if (sessionMethod === "test") {
      expect(host.querySelector('.test-account-login input[name="username"]')).not.toBeNull();
      expect(host.querySelector('.test-account-login input[name="password"]')).not.toBeNull();
    } else {
      expect(host.querySelector(".test-account-login")).toBeNull();
      expect(host.textContent).toContain(locale === "zh-CN" ? "退出并更换账号" : "登出並更換帳號");
    }
  });
});

describe("return to retained draft owner", () => {
  it.each(["zh-CN", "zh-HK"] as const)("keeps private answers isolated and restores the login form in %s", async locale => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.setItem("nova-locale", locale); window.location.hash = "#dashboard";
    const parent: User = { id: "synthetic-parent", name: "Synthetic parent", role: "parent", region: "HK" };
    let user: User = parent;
    const activate = vi.spyOn(AccountDraftStore.prototype, "activate");
    const writes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (init?.method && init.method !== "GET") writes.push(path);
      if (path === "/api/session") return Response.json({ user, region: "HK", mode: "service", authProvider: "clerk", identityState: "ready", sessionMethod: "test", testAccountLoginEnabled: true, demoAccounts: [], siblingUrl: null });
      if (path === "/api/workspace") return Response.json({ user, region: "HK", mode: "service", families: [], assessments: [], reports: [], goals: [], observations: [], scales: [], staff: [], contentVersions: [], alerts: [], staffNotes: [], summary: {} });
      throw new Error(`Unexpected request ${path}`);
    }));
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => root!.render(createElement(NovaApp)));
    const store = activate.mock.contexts[0];
    if (!(store instanceof AccountDraftStore)) throw new Error("Expected the mounted app draft store");
    const draft = store.remember(parent, { id: "retained", status: "pending", childName: "Synthetic child", scaleTitle: "Synthetic", demo: true, description: "", surveyJson: {}, draftAnswers: {}, draftRevision: 0, consentRequired: false });
    const privateAnswer = "Synthetic parent-only unsaved answer";
    await act(async () => {
      draft.setAcknowledged(true, locale); draft.update({ q1: privateAnswer }, locale);
      user = { id: "synthetic-student", name: "Synthetic student", role: "student", region: "HK" };
      window.dispatchEvent(new Event("nova-identity-change"));
    });
    expect(store.state).toBe("mismatch");
    expect(host.querySelector(".draft-account-mismatch")).not.toBeNull();
    expect(host.textContent).not.toContain(privateAnswer);
    const returnButton = Array.from(host.querySelectorAll("button")).find(button => button.textContent === (locale === "zh-CN" ? "使用原账号重新登录" : "使用原帳號重新登入"));
    expect(returnButton).toBeDefined();
    await act(async () => returnButton!.click());
    expect(host.querySelector('.test-account-login input[name="username"]')).not.toBeNull();
    expect(host.querySelector('.test-account-login input[name="password"]')).not.toBeNull();
    expect(host.textContent).not.toContain(privateAnswer);
    expect(draft.getSnapshot().answers).toEqual({ q1: privateAnswer });
    expect(store.hasUnsavedChanges()).toBe(true);
    expect(writes).toEqual([]);
  });
});
