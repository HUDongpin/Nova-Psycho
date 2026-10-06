import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Assessment } from "../src/components/api";
import { AssessmentList } from "../src/components/workspace-views";

function row(over: Partial<Assessment>): Assessment {
  return {
    id: "a", familyId: "f", childName: "小林", respondentId: "u", respondentName: "家长", respondentRole: "parent",
    scaleVersionId: "s", scaleTitle: "家庭问卷", status: "published", createdAt: "2026-03-01T00:00:00Z",
    submittedAt: "2026-03-02T00:00:00Z", reportId: null, canRespond: false, ...over
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

  it("does not offer the parent report to the child or teacher themselves", () => {
    const markup = html([row({ id: "child", respondentRole: "student", respondentName: "孩子", reportId: null })], false);
    expect(markup).toContain("已完成提交");
    expect(markup).not.toContain("查看报告");
  });
});
