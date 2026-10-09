import type { Metadata } from "next";
import { LocalizedClerkProvider } from "@/components/localized-clerk-provider";
import { getAuthProvider, getClerkConfig } from "@/lib/auth-provider";
import "survey-core/survey-core.min.css";
import "./globals.css";
export const metadata: Metadata = { title: "TopE 心理助手 · 家庭成长支持", description: "以理解与关怀陪伴成长。家庭测评、成长报告与日常支持。", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = process.env.NOVA_REGION === "HK" ? "zh-HK" : "zh-CN";
  const content = getAuthProvider() === "clerk" ? <LocalizedClerkProvider publishableKey={getClerkConfig().publishableKey} initialLocale={locale}>{children}</LocalizedClerkProvider> : children;
  return <html lang={locale}><body>{content}</body></html>;
}
