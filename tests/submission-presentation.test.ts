import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { submissionDisplayState } from "../src/components/submission-presentation";
import { SubmissionPanel } from "../src/components/documents";
import { copy } from "../src/components/copy";
import type { AssessmentStatus, Role, SubmissionPhase } from "../src/components/api";

const base = { role: "parent" as const, phase: null, reportId: null };

describe("truthful submission presentation", () => {
  it.each([
    [{ phase: "waiting", status: "queued" }, "waiting"],
    [{ phase: "consent", status: "queued" }, "consent"],
    [{ phase: "reporting", status: "queued" }, "reporting"],
    [{ phase: null, status: "queued" }, "reporting"],
    [{ phase: "reporting", status: "failed" }, "failed"],
    [{ phase: null, status: "published", reportHeld: true }, "consent"],
    [{ phase: null, status: "published", reportId: "available", reportHeld: true }, "ready"],
    [{ phase: null, status: "published", reportId: "old-report", privacyRefreshRequired: true }, "privacy"],
    [{ phase: null, status: "pending" }, "submitted"],
  ] as const)("maps actual parent state %j to %s", (input, state) => {
    expect(submissionDisplayState({ ...base, ...input })).toBe(state);
  });

  it.each(["student", "teacher"] as const)("keeps %s confirmation limited to their own submission", role => {
    for (const phase of ["waiting", "consent", "reporting", null] as const) {
      expect(submissionDisplayState({ role, phase, status: "failed", reportId: "untrusted-prop", reportHeld: true })).toBe("submitted");
    }
  });
});

function markup(role: Role, phase: SubmissionPhase, status: AssessmentStatus, reportId: string | null = null, onRetry?: () => void) {
  return renderToStaticMarkup(createElement(SubmissionPanel, {
    role, phase, status, reportId, locale: "zh-CN", region: "CN", onRetry,
    onBack() {}, onViewReport() {},
  }));
}

describe("submission panel operations and privacy", () => {
  it("offers the existing retry action only for an authorized failed report", () => {
    expect(markup("parent", "reporting", "failed", null, () => undefined)).toContain(copy("zh-CN")("retryReport"));
    expect(markup("parent", "reporting", "failed")).not.toContain(copy("zh-CN")("retryReport"));
    expect(markup("parent", "reporting", "queued", null, () => undefined)).not.toContain(copy("zh-CN")("retryReport"));
    expect(markup("teacher", "reporting", "failed", null, () => undefined)).not.toContain(copy("zh-CN")("retryReport"));
  });

  it("never shows the report action or parent pipeline state to students and teachers", () => {
    for (const role of ["student", "teacher"] as const) {
      const html = markup(role, "consent", "published", "report-id", () => undefined);
      expect(html).toContain('data-state="submitted"');
      expect(html).toContain("已完成提交");
      expect(html).not.toContain("查看报告");
      expect(html).not.toContain("等待家长报告同意");
    }
  });

  it("uses factual waiting text without inventing the number of outstanding respondents", () => {
    const html = markup("parent", "waiting", "queued");
    expect(html).toContain('data-state="waiting"');
    expect(html).toContain("等待三方填写齐全");
    expect(html).not.toContain("等待另外两方");
    expect(html).not.toContain("progressbar");
  });
});
