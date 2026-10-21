import { describe, expect, it } from "vitest";
import { Model } from "survey-core";
import { createQuestionChapters, createSurveyProgressStore, createSurveySectionsStore, readSurveyProgress, readSurveySections } from "../src/components/survey-progress";

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

  it("notifies every global-progress subscriber once per changed snapshot and detaches each independently", () => {
    const { model, chapters } = fixture();
    const events = [model.onValueChanged, model.onCurrentPageChanged, model.onQuestionVisibleChanged, model.onPageVisibleChanged, model.onPanelVisibleChanged];
    const baseline = events.map(event => event.length);
    const store = createSurveyProgressStore(model, chapters);
    let firstCalls = 0;
    let secondCalls = 0;
    const disposeFirst = store.subscribe(() => { firstCalls += 1; });
    const disposeSecond = store.subscribe(() => { secondCalls += 1; });
    model.setValue("first", -1);
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
    const answered = store.getSnapshot();
    model.setValue("first", 0);
    expect(store.getSnapshot()).toBe(answered);
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
    model.currentElement = model.getQuestionByName("many");
    expect(firstCalls).toBe(2);
    expect(secondCalls).toBe(2);
    disposeFirst();
    model.setValue("many", [1]);
    expect(firstCalls).toBe(2);
    expect(secondCalls).toBe(3);
    disposeSecond();
    expect(events.map(event => event.length)).toEqual(baseline);
    model.setValue("many", []);
    expect(secondCalls).toBe(3);
  });

  it("uses a generic chapter and zero counts for an empty or untitled questionnaire", () => {
    const model = new Model({ elements: [] });
    expect(readSurveyProgress(model, createQuestionChapters({}))).toEqual({ position: 0, total: 0, answered: 0, chapter: { id: "assessment", title: "" } });
    const flat = { elements: [{ type: "comment", name: "free" }] };
    expect(createQuestionChapters(flat).get("free")).toEqual({ id: "assessment", title: "" });
  });
});

describe("visible survey sections", () => {
  it("groups by original page ID in source order and uses the page label without panel labels", () => {
    const { json, model, chapters } = fixture();
    const before = structuredClone(json);
    expect(readSurveySections(model, chapters)).toEqual([
      { id: "background", title: "关于你", questionIds: ["first"], answered: 0, total: 1, targetId: "first" },
      { id: "school", title: "学习日常", questionIds: ["many", "words"], answered: 0, total: 2, targetId: "many" },
    ]);
    expect(json).toEqual(before);
    expect(chapters.get("many")).toEqual({ id: "school", title: "学习日常 · 课程安排" });
  });

  it("preserves original source order even when the model presents pages in a different order", () => {
    const { json, chapters } = fixture();
    const model = new Model({ ...json, pages: [...json.pages].reverse() });
    model.questionsOnPageMode = "inputPerPage";
    expect(readSurveySections(model, chapters).map(section => section.id)).toEqual(["background", "school"]);
  });

  it("targets the first unanswered visible question, treating whitespace as empty and zero and minus one as answers", () => {
    const { model, chapters } = fixture();
    model.data = { first: 0, many: [1], words: " \n\t " };
    expect(readSurveySections(model, chapters)).toMatchObject([
      { answered: 1, total: 1, targetId: "first" },
      { answered: 1, total: 2, targetId: "words" },
    ]);
    model.setValue("first", -1);
    model.setValue("words", "合成观察");
    expect(readSurveySections(model, chapters)).toMatchObject([
      { answered: 1, total: 1, targetId: "first" },
      { answered: 2, total: 2, targetId: "many" },
    ]);
    model.setValue("many", []);
    expect(readSurveySections(model, chapters)[1]).toMatchObject({ answered: 1, total: 2, targetId: "many" });
  });

  it("recomputes conditional questions and removes a chapter once every answerable question is hidden", () => {
    const { model, chapters } = fixture();
    model.data = { first: 1, many: [1], words: "合成观察", conditional: 2 };
    expect(readSurveySections(model, chapters)[1]).toEqual({
      id: "school", title: "学习日常", questionIds: ["many", "words", "conditional"], answered: 3, total: 3, targetId: "many",
    });
    model.setValue("first", 0);
    expect(readSurveySections(model, chapters)[1]).toMatchObject({ questionIds: ["many", "words"], answered: 2, total: 2 });
    model.getQuestionByName("many").visible = false;
    model.getQuestionByName("words").visible = false;
    expect(readSurveySections(model, chapters)).toEqual([
      { id: "background", title: "关于你", questionIds: ["first"], answered: 1, total: 1, targetId: "first" },
    ]);
  });

  it("keeps global and chapter counts aligned when their containing panel or page becomes hidden", () => {
    const json = { pages: [
      { name: "keep", elements: [{ type: "comment", name: "one" }] },
      { name: "chapter", elements: [{ type: "panel", name: "context", elements: [
        { type: "comment", name: "two" },
        { type: "comment", name: "three" },
      ] }] },
    ] };
    const model = new Model(json);
    model.questionsOnPageMode = "inputPerPage";
    model.data = { one: "合成观察", two: "合成回答" };
    const chapters = createQuestionChapters(json);
    const store = createSurveySectionsStore(model, chapters);
    const globalStore = createSurveyProgressStore(model, chapters);
    let visibleSections = store.getSnapshot();
    let globalProgress = globalStore.getSnapshot();
    const dispose = store.subscribe(() => { visibleSections = store.getSnapshot(); });
    const disposeGlobal = globalStore.subscribe(() => { globalProgress = globalStore.getSnapshot(); });
    const expectAlignedCounts = (total: number, answered: number) => {
      expect(globalProgress).toMatchObject({ total, answered });
      expect(readSurveyProgress(model, chapters)).toMatchObject({ total, answered });
      expect(visibleSections.reduce((sum, section) => sum + section.total, 0)).toBe(total);
      expect(visibleSections.reduce((sum, section) => sum + section.answered, 0)).toBe(answered);
    };
    expectAlignedCounts(3, 2);
    model.getPanelByName("context").visible = false;
    expect(visibleSections.map(section => section.id)).toEqual(["keep"]);
    expectAlignedCounts(1, 1);
    model.getPanelByName("context").visible = true;
    expect(visibleSections.map(section => section.id)).toEqual(["keep", "chapter"]);
    expectAlignedCounts(3, 2);
    model.getPageByName("chapter").visible = false;
    expect(visibleSections.map(section => section.id)).toEqual(["keep"]);
    expectAlignedCounts(1, 1);
    model.getPageByName("chapter").visible = true;
    expectAlignedCounts(3, 2);
    dispose();
    disposeGlobal();
  });

  it("keeps distinct page IDs with identical labels and provides an empty fallback label", () => {
    const json = { pages: [
      { name: "a", title: "同名", elements: [{ type: "comment", name: "a1" }] },
      { name: "b", title: "同名", elements: [{ type: "comment", name: "b1" }] },
      { name: "c", elements: [{ type: "comment", name: "c1" }] },
    ] };
    const model = new Model(json);
    model.questionsOnPageMode = "inputPerPage";
    expect(readSurveySections(model, createQuestionChapters(json))).toMatchObject([
      { id: "a", title: "同名", questionIds: ["a1"] },
      { id: "b", title: "同名", questionIds: ["b1"] },
      { id: "c", title: "", questionIds: ["c1"] },
    ]);
    expect(readSurveySections(model, new Map())).toEqual([
      { id: "assessment", title: "", questionIds: ["a1", "b1", "c1"], answered: 0, total: 3, targetId: "a1" },
    ]);
    expect(readSurveySections(new Model({ elements: [] }), new Map())).toEqual([]);
  });

  it("reads restored answers without navigating, changing data, or completing the questionnaire", () => {
    const { model, chapters } = fixture();
    model.data = { first: -1, many: [2], words: "合成观察" };
    const before = structuredClone(model.data);
    const current = model.currentSingleQuestion;
    expect(readSurveySections(model, chapters)).toMatchObject([{ answered: 1 }, { answered: 2 }]);
    expect(model.data).toEqual(before);
    expect(model.currentSingleQuestion).toBe(current);
    expect(model.state).toBe("running");
    expect(model.showCompleteButton).toBe(false);
  });

  it("keeps the snapshot stable for navigation and answer edits that do not change section content", () => {
    const { model, chapters } = fixture();
    const store = createSurveySectionsStore(model, chapters);
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    model.currentElement = model.getQuestionByName("words");
    expect(store.getSnapshot()).toBe(first);
    model.setValue("first", -1);
    const answered = store.getSnapshot();
    expect(answered).not.toBe(first);
    model.setValue("first", 0);
    expect(store.getSnapshot()).toBe(answered);
  });

  it("replaces the snapshot when the target changes while the answered total stays equal", () => {
    const { model, chapters } = fixture();
    model.data = { many: [1] };
    const store = createSurveySectionsStore(model, chapters);
    const first = store.getSnapshot();
    expect(first[1]).toMatchObject({ answered: 1, total: 2, targetId: "words" });
    model.data = { words: "合成观察" };
    const next = store.getSnapshot();
    expect(next).not.toBe(first);
    expect(next[1]).toMatchObject({ answered: 1, total: 2, targetId: "many" });
    expect(store.getSnapshot()).toBe(next);
  });

  it("replaces the snapshot when visible IDs change even if counts and target stay equal", () => {
    const json = { pages: [{ name: "branch", elements: [
      { type: "comment", name: "always" },
      { type: "comment", name: "left", visibleIf: "{side} != 'right'" },
      { type: "comment", name: "right", visibleIf: "{side} = 'right'" },
    ] }] };
    const model = new Model(json);
    model.questionsOnPageMode = "inputPerPage";
    const store = createSurveySectionsStore(model, createQuestionChapters(json));
    const first = store.getSnapshot();
    model.setVariable("side", "right");
    const next = store.getSnapshot();
    expect(next).not.toBe(first);
    expect(first[0]).toMatchObject({ questionIds: ["always", "left"], answered: 0, total: 2, targetId: "always" });
    expect(next[0]).toMatchObject({ questionIds: ["always", "right"], answered: 0, total: 2, targetId: "always" });
  });

  it("notifies all subscribers on value and visibility changes and removes every listener on disposal", () => {
    const { model, chapters } = fixture();
    const events = [model.onValueChanged, model.onCurrentPageChanged, model.onQuestionVisibleChanged, model.onPageVisibleChanged, model.onPanelVisibleChanged];
    const baseline = events.map(event => event.length);
    const store = createSurveySectionsStore(model, chapters);
    let firstCalls = 0;
    let secondCalls = 0;
    const disposeFirst = store.subscribe(() => { firstCalls += 1; });
    const disposeSecond = store.subscribe(() => { secondCalls += 1; });
    model.setValue("first", 0);
    expect(firstCalls).toBeGreaterThan(0);
    expect(secondCalls).toBe(firstCalls);
    const beforeNavigation = firstCalls;
    model.currentElement = model.getQuestionByName("many");
    expect(firstCalls).toBe(beforeNavigation);
    model.getQuestionByName("words").visible = false;
    expect(firstCalls).toBeGreaterThan(beforeNavigation);
    expect(secondCalls).toBe(firstCalls);
    const beforeDispose = firstCalls;
    disposeFirst();
    model.setValue("many", [1]);
    expect(firstCalls).toBe(beforeDispose);
    expect(secondCalls).toBeGreaterThan(beforeDispose);
    const secondBeforeDispose = secondCalls;
    disposeSecond();
    expect(events.map(event => event.length)).toEqual(baseline);
    model.setValue("many", []);
    expect(secondCalls).toBe(secondBeforeDispose);
    expect(store.getSnapshot()[1].answered).toBe(0);
  });
});
