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
    ["zh-CN", "设置密码"],
    ["zh-HK", "設定密碼"],
  ] as const)("provides the dedicated sign-up password placeholder for %s", (locale, expected) => {
    expect(resource(locale).formFieldInputPlaceholder__signUpPassword).toBe(expected);
  });
  it("provides the simplified Chinese email format hint", () => {
    expect(resource("zh-CN").formFieldInput__emailAddress_format).toBe("示例格式：name@example.com");
  });
  it.each([
    ["zh-CN", zhCN, ["formFieldInputPlaceholder__signUpPassword", "formFieldInput__emailAddress_format"]],
    ["zh-HK", zhTW, ["formFieldInputPlaceholder__signUpPassword"]],
  ] as const)("preserves every other installed translation for %s", (locale, base, overridden) => {
    const actual = resource(locale);
    const unchanged = (value: typeof zhCN) => Object.fromEntries(Object.entries(value).filter(([key]) => !(overridden as readonly string[]).includes(key)));
    expect(unchanged(actual)).toEqual(unchanged(base));
    // The pinned package's missing values must remain untouched globally.
    for (const key of overridden) expect(base[key]).toBeUndefined();
  });
  it("keeps the installed traditional Chinese email format hint", () => {
    expect(resource("zh-HK").formFieldInput__emailAddress_format).toBe("範例格式：name@example.com");
  });
});
