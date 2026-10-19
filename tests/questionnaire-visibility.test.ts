import { describe, expect, it } from "vitest";
import { Model } from "survey-core";
import { ScoringError, scoreAssessment, validateAnswers } from "../src/domain/scoring";
import { surveyDefinition } from "../src/domain/survey";
import { previewAnswers } from "../src/domain/triad-report";
import { childScale } from "../src/domain/triad-scales";
import type { StoredAnswer } from "../src/domain/types";

const context = { age: 10, region: "CN" as const, role: "student" as const };

describe("conditional questionnaire answers", () => {
  it("rejects an immediate-danger answer while its safety follow-up is hidden", () => {
    const answers = { ...previewAnswers(childScale), c14: [6], c15: 1 };
    expect(() => scoreAssessment(childScale, answers, context)).toThrow(ScoringError);
  });

  it("rejects youth scores when the selected age hides that section", () => {
    const answers: Record<string, StoredAnswer> = { ...previewAnswers(childScale), c_age: 10 };
    for (const item of childScale.items.filter(item => item.showIf?.itemId === "c_age")) answers[item.id] = 5;
    expect(() => scoreAssessment(childScale, answers, context)).toThrow(ScoringError);
  });

  it("accepts SurveyJS data after changing an answer hides and clears its follow-ups", () => {
    const model = new Model(surveyDefinition(childScale, "student", "zh-CN"));
    model.data = { ...previewAnswers(childScale, "risk"), c_age: 12 };
    model.setValue("c18_1", 5);
    model.setValue("c_age", 10);
    model.setValue("c14", [6]);
    expect(model.getQuestionByName("c15").isVisible).toBe(false);
    expect(model.getQuestionByName("c18_1").isVisible).toBe(false);
    expect(model.data.c15).toBeUndefined();
    expect(model.data.c18_1).toBeUndefined();
    expect(() => validateAnswers(childScale, model.data)).not.toThrow();
    expect(scoreAssessment(childScale, model.data, context).riskMessages).not.toContainEqual(childScale.riskRules.find(rule => rule.itemId === "c15")?.message);
    model.dispose();
  });
});
