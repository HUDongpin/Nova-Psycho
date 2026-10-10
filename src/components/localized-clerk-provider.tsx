"use client";
import { ClerkProvider, useAuth, useClerk } from "@clerk/nextjs";
import { zhCN, zhTW } from "@clerk/localizations";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Locale } from "./api";
import { LocaleContext } from "./ui";

const IdentityAuth = createContext<{ enabled: boolean; signOut: () => Promise<void>; manageAccount: () => void }>({ enabled: false, signOut: async () => undefined, manageAccount: () => undefined });
export const useIdentityAuth = () => useContext(IdentityAuth);
function IdentityBridge({ children }: { children: ReactNode }) {
  const clerk = useClerk();
  const { isLoaded, sessionId } = useAuth();
  useEffect(() => { if (isLoaded) window.dispatchEvent(new Event("nova-identity-change")); }, [isLoaded, sessionId]);
  const value = useMemo(() => ({ enabled: true, signOut: () => clerk.signOut(() => undefined), manageAccount: () => clerk.openUserProfile() }), [clerk]);
  return <IdentityAuth.Provider value={value}>{children}</IdentityAuth.Provider>;
}
export function LocalizedClerkProvider({ children, publishableKey, initialLocale = "zh-CN" }: { children: ReactNode; publishableKey: string; initialLocale?: Locale }) {
  const [locale, setLocale] = useState(initialLocale);
  useEffect(() => {
    const read = () => { const saved = localStorage.getItem("nova-locale"); if (saved === "zh-CN" || saved === "zh-HK") setLocale(saved); };
    read(); window.addEventListener("nova-locale-change", read);
    return () => window.removeEventListener("nova-locale-change", read);
  }, []);
  return <LocaleContext.Provider value={locale}><ClerkProvider publishableKey={publishableKey} localization={locale === "zh-HK" ? zhTW : zhCN} signInUrl="/sign-in" signUpUrl="/sign-up"><IdentityBridge>{children}</IdentityBridge></ClerkProvider></LocaleContext.Provider>;
}
