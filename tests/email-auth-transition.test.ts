// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mounted = vi.hoisted(() => ({ props: undefined as Record<string, unknown> | undefined }));
vi.mock("../src/components/localized-clerk-provider", () => ({ useIdentityAuth: () => ({ enabled: true }) }));
vi.mock("@clerk/nextjs", () => ({
  SignIn: (props: Record<string, unknown>) => { mounted.props = props; return createElement("div", { "data-auth-step": "sign-in" }); },
  SignUp: (props: Record<string, unknown>) => { mounted.props = props; return createElement("div", { "data-auth-step": "sign-up" }); },
}));
import { EmailAuthPage } from "../src/components/email-auth";

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  mounted.props = undefined; localStorage.clear(); sessionStorage.clear(); document.body.replaceChildren();
});

async function render(mode: "sign-in" | "sign-up") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(createElement(EmailAuthPage, { mode })));
  return host;
}

describe("email authentication inside the shared shell", () => {
  it.each(["sign-in", "sign-up"] as const)("waits for test-session cleanup before mounting %s", async mode => {
    let finish!: (response: Response) => void;
    const request = new Promise<Response>(resolve => { finish = resolve; });
    const fetcher = vi.fn(() => request); vi.stubGlobal("fetch", fetcher);
    const host = await render(mode);
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/api/auth/test-logout"), expect.objectContaining({ method: "POST" }));
    expect(host.querySelector("[data-auth-step]")).toBeNull();
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => finish(Response.json({ ok: true })));
    expect(host.querySelector("[data-auth-step]")?.getAttribute("data-auth-step")).toBe(mode);
    expect(mounted.props?.forceRedirectUrl).toBe("/");
    expect(mounted.props?.appearance).toBeDefined();
    expect(host.querySelectorAll("h1")).toHaveLength(1);
    expect(host.textContent?.includes("账号验证完成后")).toBe(mode === "sign-up");
  });

  it("does not mount provider authentication when test-session cleanup fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Synthetic cleanup failure", code: "UNAVAILABLE" }, { status: 503 })));
    const host = await render("sign-in");
    expect(host.querySelector("[data-auth-step]")).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Synthetic cleanup failure");
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector('a[href="/"]')).not.toBeNull();
  });

  it.each(["sign-in", "sign-up"] as const)("preserves the pending invitation across %s", async mode => {
    sessionStorage.setItem("nova-pending-invitation", JSON.stringify({ token: "synthetic-invitation-token", expiresAt: Date.now() + 60_000 }));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true })));
    const host = await render(mode);
    expect(mounted.props?.forceRedirectUrl).toBe("/invite");
    expect(mounted.props?.[mode === "sign-in" ? "signUpForceRedirectUrl" : "signInForceRedirectUrl"]).toBe("/invite");
    expect(host.querySelector('a[href="/invite"]')).not.toBeNull();
    expect(sessionStorage.getItem("nova-pending-invitation")).not.toBeNull();
  });
});
