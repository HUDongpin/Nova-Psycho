// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Locale, Session, User } from "../src/components/api";
vi.mock("../src/components/localized-clerk-provider", () => ({ useIdentityAuth: () => ({ enabled: true, signOut: async () => undefined, manageAccount: () => undefined }) }));
import NovaApp from "../src/components/nova-app";

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); document.body.replaceChildren();
});

const signedOut: Session = { user: null, region: "HK", mode: "service", authProvider: "clerk", identityState: "signed_out", testAccountLoginEnabled: true, demoAccounts: [], siblingUrl: null };
const user: User = { id: "synthetic-parent", name: "Synthetic private parent", role: "parent", region: "HK" };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

async function renderApp(locale: Locale, initialSession = signedOut) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.setItem("nova-locale", locale); window.history.replaceState(null, "", "/");
  let nextSession: Promise<Response> | undefined;
  let nextPrivacy: Promise<Response> | undefined;
  let workspaceUser = initialSession.user;
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://localhost"); requests.push(url.pathname);
    if (url.pathname === "/api/session") {
      const response = await (nextSession ?? Response.json(initialSession));
      if (response.ok) workspaceUser = (await response.clone().json() as Session).user;
      return response;
    }
    if (url.pathname === "/api/privacy") return nextPrivacy ?? Response.json({ version: "nova-privacy-synthetic", title: url.searchParams.get("locale") === "zh-HK" ? "私隱說明" : "隐私说明", sections: [{ title: "Synthetic public policy", body: "Public notice only" }] });
    if (url.pathname === "/api/auth/test-login") return Response.json({ error: "Synthetic invalid credentials", code: "INVALID_CREDENTIALS" }, { status: 401 });
    if (url.pathname === "/api/workspace") return Response.json({ user: workspaceUser, region: "HK", mode: "service", families: [], assessments: [], reports: [], goals: [], observations: [], scales: [], staff: [], contentVersions: [], alerts: [], staffNotes: [], summary: {} });
    throw new Error(`Unexpected request ${url.pathname}`);
  }));
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(createElement(NovaApp)));
  return { host, requests, delaySession() { const pending = deferred<Response>(); nextSession = pending.promise; return pending; }, delayPrivacy() { const pending = deferred<Response>(); nextPrivacy = pending.promise; return pending; } };
}

describe("privacy during identity verification", () => {
  it.each(["zh-CN", "zh-HK"] as const)("keeps an open public notice mounted through a signed-out refresh in %s", async locale => {
    const { host, requests, delaySession } = await renderApp(locale);
    const opener = host.querySelector<HTMLButtonElement>(".login-privacy")!;
    opener.focus(); await act(async () => opener.click());
    const dialog = host.querySelector<HTMLDialogElement>("dialog")!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain("nova-privacy-synthetic");
    const pending = delaySession();
    await act(async () => { window.dispatchEvent(new Event("nova-identity-change")); });
    expect(host.querySelector("dialog"), "Public notice must survive pending identity verification").toBe(dialog);
    expect(host.querySelector<HTMLButtonElement>(".test-account-login .button.primary")?.disabled).toBe(true);
    await act(async () => { host.querySelector(".test-account-login form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(requests).not.toContain("/api/auth/test-login");
    await act(async () => pending.resolve(Response.json(signedOut)));
    expect(host.querySelector("dialog")).toBe(dialog);
    expect(dialog.open).toBe(true);
    expect(requests.filter(path => path === "/api/privacy")).toHaveLength(1);
    await act(async () => dialog.querySelector<HTMLButtonElement>(".modal-header button")!.click());
    expect(host.querySelector("dialog")).toBeNull();
    expect(document.activeElement).toBe(host.querySelector(".login-privacy"));
  });

  it("shows a retry when signed-out verification fails and lets the notice close", async () => {
    const { host, delaySession } = await renderApp("zh-HK");
    await act(async () => host.querySelector<HTMLButtonElement>(".login-privacy")!.click());
    const pending = delaySession();
    await act(async () => { window.dispatchEvent(new Event("nova-identity-change")); });
    await act(async () => pending.resolve(Response.json({ error: "Synthetic identity unavailable" }, { status: 503 })));
    const dialog = host.querySelector<HTMLDialogElement>("dialog");
    expect(dialog).not.toBeNull();
    await act(async () => dialog!.querySelector<HTMLButtonElement>(".modal-header button")!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Synthetic identity unavailable");
    const retry = Array.from(host.querySelectorAll("button")).find(button => button.textContent?.includes("重新載入"));
    expect(retry).toBeDefined();
    const recovered = delaySession(); recovered.resolve(Response.json(signedOut));
    await act(async () => retry!.click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>(".test-account-login .button.primary")?.disabled).toBe(false);
  });

  it("keeps the first privacy click while both policy and identity responses are pending", async () => {
    const { host, requests, delaySession, delayPrivacy } = await renderApp("zh-HK");
    const policy = delayPrivacy();
    await act(async () => host.querySelector<HTMLButtonElement>(".login-privacy")!.click());
    const dialog = host.querySelector<HTMLDialogElement>("dialog")!;
    expect(dialog.querySelector('[role="status"]')).not.toBeNull();
    const pending = delaySession();
    await act(async () => { window.dispatchEvent(new Event("nova-identity-change")); });
    expect(host.querySelector("dialog")).toBe(dialog);
    await act(async () => pending.resolve(Response.json(signedOut)));
    await act(async () => policy.resolve(Response.json({ version: "nova-privacy-delayed", title: "私隱說明", sections: [] })));
    expect(host.querySelector("dialog")).toBe(dialog);
    expect(dialog.textContent).toContain("nova-privacy-delayed");
    expect(requests.filter(path => path === "/api/privacy")).toHaveLength(1);
  });

  it("preserves an existing login error through a signed-out identity refresh", async () => {
    const { host, delaySession } = await renderApp("zh-HK");
    host.querySelector<HTMLInputElement>('input[name="username"]')!.value = "synthetic-invalid";
    host.querySelector<HTMLInputElement>('input[name="password"]')!.value = "Synthetic_Not_A_Credential";
    await act(async () => { host.querySelector(".test-account-login form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Synthetic invalid credentials");
    const pending = delaySession();
    await act(async () => { window.dispatchEvent(new Event("nova-identity-change")); });
    await act(async () => pending.resolve(Response.json(signedOut)));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Synthetic invalid credentials");
  });

  it("removes signed-out credentials and the notice when a different identity is verified", async () => {
    const { host, delaySession } = await renderApp("zh-HK");
    const input = host.querySelector<HTMLInputElement>('.test-account-login input[name="username"]')!;
    input.value = "synthetic-old-login";
    await act(async () => host.querySelector<HTMLButtonElement>(".login-privacy")!.click());
    const pending = delaySession();
    await act(async () => { window.dispatchEvent(new Event("nova-identity-change")); });
    expect(host.querySelector<HTMLButtonElement>(".test-account-login .button.primary")?.disabled).toBe(true);
    await act(async () => pending.resolve(Response.json({ ...signedOut, user, identityState: "ready" })));
    expect(input.isConnected).toBe(false);
    expect(host.querySelector("dialog")).toBeNull();
    expect(host.querySelector(".login-page")).toBeNull();
    expect(host.querySelector(".app-shell")).not.toBeNull();
  });

  it("unmounts unfinished profile inputs during an identity change", async () => {
    const { host, delaySession } = await renderApp("zh-HK", { ...signedOut, identityState: "profile_required" });
    await act(async () => host.querySelector<HTMLButtonElement>(".entry-door-parent")!.click());
    const input = host.querySelector<HTMLInputElement>('input[name="name"]')!;
    expect(input).not.toBeNull(); input.value = "Synthetic previous profile";
    const pending = delaySession();
    await act(async () => { window.dispatchEvent(new Event("nova-identity-change")); });
    expect(input.isConnected).toBe(false);
    expect(host.querySelector(".login-page")).toBeNull();
    await act(async () => pending.resolve(Response.json(signedOut)));
  });

  it("hides protected UI immediately and keeps a failed identity read recoverable", async () => {
    const { host, delaySession } = await renderApp("zh-HK", { ...signedOut, user, identityState: "ready" });
    expect(host.textContent).toContain(user.name);
    const pending = delaySession();
    await act(async () => { window.dispatchEvent(new Event("nova-identity-change")); });
    expect(host.querySelector(".app-shell")).toBeNull();
    expect(host.textContent).not.toContain(user.name);
    await act(async () => pending.resolve(Response.json({ error: "Synthetic identity unavailable" }, { status: 503 })));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Synthetic identity unavailable");
    expect(host.querySelector(".app-shell")).toBeNull();
    expect(Array.from(host.querySelectorAll("button")).some(button => button.textContent?.includes("重新載入"))).toBe(true);
  });
});
