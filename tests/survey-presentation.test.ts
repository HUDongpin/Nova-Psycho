import { describe, expect, it } from "vitest";
import { ItemValue, Model, type TextMarkdownEvent } from "survey-core";
import { surveyDefinition } from "../src/domain/survey";
import { parentScale, parentScaleV1 } from "../src/domain/triad-scales";
import type { Locale, ScaleDefinition } from "../src/domain/types";
import { titleEmphasis } from "../src/domain/survey-presentation";
import { configureTitleEmphasis } from "../src/components/survey-presentation";
import { surveySupplements } from "../src/domain/survey-supplements";

describe.each(["zh-CN", "zh-HK"] as const)("questionnaire presentation in %s", (locale: Locale) => {
  it("adds a child observation description without rewriting the assigned question or page title", () => {
    const before = structuredClone(parentScale);
    const model = new Model(surveyDefinition(parentScale, "parent", locale));
    const item = parentScale.items.find(item => item.id === "q20_1")!;
    expect(model.getQuestionByName(item.id).description).toBe(locale === "zh-HK" ? "以下請回答孩子過去四周的情況。" : "以下请回答孩子过去四周的情况。");
    expect(model.getQuestionByName(item.id).title).toBe(item.label[locale]);
    expect(model.pages.find(page => page.name === "state")?.title).toBe(item.pageTitle?.[locale]);
    expect(parentScale).toEqual(before);
  });

  it("identifies the parent's own section while retaining its two-week question text", () => {
    const model = new Model(surveyDefinition(parentScale, "parent", locale));
    const item = parentScale.items.find(item => item.id === "q30")!;
    expect(model.getQuestionByName(item.id).description).toBe(locale === "zh-HK" ? "以下請回答您自己的情況。" : "以下请回答您自己的情况。");
    expect(model.getQuestionByName(item.id).title).toBe(item.label[locale]);
  });

  it("explains multiple selection and its existing limit in a separate description", () => {
    const model = new Model(surveyDefinition(parentScale, "parent", locale));
    const unrestricted = model.getQuestionByName("p_care");
    const limited = model.getQuestionByName("p_focus");
    expect(unrestricted.description).toBe(locale === "zh-HK" ? "可多選。" : "可多选。");
    expect(limited.description).toBe(locale === "zh-HK" ? "可多選，最多選 3 項。" : "可多选，最多选 3 项。");
    expect(limited.title).toBe(parentScale.items.find(item => item.id === "p_focus")!.label[locale]);
    expect(limited.getPropertyValue("maxSelectedChoices")).toBe(3);
  });

  it("emphasizes only the complete negative phrase while preserving the original plain title", () => {
    const model = new Model(surveyDefinition(parentScale, "parent", locale));
    const metadata = titleEmphasis(parentScale, "parent", locale);
    const phrase = locale === "zh-HK" ? "不需要反覆催促" : "不需要反复催促";
    const original = parentScale.items.find(item => item.id === "q14_1")!.label[locale];
    expect(metadata).toEqual([{ itemId: "q14_1", expectedTitle: original, phrase }]);
    configureTitleEmphasis(model, metadata);
    expect(model.getQuestionByName("q14_1").locTitle.renderedHtml).toBe(original.replace(phrase, `<strong>${phrase}</strong>`));
    expect(model.getQuestionByName("q14_1").title).toBe(original);
    expect(model.getQuestionByName("q14_2").locTitle.renderedHtml).not.toContain("<strong>");
  });

  it("keeps every question title, page title and option value unchanged", () => {
    for (const scale of [parentScaleV1, parentScale]) {
      const model = new Model(surveyDefinition(scale, "parent", locale));
      const mainItems = scale.items.filter(item => !item.supplementFor);
      expect(mainItems).toHaveLength(145);
      expect(model.getAllQuestions()).toHaveLength(145);
      for (const item of mainItems) {
        const question = model.getQuestionByName(item.id);
        expect(question.title).toBe((item.observerLabel ?? item.label)[locale]);
        expect(question.getPropertyValue("choices", []).map((choice: ItemValue) => choice.value)).toEqual(item.choices.map(choice => choice.value));
        expect(model.pages.find(page => page.name === item.page)?.title).toBe(item.pageTitle?.[locale]);
      }
      const supplements = scale.items.filter(item => item.supplementFor);
      expect(supplements).toHaveLength(scale.version === parentScaleV1.version ? 0 : 7);
      expect(surveySupplements(scale, locale)).toEqual(supplements.map(item => ({ itemId: item.id, parentId: item.supplementFor, label: item.label[locale], anyOf: item.showIf!.anyOf, maxLength: 2000 })));
      for (const item of supplements) expect(model.getQuestionByName(item.id)).toBeFalsy();
    }
  });
});

describe("presentation is bound to the canonical assigned content", () => {
  const mutations: Array<[string, (scale: ScaleDefinition) => void]> = [
    ["scale id", scale => { scale.id = "imported-parent"; }],
    ["version", scale => { scale.version = "1.0.1"; }],
    ["allowed role", scale => { scale.roles = ["teacher"]; }],
    ["simplified title", scale => { for (const id of ["q14_1", "q20_1", "q24_1"]) scale.items.find(item => item.id === id)!.label["zh-CN"] += " changed"; }],
    ["traditional title", scale => { for (const id of ["q14_1", "q20_1", "q24_1"]) scale.items.find(item => item.id === id)!.label["zh-HK"] += " changed"; }],
    ["page", scale => { for (const id of ["q14_1", "q20_1", "q24_1"]) scale.items.find(item => item.id === id)!.page = "elsewhere"; }],
    ["page title", scale => { for (const id of ["q14_1", "q20_1", "q24_1"]) scale.items.find(item => item.id === id)!.pageTitle = { "zh-CN": "Different", "zh-HK": "Different" }; }],
    ["observer wording", scale => { for (const id of ["q14_1", "q20_1", "q24_1"]) scale.items.find(item => item.id === id)!.observerLabel = { "zh-CN": "Different", "zh-HK": "Different" }; }]
  ];
  it.each(mutations)("does not attach the known wording overlay after a change to %s", (_name, mutate) => {
    const scale = structuredClone(parentScale);
    mutate(scale);
    const model = new Model(surveyDefinition(scale, "parent", "zh-CN"));
    expect(model.getQuestionByName("q20_1").description).toBe("");
    expect(model.getQuestionByName("q24_1").description).toBe("");
    expect(titleEmphasis(scale, "parent", "zh-CN")).toEqual([]);
  });

  it("does not attach parent observation hints or emphasis for another respondent role", () => {
    const model = new Model(surveyDefinition(parentScale, "teacher", "zh-CN"));
    expect(model.getQuestionByName("q20_1").description).toBe("");
    expect(titleEmphasis(parentScale, "teacher", "zh-CN")).toEqual([]);
  });

  it("does not mistake an option, another property or mismatched title for the approved title", () => {
    const model = new Model(surveyDefinition(parentScale, "parent", "zh-CN"));
    const metadata = titleEmphasis(parentScale, "parent", "zh-CN");
    configureTitleEmphasis(model, metadata);
    const question = model.getQuestionByName("q14_1");
    const attempts: TextMarkdownEvent[] = [
      { element: question, name: "title", text: question.title, item: new ItemValue(1, question.title) },
      { element: question, name: "description", text: question.title },
      { element: question, name: "title", text: `${question.title}<img src=x onerror=alert(1)>` },
      { element: model.getQuestionByName("q14_2"), name: "title", text: question.title }
    ];
    for (const attempt of attempts) {
      model.onTextMarkdown.fire(model, attempt);
      expect(attempt.html).toBeUndefined();
    }
  });

  it("escapes all text even when directly supplied metadata contains HTML-like characters", () => {
    const title = '<img src=x onerror="alert(1)">不需要反复催促 & <script>x</script>';
    const model = new Model({ elements: [{ type: "radiogroup", name: "q14_1", title, choices: [1, 2] }] });
    configureTitleEmphasis(model, [{ itemId: "q14_1", expectedTitle: title, phrase: "不需要反复催促" }]);
    const rendered = model.getQuestionByName("q14_1").locTitle.renderedHtml;
    expect(rendered).toContain("<strong>不需要反复催促</strong>");
    expect(rendered).toContain("&lt;img");
    expect(rendered).toContain("&lt;script&gt;");
    expect(rendered).not.toContain("<img");
    expect(rendered).not.toContain("<script>");
  });
});
