// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Assessment, Locale, SurveyRecord } from "../src/components/api";
import { AccountDraftStore } from "../src/components/account-drafts";
import { copy } from "../src/components/copy";
import { AssessmentList } from "../src/components/workspace-views";

vi.mock("next/dynamic", () => ({ default: () => () => createElement("div", { "data-survey-runner": "mounted" }) }));
import { AssessmentView } from "../src/components/documents";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const item: Assessment = { id: "task", familyId: "family", childName: "Synthetic child", respondentId: "parent", respondentName: "Synthetic parent", respondentRole: "parent", scaleVersionId: "synthetic@1.0.0", scaleTitle: "Synthetic questionnaire", status: "pending", createdAt: "2026-10-01T00:00:00Z", reportId: null, canRespond: true, canRetryReport: false };
const base: SurveyRecord = { id: "task", status: "pending", childName: "Synthetic child", scaleTitle: "Synthetic questionnaire", demo: true, description: "Synthetic", surveyJson: {}, draftAnswers: { prior: "saved synthetic answer" }, draftRevision: 2, consentRequired: false };
let root: Root | undefined;
let store: AccountDraftStore | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; store?.discardAll(); store = undefined; vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function renderRecord(record: SurveyRecord, locale: Locale) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(record), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const owner = { id: "parent", region: "CN" as const };
  store = new AccountDraftStore(() => undefined); store.activate(owner);
  await act(async () => root!.render(createElement(AssessmentView, { owner, id: "task", refreshKey: 0, locale, region: "CN", role: "parent", draftSessions: store!, reportId: null, onViewReport() {}, onBack() {}, async onRefresh() {}, openPrivacy() {} })));
  return { host, fetch, draft: store.get(owner, "task")! };
}

for (const locale of ["zh-CN", "zh-HK"] as const) describe(`instrument availability ${locale}`, () => {
  it.each(["UNVALIDATED_INSTRUMENT", "DEMO_INSTRUMENT"] as const)("explains %s before mounting the answer form", async reason => {
    const { host, fetch, draft } = await renderRecord({ ...base, responseBlockedReason: reason }, locale);
    expect(host.textContent).toContain(copy(locale)("instrumentUnavailable"));
    expect(host.textContent).toContain(copy(locale)(reason === "UNVALIDATED_INSTRUMENT" ? "instrumentUnvalidated" : "instrumentDemoOnly"));
    expect(host.querySelector("[data-survey-runner]")).toBeNull();
    expect(host.querySelector("input,textarea")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.length).toBeGreaterThan(0);
    expect(draft.getSnapshot().answers).toEqual(base.draftAnswers);
  });
  it("leaves writable demo/official records on the normal answer path", async () => {
    const { host } = await renderRecord(base, locale);
    expect(host.querySelector("[data-survey-runner]")).not.toBeNull();
    expect(host.textContent).not.toContain(copy(locale)("instrumentUnavailable"));
  });
  it("labels the server-authorized synthetic test before the normal answer form", async () => {
    const { host } = await renderRecord({ ...base, syntheticTest: true }, locale);
    expect(host.textContent).toContain(copy(locale)("syntheticTest"));
    expect(host.textContent).toContain(copy(locale)("syntheticTestNotice"));
    expect(host.querySelector("[data-survey-runner]")).not.toBeNull();
  });
  it("keeps historical submitted records on the waiting path", async () => {
    const { host } = await renderRecord({ ...base, status: "queued", phase: "waiting", responseBlockedReason: "UNVALIDATED_INSTRUMENT" }, locale);
    expect(host.textContent).toContain(copy(locale)("triadWaiting"));
    expect(host.textContent).not.toContain(copy(locale)("instrumentUnavailable"));
    expect(host.querySelector("[data-survey-runner]")).toBeNull();
  });
  it.each([false, true])("hides Start and explains the restriction in list compact=%s", compact => {
    const html = renderToStaticMarkup(createElement(AssessmentList, { assessments: [{ ...item, responseBlockedReason: "UNVALIDATED_INSTRUMENT" }], locale, compact, navigate() {} }));
    expect(html).toContain(copy(locale)("instrumentUnavailable"));
    expect(html).toContain(copy(locale)("instrumentUnvalidated"));
    expect(html).not.toContain(copy(locale)("start"));
  });
});
