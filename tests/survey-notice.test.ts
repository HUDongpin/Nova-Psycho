import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SurveyRunner from "../src/components/survey-runner";
import { AssessmentDraftSession } from "../src/components/draft-session";
import type { SurveyRecord } from "../src/components/api";
import { SurveyNotice } from "../src/components/survey-notice";

describe("assessment notice structure", () => {
  it("shows a short summary and makes the full notice a separate action from acknowledgement", () => {
    const record: SurveyRecord = { id: "notice-synthetic", status: "pending", childName: "Synthetic", scaleTitle: "Synthetic", description: "", demo: true, surveyJson: { elements: [{ type: "radiogroup", name: "q1", choices: [1, 2] }] }, draftAnswers: {}, draftRevision: 0, consentRequired: false };
    const draft = new AssessmentDraftSession(record);
    const html = renderToStaticMarkup(createElement(SurveyRunner, { record, draft, locale: "zh-CN", onSubmitted: async () => undefined, onReloadLatest: async () => undefined, openPrivacy: () => undefined }));
    expect(html).toContain('data-testid="survey-notice-summary"');
    expect(html).toContain('data-testid="survey-notice-open"');
    expect(html).toContain('aria-haspopup="dialog"');
    const acknowledgement = html.match(/<label class="checkbox-label">([\s\S]*?)<\/label>/)?.[1] || "";
    expect(acknowledgement).toContain('type="checkbox"');
    expect(acknowledgement).not.toContain("<button");
    expect(acknowledgement).not.toContain("checked");
    draft.dispose();
  });
  it.each(["zh-CN", "zh-HK"] as const)("keeps the initial confirmation explicit and independent from the full-notice action (%s)", locale => {
    const html = renderToStaticMarkup(createElement(SurveyNotice, { locale, acknowledged: false, disabled: false, consentRequired: false, onAcknowledged() {}, onOpen() {} }));
    const acknowledgement = html.match(/<label class="checkbox-label">([\s\S]*?)<\/label>/)?.[1] || "";
    expect(acknowledgement).toContain('type="checkbox"');
    expect(acknowledgement).not.toContain("disabled");
    expect(acknowledgement).not.toContain("checked");
    expect(acknowledgement).not.toContain("<button");
    expect(acknowledgement).toContain(locale === "zh-HK" ? "我已了解上述說明及私隱須知，自願作答。" : "我已了解上述说明及隐私须知，自愿作答。");
    expect(html).toContain(locale === "zh-HK" ? "不提供醫學診斷" : "不提供医学诊断");
    expect(html).toContain(locale === "zh-HK" ? "服務人員按家庭分工存取資料" : "服务人员按家庭分工访问资料");
  });
  it("retains a previously given confirmation and preserves the existing locked state", () => {
    const html = renderToStaticMarkup(createElement(SurveyNotice, { locale: "zh-CN", acknowledged: true, disabled: true, consentRequired: true, onAcknowledged() {}, onOpen() {} }));
    const acknowledgement = html.match(/<label class="checkbox-label">([\s\S]*?)<\/label>/)?.[1] || "";
    expect(acknowledgement).toContain("disabled");
    expect(acknowledgement).toContain("checked");
    expect(html).toContain("请先记录监护人知情同意。");
  });
});
