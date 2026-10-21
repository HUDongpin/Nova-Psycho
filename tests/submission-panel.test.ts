import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SubmissionPhase } from "../src/components/api";
import { SubmissionPanel } from "../src/components/documents";

function panelFor(role: "parent" | "admin" | "student" | "teacher", phase: SubmissionPhase, options: { locale?: "zh-CN" | "zh-HK"; reportId?: string | null; reportHeld?: boolean; privacyRefreshRequired?: boolean } = {}) {
  return renderToStaticMarkup(createElement(SubmissionPanel, {
    locale: options.locale ?? "zh-CN", region: options.locale === "zh-HK" ? "HK" : "CN", role, phase, safetyGuidance: false, reportId: options.reportId ?? null, reportHeld: options.reportHeld, privacyRefreshRequired: options.privacyRefreshRequired, onViewReport: () => undefined, onBack: () => undefined
  }));
}

describe("submission confirmation when the parent report is held", () => {
  it("tells parents and staff the report waits for parent-report consent", () => {
    for (const role of ["parent", "admin"] as const) {
      const markup = panelFor(role, "consent");
      expect(markup).toContain("等待家长报告同意");
      expect(markup).toContain("尚未取得向家长提供综合报告的同意");
      expect(markup).not.toContain("报告由服务自动生成");
      expect(markup).not.toContain("查看报告");
    }
    const hk = panelFor("parent", "consent", { locale: "zh-HK" });
    expect(hk).toContain("等待家長報告同意");
    expect(hk).toContain("尚未取得向家長提供綜合報告的同意");
  });

  it("explains a privacy hold without suggesting new consent or offering a stale report", () => {
    for (const locale of ["zh-CN", "zh-HK"] as const) {
      const markup = panelFor("parent", null, { locale, reportHeld: true, reportId: "stale-report", privacyRefreshRequired: true });
      expect(markup.includes(locale === "zh-CN" ? "隐私保护" : "私隱保護")).toBe(true);
      expect(markup.includes(locale === "zh-CN" ? "查看报告" : "查看報告")).toBe(false);
      expect(markup.includes(locale === "zh-CN" ? "等待家长报告同意" : "等待家長報告同意")).toBe(false);
      expect(markup.includes(locale === "zh-CN" ? "报告由服务自动生成" : "報告由服務自動產生")).toBe(false);
    }
  });

  it("keeps that reason off the child and teacher confirmation", () => {
    for (const role of ["student", "teacher"] as const) {
      const markup = panelFor(role, "consent");
      expect(markup).toContain("已完成提交");
      expect(markup).toContain("无需再次填写");
      expect(markup).not.toContain("等待家长报告同意");
      expect(markup).not.toContain("尚未取得向家长提供综合报告的同意");
    }
  });

  it("keeps the automatic-report note when nothing is held", () => {
    const markup = panelFor("parent", null);
    expect(markup).toContain("已完成提交");
    expect(markup).toContain("报告由服务自动生成");
    expect(markup).not.toContain("等待家长报告同意");
  });

  it("still explains a held published report and offers an available one", () => {
    const held = panelFor("parent", null, { reportHeld: true });
    expect(held).toContain("等待家长报告同意");
    expect(held).not.toContain("报告由服务自动生成");
    const ready = panelFor("parent", null, { reportId: "r1", reportHeld: true });
    expect(ready).toContain("查看报告");
    expect(ready).not.toContain("等待家长报告同意");
  });
});
