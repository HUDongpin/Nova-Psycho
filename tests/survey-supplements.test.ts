import { afterEach, describe, expect, it, vi } from "vitest";
import { Model } from "survey-core";
import { parentScale, parentScaleV1 } from "../src/domain/triad-scales";
import { surveyDefinition } from "../src/domain/survey";
import { SurveySupplementController } from "../src/components/survey-supplement-controller";
import { surveySupplements, type SurveySupplement } from "../src/domain/survey-supplements";
import { bindChoiceAutoAdvance, CHOICE_AUTO_ADVANCE_MS, questionProgressLabel } from "../src/components/survey-navigation";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SupplementInput } from "../src/components/survey-supplements";

afterEach(() => vi.useRealTimers());

function fixture() {
  const model = new Model({ questionsOnPageMode: "inputPerPage", clearInvisibleValues: "onHidden", elements: [
    { type: "radiogroup", name: "gate", choices: [1, 2] },
    { type: "radiogroup", name: "parent", title: "Synthetic main", isRequired: true, visibleIf: "{gate} = 1", choices: [1, 5] },
    { type: "radiogroup", name: "next", title: "Next main", choices: [1, 2] }
  ] });
  const supplements: SurveySupplement[] = [{ itemId: "parent_other", parentId: "parent", label: "Synthetic optional detail", anyOf: [5], maxLength: 2000 }];
  model.data = { gate: 1, parent: 5, parent_other: "Synthetic saved text" };
  model.currentElement = model.getQuestionByName("parent");
  let writable = true;
  const controller = new SurveySupplementController(model, supplements, () => writable);
  controller.connect();
  return { model, controller, lock: () => { writable = false; }, unlock: () => { writable = true; } };
}

describe("registered optional supplements are not independent questionnaire pages", () => {
  it("keeps the new parent version's visible question inventory equal to its original main items", () => {
    const original = new Model(surveyDefinition(parentScaleV1, "parent", "zh-CN"));
    const current = new Model(surveyDefinition(parentScale, "parent", "zh-CN"));
    expect(current.getAllQuestions().map(question => question.name)).toEqual(original.getAllQuestions().map(question => question.name));
    expect(parentScale.items.filter(item => item.supplementFor)).toHaveLength(7);
    expect(current.getQuestionByName("p_together_other")).toBeFalsy();
  });
});

describe("optional detail uses the existing model's canonical answer", () => {
  it("reads restored canonical data and writes one text key without changing the parent or adding a question", () => {
    const { model, controller } = fixture();
    expect(controller.currentSupplement()?.itemId).toBe("parent_other");
    expect(controller.readAnswers()).toEqual({ gate: 1, parent: 5, parent_other: "Synthetic saved text" });
    const before = questionProgressLabel(model, false);
    controller.write("parent_other", "New synthetic detail");
    expect(model.data).toEqual({ gate: 1, parent: 5, parent_other: "New synthetic detail" });
    expect(model.getAllQuestions()).toHaveLength(3);
    expect(questionProgressLabel(model, false)).toBe(before);
    expect(model.currentSingleQuestion?.name).toBe("parent");
    controller.dispose();
  });

  it("clears deselected details before later draft listeners can observe an invalid payload", () => {
    const { model, controller } = fixture();
    const payloads: Record<string, unknown>[] = [];
    model.onValueChanged.add(() => { payloads.push(controller.readAnswers()); });
    model.setValue("parent", 1);
    expect(model.data).toEqual({ gate: 1, parent: 1 });
    expect(payloads.length).toBeGreaterThan(0);
    expect(payloads.every(payload => !("parent_other" in payload))).toBe(true);
    model.setValue("parent", 5);
    expect(model.getValue("parent_other")).toBeUndefined();
    controller.dispose();
  });

  it("clears hidden-parent details and empty text but keeps selected optional blanks valid", () => {
    const { model, controller } = fixture();
    controller.write("parent_other", "   ");
    expect(model.getValue("parent_other")).toBeUndefined();
    expect(model.getQuestionByName("parent").validate()).toBe(true);
    controller.write("parent_other", "Synthetic detail");
    model.setValue("gate", 2);
    expect(controller.currentSupplement()).toBeNull();
    expect(model.getValue("parent_other")).toBeUndefined();
    controller.dispose();
  });

  it("does not mutate answers while locked or write to an inactive/unregistered field", () => {
    const { model, controller, lock, unlock } = fixture();
    lock(); controller.write("parent_other", "Blocked");
    expect(model.getValue("parent_other")).toBe("Synthetic saved text");
    unlock(); controller.write("unknown_other", "Blocked");
    expect(model.getValue("unknown_other")).toBeUndefined();
    model.currentElement = model.getQuestionByName("next");
    controller.write("parent_other", "Blocked");
    expect(model.getValue("parent_other")).toBe("Synthetic saved text");
    controller.dispose();
  });

  it("suspends advance while Other is selected, then restores ordinary selection timing", () => {
    const { model, controller } = fixture();
    vi.useFakeTimers();
    const advance = bindChoiceAutoAdvance(model, { isSuspended: () => controller.hasCurrentSupplement() });
    controller.write("parent_other", "Typing");
    vi.advanceTimersByTime(CHOICE_AUTO_ADVANCE_MS * 2);
    expect(model.currentSingleQuestion?.name).toBe("parent");
    model.setValue("parent", 1);
    vi.advanceTimersByTime(CHOICE_AUTO_ADVANCE_MS);
    expect(model.currentSingleQuestion?.name).toBe("next");
    advance(); controller.dispose();
  });

  it("reconnects after lifecycle cleanup and retains data while the old version stays unchanged", () => {
    const { model, controller } = fixture();
    controller.dispose(); controller.connect();
    expect(controller.currentSupplement()?.itemId).toBe("parent_other");
    controller.write("parent_other", "After reconnect");
    expect(model.getValue("parent_other")).toBe("After reconnect");
    expect(surveySupplements(parentScaleV1, "zh-CN")).toEqual([]);
    expect(surveySupplements(parentScale, "zh-CN")).toHaveLength(7);
    controller.dispose();
  });

  it("notifies a controlled input when the existing survey switches from display to edit", async () => {
    const { model, controller } = fixture();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    model.mode = "display";
    await Promise.resolve();
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    model.mode = "edit";
    await Promise.resolve();
    expect(listener).toHaveBeenCalled();
    controller.write("parent_other", "After unlock");
    expect(model.getValue("parent_other")).toBe("After unlock");
    unsubscribe(); controller.dispose();
  });

  it("keeps multiple hidden supplement fields out of every recursive draft snapshot", () => {
    const model = new Model({ clearInvisibleValues: "onHidden", elements: [
      { type: "radiogroup", name: "gate", choices: [1, 2] },
      { type: "radiogroup", name: "p1", choices: [1, 5], visibleIf: "{gate} = 1" },
      { type: "checkbox", name: "p2", choices: [1, 5], visibleIf: "{gate} = 1" }
    ] });
    const metadata = ["p1", "p2"].map(parentId => ({ itemId: `${parentId}_other`, parentId, label: "Optional", anyOf: [5], maxLength: 2000 }));
    model.data = { gate: 1, p1: 5, p1_other: "One", p2: [1, 5], p2_other: "Two" };
    const controller = new SurveySupplementController(model, metadata, () => true);
    controller.connect();
    const snapshots: Record<string, unknown>[] = [];
    model.onValueChanged.add(() => snapshots.push(controller.readAnswers()));
    model.setValue("gate", 2);
    expect(controller.readAnswers()).toEqual({ gate: 2 });
    expect(snapshots.length).toBeGreaterThan(0);
    for (const answers of snapshots) {
      // Each detail must disappear no later than its own parent becomes hidden.
      if (!model.getQuestionByName("p1").isVisible) expect(answers).not.toHaveProperty("p1_other");
      if (!model.getQuestionByName("p2").isVisible) expect(answers).not.toHaveProperty("p2_other");
    }
    controller.dispose();
  });

  it.each(["zh-CN", "zh-HK"] as const)("renders a named optional textarea bound to its canonical id (%s)", locale => {
    const supplement = surveySupplements(parentScale, locale)[0];
    const html = renderToStaticMarkup(createElement(SupplementInput, { supplement, value: "Synthetic text", locale, disabled: false, readOnly: false, onChange() {} }));
    expect(html).toContain(`name="${supplement.itemId}"`);
    expect(html).toContain(`data-supplement-id="${supplement.itemId}"`);
    expect(html).toContain('data-testid="survey-supplement"');
    expect(html).toContain('aria-required="false"');
    expect(html).toContain('maxLength="2000"');
    const inputId = html.match(/<textarea id="([^"]+)"/)?.[1];
    expect(inputId).toBeTruthy();
    expect(html).toContain(`<label for="${inputId}">${supplement.label}</label>`);
    expect(html).toContain(locale === "zh-HK" ? "選填，不計分" : "选填，不计分");
    expect(html).not.toContain("readOnly");
    const locked = renderToStaticMarkup(createElement(SupplementInput, { supplement, value: "Synthetic text", locale, disabled: true, readOnly: true, onChange() {} }));
    expect(locked).toContain("disabled");
    expect(locked).toContain("readOnly");
  });
});
