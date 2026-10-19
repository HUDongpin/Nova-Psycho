import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/components/api";
import { Model } from "survey-core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompletionSummary, completionQuestion, surveyCompletionIssues } from "../src/components/survey-completion";
import type { CompletionRules } from "../src/domain/completion";

afterEach(() => vi.unstubAllGlobals());

describe("completion response transport", () => {
  it("keeps structured completion reasons from an incomplete submission", async () => {
    const completionIssues = [{ kind: "required_missing", itemId: "q1" }, { kind: "insufficient_coverage", dimensionKey: "learning", itemIds: ["q1", "q2"], answered: 0, required: 2, total: 2, unansweredItemIds: ["q1"], excludedItemIds: ["q2"] }];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "INCOMPLETE_TRIAD", error: "Incomplete", completionIssues }), { status: 422 })));
    await expect(api("/api/assessments/synthetic/submit", "zh-CN", { method: "POST" })).rejects.toMatchObject({ code: "INCOMPLETE_TRIAD", completionIssues });
  });
  it("does not retain arbitrary response fields or malformed completion reasons", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "INCOMPLETE_TRIAD", error: "Incomplete", completionIssues: [{ kind: "required_missing", itemId: "q1", answers: "must not be retained" }] }), { status: 422 })));
    await expect(api("/api/assessments/synthetic/submit", "zh-CN")).rejects.toMatchObject({ completionIssues: [{ kind: "required_missing", itemId: "q1" }] });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "INCOMPLETE_TRIAD", error: "Incomplete", completionIssues: [{ kind: "insufficient_coverage", dimensionKey: "bad", answered: "0" }] }), { status: 422 })));
    await expect(api("/api/assessments/synthetic/submit", "zh-CN")).rejects.toMatchObject({ code: "INCOMPLETE_TRIAD", completionIssues: undefined });
  });
});

function fixture() {
  const model = new Model({ pages: [{ title: "孩子的情况", elements: [{ type: "panel", title: "学习表现", elements: [
    { type: "radiogroup", name: "q1", title: "第一题", isRequired: true, choices: [1, -1] },
    { type: "radiogroup", name: "q2", title: "第二题", isRequired: true, choices: [1, -1] },
    { type: "comment", name: "detail", title: "补充情况", isRequired: true, visibleIf: "{q1} = 1" },
    { type: "comment", name: "optional", title: "自愿补充" }
  ] }] }] });
  model.questionsOnPageMode = "inputPerPage";
  const rules: CompletionRules = { items: [
    { id: "q1", kind: "single", required: true, excludeValues: [-1] },
    { id: "q2", kind: "single", required: true, excludeValues: [-1] },
    { id: "detail", kind: "text", required: true, showIf: { itemId: "q1", anyOf: [1] } },
    { id: "optional", kind: "text", required: false }
  ], dimensions: [{ key: "learning", label: { "zh-CN": "学习表现", "zh-HK": "學習表現" }, itemIds: ["q1", "q2"], maxMissing: 0 }] };
  return { model, rules };
}

describe("reviewing completion against the live question model", () => {
  it("shows required and coverage reasons together without changing NA or private text", () => {
    const { model, rules } = fixture();
    model.data = { q1: -1, optional: "Synthetic private note" };
    const before = { ...model.data };
    const issues = surveyCompletionIssues(model, rules);
    expect(issues).toEqual([
      { kind: "required_missing", itemId: "q2" },
      { kind: "insufficient_coverage", dimensionKey: "learning", itemIds: ["q1", "q2"], answered: 0, required: 2, total: 2, unansweredItemIds: ["q2"], excludedItemIds: ["q1"] }
    ]);
    // In inputPerPage mode SurveyJS can accept the current question while a later
    // required question is empty. The full review must still expose both causes.
    expect(model.currentSingleQuestion?.name).toBe("q1");
    expect(model.validate(true, false, undefined, false)).toBe(true);
    expect(surveyCompletionIssues(model, rules)).toEqual(issues);
    expect(model.data).toEqual(before);
    expect(JSON.stringify(issues)).not.toContain("Synthetic private note");
  });

  it("updates visible required questions and their ordinal when conditional questions appear", () => {
    const { model, rules } = fixture();
    model.data = { q1: -1, q2: -1 };
    expect(completionQuestion(model, "detail")).toBeNull();
    expect(completionQuestion(model, "optional")?.ordinal).toBe(3);
    model.setValue("q1", 1);
    expect(completionQuestion(model, "detail")).toMatchObject({ ordinal: 3, chapter: "孩子的情况 · 学习表现" });
    expect(completionQuestion(model, "optional")?.ordinal).toBe(4);
    expect(surveyCompletionIssues(model, rules).some(issue => issue.kind === "required_missing" && issue.itemId === "detail")).toBe(true);
    model.setValue("detail", "Synthetic explanation");
    model.setValue("q2", 1);
    expect(surveyCompletionIssues(model, rules)).toEqual([]);
    model.setValue("q1", -1);
    expect(surveyCompletionIssues(model, rules).some(issue => issue.kind === "required_missing")).toBe(false);
    expect(completionQuestion(model, "optional")?.ordinal).toBe(3);
  });

  it("does not invent coverage restrictions when an ordinary survey has no completion rules", () => {
    const { model } = fixture();
    model.data = { q1: -1, q2: -1 };
    expect(surveyCompletionIssues(model)).toEqual([]);
    model.clearValue("q2");
    expect(surveyCompletionIssues(model)).toEqual([{ kind: "required_missing", itemId: "q2" }]);
  });

  it.each(["zh-CN", "zh-HK"] as const)("renders a named review region without exposing response text (%s)", locale => {
    const { model, rules } = fixture();
    model.data = { q1: -1, q2: -1, optional: "Synthetic private note" };
    const issues = surveyCompletionIssues(model, rules);
    const html = renderToStaticMarkup(createElement(CompletionSummary, { model, rules, issues, locale, disabled: false, onJump() {} }));
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-labelledby=');
    expect(html).toContain('data-question-id="q1"');
    expect(html).toContain('data-completion-kind="insufficient_coverage"');
    expect(html).toContain(locale === "zh-HK" ? "該部分已填寫" : "该部分已填写");
    expect(html).not.toContain("Synthetic private note");
  });
});
