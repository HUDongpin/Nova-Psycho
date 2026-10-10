import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ParentFamilyFields } from "../src/components/family-entry";
import { ConsentForm } from "../src/components/forms";
import type { Family } from "../src/components/api";
import { ErrorNotice, LocaleContext, LocaleSwitch, useLocale } from "../src/components/ui";
import { privacyNotice } from "../src/lib/privacy";

describe("onboarding locale and policy", () => {
  it.each(["zh-CN", "zh-HK"] as const)("renders the regional %s shell before browser preference effects run", locale => {
    function Shell() {
      const current = useLocale();
      return createElement("section", { lang: current.locale }, current.t("emailRegister"), createElement(LocaleSwitch, { locale: current.locale, onChange: current.setLocale }));
    }
    const html = renderToStaticMarkup(createElement(LocaleContext.Provider, { value: locale }, createElement(Shell)));
    expect(html).toContain(`lang="${locale}"`);
    expect(html).toContain(locale === "zh-HK" ? "使用電郵註冊" : "使用邮箱注册");
    expect(html).toContain(`<button type="button" aria-pressed="true">${locale === "zh-HK" ? "繁" : "简"}</button>`);
  });
  it.each(["zh-CN", "zh-HK"] as const)("keeps canonical submitted values and a non-submitting policy control in %s", locale => {
    const html = renderToStaticMarkup(createElement(ParentFamilyFields, { locale, openPrivacy() {} }));
    expect(html).toContain('value="母亲"');
    expect(html).toContain('value="小学四至六年级"');
    expect(html).toMatch(locale === "zh-HK" ? />母親<|>小學四至六年級</ : />母亲<|>小学四至六年级</);
    expect(html).toMatch(/<button type="button" class="text-link">.*(?:隐私与知情同意|私隱與知情同意)<\/button>/);
    expect(html).toContain('name="assessment"');
    expect(html).toContain('name="sensitiveData"');
    expect(html).toContain('name="parentReport"');
    expect(html).not.toContain('name="accepted"');
    expect(html.match(/type="checkbox" required=""/g)).toHaveLength(2);
    expect(html).toContain(locale === "zh-HK" ? "我同意參與這次評估" : "我同意参与这次测评");
    expect(html).toContain(locale === "zh-HK" ? "敏感資料" : "敏感资料");
    expect(html).toContain(locale === "zh-HK" ? "綜合報告" : "综合报告");
  });
  it("starts from the active purposes and withdraws a required scope only through an explicit action", () => {
    const family: Family = { id: "f", familyName: "Synthetic family", childName: "Synthetic child", age: 12, birthDate: "2014-01-01", grade: "小学", region: "CN", guardianLabel: "Synthetic guardian", assignedTo: null, canInviteMembers: false, createdAt: "2026-01-01T00:00:00Z", consent: true, consents: { assessment: true, sensitiveData: true, parentReport: false, aiProcessing: false }, members: [] };
    const html = renderToStaticMarkup(createElement(ConsentForm, { family, staff: false, locale: "zh-CN", onClose() {}, onDone: async () => {}, openPrivacy() {} }));
    expect(html).toContain("已记录的同意保持勾选");
    expect(html).toContain("撤回测评同意");
    expect(html).toContain("撤回敏感资料同意");
    expect(html).not.toContain("撤回家长报告同意");
    const checked = html.match(/type="checkbox"[^>]*checked=""/g) ?? [];
    expect(checked.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("disabled=\"\"");
  });
  it.each(["CN", "HK", "SG"] as const)("has no reported simplified words in the traditional %s policy", region => {
    const notice = JSON.stringify(privacyNotice("HK", "zh-HK", region));
    expect(notice).not.toMatch(/报告|撤销/);
    expect(notice).toContain("報告");
    expect(notice).toContain("撤銷");
  });
  it("renders a retained error in the currently selected locale in both directions", () => {
    const render = (message: string, locale: "zh-CN" | "zh-HK") => renderToStaticMarkup(createElement(ErrorNotice, { message, locale }));
    expect(render("账号或密码不正确。", "zh-HK")).toContain("密碼不正確");
    expect(render("賬號或密碼不正確。", "zh-CN")).toContain("账号或密码不正确");
  });
});
