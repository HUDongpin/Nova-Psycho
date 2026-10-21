import { describe, expect, it } from "vitest";
import { Model } from "survey-core";
import { createQuestionChapters, createSurveyProgressStore, readSurveyProgress } from "../src/components/survey-progress";

function fixture() {
  const json = {
    pages: [
      { name: "background", title: "关于你", elements: [
        { type: "radiogroup", name: "first", choices: [-1, 0, 1], isRequired: true },
        { type: "html", name: "explanation", html: "说明" },
      ] },
      { name: "school", title: "学习日常", elements: [
        { type: "panel", title: "课程安排", elements: [
          { type: "checkbox", name: "many", choices: [1, 2] },
          { type: "comment", name: "words" },
          { type: "radiogroup", name: "conditional", choices: [1, 2], visibleIf: "{first} = 1" },
        ] },
      ] },
    ],
  };
  const chapters = createQuestionChapters(json);
  const model = new Model(json);
  model.questionsOnPageMode = "inputPerPage";
  model.showCompleteButton = false;
  return { json, chapters, model };
}

describe("visible survey progress", () => {
  it("keeps current position separate from answered count and excludes non-input elements", () => {
    const { model, chapters } = fixture();
    expect(readSurveyProgress(model, chapters)).toMatchObject({ position: 1, total: 3, answered: 0 });
    model.setValue("first", -1);
    model.currentElement = model.getQuestionByName("words");
    expect(readSurveyProgress(model, chapters)).toMatchObject({ position: 3, total: 3, answered: 1 });
    model.currentElement = model.getQuestionByName("first");
    expect(readSurveyProgress(model, chapters)).toMatchObject({ position: 1, total: 3, answered: 1 });
  });

  it("counts not-applicable and zero as answers but leaves whitespace and empty choices unanswered", () => {
    const { model, chapters } = fixture();
    model.data = { first: 0, many: [], words: "   " };
    expect(readSurveyProgress(model, chapters).answered).toBe(1);
    model.setValue("many", [1, 2]);
    model.setValue("words", " 一句观察 ");
    expect(readSurveyProgress(model, chapters).answered).toBe(3);
    model.setValue("first", -1);
    expect(readSurveyProgress(model, chapters).answered).toBe(3);
  });

  it("recomputes visible totals and ignores answers on questions that become hidden", () => {
    const { model, chapters } = fixture();
    model.data = { first: 1, conditional: 2 };
    expect(readSurveyProgress(model, chapters)).toMatchObject({ total: 4, answered: 2 });
    model.setValue("first", 0);
    expect(readSurveyProgress(model, chapters)).toMatchObject({ total: 3, answered: 1 });
  });

  it("preserves original page and panel labels after one-question mode transforms pages", () => {
    const { model, chapters } = fixture();
    model.currentElement = model.getQuestionByName("many");
    expect(readSurveyProgress(model, chapters).chapter).toEqual({ id: "school", title: "学习日常 · 课程安排" });
    model.currentElement = model.getQuestionByName("first");
    expect(readSurveyProgress(model, chapters).chapter).toEqual({ id: "background", title: "关于你" });
  });

  it("reads restored drafts without altering answers or completion rules", () => {
    const { model, chapters } = fixture();
    model.data = { first: -1, words: "合成观察" };
    const before = structuredClone(model.data);
    expect(readSurveyProgress(model, chapters)).toMatchObject({ total: 3, answered: 2 });
    expect(model.data).toEqual(before);
    expect(model.getQuestionByName("many").isRequired).toBe(false);
  });

  it("publishes navigation, value, and visibility changes with stable snapshots and detaches listeners", () => {
    const { model, chapters } = fixture();
    const store = createSurveyProgressStore(model, chapters);
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    let calls = 0;
    const dispose = store.subscribe(() => { calls += 1; });
    model.setValue("first", 1);
    expect(store.getSnapshot()).toMatchObject({ total: 4, answered: 1 });
    model.currentElement = model.getQuestionByName("many");
    expect(store.getSnapshot().position).toBe(2);
    expect(calls).toBeGreaterThan(0);
    const beforeDispose = calls;
    dispose();
    model.setValue("many", [2]);
    expect(calls).toBe(beforeDispose);
    expect(store.getSnapshot().answered).toBe(2);
  });

  it("uses a generic chapter and zero counts for an empty or untitled questionnaire", () => {
    const model = new Model({ elements: [] });
    expect(readSurveyProgress(model, createQuestionChapters({}))).toEqual({ position: 0, total: 0, answered: 0, chapter: { id: "assessment", title: "" } });
    const flat = { elements: [{ type: "comment", name: "free" }] };
    expect(createQuestionChapters(flat).get("free")).toEqual({ id: "assessment", title: "" });
  });
});
