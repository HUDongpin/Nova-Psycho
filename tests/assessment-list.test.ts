import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Assessment, Report, Workspace } from "../src/components/api";
import { AssessmentList, ReportCards } from "../src/components/workspace-views";
import { copy } from "../src/components/copy";

function row(over: Partial<Assessment>): Assessment {
  return {
    id: "a", familyId: "f", childName: "小林", respondentId: "u", respondentName: "家长", respondentRole: "parent",
    scaleVersionId: "s", scaleTitle: "家庭问卷", status: "published", createdAt: "2026-03-01T00:00:00Z",
    submittedAt: "2026-03-02T00:00:00Z", reportId: null, canRespond: false, canRetryReport: false, ...over
  };
}

function html(assessments: Assessment[], adult = true) {
  return renderToStaticMarkup(createElement(AssessmentList, { assessments, locale: "zh-CN", navigate: () => undefined, adult }));
}

describe("assessment rows after a triad report exists", () => {
  const trio = [
    row({ id: "child", respondentRole: "student", respondentName: "孩子", scaleTitle: "孩子问卷", reportId: "r-parent" }),
    row({ id: "parent", respondentRole: "parent", respondentName: "家长", scaleTitle: "家长问卷", reportId: "r-parent" }),
    row({ id: "teacher", respondentRole: "teacher", respondentName: "老师", scaleTitle: "老师问卷", reportId: "r-parent" })
  ];

  it("shows 已完成 and 查看报告 on the child and teacher rows", () => {
    const markup = html(trio);
    expect(markup.match(/已完成/g)?.length).toBe(3);
    expect(markup.match(/查看报告/g)?.length).toBe(3);
    expect(markup).not.toContain("报告正在生成");
  });

  it("keeps 报告正在生成 only while the combined report is still queued", () => {
    const markup = html([
      row({ id: "child", respondentRole: "student", respondentName: "孩子", status: "queued", phase: "reporting", reportId: null }),
      row({ id: "teacher", respondentRole: "teacher", respondentName: "老师", status: "queued", phase: "reporting", reportId: null })
    ]);
    expect(markup).toContain("报告生成中");
    expect(markup).toContain("报告正在生成");
    expect(markup).not.toContain("查看报告");
  });

  it("replaces the three view-report buttons with the consent reason after withdrawal", () => {
    const held = trio.map(item => ({ ...item, phase: "consent" as const, reportId: "r-parent" }));
    const simplified = html(held);
    const traditional = renderToStaticMarkup(createElement(AssessmentList, { assessments: held, locale: "zh-HK", navigate: () => undefined, adult: true }));
    expect(simplified).not.toContain("查看报告");
    expect(simplified.match(/等待家长报告同意/g)?.length).toBeGreaterThanOrEqual(3);
    expect(traditional).not.toContain("查看報告");
    expect(traditional.match(/等待家長報告同意/g)?.length).toBeGreaterThanOrEqual(3);
    expect(simplified).not.toContain("<button");
  });

  it.each([
    { status: "queued", phase: "waiting" },
    { status: "queued", phase: "reporting" },
    { status: "queued", phase: "consent" },
    { status: "failed", phase: null },
    { status: "published", phase: null },
  ] as const)("confirms only the respondent's submission during $status / $phase", ({ status, phase }) => {
    for (const locale of ["zh-CN", "zh-HK"] as const) for (const respondentRole of ["student", "teacher"] as const) {
      const t = copy(locale);
      const markup = renderToStaticMarkup(createElement(AssessmentList, {
        assessments: [row({ respondentRole, status, phase })], locale,
        navigate: () => undefined, adult: false, onRefresh: async () => undefined,
      }));
      expect(markup).toContain(t("submitted"));
      expect(markup).toContain(t("submittedNote"));
      expect(markup).toContain("badge-sage");
      expect(markup).not.toContain("badge-danger");
      expect(markup).not.toContain("badge-peach");
      for (const key of ["triadWaiting", "triadWaitingNote", "reportNeedsParentConsent", "reportQueued", "reportFailed", "viewReport", "retryReport"] as const) {
        expect(markup).not.toContain(t(key));
      }
    }
  });

  it("keeps the actual three-party waiting state visible to parents and staff", () => {
    for (const locale of ["zh-CN", "zh-HK"] as const) {
      const t = copy(locale);
      const markup = renderToStaticMarkup(createElement(AssessmentList, {
        assessments: [row({ status: "queued", phase: "waiting" })], locale,
        navigate: () => undefined, adult: true,
      }));
      expect(markup).toContain(t("triadWaiting"));
      expect(markup).toContain(t("triadWaitingNote"));
      expect(markup).not.toContain(t("reportQueued"));
    }
  });

  it("replaces stale report links with a privacy hold in both languages", () => {
    const held = trio.map(item => ({ ...item, privacyRefreshRequired: true, phase: null }));
    for (const locale of ["zh-CN", "zh-HK"] as const) {
      const markup = renderToStaticMarkup(createElement(AssessmentList, { assessments: held, locale, navigate: () => undefined, adult: true }));
      expect(markup.includes(locale === "zh-CN" ? "隐私保护" : "私隱保護")).toBe(true);
      expect(markup.includes(locale === "zh-CN" ? "查看报告" : "查看報告")).toBe(false);
      expect(markup.includes(locale === "zh-CN" ? "等待家长报告同意" : "等待家長報告同意")).toBe(false);
    }
  });

  it("keeps a privacy-held report neutral for its child and teacher respondents", () => {
    for (const locale of ["zh-CN", "zh-HK"] as const) for (const respondentRole of ["student", "teacher"] as const) {
      const t = copy(locale);
      const markup = renderToStaticMarkup(createElement(AssessmentList, {
        assessments: [row({ respondentRole, privacyRefreshRequired: true, reportId: "stale-report" })], locale,
        navigate: () => undefined, adult: false,
      }));
      expect(markup).toContain(t("submittedNote"));
      expect(markup).toContain("badge-sage");
      expect(markup).not.toContain(t("reportPrivacyHeld"));
      expect(markup).not.toContain(t("reportPrivacyRefresh"));
      expect(markup).not.toContain(t("viewReport"));
    }
  });

  it("shows a staff age-mismatch note without printing a birth date", () => {
    const markup = html([row({ respondentRole: "student", respondentName: "孩子", reviewFlags: ["age_mismatch"], statedAge: 15 })]);
    expect(markup).toContain("填写的年龄是 15 岁，和出生日期不一致，请工作人员核对。");
    expect(markup).not.toContain("出生日期是");
    expect(html([row({ respondentRole: "student", respondentName: "孩子" })])).not.toContain("出生日期不一致");
  });

  it("does not offer the parent report to the child or teacher themselves", () => {
    const markup = html([row({ id: "child", respondentRole: "student", respondentName: "孩子", reportId: null })], false);
    expect(markup).toContain("已完成提交");
    expect(markup).not.toContain("查看报告");
  });

  it("keeps a missing parent-report consent neutral for the child and the teacher", () => {
    for (const respondentRole of ["student", "teacher"] as const) {
      const markup = html([row({ respondentRole, respondentName: respondentRole === "student" ? "孩子" : "老师", status: "queued", phase: "consent", reportId: null })], false);
      expect(markup).toContain("已完成提交");
      expect(markup).toContain("无需再次填写");
      expect(markup).not.toContain("等待家长报告同意");
      expect(markup).not.toContain("尚未取得向家长提供综合报告的同意");
      expect(markup).not.toContain("等待另外两方");
      expect(markup).not.toContain("报告正在生成");
      expect(markup).not.toContain("报告生成中");
    }
  });
});

describe("report retry capability", () => {
  const workspace: Workspace = {
    user: {id: "staff", name: "合成工作人员", role: "staff", region: "CN"}, region: "CN", mode: "demo",
    families: [], assessments: [], reports: [], scales: [], goals: [], observations: [], staff: [],
    contentVersions: [], alerts: [], staffNotes: [], summary: {}
  };
  function retryMarkup(canRetryReport: boolean, locale: "zh-CN" | "zh-HK" = "zh-CN") {
    return renderToStaticMarkup(createElement(AssessmentList, {
      assessments: [row({status: "failed", canRetryReport})], locale, workspace,
      navigate: () => undefined, onRefresh: async () => undefined
    }));
  }
  it("does not turn risk-alert visibility into permission to retry", () => {
    expect(retryMarkup(false)).not.toContain("重新排队生成报告");
  });
  it("offers retry when the server grants the capability in either locale", () => {
    expect(retryMarkup(true)).toContain("重新排队生成报告");
    expect(retryMarkup(true, "zh-HK")).toContain("重新排隊產生報告");
  });
  it("does not show report retry in the respondent-only list", () => {
    for (const respondentRole of ["student", "teacher"] as const) {
      const markup = renderToStaticMarkup(createElement(AssessmentList, {
        assessments: [row({ respondentRole, status: "failed", canRetryReport: true })], locale: "zh-CN",
        navigate: () => undefined, adult: false, onRefresh: async () => undefined,
      }));
      expect(markup).toContain("已完成提交");
      expect(markup).not.toContain("重新排队生成报告");
    }
  });
  it("keeps a privacy hold ahead of an otherwise granted report retry", () => {
    const markup = renderToStaticMarkup(createElement(AssessmentList, {
      assessments: [row({ status: "failed", canRetryReport: true, privacyRefreshRequired: true })], locale: "zh-CN",
      navigate: () => undefined, adult: true, onRefresh: async () => undefined,
    }));
    expect(markup).toContain(copy("zh-CN")("reportPrivacyRefresh"));
    expect(markup).not.toContain("重新排队生成报告");
  });
});

describe("garden report cards under a legacy privacy hold", () => {
  const report: Report = {
    id: "r", familyId: "f", childName: "合成孩子", title: "合成报告", respondentRole: "parent",
    scaleTitle: "合成问卷", createdAt: "2026-03-02T00:00:00Z", generationMode: "template",
    risk: false, demo: true, dimensions: [], assessmentId: "a", comparison: { available: false },
  };
  it.each([false, true])("preserves the garden layout while withholding stale entry (compact=%s)", compact => {
    for (const locale of ["zh-CN", "zh-HK"] as const) {
      const t = copy(locale);
      const render = (privacyRefreshRequired: boolean) => renderToStaticMarkup(createElement(ReportCards, {
        reports: [{ ...report, privacyRefreshRequired }], locale, navigate: () => undefined, compact,
      }));
      const held = render(true);
      expect(held).toContain("garden-report-card");
      expect(held).toContain(t("reportPrivacyRefresh"));
      expect(held).not.toContain(t("viewReport"));
      expect(render(false)).toContain(t("viewReport"));
    }
  });
});
