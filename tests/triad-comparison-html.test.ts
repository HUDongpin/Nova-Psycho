import { describe, expect, it } from "vitest";
import { demoAdvice, demoTemplate } from "../src/domain/demo";
import { reportHtml } from "../src/domain/report-html";
import { scoreAssessment } from "../src/domain/scoring";
import { composeTriad, previewAnswers } from "../src/domain/triad-report";
import { parentScale } from "../src/domain/triad-scales";
import type { Locale, ReportPayload } from "../src/domain/types";
import { pair } from "../src/domain/zh-pair";

const currentDate = "2026-10-20T03:00:00.000Z";
const previousDate = "2026-07-20T03:00:00.000Z";
const changes = [
  { key: "q14", label: pair("学习和思考"), previous: 2, current: 3, delta: 1, higherMeans: "more_strength" as const },
  { key: "q20", label: pair("最近状态"), previous: 3, current: 2, delta: -1, higherMeans: "more_support" as const },
  { key: "q21", label: pair("影响"), previous: 2, current: 2, delta: 0, higherMeans: "more_support" as const }
];
function payload(): ReportPayload {
  const answers = previewAnswers(parentScale);
  const score = scoreAssessment(parentScale, answers, { age: 12, region: "CN", role: "parent" });
  return {
    scale: parentScale, score, childName: "合成比较孩子", grade: "初中", submittedAt: currentDate, aiConsented: false,
    advice: { id: "advice", version: "1", content: demoAdvice },
    template: { id: "template", version: "1", content: demoTemplate },
    selectedAdviceIds: [], generationMode: "template", fallbackReason: "triad_combined", aiModel: null,
    comparison: { available: true },
    triad: {
      ...composeTriad([{ role: "parent", scale: parentScale, score, answers, submittedAt: currentDate }]),
      ...{ comparisons: [
        { role: "student" as const, currentDate, previousDate, available: true, changes: structuredClone(changes), omitted: [{ key: "c18", label: pair("接下来的方向") }] },
        { role: "parent" as const, currentDate, previousDate, available: false, reason: "incompatible_version" as const },
        { role: "teacher" as const, currentDate, previousDate, available: false, reason: "different_respondent" as const }
      ] }
    }
  };
}

describe("triad longitudinal report HTML", () => {
  it.each(["zh-CN", "zh-HK"] as const)("renders per-role dates, values and bounded interpretations in %s", locale => {
    const html = reportHtml(payload(), locale);
    const section = html.slice(html.indexOf('<section class="triad-comparison"'));
    expect(section).toContain(locale === "zh-CN" ? "和上一轮相比" : "和上一輪相比");
    for (const date of [currentDate, previousDate]) {
      expect(section).toContain(new Intl.DateTimeFormat(locale, { timeZone: "Asia/Hong_Kong", year: "numeric", month: "long", day: "numeric" }).format(new Date(date)));
    }
    expect(section).toContain("+1"); expect(section).toContain("-1"); expect(section).not.toContain("+0");
    expect(section).toContain(locale === "zh-CN" ? "原始分没有变化" : "原始分沒有變化");
    expect(section).toContain(locale === "zh-CN" ? "分数越高表示需要更多支持" : "分數越高表示需要更多支持");
    expect(section).toContain(locale === "zh-CN" ? "分数越高表示该方面的优势更明显" : "分數越高表示該方面的優勢更明顯");
    expect(section).toContain(locale === "zh-CN" ? "问卷版本或计分依据不同" : "問卷版本或計分依據不同");
    expect(section).toContain(locale === "zh-CN" ? "填写人不同" : "填寫人不同");
    expect(section).toContain(locale === "zh-CN" ? "接下来的方向" : "接下來的方向");
    expect(section).toContain(locale === "zh-CN" ? "不适用或有效回答不足" : "不適用或有效回答不足");
    expect(section).toContain(locale === "zh-CN" ? "变化本身不证明辅导疗效" : "變化本身不證明輔導療效");
    expect(section).toContain(locale === "zh-CN" ? "不合成三方总分" : "不合成三方總分");
  });

  it.each(["zh-CN", "zh-HK"] as const)("distinguishes no prior round from unrecorded historical comparisons in %s", (locale: Locale) => {
    const p = payload();
    p.triad = { ...p.triad!, comparisons: [{ role: "parent", currentDate, available: false, reason: "first_assessment" }] };
    expect(reportHtml(p, locale)).toContain(locale === "zh-CN" ? "没有更早的完整三方记录" : "沒有更早的完整三方紀錄");
    delete p.triad.comparisons;
    const html = reportHtml(p, locale);
    expect(html).toContain(locale === "zh-CN" ? "这份历史报告未记录前后比较结果" : "這份歷史報告未記錄前後比較結果");
    expect(html).not.toContain(locale === "zh-CN" ? "没有更早的完整三方记录" : "沒有更早的完整三方紀錄");
  });

  it("escapes comparison labels and keeps safety before longitudinal values", () => {
    const p = payload();
    p.triad!.safety = [pair("请先获得安全支持")];
    p.triad!.comparisons![0].changes![0].label = pair("<script>private()</script>");
    const html = reportHtml(p, "zh-CN");
    expect(html).toContain("&lt;script&gt;private()&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html.indexOf('class="risk"')).toBeLessThan(html.indexOf('<section class="triad-comparison"'));
  });
});
