// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Model } from "survey-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SurveyRecord } from "../src/components/api";
import { AssessmentDraftSession } from "../src/components/draft-session";

let model: Model;
vi.mock("survey-react-ui", () => ({ Survey: (props: { model: Model }) => {
  model = props.model;
  return createElement("div", { "data-engine": "surveyjs" });
} }));
import SurveyRunner from "../src/components/survey-runner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let draft: AssessmentDraftSession | undefined;
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  draft?.dispose(); draft = undefined;
  vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren();
});

async function fixture() {
  const record: SurveyRecord = {
    id: "synthetic-flow", status: "pending", childName: "合成孩子", scaleTitle: "合成问卷", demo: true,
    description: "", draftAnswers: {}, draftRevision: 0, consentRequired: false,
    supplements: [{ itemId: "first_other", parentId: "first", label: "其他安排（选填）", anyOf: [1], maxLength: 2000 }],
    surveyJson: { pages: [
      { name: "start", title: "学习日常", elements: [
        { name: "first", type: "radiogroup", title: "最近的学习安排", isRequired: true, choices: [0, 1, -1] },
      ] },
      { name: "more", title: "更多了解", elements: [
        { name: "second", type: "comment", title: "一段说明", isRequired: true },
        { name: "optional", type: "comment", title: "选填补充" },
      ] },
    ] },
  };
  let revision = 0;
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requests.push(url);
    return Response.json(url.includes("/submit") ? { status: "queued", phase: "waiting" } : { revision: ++revision });
  }));
  const submitted = vi.fn(async () => undefined);
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  draft = new AssessmentDraftSession(record);
  await act(async () => root!.render(createElement(SurveyRunner, {
    record, draft: draft!, locale: "zh-CN", onSubmitted: submitted,
    onReloadLatest: async () => undefined, openPrivacy() {},
  })));
  const button = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
  const start = async () => {
    await act(async () => host.querySelector<HTMLInputElement>(".survey-assent-panel input")!.click());
    await act(async () => button("survey-start").click());
  };
  return { host, button, start, requests, submitted };
}

describe("questionnaire reading, answering and review flow", () => {
  it("includes active optional details in review without treating them as extra questions", async () => {
    const f = await fixture(); await f.start();
    await act(async () => { model.setValue("first", 1); model.setValue("first_other", "合成其他安排详情"); model.setValue("second", "合成说明"); });
    await act(async () => f.button("survey-review").click());
    expect(f.host.querySelector('[data-testid="survey-progress"]')?.getAttribute("data-total")).toBe("3");
    expect(f.host.querySelector('[data-review-supplement="first_other"]')?.textContent).toContain("合成其他安排详情");
  });
  it("requires a separate start action after explicit notice confirmation", async () => {
    const f = await fixture();
    expect(f.button("survey-start")).not.toBeNull();
    expect(f.button("survey-start").disabled).toBe(true);
    expect(model.mode).toBe("display");
    await act(async () => f.host.querySelector<HTMLInputElement>(".survey-assent-panel input")!.click());
    expect(f.button("survey-start").disabled).toBe(false);
    expect(model.mode).toBe("display");
    expect(f.requests).toEqual([]);
    await act(async () => f.button("survey-start").click());
    expect(model.mode).toBe("edit");
    expect(f.host.querySelector('[data-stage="answering"]')).not.toBeNull();
    expect(f.host.querySelector('[data-testid="survey-submit"]')).toBeNull();
  });

  it("stays on a selected answer after five seconds and advances only on Next", async () => {
    vi.useFakeTimers();
    const f = await fixture(); await f.start();
    await act(async () => { model.setValue("first", 0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(model.currentSingleQuestion?.name).toBe("first");
    expect(draft!.getSnapshot().status).toBe("saved");
    await act(async () => f.button("survey-next").click());
    expect(model.currentSingleQuestion?.name).toBe("second");
    expect(f.requests.some(url => url.includes("/submit"))).toBe(false);
  });

  it("reviews missing required items, jumps back to them, and permits optional blanks", async () => {
    const f = await fixture(); await f.start();
    await act(async () => { model.setValue("first", -1); });
    await act(async () => f.button("survey-review").click());
    expect(f.host.querySelector('[data-stage="review"]')).not.toBeNull();
    expect(f.host.querySelector('[data-question-id="second"]')).not.toBeNull();
    expect(f.host.querySelector('[data-question-id="optional"][data-completion-kind]')).toBeNull();
    expect(f.requests.some(url => url.includes("/submit"))).toBe(false);
    await act(async () => f.host.querySelector<HTMLButtonElement>('.survey-completion [data-question-id="second"]')!.click());
    expect(model.currentSingleQuestion?.name).toBe("second");
    expect(f.host.querySelector('[data-stage="answering"]')).not.toBeNull();
    await act(async () => { model.setValue("second", "合成说明"); });
    await act(async () => f.button("survey-review").click());
    expect(f.host.querySelector(".survey-completion")).toBeNull();
    expect(f.submitted).not.toHaveBeenCalled();
    await act(async () => f.button("survey-submit").click());
    expect(f.requests.filter(url => url.includes("/submit"))).toHaveLength(1);
    expect(f.submitted).toHaveBeenCalledOnce();
  });
});
