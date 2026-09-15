import type { Metadata } from "next";
import "survey-core/survey-core.min.css";
import "./globals.css";
export const metadata: Metadata = { title: "Nova 心理助手 · 家庭成长支持", description: "以理解与关怀陪伴成长。家庭测评、成长报告与日常支持。", robots: { index: false, follow: false } };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="zh-CN"><body>{children}</body></html>; }
