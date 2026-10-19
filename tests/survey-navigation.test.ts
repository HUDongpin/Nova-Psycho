import { afterEach, describe, expect, it, vi } from "vitest";
import { Model } from "survey-core";
import { bindChoiceAutoAdvance, bindCompletionNavigation, CHOICE_AUTO_ADVANCE_MS, configureQuestionProgress, focusFirstUnanswered, questionProgressLabel } from "../src/components/survey-navigation";
import { teacherScale } from "../src/domain/triad-scales";
import { surveyDefinition } from "../src/domain/survey";

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

describe("rendered progress notifications", () => {
  it.each([false, true])("publishes the correct ordinal after saved teacher navigation (traditional=%s)", traditional => {
    const survey = new Model(surveyDefinition(teacherScale, "teacher", traditional ? "zh-HK" : "zh-CN"));
    survey.questionsOnPageMode = "inputPerPage";
    const answers = Object.fromEntries(teacherScale.items.slice(0, 8).map(item => [item.id, item.id === "t8_1" ? 2 : item.kind === "multi" ? [item.choices[0].value] : item.choices[0].value]));
    survey.data = answers;
    focusFirstUnanswered(survey);
    configureQuestionProgress(survey, traditional);
    const suffix = traditional ? "題" : "题";
    expect(survey.currentSingleQuestion?.name).toBe("t8_2");
    expect(survey.progressText).toBe(`第 9/63 ${suffix}`);
    const displayed: unknown[] = [];
    survey.progressTextModel.onPropertyChanged.add((_sender, event) => {
      if (event.name === "progressText" && event.newValue !== undefined) displayed.push(event.newValue);
    });
    survey.prevPage();
    expect(survey.currentSingleQuestion?.name).toBe("t8_1");
    expect(displayed.at(-1)).toBe(`第 8/63 ${suffix}`);
    survey.prevPage();
    expect(survey.currentSingleQuestion?.name).toBe("t_focus");
    expect(displayed.at(-1)).toBe(`第 7/63 ${suffix}`);
    survey.nextPage();
    expect(displayed.at(-1)).toBe(`第 8/63 ${suffix}`);
    survey.nextPage();
    expect(displayed.at(-1)).toBe(`第 9/63 ${suffix}`);
    expect(survey.data).toEqual(answers);
  });

  it("publishes the new ordinal after timed single-choice auto-advance", () => {
    const survey = choiceSurvey();
    configureQuestionProgress(survey, true);
    expect(survey.progressText).toBe("第 1/5 題");
    const displayed: unknown[] = [];
    survey.progressTextModel.onPropertyChanged.add((_sender, event) => {
      if (event.name === "progressText" && event.newValue !== undefined) displayed.push(event.newValue);
    });
    vi.useFakeTimers();
    const stop = bindChoiceAutoAdvance(survey);
    survey.setValue("q1", "a");
    vi.advanceTimersByTime(CHOICE_AUTO_ADVANCE_MS);
    expect(survey.currentSingleQuestion?.name).toBe("q2");
    expect(displayed.at(-1)).toBe("第 2/5 題");
    stop();
  });
});

describe("choice auto-advance", () => {
  it("does not start a timer while the full notice is open", () => {
    const survey = choiceSurvey();
    vi.useFakeTimers();
    const onPending = vi.fn();
    const stop = bindChoiceAutoAdvance(survey, { isSuspended: () => true, onPending });
    survey.setValue("q1", "a");
    vi.advanceTimersByTime(CHOICE_AUTO_ADVANCE_MS * 2);
    expect(survey.currentSingleQuestion?.name).toBe("q1");
    expect(onPending).not.toHaveBeenCalled();
    stop();
  });

  it("checks reading suspension again at the timer boundary and does not revive the old timer", () => {
    const survey = choiceSurvey();
    vi.useFakeTimers();
    let suspended = false;
    const hooks = { delay: CHOICE_AUTO_ADVANCE_MS, isSuspended: () => suspended };
    const stop = bindChoiceAutoAdvance(survey, hooks);
    survey.setValue("q1", "a");
    vi.advanceTimersByTime(CHOICE_AUTO_ADVANCE_MS - 1);
    suspended = true;
    vi.advanceTimersByTime(1);
    expect(survey.currentSingleQuestion?.name).toBe("q1");
    suspended = false;
    vi.advanceTimersByTime(CHOICE_AUTO_ADVANCE_MS);
    expect(survey.currentSingleQuestion?.name).toBe("q1");
    survey.setValue("q1", "b");
    vi.advanceTimersByTime(CHOICE_AUTO_ADVANCE_MS);
    expect(survey.currentSingleQuestion?.name).toBe("q2");
    stop();
  });

  it("can cancel a pending advance without leaving the current question", () => {
    const survey = choiceSurvey();
    vi.useFakeTimers();
    const stop = bindChoiceAutoAdvance(survey);
    survey.setValue("q1", "a");
    vi.advanceTimersByTime(1000);
    stop.cancel();
    vi.advanceTimersByTime(CHOICE_AUTO_ADVANCE_MS);
    expect(survey.currentSingleQuestion?.name).toBe("q1");
    stop();
  });

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

  it("does not auto-advance a safety single-choice question", () => {
    const survey = new Model({
      pages: [{
        elements: [
          { type: "radiogroup", name: "before", choices: ["a", "b"] },
          { type: "radiogroup", name: "c15", noAutoAdvance: true, choices: ["是", "不是"] },
          { type: "radiogroup", name: "after", choices: ["a", "b"] }
        ]
      }]
    });
    survey.questionsOnPageMode = "inputPerPage";
    survey.showCompleteButton = false;
    survey.mode = "edit";
    vi.useFakeTimers();
    const stop = bindChoiceAutoAdvance(survey, { delay: 5000 });
    survey.setValue("before", "a");
    vi.advanceTimersByTime(5000);
    expect(survey.currentSingleQuestion?.name).toBe("c15");
    survey.setValue("c15", "是");
    vi.advanceTimersByTime(5000);
    expect(survey.currentSingleQuestion?.name).toBe("c15");
    expect(survey.state).toBe("running");
    survey.nextPage();
    expect(survey.currentSingleQuestion?.name).toBe("after");
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

describe("completion issue navigation", () => {
  it("can reconnect after an effect cleanup and still focus newly rendered questions", () => {
    const survey = choiceSurvey();
    const navigation = bindCompletionNavigation(survey, vi.fn(), () => true);
    navigation.connect();
    navigation.dispose();
    navigation.connect();
    const target = survey.getQuestionByName("q3");
    const focus = vi.spyOn(target, "focus").mockImplementation(() => undefined);
    navigation.jump("q3");
    survey.onAfterRenderQuestion.fire(survey, { question: target, htmlElement: { isConnected: true, scrollIntoView: vi.fn() } as unknown as HTMLElement });
    expect(focus).toHaveBeenCalledOnce();
    navigation.dispose();
  });

  it("waits for the target to render and focuses it again on a same-question jump", () => {
    const survey = choiceSurvey();
    const cancel = vi.fn();
    const navigation = bindCompletionNavigation(survey, cancel, () => true);
    navigation.connect();
    const target = survey.getQuestionByName("q3");
    const focus = vi.spyOn(target, "focus").mockImplementation(() => undefined);
    expect(navigation.jump("q3")).toBe(true);
    expect(survey.currentSingleQuestion?.name).toBe("q3");
    expect(focus).not.toHaveBeenCalled();
    const element = { isConnected: true, scrollIntoView: vi.fn() } as unknown as HTMLElement;
    survey.onAfterRenderQuestion.fire(survey, { question: target, htmlElement: element });
    expect(focus).toHaveBeenCalledTimes(1);
    expect(element.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    navigation.jump("q3");
    expect(focus).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(2);
    navigation.dispose();
  });

  it("does not navigate or later focus after the session locks, or to a hidden question", () => {
    const survey = choiceSurvey();
    let unlocked = true;
    const navigation = bindCompletionNavigation(survey, vi.fn(), () => unlocked);
    navigation.connect();
    const target = survey.getQuestionByName("q3");
    const focus = vi.spyOn(target, "focus").mockImplementation(() => undefined);
    navigation.jump("q3");
    unlocked = false;
    survey.onAfterRenderQuestion.fire(survey, { question: target, htmlElement: { isConnected: true, scrollIntoView: vi.fn() } as unknown as HTMLElement });
    expect(focus).not.toHaveBeenCalled();
    expect(navigation.jump("q1")).toBe(false);
    unlocked = true;
    target.visible = false;
    expect(navigation.jump("q3")).toBe(false);
    navigation.dispose();
  });
});
