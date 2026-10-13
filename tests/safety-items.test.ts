import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Model } from "survey-core";
import { safetyGuidanceText } from "../src/components/copy";
import { SubmissionPanel } from "../src/components/documents";
import { scoreAssessment, ScoringError } from "../src/domain/scoring";
import { surveyDefinition } from "../src/domain/survey";
import { previewAnswers } from "../src/domain/triad-report";
import { childScale, parentScale, teacherScale } from "../src/domain/triad-scales";

const student = { age: 12, region: "CN" as const, role: "student" as const };
const parent = { age: 12, region: "CN" as const, role: "parent" as const };
const teacher = { age: 12, region: "HK" as const, role: "teacher" as const };

function choice(scale: typeof childScale, itemId: string, label: string) {
  return scale.items.find(item => item.id === itemId)?.choices.find(entry => entry.label["zh-CN"] === label);
}

describe("safety items stay early and exclusive", () => {
  it("asks c14–c16 before the long matrices and keeps them off the auto-advance timer", () => {
    const ids = childScale.items.map(item => item.id);
    expect(ids.indexOf("c14")).toBeGreaterThan(ids.indexOf("c_help"));
    expect(ids.indexOf("c14")).toBeLessThan(ids.indexOf("c15"));
    expect(ids.indexOf("c15")).toBeLessThan(ids.indexOf("c16"));
    expect(ids.indexOf("c16")).toBeLessThan(ids.indexOf("c7_1"));
    for (const id of ["c14", "c15", "c16"]) expect(childScale.items.find(item => item.id === id)?.noAutoAdvance).toBe(true);
    const survey = surveyDefinition(childScale, "student", "zh-CN");
    const serialized = JSON.stringify(survey);
    expect(serialized.indexOf('"name":"c14"')).toBeLessThan(serialized.indexOf('"name":"c7_1"'));
    for (const id of ["c14", "c15", "c16"]) expect(serialized).toContain(`"name":"${id}"`);
    expect(serialized).toContain('"noAutoAdvance":true');
    expect(serialized).toContain('"isExclusive":true');
    expect(serialized).toContain("{c14} anyof [1,2,3,4,5,7,8]");
    expect(serialized).not.toContain("{c14} anyof [1,2,3,4,5]");
  });

  it("makes none, unsure and decline exclusive on the child, parent and teacher checklists", () => {
    for (const label of ["以上均没有", "不确定", "不愿回答"]) expect(choice(childScale, "c14", label)?.exclusive).toBe(true);
    expect(choice(childScale, "c14", "想到伤害自己")?.exclusive).toBeUndefined();
    for (const label of ["以上均没有", "不确定", "不愿回答"]) expect(choice(parentScale, "q22", label)?.exclusive).toBe(true);
    for (const label of ["以上均没有", "不确定", "不便在本问卷中说明"]) expect(choice(teacherScale, "t15", label)?.exclusive).toBe(true);
  });

  it("lets a click on an exclusive safety option replace every other selection", () => {
    const survey = new Model({ elements: [{ type: "checkbox", name: "c14", choices: childScale.items.find(item => item.id === "c14")?.choices.map(entry => ({ value: entry.value, text: entry.label["zh-CN"], isExclusive: entry.exclusive === true })) }] });
    const question = survey.getQuestionByName("c14") as unknown as { value: number[]; visibleChoices: { value: number }[]; selectItem: (item: { value: number }, checked?: boolean) => void };
    const pick = (value: number) => {
      const item = question.visibleChoices.find(entry => entry.value === value);
      if (!item) throw new Error(`Missing choice ${value}`);
      question.selectItem(item, true);
    };
    pick(1);
    pick(4);
    expect([...question.value]).toEqual([1, 4]);
    pick(6);
    expect([...question.value]).toEqual([6]);
    pick(1);
    expect([...question.value]).toEqual([1]);
    pick(7);
    expect([...question.value]).toEqual([7]);
    pick(8);
    expect([...question.value]).toEqual([8]);
  });
});

describe("safety follow-up and risk visibility", () => {
  it("treats unsure and declined child answers as a staff review and still asks about immediate danger", () => {
    for (const value of [7, 8]) {
      const answers = previewAnswers(childScale, "calm");
      answers.c14 = [value];
      answers.c15 = 3;
      const score = scoreAssessment(childScale, answers, student);
      expect(score.status).toBe("valid");
      expect(score.risk).toBe(true);
      expect(score.riskMessages.some(message => message["zh-CN"].includes(value === 7 ? "不确定" : "未回答"))).toBe(true);
    }
  });

  it("does not flag “以上均没有” and ignores a hidden danger answer", () => {
    const calm = previewAnswers(childScale, "calm");
    expect(calm.c14).toEqual([6]);
    expect(calm.c15).toBeUndefined();
    const clean = scoreAssessment(childScale, calm, student);
    expect(clean.status).toBe("valid");
    expect(clean.risk).toBe(false);
    const hidden = scoreAssessment(childScale, { ...calm, c15: 1 }, student);
    expect(hidden.risk).toBe(false);
    expect(hidden.riskMessages).toEqual([]);
  });

  it("rejects combining a harm choice with an exclusive option", () => {
    const answers = previewAnswers(childScale, "risk");
    expect(() => scoreAssessment(childScale, { ...answers, c14: [1, 6] }, student)).toThrow(ScoringError);
    expect(() => scoreAssessment(childScale, { ...answers, c14: [7, 8] }, student)).toThrow(ScoringError);
  });

  it("reviews an unsure or declined parent or teacher answer without requiring the incident note", () => {
    const parentCalm = previewAnswers(parentScale, "calm");
    expect(parentCalm.q22).toEqual([7]);
    expect(scoreAssessment(parentScale, parentCalm, parent).risk).toBe(false);
    expect(scoreAssessment(parentScale, { ...parentCalm, q22: [8] }, parent).risk).toBe(true);
    expect(scoreAssessment(parentScale, { ...parentCalm, q22: [9] }, parent).status).toBe("valid");
    const teacherCalm = previewAnswers(teacherScale, "calm");
    expect(teacherCalm.t15).toEqual([6]);
    expect(scoreAssessment(teacherScale, teacherCalm, teacher).risk).toBe(false);
    const declined = scoreAssessment(teacherScale, { ...teacherCalm, t15: [8] }, teacher);
    expect(declined.risk).toBe(true);
    expect(declined.status).toBe("valid");
  });
});

describe("child safety guidance", () => {
  const panel = (region: "CN" | "HK", locale: "zh-CN" | "zh-HK", phase: "waiting" | "reporting" | null, safetyGuidance: boolean) => renderToStaticMarkup(createElement(SubmissionPanel, {
    locale, region, role: "student", phase, safetyGuidance, reportId: null, onViewReport: () => undefined, onBack: () => undefined
  }));

  it("uses the waiting note instead of the finished note while other roles are pending", () => {
    const html = panel("CN", "zh-CN", "waiting", false);
    expect(html).toContain("等待另外两方");
    expect(html).toContain("孩子、家长和老师都交齐后");
    expect(html).not.toContain("无需再次填写");
    expect(html).not.toContain("110");
  });

  it("shows region-specific guidance after a risk submission, without diagnosis language", () => {
    const cn = panel("CN", "zh-CN", "waiting", true);
    expect(cn).toContain("请先照顾你的安全");
    expect(cn).toContain("你信任的大人");
    expect(cn).toContain("110");
    expect(cn).toContain("120");
    expect(cn).toContain("等待另外两方");
    const hk = panel("HK", "zh-HK", null, true);
    expect(hk).toContain("請先照顧你的安全");
    expect(hk).toContain("你信任的大人");
    expect(hk).toContain("999");
    expect(hk).toContain("無需再次填寫");
    expect(hk).not.toContain("110");
    for (const text of [cn, hk, safetyGuidanceText("CN", "zh-HK"), safetyGuidanceText("HK", "zh-CN")]) {
      expect(text).not.toMatch(/诊断|診斷|抑郁|抑鬱|障碍|障礙|症状|症狀|自杀|自殺|临床|臨床/);
    }
    expect(safetyGuidanceText("HK", "zh-CN")).toContain("999");
    expect(safetyGuidanceText("CN", "zh-HK")).toContain("110");
  });
});
