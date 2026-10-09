import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("../src/components/localized-clerk-provider", () => ({ useIdentityAuth: () => ({ enabled: true, signOut: async () => undefined, manageAccount: () => undefined }) }));
import { Login } from "../src/components/login";
import type { Session } from "../src/components/api";

const session: Session = { user: null, region: "HK", mode: "service", demoAccounts: [], siblingUrl: null, authProvider: "clerk", identityState: "signed_out" };

describe("test account login entry", () => {
  it.each(["zh-CN", "zh-HK"] as const)("shows password login alongside email entry only when enabled in %s", locale => {
    const render = (enabled: boolean) => renderToStaticMarkup(createElement(Login, { session: { ...session, testAccountLoginEnabled: enabled }, locale, setLocale: () => undefined, onLogin: async () => undefined }));
    expect(render(false)).not.toContain('name="password"');
    const html = render(true);
    expect(html).toContain('name="username"');
    expect(html).toContain('type="password"');
    expect(html).toContain(locale === "zh-HK" ? "測試帳號登入" : "测试账号登录");
    expect(html).toContain('href="/sign-in"');
    expect(html).toContain('href="/sign-up"');
    expect(html).not.toContain("Clerk");
  });
  it("does not offer test login over a signed-in email identity", () => {
    const html = renderToStaticMarkup(createElement(Login, { session: { ...session, identityState: "email_unverified", testAccountLoginEnabled: true }, locale: "zh-CN", setLocale: () => undefined, onLogin: async () => undefined }));
    expect(html).not.toContain('name="password"');
  });
});
