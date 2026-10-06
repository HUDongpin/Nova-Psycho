import { afterEach, describe, expect, it, vi } from "vitest";
import { Model } from "survey-core";
import { bindChoiceAutoAdvance, focusFirstUnanswered, questionProgressLabel } from "../src/components/survey-navigation";

afterEach(() => { vi.useRealTimers(); });

function choiceSurvey() {
  const survey = new Model({
    pages: [{
      elements: [{
        type: "panel", name: "group", title: "一组题目", elements: [
          { type: "radiogroup", name: "q1", isRequired: true, choices: ["a", "b"] },
          { type: "radiogroup", name: "q2", isRequired: true, choices: ["a", "b"] },
          { type: "radiogroup", name: "q3", isRequired: true, choices: ["a", "b"] }
        ]
      }, { type: "checkbox", name: "q4", choices: ["x", "y"] }, { type: "comment", name: "q5" }]
    }]
  });
  survey.questionsOnPageMode = "inputPerPage";
  survey.showCompleteButton = false;
  survey.mode = "edit";
  return survey;
}

describe("one question at a time", () => {
  it("resumes a draft at the first empty question, even when an earlier question is optional", () => {
    const survey = choiceSurvey();
    survey.data = { q1: "a" };
    focusFirstUnanswered(survey);
    expect(survey.currentSingleQuestion?.name).toBe("q2");
  });

  it("starts at the first question when only a later question is required", () => {
    const survey = new Model({
      pages: [{
        elements: [
          { type: "radiogroup", name: "q1", choices: ["a", "b"] },
          { type: "radiogroup", name: "q9", isRequired: true, choices: ["a", "b"] }
        ]
      }]
    });
    survey.questionsOnPageMode = "inputPerPage";
    focusFirstUnanswered(survey);
    expect(survey.currentSingleQuestion?.name).toBe("q1");
    expect(questionProgressLabel(survey, false)).toBe("第 1/2 题");
    survey.nextPage();
    expect(questionProgressLabel(survey, true)).toBe("第 2/2 題");
  });

  it("opens the last question when every answer is already saved", () => {
    const survey = choiceSurvey();
    survey.data = { q1: "a", q2: "b", q3: "a", q4: ["x"], q5: "note" };
    focusFirstUnanswered(survey);
    expect(survey.currentSingleQuestion?.name).toBe("q5");
  });
});

describe("choice auto-advance", () => {
  it("moves exactly one question five seconds after a single choice", () => {
    const survey = choiceSurvey();
    vi.useFakeTimers();
    const stop = bindChoiceAutoAdvance(survey, { delay: 5000 });
    survey.setValue("q1", "a");
    vi.advanceTimersByTime(4999);
    expect(survey.currentSingleQuestion?.name).toBe("q1");
    vi.advanceTimersByTime(1);
    expect(survey.currentSingleQuestion?.name).toBe("q2");
    stop();
  });

  it("restarts the wait when the respondent changes the selected choice", () => {
    const survey = choiceSurvey();
    vi.useFakeTimers();
    const stop = bindChoiceAutoAdvance(survey, { delay: 5000 });
    survey.setValue("q1", "a");
    vi.advanceTimersByTime(4000);
    survey.setValue("q1", "b");
    vi.advanceTimersByTime(4999);
    expect(survey.currentSingleQuestion?.name).toBe("q1");
    vi.advanceTimersByTime(1);
    expect(survey.currentSingleQuestion?.name).toBe("q2");
    stop();
  });

  it("does not advance again after the respondent has already moved on", () => {
    const survey = choiceSurvey();
    vi.useFakeTimers();
    const stop = bindChoiceAutoAdvance(survey, { delay: 5000 });
    survey.setValue("q1", "a");
    vi.advanceTimersByTime(1000);
    survey.nextPage();
    expect(survey.currentSingleQuestion?.name).toBe("q2");
    vi.advanceTimersByTime(5000);
    expect(survey.currentSingleQuestion?.name).toBe("q2");
    stop();
  });

  it("leaves checkboxes and comments for the next button", () => {
    const survey = choiceSurvey();
    survey.data = { q1: "a", q2: "b", q3: "a" };
    focusFirstUnanswered(survey);
    expect(survey.currentSingleQuestion?.name).toBe("q4");
    vi.useFakeTimers();
    const stop = bindChoiceAutoAdvance(survey, { delay: 5000 });
    survey.setValue("q4", ["x"]);
    vi.advanceTimersByTime(5000);
    expect(survey.currentSingleQuestion?.name).toBe("q4");
    survey.nextPage();
    survey.setValue("q5", "written");
    vi.advanceTimersByTime(5000);
    expect(survey.currentSingleQuestion?.name).toBe("q5");
    expect(survey.state).toBe("running");
    stop();
  });

  it("stays on the last single-choice question instead of submitting", () => {
    const survey = new Model({ pages: [{ elements: [{ type: "radiogroup", name: "only", choices: ["a", "b"] }] }] });
    survey.questionsOnPageMode = "inputPerPage";
    survey.showCompleteButton = false;
    survey.mode = "edit";
    vi.useFakeTimers();
    const stop = bindChoiceAutoAdvance(survey, { delay: 5000 });
    survey.setValue("only", "a");
    vi.advanceTimersByTime(5000);
    expect(survey.currentSingleQuestion?.name).toBe("only");
    expect(survey.state).toBe("running");
    stop();
  });

  it("does not arm a timer while the questionnaire is locked", () => {
    const survey = choiceSurvey();
    survey.mode = "display";
    vi.useFakeTimers();
    const stop = bindChoiceAutoAdvance(survey, { delay: 5000 });
    survey.setValue("q1", "a");
    vi.advanceTimersByTime(5000);
    expect(survey.currentSingleQuestion?.name).toBe("q1");
    stop();
  });
});
