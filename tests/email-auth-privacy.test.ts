import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const identity = vi.hoisted(() => ({ enabled: false, signOut: async () => undefined, manageAccount: () => undefined }));
vi.mock("../src/components/localized-clerk-provider", () => ({ useIdentityAuth: () => identity }));
import { EmailAuthPage } from "../src/components/email-auth";
import { LocaleContext } from "../src/components/ui";
beforeEach(() => { identity.enabled = false; });

describe("email authentication privacy disclosure", () => {
  it.each([
    ["sign-in", "zh-CN"], ["sign-up", "zh-CN"],
    ["sign-in", "zh-HK"], ["sign-up", "zh-HK"],
  ] as const)("provides the %s disclosure and policy control only with Clerk enabled in %s", (mode, locale) => {
    const render = () => renderToStaticMarkup(createElement(LocaleContext.Provider, { value: locale }, createElement(EmailAuthPage, { mode })));
    expect(render()).not.toContain("Clerk");
    identity.enabled = true;
    const html = render();
    expect(html).toContain(locale === "zh-HK" ? "身分資料在美國託管" : "身份数据在美国托管");
    expect(html).toContain(locale === "zh-HK" ? "家庭資料、答案及報告" : "家庭资料、答案和报告");
    expect(html).toContain(`<button type="button" class="text-link">${locale === "zh-HK" ? "私隱與知情同意" : "隐私与知情同意"}</button>`);
  });
});
