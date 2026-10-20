// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { demoTemplate } from "../src/domain/demo";
import { reportHtml } from "../src/domain/report-html";
import { scoreAssessment } from "../src/domain/scoring";
import { composeTriad, previewAnswers } from "../src/domain/triad-report";
import { childScale, parentScale, teacherScale } from "../src/domain/triad-scales";
import type { AdviceLibrary, Locale, ReportPayload } from "../src/domain/types";

const locales: Locale[] = ["zh-CN", "zh-HK"];
const submittedAt = "2026-10-20T03:00:00.000Z";
const frozenAdvice: AdviceLibrary = {
  title: { "zh-CN": "合成冻结建议库", "zh-HK": "合成凍結建議庫" },
  blocks: [
    { id: "first", title: { "zh-CN": "第一条支持", "zh-HK": "第一條支持" }, body: { "zh-CN": "第一条冻结文本", "zh-HK": "第一條凍結文字" }, source: "合成来源 A", dimensionKeys: [] },
    { id: "second", title: { "zh-CN": "第二条支持", "zh-HK": "第二條支持" }, body: { "zh-CN": "第二条冻结文本", "zh-HK": "第二條凍結文字" }, source: "合成来源 B", dimensionKeys: [] },
    { id: "unselected", title: { "zh-CN": "未选择建议", "zh-HK": "未選擇建議" }, body: { "zh-CN": "不应展示的文本", "zh-HK": "不應展示的文字" }, source: "合成来源 C", dimensionKeys: [] }
  ]
};

function payload(): ReportPayload {
  const sources = [childScale, parentScale, teacherScale].map(scale => {
    const answers = previewAnswers(scale, "calm");
    return { role: scale.roles[0], scale, answers, score: scoreAssessment(scale, answers, { age: 12, region: "CN", role: scale.roles[0] }), submittedAt };
  });
  const parent = sources.find(source => source.role === "parent")!;
  return {
    scale: parent.scale, score: parent.score,
    advice: { id: "frozen-parent-library", version: "1.1.0", content: structuredClone(frozenAdvice) },
    template: { id: "frozen-template", version: "1.0.0", content: demoTemplate },
    childName: "合成报告孩子", grade: "初中", submittedAt, aiConsented: true,
    selectedAdviceIds: ["second", "first"], generationMode: "ai", fallbackReason: null, aiModel: "synthetic-sorter",
    comparison: { available: false }, triad: composeTriad(sources)
  };
}

function documentFor(p: ReportPayload, locale: Locale): Document {
  return new DOMParser().parseFromString(reportHtml(p, locale), "text/html");
}

describe("triad advice presentation", () => {
  it.each(locales)("renders only frozen approved advice in the saved order for %s", locale => {
    const p = payload();
    p.selectedAdviceIds = ["second", "unknown-model-text", "first"];
    const document = documentFor(p, locale);
    const blocks = [...document.querySelectorAll(".advice")];
    expect(blocks.map(block => block.querySelector("h3")?.textContent)).toEqual([
      `1. ${frozenAdvice.blocks[1].title[locale]}`,
      `2. ${frozenAdvice.blocks[0].title[locale]}`
    ]);
    expect(blocks.map(block => block.querySelector("p")?.textContent)).toEqual([
      frozenAdvice.blocks[1].body[locale],
      frozenAdvice.blocks[0].body[locale]
    ]);
    expect(document.body.textContent).not.toContain(frozenAdvice.blocks[2].body[locale]);
    expect(document.body.textContent).not.toContain("unknown-model-text");
    expect(blocks[0].textContent).toContain(frozenAdvice.blocks[1].source);
  });

  it.each(locales)("escapes frozen advice, provenance and version text for %s", locale => {
    const p = payload();
    const block = p.advice.content.blocks[0];
    block.title[locale] = '<script>alert("title")</script>';
    block.body[locale] = '<img src=x onerror="alert(1)"> & "frozen"';
    block.source = "<b>source</b> & 'evidence'";
    p.advice.version = "<version>";
    const document = documentFor(p, locale);
    const advice = document.querySelectorAll(".advice")[1];
    expect(advice).toBeDefined();
    expect(advice.querySelector("h3")?.textContent).toBe(`2. ${block.title[locale]}`);
    expect(advice.querySelector("p")?.textContent).toBe(block.body[locale]);
    expect(advice.textContent).toContain(block.source);
    expect(document.querySelector("script, img, b")).toBeNull();
    expect(document.querySelector("footer")?.textContent).toContain("<version>");
  });

  it.each(locales)("shows the saved AI mode and advice version for %s", locale => {
    const document = documentFor(payload(), locale);
    expect(document.querySelector("footer")?.textContent).toContain(locale === "zh-CN" ? "AI 辅助排序建议" : "AI 輔助排序建議");
    expect(document.querySelector("footer")?.textContent).toContain(locale === "zh-CN" ? "建议库版本 1.1.0" : "建議庫版本 1.1.0");
    expect(document.body.textContent).toContain(locale === "zh-CN" ? "家长可以尝试的下一步" : "家長可以嘗試的下一步");
  });

  it.each(locales)("keeps old template snapshots renderable without triad applicability metadata for %s", locale => {
    const p = payload();
    p.selectedAdviceIds = [];
    p.generationMode = "template";
    p.fallbackReason = "triad_combined";
    p.aiModel = null;
    p.advice.version = "1.0.0";
    const document = documentFor(p, locale);
    expect(document.querySelectorAll(".advice")).toHaveLength(0);
    expect(document.body.textContent).toContain(locale === "zh-CN" ? "本次报告未附加支持建议。" : "本次報告未附加支持建議。");
    expect(document.querySelector("footer")?.textContent).toContain(locale === "zh-CN" ? "规则模板生成" : "規則模板產生");
    expect(document.querySelector("footer")?.textContent).toContain("1.0.0");
    expect(document.querySelector("footer")?.textContent).not.toContain("AI");
    expect(document.querySelectorAll(".dimension").length).toBeGreaterThan(0);
    expect(document.querySelector(".limitation")?.textContent).toBe(demoTemplate.limitation[locale]);
  });

  it("keeps safety before routine advice and advice before the limitation and footer", () => {
    const p = payload();
    p.triad!.safety = [{ "zh-CN": "合成安全提示", "zh-HK": "合成安全提示" }];
    const document = documentFor(p, "zh-CN");
    const safety = document.querySelector(".risk")!;
    const advice = document.querySelector(".advice")!;
    const limitation = document.querySelector(".limitation")!;
    const footer = document.querySelector("footer")!;
    expect(advice).not.toBeNull();
    expect(safety.compareDocumentPosition(advice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(advice.compareDocumentPosition(limitation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(limitation.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
