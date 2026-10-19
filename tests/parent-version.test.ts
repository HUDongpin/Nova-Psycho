import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as instruments from "../src/domain/triad-scales";
import { completionIssues, completionRules } from "../src/domain/completion";
import { modelInput } from "../src/domain/narrative";
import { compareResults, scoreAssessment } from "../src/domain/scoring";
import { titleEmphasis, questionDescription } from "../src/domain/survey-presentation";
import { composeTriad, previewAnswers, staffOnlyText } from "../src/domain/triad-report";
import { demoAdvice, demoTemplate } from "../src/domain/demo";
import { parseScale, parseStoredScale } from "../src/domain/validation";
import { pair } from "../src/domain/zh-pair";
import type { AssessmentSnapshot, ScaleDefinition, ScaleItem, StoredAnswer } from "../src/domain/types";

const oldParentHash = "e6262dc928c2945d491ce8ebf96f6eada93997e683642729d8b1cda190a64d57";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function withoutItemsAndVersion(scale: ScaleDefinition): Omit<ScaleDefinition, "items" | "version"> {
  const rest: Record<string, unknown> = { ...scale };
  delete rest.items;
  delete rest.version;
  return rest as Omit<ScaleDefinition, "items" | "version">;
}
const supplements = [
  ["p_together", 5, "其他共同生活安排（选填）"], ["p_grade", 6, "其他年级（选填）"],
  ["p_curriculum", 6, "其他课程体系（选填）"], ["p_care", 7, "其他照顾安排（选填）"],
  ["p_changes", 8, "其他重要变化（选填）"], ["p_focus", 11, "其他希望改善的方面（选填）"],
  ["q31", 10, "其他需要的支持（选填）"]
] as const;
const wording: Record<string, string> = {
  p_care: "孩子主要由谁陪伴或照顾，平时有哪些照顾安排？",
  q15_4: "孩子能安排任务的先后顺序，并估计任务大约需要多长时间。",
  q24_4: "我会反思自己的应对方式是否让问题加重。",
  q25_3: "我会区分“两件事有关联”和“一件事导致另一件事”，也避免把成绩变化只归因于一个因素。",
  q28_3: "我会分析问题在什么情况下发生、哪些因素让它持续，以及哪些时候问题没有出现或较轻。"
};

describe("versioned parent questionnaire", () => {
  it("keeps the complete original parent definition and unchanged child/teacher definitions", () => {
    expect(instruments.parentScaleV1).toBeDefined();
    expect(digest(instruments.parentScaleV1)).toBe(oldParentHash);
    expect(digest(instruments.childScale)).toBe("6342cc8dc27843e1d03f4689bcd1d22f925aec01892da414279dffb709fb4dcd");
    expect(digest(instruments.teacherScale)).toBe("03ef49144eac9e2e5dbe138afa4f8ef5e6c642ac78a949bfdd33382e64bf21f8");
  });

  it("keeps the wording revision and publishes safety defaults without replacing frozen baselines", () => {
    expect(instruments.parentScale.version).toBe("1.1.0");
    expect(instruments.parentScaleSafety.version).toBe("1.2.0");
    expect(instruments.childScaleSafety.version).toBe("1.1.0");
    expect(instruments.teacherScaleSafety.version).toBe("1.1.0");
    expect(instruments.triadScales.map(scale => `${scale.id}@${scale.version}`).sort()).toEqual([
      "growth-child@1.0.0", "growth-child@1.1.0", "growth-child@1.2.0", "growth-parent@1.0.0", "growth-parent@1.1.0", "growth-parent@1.2.0", "growth-teacher@1.0.0", "growth-teacher@1.1.0"
    ]);
    expect(instruments.currentTriadScaleIds).toEqual({ parent: "growth-parent@1.2.0", student: "growth-child@1.2.0", teacher: "growth-teacher@1.1.0" });
  });

  it("changes only the approved old-item wording and adds seven independent optional staff fields", () => {
    const next = instruments.parentScale, previous = instruments.parentScaleV1;
    expect(previous).toBeDefined();
    expect(next.items).toHaveLength(152);
    const newMetadata = withoutItemsAndVersion(next);
    const oldMetadata = withoutItemsAndVersion(previous);
    expect(newMetadata).toEqual(oldMetadata);
    for (const old of previous.items) {
      const expected = structuredClone(old);
      if (wording[old.id]) expected.label = pair(wording[old.id]);
      if (old.id === "p_support") expected.choices.find(choice => choice.value === 6)!.label = pair("亲子沟通与协作支持");
      expect(next.items.find(item => item.id === old.id)).toEqual(expected);
    }
    expect(next.items.filter(item => !item.supplementFor).map(item => item.id)).toEqual(previous.items.map(item => item.id));
    for (const [parentId, value, label] of supplements) {
      const index = next.items.findIndex(item => item.id === parentId), parent = next.items[index];
      expect(next.items[index + 1]).toEqual({ id: `${parentId}_other`, label: pair(label), kind: "text", choices: [], reverse: false, required: false, report: "staff", supplementFor: parentId, showIf: { itemId: parentId, anyOf: [value] }, page: parent.page, pageTitle: parent.pageTitle });
    }
    expect(digest(previous)).toBe(oldParentHash);
    expect(next.dimensions).not.toBe(previous.dimensions);
    expect(next.items[0]).not.toBe(previous.items[0]);
  });

  it("keeps scoring mechanics and real NA responses but never treats the versions as equivalent", () => {
    expect(instruments.parentScaleV1).toBeDefined();
    const answers = { ...previewAnswers(instruments.parentScaleV1), q14_1: -1 };
    const before = structuredClone(answers);
    const context = { age: 12, region: "CN" as const, role: "parent" as const };
    const old = scoreAssessment(instruments.parentScaleV1, answers, context), next = scoreAssessment(instruments.parentScale, answers, context);
    expect(next.dimensions).toEqual(old.dimensions);
    expect(next.riskMessages).toEqual(old.riskMessages);
    expect(next.status).toBe(old.status);
    expect(compareResults(next, old)).toEqual({ available: false, reason: "incompatible_version" });
    expect(answers).toEqual(before);
    expect(completionIssues(completionRules(instruments.parentScale), answers)).toEqual([]);
  });

  it("keeps both canonical versions' presentation while excluding unknown versions", () => {
    expect(instruments.parentScaleV1).toBeDefined();
    for (const scale of [instruments.parentScaleV1, instruments.parentScale, instruments.parentScaleSafety]) for (const locale of ["zh-CN", "zh-HK"] as const) {
      expect(titleEmphasis(scale, "parent", locale)).toHaveLength(1);
      expect(questionDescription(scale, "parent", scale.items.find(item => item.id === "q20_1")!, locale)).toContain(locale === "zh-CN" ? "孩子" : "孩子");
      expect(titleEmphasis({ ...scale, version: "9.9.9" }, "parent", locale)).toEqual([]);
    }
  });

  it("combines new-parent and original child/teacher snapshots without publishing staff supplements or sending them to AI", () => {
    expect(instruments.parentScale.items.filter(item => item.supplementFor)).toHaveLength(7);
    const parent = instruments.parentScale, answers: Record<string, StoredAnswer> = previewAnswers(parent);
    for (const [id, value] of supplements) {
      answers[id] = parent.items.find(item => item.id === id)!.kind === "multi" ? [value] : value;
      answers[`${id}_other`] = `SYNTHETIC_PRIVATE_SUPPLEMENT_${id}`;
    }
    const score = scoreAssessment(parent, answers, { age: 12, region: "CN", role: "parent" });
    expect(score.status).toBe("valid");
    const sources = [instruments.childScale, parent, instruments.teacherScale].map(scale => {
      const values = scale === parent ? answers : previewAnswers(scale), role = scale.roles[0];
      return { role, scale, answers: values, score: scoreAssessment(scale, values, { age: 12, region: "CN", role }), submittedAt: "2026-10-15T00:00:00Z" };
    });
    expect(composeTriad(sources).sources).toHaveLength(3);
    expect(JSON.stringify(composeTriad(sources))).not.toContain("SYNTHETIC_PRIVATE_SUPPLEMENT");
    expect(staffOnlyText(parent, answers).filter(item => item.value.startsWith("SYNTHETIC_PRIVATE_SUPPLEMENT"))).toHaveLength(7);
    const snapshot: AssessmentSnapshot = { scale: parent, score, childName: "Synthetic", grade: "S1", submittedAt: "2026-10-15T00:00:00Z", aiConsented: true, advice: { id: "advice", version: "1.0.0", content: demoAdvice }, template: { id: "template", version: "1.0.0", content: demoTemplate } };
    expect(JSON.stringify(modelInput(snapshot))).not.toContain("SYNTHETIC_PRIVATE_SUPPLEMENT");
  });
});

function withSupplement(): ScaleDefinition {
  const scale = structuredClone(instruments.parentScale);
  scale.items = scale.items.filter(item => !item.supplementFor);
  scale.items.push({ id: "test_other", kind: "text", label: pair("其他课程（选填）"), choices: [], reverse: false, required: false, report: "staff", supplementFor: "p_curriculum", showIf: { itemId: "p_curriculum", anyOf: [6] } });
  return scale;
}

describe("supplement schema boundary", () => {
  it("accepts explicit optional staff-only text paired to a valid choice", () => {
    expect(parseStoredScale(withSupplement()).items.at(-1)).toMatchObject({ supplementFor: "p_curriculum", required: false, report: "staff" });
  });
  it.each([
    ["required", (item: ScaleItem) => { item.required = true; }],
    ["parent report", (item: ScaleItem) => { item.report = "words"; }],
    ["choice type", (item: ScaleItem) => { item.kind = "single"; item.report = "omit"; item.choices = [{ value: 1, label: pair("一") }, { value: 2, label: pair("二") }]; }],
    ["missing parent", (item: ScaleItem) => { item.supplementFor = "unknown"; }],
    ["text parent", (item: ScaleItem) => { item.supplementFor = "p_worry"; item.showIf = { itemId: "p_worry", anyOf: [1] }; }],
    ["no condition", (item: ScaleItem) => { delete item.showIf; }],
    ["different condition parent", (item: ScaleItem) => { item.showIf = { itemId: "p_together", anyOf: [5] }; }],
    ["invalid choice", (item: ScaleItem) => { item.showIf!.anyOf = [99]; }],
    ["entry gate", (item: ScaleItem) => { item.gate = 1; }]
  ] as const)("rejects a supplement with %s", (_name, mutate) => {
    const scale = withSupplement(); mutate(scale.items.at(-1)!); expect(() => parseScale(scale)).toThrow();
  });
  it("rejects two supplements for one parent", () => {
    const scale = withSupplement(); scale.items.push({ ...structuredClone(scale.items.at(-1)!), id: "second_other" }); expect(() => parseScale(scale)).toThrow();
  });
  it("does not admit a supplement into scoring or safety rules", () => {
    const scored = withSupplement(); scored.dimensions[0].items.push("test_other"); expect(() => parseScale(scored)).toThrow();
    const safety = withSupplement(); safety.riskRules.push({ itemId: "test_other", values: [1], message: pair("不可使用的风险规则") }); expect(() => parseScale(safety)).toThrow();
  });
});
