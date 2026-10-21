"use client";
import { ClerkProvider, useAuth, useClerk } from "@clerk/nextjs";
import { zhCN, zhTW } from "@clerk/localizations";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Locale } from "./api";
import { LocaleContext } from "./ui";

// The installed Chinese resources leave these authentication hints/errors untranslated.
const clerkLocalizations: Record<Locale, typeof zhCN> = {
  "zh-CN": {
    ...zhCN,
    formFieldInputPlaceholder__password: "请输入密码",
    formFieldInputPlaceholder__signUpPassword: "设置密码",
    formFieldInput__emailAddress_format: "示例格式：name@example.com",
    signIn: {
      ...zhCN.signIn,
      start: { ...zhCN.signIn?.start, title: "登录 TopE", subtitle: "欢迎回来，继续你的陪伴之旅。", actionText: "还没有账号？", actionLink: "使用邮箱注册" },
    },
    unstable__errors: {
      ...zhCN.unstable__errors,
      form_password_incorrect: "密码不正确，请重试或使用其他方式登录。",
      form_code_incorrect: "验证码不正确，请检查后重试。",
    },
  },
  "zh-HK": {
    ...zhTW,
    formFieldInputPlaceholder__signUpPassword: "設定密碼",
    signIn: {
      ...zhTW.signIn,
      start: { ...zhTW.signIn?.start, title: "登入 TopE", subtitle: "歡迎回來，繼續你的陪伴之旅。", actionText: "還沒有帳號？", actionLink: "使用電郵註冊" },
    },
    unstable__errors: {
      ...zhTW.unstable__errors,
      form_password_incorrect: "密碼不正確，請重試或使用其他方式登入。",
      form_code_incorrect: "驗證碼不正確，請檢查後重試。",
    },
  },
};

const IdentityAuth = createContext<{ enabled: boolean; signOut: () => Promise<void>; manageAccount: () => void }>({ enabled: false, signOut: async () => undefined, manageAccount: () => undefined });
export const useIdentityAuth = () => useContext(IdentityAuth);
function IdentityBridge({ children }: { children: ReactNode }) {
  const clerk = useClerk();
  const { isLoaded, sessionId } = useAuth();
  useEffect(() => { if (isLoaded) window.dispatchEvent(new Event("nova-identity-change")); }, [isLoaded, sessionId]);
  const value = useMemo(() => ({ enabled: true, signOut: () => clerk.signOut(() => undefined), manageAccount: () => clerk.openUserProfile() }), [clerk]);
  return <IdentityAuth.Provider value={value}>{children}</IdentityAuth.Provider>;
}
export function LocalizedClerkProvider({ children, publishableKey, initialLocale = "zh-CN", nonce }: { children: ReactNode; publishableKey: string; initialLocale?: Locale; nonce?: string }) {
  const [locale, setLocale] = useState(initialLocale);
  useEffect(() => {
    const read = () => { const saved = localStorage.getItem("nova-locale"); if (saved === "zh-CN" || saved === "zh-HK") setLocale(saved); };
    read(); window.addEventListener("nova-locale-change", read);
    return () => window.removeEventListener("nova-locale-change", read);
  }, []);
  return <LocaleContext.Provider value={locale}><ClerkProvider publishableKey={publishableKey} nonce={nonce} localization={clerkLocalizations[locale]} signInUrl="/sign-in" signUpUrl="/sign-up"><IdentityBridge>{children}</IdentityBridge></ClerkProvider></LocaleContext.Provider>;
}
