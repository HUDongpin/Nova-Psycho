import { describe, expect, it } from "vitest";
import { demoAdvice, demoTemplate } from "../src/domain/demo";
import { reportHtml } from "../src/domain/report-html";
import { scoreAssessment } from "../src/domain/scoring";
import { surveyDefinition } from "../src/domain/survey";
import { composeTriad, previewAnswers, triadRolesReady } from "../src/domain/triad-report";
import { childScale, maxMissingForCoverage, parentScale, teacherScale } from "../src/domain/triad-scales";
import { formatJoinCode } from "../src/lib/triad";
import { parseScale } from "../src/domain/validation";
import type { RespondentRole, ScaleDefinition } from "../src/domain/types";

describe("family join codes", () => {
  it("uses the TOPE brand prefix", () => {
    expect(formatJoinCode("a2b3c4d5")).toBe("TOPE-A2B3C4D5");
    expect(formatJoinCode("tope-a2b3c4d5")).toBe("TOPE-A2B3C4D5");
    expect(formatJoinCode("TOPEA2B3C4D5")).toBe("TOPE-A2B3C4D5");
  });
});

describe("growth triad questionnaires", () => {
  it("keeps the three source instruments and the 75 percent rule", () => {
    for (const scale of [childScale, parentScale, teacherScale]) parseScale(scale);
    expect(childScale.items.some(item => item.label["zh-CN"].includes("我知道自己已经学会了什么"))).toBe(true);
    expect(parentScale.items.some(item => item.label["zh-CN"].includes("我会先区分事实、我的解释和我的情绪"))).toBe(true);
    expect(teacherScale.items.some(item => item.label["zh-CN"].includes("学生能判断自己是否理解"))).toBe(true);
    expect(childScale.items.find(item => item.id === "c7_1")?.label["zh-HK"]).toContain("學");
    expect(childScale.dimensions.find(item => item.key === "c7")?.maxMissing).toBe(1);
    expect(maxMissingForCoverage(8)).toBe(2);
  });

  it("leaves inapplicable answers out of the mean and flags safety selections", () => {
    const calm = previewAnswers(childScale);
    const score = scoreAssessment(childScale, calm, { age: 12, region: "CN", role: "student" });
    expect(score.status).toBe("valid");
    expect(score.risk).toBe(false);
    const excluded = { ...calm, c7_1: -1, c7_2: -1 };
    expect(scoreAssessment(childScale, excluded, { age: 12, region: "CN", role: "student" }).dimensions.find(item => item.key === "c7")?.raw).toBeNull();
    expect(scoreAssessment(childScale, previewAnswers(childScale, "risk"), { age: 12, region: "CN", role: "student" }).risk).toBe(true);
  });

  it("publishes one parent report after all three, with safety first and no parent rank", () => {
    const sources = ([["student", childScale], ["parent", parentScale], ["teacher", teacherScale]] as [RespondentRole, ScaleDefinition][]).map(([role, scale]) => {
      const answers = previewAnswers(scale, role === "parent" ? "risk" : "calm");
      const score = scoreAssessment(scale, answers, { age: 12, region: "CN", role });
      return { role, scale, answers, score, submittedAt: "2026-10-06T02:00:00.000Z" };
    });
    expect(sources.every(source => source.score.status === "valid")).toBe(true);
    expect(triadRolesReady(["parent", "teacher"])).toBe(false);
    expect(triadRolesReady(sources.map(source => source.role))).toBe(true);
    const triad = composeTriad(sources);
    const html = reportHtml({
      scale: parentScale, advice: { id: "a", version: "1.0.0", content: demoAdvice }, template: { id: "t", version: "1.0.0", content: demoTemplate },
      score: sources[1].score, childName: "小林", grade: "初中", submittedAt: sources[1].submittedAt, aiConsented: false,
      selectedAdviceIds: [], generationMode: "template", fallbackReason: null, aiModel: null, comparison: { available: false }, triad
    }, "zh-CN");
    expect(html.indexOf("请先关注安全")).toBeGreaterThan(-1);
    expect(html.indexOf("请先关注安全")).toBeLessThan(html.indexOf("三方看到的情况"));
    const portrait = html.slice(html.indexOf('class="portrait"'), html.indexOf('class="situations"'));
    expect(portrait).toContain("不给家长打分");
    expect(portrait).not.toContain("原始平均分");
    expect(html).not.toContain("13800001111");
    expect(html).toContain("想被理解");
    const survey = JSON.stringify(surveyDefinition(childScale, "student", "zh-CN"));
    expect(survey).toContain("checkbox");
    expect(survey).toContain("visibleIf");
    expect(survey).toContain("comment");
  });
});
