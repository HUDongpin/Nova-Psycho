// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Model } from "survey-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SurveyRecord } from "../src/components/api";
import { AssessmentDraftSession } from "../src/components/draft-session";
import { STUDENT_SUPPORT_OPTIONS } from "../src/domain/student-sharing";
let model: Model;
vi.mock("survey-react-ui", () => ({ Survey: (props: { model: Model }) => { model = props.model; return createElement("div", { "data-engine": "surveyjs" }); } }));
import SurveyRunner from "../src/components/survey-runner";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, draft: AssessmentDraftSession | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; draft?.dispose(); draft = undefined; vi.unstubAllGlobals(); document.body.replaceChildren(); });
async function fixture(locale: "zh-CN" | "zh-HK" = "zh-CN") {
  const record: SurveyRecord = { id: "staged-synthetic-child", status: "pending", childName: "合成孩子", scaleTitle: "合成问卷", demo: true, description: "", draftAnswers: {}, draftRevision: 0, consentRequired: false, studentSharing: true, surveyJson: { pages: [{ name: "sharing", elements: [
    { name: "private", type: "comment", title: "Private field" },
    { name: "c_share_support", type: "checkbox", title: "Sharing", choices: [0, 1, 2, 3, 4, 5] },
    { name: "c_share_confirm", type: "radiogroup", title: "Confirm", choices: [0, 1], visibleIf: "{c_share_support} anyof [1,2,3,4,5]", isRequired: true },
  ] }] } };
  let revision = 0;
  const fetch = vi.fn(async (url: string, _options?: RequestInit) => Response.json(url.includes("/submit") ? { status: "submitted", phase: "reporting" } : { revision: ++revision })); vi.stubGlobal("fetch", fetch);
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); draft = new AssessmentDraftSession(record);
  const submitted = vi.fn(async () => undefined);
  await act(async () => root!.render(createElement(SurveyRunner, { record, draft: draft!, locale, onSubmitted: submitted, onReloadLatest: async () => undefined, openPrivacy() {} })));
  await act(async () => host.querySelector<HTMLInputElement>(".survey-assent-panel input")!.click());
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="survey-start"]')!.click());
  const review = async () => { await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="survey-review"]')!.click()); };
  return { host, fetch, submitted, review };
}
for (const locale of ["zh-CN", "zh-HK"] as const) describe(`student sharing review ${locale}`, () => {
  it("shows only the exact selected fixed sentences and requires confirmation in review even after an earlier answer", async () => {
    const f = await fixture(locale);
    await act(async () => { model.setValue("private", "PRIVATE_RESPONSE_NEVER_IN_PREVIEW"); model.setValue("c_share_support", [3, 1]); model.setValue("c_share_confirm", 1); });
    await f.review();
    const preview = f.host.querySelector('[data-testid="student-sharing-preview"]')!;
    expect(preview).not.toBeNull(); expect(preview.textContent).not.toContain("PRIVATE_RESPONSE_NEVER_IN_PREVIEW");
    expect([...preview.querySelectorAll("li")].map(item => item.textContent)).toEqual([STUDENT_SUPPORT_OPTIONS[2].label[locale], STUDENT_SUPPORT_OPTIONS[0].label[locale]]);
    const submit = f.host.querySelector<HTMLButtonElement>('[data-testid="survey-submit"]')!;
    expect(submit.disabled).toBe(true);
    await act(async () => preview.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click()); expect(f.submitted).toHaveBeenCalledOnce();
    const sent = f.fetch.mock.calls.find(([url]) => url.includes("/submit"));
    expect(JSON.parse(sent![1]!.body as string).answers.c_share_confirm).toBe(1);
  });
  it.each([undefined, [0]])("allows no-share %s without confirmation", async value => {
    const f = await fixture(locale); await act(async () => model.setValue("c_share_support", value)); await f.review();
    const preview = f.host.querySelector('[data-testid="student-sharing-preview"]')!;
    expect(preview.querySelector("input")).toBeNull();
    const submit = f.host.querySelector<HTMLButtonElement>('[data-testid="survey-submit"]')!; expect(submit.disabled).toBe(false);
    await act(async () => submit.click()); expect(f.submitted).toHaveBeenCalledOnce();
  });
  it("invalidates confirmation when selected sentences change", async () => {
    const f = await fixture(locale); await act(async () => { model.setValue("c_share_support", [1]); model.setValue("c_share_confirm", 1); }); await f.review();
    await act(async () => f.host.querySelector<HTMLInputElement>('[data-testid="student-sharing-preview"] input')!.click());
    await act(async () => model.setValue("c_share_support", [2]));
    expect(model.getValue("c_share_confirm")).not.toBe(1);
    expect(f.host.querySelector<HTMLButtonElement>('[data-testid="survey-submit"]')!.disabled).toBe(true);
  });
});
