import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { zhCN, zhTW } from "@clerk/localizations";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Locale } from "../src/components/api";

const captured = vi.hoisted(() => ({ localization: undefined as typeof zhCN | undefined }));
vi.mock("@clerk/nextjs", () => ({
  ClerkProvider: ({ children, localization }: { children: ReactNode; localization: typeof zhCN }) => {
    captured.localization = localization;
    return children;
  },
  useAuth: () => ({ isLoaded: false, sessionId: undefined }),
  useClerk: () => ({ signOut: async () => undefined, openUserProfile: () => undefined }),
}));
import { LocalizedClerkProvider } from "../src/components/localized-clerk-provider";

function resource(locale: Locale) {
  renderToStaticMarkup(createElement(LocalizedClerkProvider, {
    initialLocale: locale, publishableKey: "synthetic-placeholder", children: null,
  }));
  expect(captured.localization).toBeDefined();
  return captured.localization!;
}
beforeEach(() => { captured.localization = undefined; });

describe("Clerk Chinese authentication translations", () => {
  it.each([
    ["zh-CN", "请输入密码"],
    ["zh-HK", "輸入您的密碼"],
  ] as const)("provides the sign-in password placeholder for %s", (locale, expected) => {
    expect(resource(locale).formFieldInputPlaceholder__password).toBe(expected);
  });
  it.each([
    ["zh-CN", "设置密码"],
    ["zh-HK", "設定密碼"],
  ] as const)("provides the dedicated sign-up password placeholder for %s", (locale, expected) => {
    expect(resource(locale).formFieldInputPlaceholder__signUpPassword).toBe(expected);
  });
  it("provides the simplified Chinese email format hint", () => {
    expect(resource("zh-CN").formFieldInput__emailAddress_format).toBe("示例格式：name@example.com");
  });
  it.each([
    ["zh-CN", zhCN, ["formFieldInputPlaceholder__password", "formFieldInputPlaceholder__signUpPassword", "formFieldInput__emailAddress_format"]],
    ["zh-HK", zhTW, ["formFieldInputPlaceholder__signUpPassword"]],
  ] as const)("preserves every other installed translation for %s", (locale, base, overridden) => {
    const actual = resource(locale);
    const unchanged = (value: typeof zhCN) => ({
      ...Object.fromEntries(Object.entries(value).filter(([key]) => !["unstable__errors", "signIn"].includes(key) && !(overridden as readonly string[]).includes(key))),
      signIn: { ...value.signIn, start: Object.fromEntries(Object.entries(value.signIn?.start ?? {}).filter(([key]) => !["title", "subtitle", "actionText", "actionLink"].includes(key))) },
      unstable__errors: Object.fromEntries(Object.entries(value.unstable__errors ?? {}).filter(([key]) => !["form_password_incorrect", "form_code_incorrect"].includes(key))),
    });
    expect(unchanged(actual)).toEqual(unchanged(base));
    // The pinned package's missing values must remain untouched globally.
    for (const key of overridden) expect(base[key]).toBeUndefined();
  });
  it("keeps the installed traditional Chinese email format hint", () => {
    expect(resource("zh-HK").formFieldInput__emailAddress_format).toBe("範例格式：name@example.com");
  });
  it.each([
    ["zh-CN", "登录 TopE", "欢迎回来，继续你的陪伴之旅。", "使用邮箱注册"],
    ["zh-HK", "登入 TopE", "歡迎回來，繼續你的陪伴之旅。", "使用電郵註冊"],
  ] as const)("uses the approved sign-in copy without replacing later steps in %s", (locale, title, subtitle, actionLink) => {
    expect(resource(locale).signIn?.start).toMatchObject({ title, subtitle, actionLink });
  });
  it.each([
    ["zh-CN", zhCN, "密码不正确，请重试或使用其他方式登录。", "验证码不正确，请检查后重试。"],
    ["zh-HK", zhTW, "密碼不正確，請重試或使用其他方式登入。", "驗證碼不正確，請檢查後重試。"],
  ] as const)("translates missing password and verification errors in %s", (locale, base, password, code) => {
    expect(resource(locale).unstable__errors?.form_password_incorrect).toBe(password);
    expect(resource(locale).unstable__errors?.form_code_incorrect).toBe(code);
    expect(base.unstable__errors?.form_password_incorrect).toBeUndefined();
    expect(base.unstable__errors?.form_code_incorrect).toBeUndefined();
  });
});
