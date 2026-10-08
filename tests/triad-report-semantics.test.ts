import { describe, expect, it } from "vitest";
import { demoAdvice, demoTemplate } from "../src/domain/demo";
import { reportHtml } from "../src/domain/report-html";
import { scoreAssessment } from "../src/domain/scoring";
import { composeTriad, previewAnswers, type TriadSource } from "../src/domain/triad-report";
import { childScale, parentScale, teacherScale } from "../src/domain/triad-scales";
import type { Locale, ReportPayload, ScaleDefinition, TriadReport } from "../src/domain/types";

const locales: Locale[] = ["zh-CN", "zh-HK"];
const submittedAt = "2026-10-08T03:00:00.000Z";

function source(original: ScaleDefinition, values: Record<string, number | number[]> = {}, risk = false): TriadSource {
  const scale = structuredClone(original);
  const preview = structuredClone(scale);
  for (const item of preview.items) {
    if (item.id === "c_age" || item.id === "p_age") item.choices = item.choices.filter(choice => choice.value === 12);
  }
  const answers = previewAnswers(preview, risk ? "risk" : "calm");
  for (const [key, value] of Object.entries(values)) {
    const dimension = scale.dimensions.find(item => item.key === key)!;
    for (const [index, id] of dimension.items.entries()) answers[id] = Array.isArray(value) ? value[index] : value;
  }
  return { role: scale.roles[0], scale, answers, score: scoreAssessment(scale, answers, { age: 12, region: "CN", role: scale.roles[0] }), submittedAt };
}

function view(report: TriadReport, from: TriadSource, key: string) {
  const dimension = from.scale.dimensions.find(item => item.key === key)!;
  return report.domains.find(item => item.key === dimension.domain)!.views.find(item => item.role === from.role && item.label["zh-CN"].endsWith(dimension.label["zh-CN"]))!;
}

function payload(sources: TriadSource[]): ReportPayload {
  const parent = sources.find(item => item.role === "parent")!;
  return {
    scale: parent.scale, score: parent.score,
    advice: { id: "synthetic-advice", version: "1.0.0", content: demoAdvice },
    template: { id: "synthetic-template", version: "1.0.0", content: demoTemplate },
    childName: "合成语义检查孩子", grade: "初中", submittedAt, aiConsented: false,
    selectedAdviceIds: [], generationMode: "template", fallbackReason: "triad_combined", aiModel: null,
    comparison: { available: false }, triad: composeTriad(sources)
  };
}

describe("triad domain comparisons", () => {
  it("does not mistake a spread across subdimensions for disagreement between respondents", () => {
    const sources = [source(childScale, { c7: 1, c8: 5 }), source(parentScale, { q14: 5, q15: 1 }), source(teacherScale, { t8: 1 })];
    expect(sources.every(item => item.score.status === "valid")).toBe(true);
    const report = composeTriad(sources);
    const cognition = report.domains.find(item => item.key === "cognition")!;
    expect(cognition.note).toBeNull();
    expect(cognition.views.map(item => ({ role: item.role, raw: item.raw }))).toEqual([
      { role: "student", raw: 1 }, { role: "student", raw: 5 },
      { role: "parent", raw: 5 }, { role: "parent", raw: 1 }, { role: "teacher", raw: 1 }
    ]);
    expect(cognition.views.every(item => Object.hasOwn(item, "submittedAt"))).toBe(true);
    expect(report.sources).toEqual(sources.map(item => ({ role: item.role, submittedAt })));
  });

  it("does not create a new disagreement threshold or assert agreement for other domains", () => {
    const sources = [source(childScale, { c9: 1, c13: 0 }), source(parentScale, { q16: 5, q20: 4 }), source(teacherScale, { t9: 3, t13: 2 })];
    const report = composeTriad(sources);
    expect(report.domains.every(item => item.note === null)).toBe(true);
    for (const locale of locales) {
      const html = reportHtml(payload(sources), locale);
      expect(html).not.toContain(locale === "zh-CN" ? "相差比较明显" : "相差比較明顯");
      expect(html).not.toContain(locale === "zh-CN" ? "三方一致" : "三方一致");
    }
  });
});

describe("snapshot answer anchors", () => {
  it.each([0, 1, 2, 3, 4])("preserves impact anchor %i as impact, not frequency, in both languages", value => {
    const sources = [source(parentScale, { q21: value }), source(teacherScale, { t14: value })];
    const report = composeTriad(sources);
    for (const from of sources) {
      const key = from.role === "parent" ? "q21" : "t14";
      const item = from.scale.items.find(item => item.id === `${key}_1`)!;
      const anchor = item.choices.find(choice => choice.value === value)!;
      const shown = view(report, from, key);
      expect(shown.raw).toBe(value);
      for (const locale of locales) {
        expect(shown.body[locale]).toContain(`${value}「${anchor.label[locale]}」`);
        expect(shown.body[locale]).not.toMatch(/经常|經常|偶尔|偶爾|有时|有時|情况越多|情況越多/);
      }
    }
  });

  it("describes fractional means between the original neighboring impact anchors without rounding into a category", () => {
    const parent = source(parentScale, { q21: [3, 3, 3, 3, 3, 4, 4] });
    const teacher = source(teacherScale, { t14: [2, 2, 2, 3, 3] });
    const report = composeTriad([parent, teacher]);
    const parentView = view(report, parent, "q21"), teacherView = view(report, teacher, "t14");
    expect(parentView.raw).toBe(3.285714);
    expect(teacherView.raw).toBe(2.4);
    for (const locale of locales) {
      expect(parentView.body[locale]).toContain("3.285714");
      expect(parentView.body[locale]).toContain(locale === "zh-CN" ? "3「较大」与 4「非常大」之间" : "3「較大」與 4「非常大」之間");
      expect(teacherView.body[locale]).toContain(locale === "zh-CN" ? "2「中等」与 3「较大」之间" : "2「中等」與 3「較大」之間");
    }
  });

  it("uses usable anchors after excluding a not-applicable answer", () => {
    const parent = source(parentScale, { q21: [-1, 3, 3, 3, 4, 4, 4] });
    const shown = view(composeTriad([parent]), parent, "q21");
    expect(parent.score.status).toBe("valid");
    expect(shown.raw).toBe(3.5);
    expect(shown.body["zh-CN"]).toContain("3「较大」与 4「非常大」之间");
    expect(shown.body["zh-CN"]).not.toContain("不适用");
  });

  it.each([1, 3, 4, 5])("retains the child's agreement anchor %i instead of rewriting it as frequency", value => {
    const child = source(childScale, { c7: value });
    const anchor = child.scale.items.find(item => item.id === "c7_1")!.choices.find(choice => choice.value === value)!;
    const shown = view(composeTriad([child]), child, "c7");
    for (const locale of locales) {
      expect(shown.body[locale]).toContain(`${value}「${anchor.label[locale]}」`);
      expect(shown.body[locale]).not.toMatch(/经常出现|經常出現|较少出现|較少出現|很少出现|很少出現/);
    }
  });

  it("retains the different anchors used by observation and distress frequency questions", () => {
    const child = source(childScale, { c13: 4 });
    const teacher = source(teacherScale, { t8: 5 });
    const report = composeTriad([child, teacher]);
    for (const locale of locales) {
      expect(view(report, child, "c13").body[locale]).toContain(locale === "zh-CN" ? "4「几乎每天」" : "4「幾乎每天」");
      expect(view(report, teacher, "t8").body[locale]).toContain(locale === "zh-CN" ? "5「几乎总是」" : "5「幾乎總是」");
    }
  });

  it("uses the labels frozen in the supplied snapshot, including its original traditional text", () => {
    const parent = source(parentScale, { q21: 3 });
    for (const item of parent.scale.items.filter(item => item.id.startsWith("q21_"))) {
      item.choices.reverse();
      item.choices.find(choice => choice.value === 3)!.label = { "zh-CN": "合成冻结影响选项", "zh-HK": "合成凍結影響選項（原繁體）" };
    }
    const shown = view(composeTriad([parent]), parent, "q21");
    expect(shown.body["zh-CN"]).toContain("3「合成冻结影响选项」");
    expect(shown.body["zh-HK"]).toContain("3「合成凍結影響選項（原繁體）」");
  });

  it("keeps a value just below an anchor between anchors instead of displaying it as the endpoint", () => {
    const parent = source(parentScale, { q21: 3 });
    parent.score.dimensions.find(item => item.key === "q21")!.raw = 3.999999;
    const shown = view(composeTriad([parent]), parent, "q21");
    expect(shown.body["zh-CN"]).toContain("3.999999");
    expect(shown.body["zh-CN"]).toContain("3「较大」与 4「非常大」之间");
  });

  it.each(["sum", "reverse", "mixed-labels", "unknown-item"] as const)("does not infer a uniform interpretation for %s scoring", mode => {
    const parent = source(parentScale, { q21: 3 });
    const dimension = parent.scale.dimensions.find(item => item.key === "q21")!;
    if (mode === "sum") {
      dimension.aggregation = "sum";
      parent.score = scoreAssessment(parent.scale, parent.answers, { age: 12, region: "CN", role: "parent" });
    } else if (mode === "reverse") parent.scale.items.find(item => item.id === "q21_1")!.reverse = true;
    else if (mode === "mixed-labels") parent.scale.items.find(item => item.id === "q21_1")!.choices.find(choice => choice.value === 3)!.label["zh-HK"] = "不同的合成標籤";
    else dimension.items.push("unknown_snapshot_item");
    const shown = view(composeTriad([parent]), parent, "q21");
    for (const locale of locales) {
      expect(shown.body[locale]).not.toMatch(/「|经常|經常|情况越多|情況越多/);
      expect(shown.body[locale]).toContain(locale === "zh-CN" ? "各题的回答" : "各題的回答");
    }
    if (mode === "sum") expect(shown.body["zh-CN"]).toContain("原始分 21");
  });

  it("keeps insufficient data uninterpreted", () => {
    const parent = source(parentScale, { q21: [-1, -1, 3, 3, 3, 3, 3] });
    const shown = view(composeTriad([parent]), parent, "q21");
    expect(shown.raw).toBeNull();
    for (const locale of locales) expect(shown.body[locale]).not.toContain("「");
  });
});

describe("portrait, safety and privacy boundaries", () => {
  it("uses the parent's original response anchors without printing a score or assigning a rank", () => {
    const parent = source(parentScale, { q24: [3, 3, 3, 3, 4, 4, 4, 4], q25: 5 });
    const report = composeTriad([parent]);
    for (const locale of locales) {
      expect(report.portrait[0].body[locale]).toContain(locale === "zh-CN" ? "本组回答的平均位置" : "本組回答的平均位置");
      expect(report.portrait[0].body[locale]).toContain(locale === "zh-CN" ? "「有时」与「经常」之间" : "「有時」與「經常」之間");
      expect(report.portrait[1].body[locale]).toContain(locale === "zh-CN" ? "「几乎总是」" : "「幾乎總是」");
      expect(report.portrait.map(item => item.body[locale]).join("")).not.toMatch(/[0-9]|原始平均分|等级|等級|排名/);
    }
  });

  it("preserves frozen answers and scores, safety-first HTML, and child/staff writing privacy", () => {
    const sources = [source(childScale, {}, true), source(parentScale, {}, true), source(teacherScale, {}, true)];
    for (const from of sources) for (const item of from.scale.items) {
      if (item.kind === "text" && from.answers[item.id] !== undefined) from.answers[item.id] = `${from.role}-${item.report}-SYNTHETIC_PRIVATE`;
    }
    const before = JSON.stringify(sources);
    const report = composeTriad(sources);
    expect(JSON.stringify(sources)).toBe(before);
    expect(sources.every(item => item.scale.version === "1.0.0")).toBe(true);
    expect(report.safety.length).toBeGreaterThan(0);
    for (const collection of [report.situations, report.priorities, report.words]) expect(collection.every(item => item.role !== "student")).toBe(true);
    for (const locale of locales) {
      const html = reportHtml(payload(sources), locale);
      expect(html.indexOf(locale === "zh-CN" ? "请先关注安全" : "請先關注安全")).toBeLessThan(html.indexOf(locale === "zh-CN" ? "三方看到的情况" : "三方看到的情況"));
      expect(html).not.toContain("student-words-SYNTHETIC_PRIVATE");
      expect(html).not.toContain("staff-SYNTHETIC_PRIVATE");
      expect(html).toContain("parent-words-SYNTHETIC_PRIVATE");
      expect(html).toContain("teacher-words-SYNTHETIC_PRIVATE");
      for (const message of report.safety) expect(html).toContain(message[locale]);
    }
  });
});
