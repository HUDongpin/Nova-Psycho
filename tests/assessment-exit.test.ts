// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountDraftStore } from "../src/components/account-drafts";
import type { SurveyRecord } from "../src/components/api";
vi.mock("next/dynamic", () => ({ default: () => () => createElement("div", { "data-survey-runner": true }) }));
import { AssessmentView } from "../src/components/documents";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let store: AccountDraftStore | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; store?.discardAll(); store = undefined; vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function fixture() {
  const record: SurveyRecord = { id: "exit-fixture", childName: "合成孩子", scaleTitle: "合成问卷", status: "pending", demo: true, description: "", surveyJson: {}, draftAnswers: {}, draftRevision: 0, consentRequired: false };
  let resolveSave!: (response: Response) => void;
  const save = new Promise<Response>(resolve => { resolveSave = resolve; });
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    requests.push(init?.method ?? "GET");
    return init?.method === "PATCH" ? save : Response.json(record);
  }));
  const owner = { id: "parent", region: "CN" as const };
  store = new AccountDraftStore(() => undefined); store.activate(owner);
  const onBack = vi.fn();
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(createElement(AssessmentView, { owner, id: record.id, refreshKey: 0, locale: "zh-CN", region: "CN", role: "parent", draftSessions: store!, reportId: null, onViewReport() {}, onBack, onRefresh: async () => undefined, openPrivacy() {} })));
  const draft = store.get(owner, record.id)!;
  draft.setAcknowledged(true, "zh-CN"); draft.update({ answer: "合成更改" }, "zh-CN");
  return { host, draft, onBack, resolveSave, requests };
}

describe("questionnaire return navigation", () => {
  it("waits for a real save acknowledgement before leaving", async () => {
    const f = await fixture();
    const back = f.host.querySelector<HTMLButtonElement>('[data-testid="survey-back"]');
    expect(back).not.toBeNull();
    await act(async () => back!.click());
    expect(f.requests).toContain("PATCH");
    expect(f.onBack).not.toHaveBeenCalled();
    expect(back!.disabled).toBe(true);
    await act(async () => f.resolveSave(Response.json({ revision: 1 })));
    expect(f.draft.getSnapshot().hasUnsavedChanges).toBe(false);
    expect(f.onBack).toHaveBeenCalledOnce();
  });

  it("keeps the page and answers when the return-time save fails", async () => {
    const f = await fixture();
    const back = f.host.querySelector<HTMLButtonElement>('[data-testid="survey-back"]');
    expect(back).not.toBeNull();
    await act(async () => back!.click());
    await act(async () => f.resolveSave(Response.json({ error: "合成保存失败" }, { status: 500 })));
    expect(f.onBack).not.toHaveBeenCalled();
    expect(f.draft.getSnapshot().answers).toEqual({ answer: "合成更改" });
    expect(f.host.querySelector('[role="alert"]')?.textContent).toContain("合成保存失败");
    expect(back!.disabled).toBe(false);
  });
});
