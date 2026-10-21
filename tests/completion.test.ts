import { describe, expect, it, vi } from "vitest";
import { completionIssues, completionRules, type CompletionRules } from "../src/domain/completion";
import { scoreAssessment } from "../src/domain/scoring";
import { previewAnswers } from "../src/domain/triad-report";
import { childScale, childScaleBirthAge, childScaleStaffNotes, parentScale, teacherScale } from "../src/domain/triad-scales";

function rulesFor(count: number, maxMissing: number): CompletionRules {
  const itemIds = Array.from({ length: count }, (_, index) => `q_${index + 1}`);
  return {
    items: itemIds.map(id => ({ id, kind: "single", required: true, excludeValues: [-1] })),
    dimensions: [{ key: "dimension", label: { "zh-CN": "合成维度", "zh-HK": "合成維度" }, itemIds, maxMissing }]
  };
}

describe("questionnaire completion diagnostics", () => {
  it.each([[6, 1, 5, false], [6, 1, 4, true], [8, 2, 6, false], [8, 2, 5, true]] as const)("checks %i items with maxMissing=%i and %i usable answers", (count, maxMissing, usable, insufficient) => {
    const rules = rulesFor(count, maxMissing);
    const answers = Object.fromEntries(rules.items.map((item, index) => [item.id, index < usable ? 3 : -1]));
    const issues = completionIssues(rules, answers);
    expect(issues).toEqual(insufficient ? [{
      kind: "insufficient_coverage", dimensionKey: "dimension", itemIds: rules.dimensions[0].itemIds,
      answered: usable, required: count - maxMissing, total: count,
      unansweredItemIds: [], excludedItemIds: rules.items.slice(usable).map(item => item.id)
    }] : []);
  });

  it("treats all NA answers as coverage insufficiency and never as missing required answers", () => {
    const rules = rulesFor(6, 1);
    const answers = Object.fromEntries(rules.items.map(item => [item.id, -1]));
    expect(completionIssues(rules, answers)).toEqual([{
      kind: "insufficient_coverage", dimensionKey: "dimension", itemIds: rules.dimensions[0].itemIds,
      answered: 0, required: 5, total: 6, unansweredItemIds: [], excludedItemIds: rules.dimensions[0].itemIds
    }]);
  });

  it("distinguishes an actual missing required item from excluded answers in the same dimension", () => {
    const rules = rulesFor(6, 1);
    expect(completionIssues(rules, { q_1: 3, q_2: 3, q_3: 3, q_4: 3, q_5: -1 })).toEqual([
      { kind: "required_missing", itemId: "q_6" },
      { kind: "insufficient_coverage", dimensionKey: "dimension", itemIds: rules.dimensions[0].itemIds,
        answered: 4, required: 5, total: 6, unansweredItemIds: ["q_6"], excludedItemIds: ["q_5"] }
    ]);
  });

  it("still requires a missing mandatory answer when coverage alone is sufficient", () => {
    const rules = rulesFor(6, 1);
    expect(completionIssues(rules, { q_1: 3, q_2: 3, q_3: 3, q_4: 3, q_5: 3 })).toEqual([{ kind: "required_missing", itemId: "q_6" }]);
  });

  it("checks empty text and multi-select responses while preserving optional and hidden questions", () => {
    const rules: CompletionRules = { dimensions: [], items: [
      { id: "choice", kind: "multi", required: true },
      { id: "text", kind: "text", required: true },
      { id: "optional", kind: "single", required: false },
      { id: "followup", kind: "text", required: true, showIf: { itemId: "choice", anyOf: [2, 4] } }
    ] };
    expect(completionIssues(rules, { choice: [], text: "  \n " })).toEqual([
      { kind: "required_missing", itemId: "choice" }, { kind: "required_missing", itemId: "text" }
    ]);
    expect(completionIssues(rules, { choice: [1], text: "synthetic" })).toEqual([]);
    expect(completionIssues(rules, { choice: [2], text: "synthetic" })).toEqual([{ kind: "required_missing", itemId: "followup" }]);
    rules.items[0].kind = "single";
    expect(completionIssues(rules, { choice: 4, text: "synthetic" })).toEqual([{ kind: "required_missing", itemId: "followup" }]);
  });

  it("does not turn an optional dimension into a coverage blocker", () => {
    const rules = rulesFor(6, 1);
    rules.dimensions[0].optional = true;
    const answers = Object.fromEntries(rules.items.map(item => [item.id, -1]));
    expect(completionIssues(rules, answers)).toEqual([]);
    delete answers.q_1;
    expect(completionIssues(rules, answers)).toEqual([{ kind: "required_missing", itemId: "q_1" }]);
  });

  it("keeps a dimension's assigned denominator when some questions become hidden", () => {
    const rules = rulesFor(6, 1);
    for (const item of rules.items.slice(4)) item.showIf = { itemId: "gate", anyOf: [1] };
    const issues = completionIssues(rules, { gate: 0, q_1: 3, q_2: 3, q_3: 3, q_4: 3 });
    expect(issues).toEqual([{
      kind: "insufficient_coverage", dimensionKey: "dimension", itemIds: rules.dimensions[0].itemIds,
      answered: 4, required: 5, total: 6, unansweredItemIds: ["q_5", "q_6"], excludedItemIds: []
    }]);
  });

  it("returns every insufficient dimension in source order", () => {
    const rules = rulesFor(6, 1);
    rules.dimensions.push({ ...rules.dimensions[0], key: "second", itemIds: ["q_1", "q_2"], maxMissing: 0 });
    const answers = Object.fromEntries(rules.items.map(item => [item.id, -1]));
    expect(completionIssues(rules, answers).map(issue => issue.kind === "insufficient_coverage" ? issue.dimensionKey : issue.itemId)).toEqual(["dimension", "second"]);
  });

  it("uses the assigned version's missing allowance and still needs at least one usable response", () => {
    const answers = { q_1: 3, q_2: 3, q_3: 3, q_4: 3, q_5: -1, q_6: -1 };
    expect(completionIssues(rulesFor(6, 1), answers)).toHaveLength(1);
    expect(completionIssues(rulesFor(6, 2), answers)).toEqual([]);
    expect(completionIssues(rulesFor(1, 1), { q_1: -1 })).toMatchObject([{ required: 1, answered: 0 }]);
  });

  it("does not mutate rules or real NA/free-text answers and emits no raw answer content", () => {
    const rules = completionRules(parentScale);
    const answers = { ...previewAnswers(parentScale), q14_1: -1, q14_2: -1, p_worry: "PRIVATE_SYNTHETIC_FREE_TEXT" };
    const rulesBefore = structuredClone(rules), answersBefore = structuredClone(answers);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const issues = completionIssues(rules, answers);
      expect(rules).toEqual(rulesBefore);
      expect(answers).toEqual(answersBefore);
      expect(JSON.stringify(issues)).not.toContain("PRIVATE_SYNTHETIC_FREE_TEXT");
      expect(output).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally { output.mockRestore(); errors.mockRestore(); }
  });

  it("projects independent rules without scores, choices, report routing or clinical metadata", () => {
    const scale = structuredClone(childScale), original = structuredClone(scale);
    const rules = completionRules(scale);
    expect(Object.keys(rules)).toEqual(["items", "dimensions"]);
    expect(rules.items.every(item => Object.keys(item).every(key => ["id", "kind", "required", "showIf", "excludeValues"].includes(key)))).toBe(true);
    expect(rules.dimensions.every(dimension => Object.keys(dimension).every(key => ["key", "label", "itemIds", "maxMissing", "optional"].includes(key)))).toBe(true);
    rules.dimensions[0].label["zh-CN"] = "changed";
    rules.dimensions[0].itemIds.pop();
    const conditional = rules.items.find(item => item.showIf);
    conditional?.showIf?.anyOf.push(99);
    rules.items.find(item => item.excludeValues)?.excludeValues?.push(99);
    expect(scale).toEqual(original);
  });

  it.each([childScaleBirthAge, childScaleStaffNotes])("does not require birth-date youth items hidden from an under-12 child on $id@$version", scale => {
    const answers = previewAnswers(scale);
    for (const id of Object.keys(answers)) if (id.startsWith("c18_")) delete answers[id];
    expect(scoreAssessment(scale, answers, { age: 11, region: "CN", role: "student" }).status).toBe("valid");
    expect(completionIssues(completionRules(scale, 11), answers)).toEqual([]);
    expect(completionIssues(completionRules(scale, 12), answers).filter(issue => issue.kind === "required_missing").map(issue => issue.itemId)).toEqual(["c18_1", "c18_2", "c18_3", "c18_4", "c18_5", "c18_6"]);
    expect(completionRules(scale).items.find(item => item.id === "c18_1")?.required).toBe(true);
  });

  it.each([childScale, parentScale, teacherScale])("agrees with unchanged scoring coverage across $id dimension boundaries", scale => {
    const role = scale.roles[0], rules = completionRules(scale);
    for (const dimension of scale.dimensions.filter(candidate => !candidate.optional)) {
      for (const excludedCount of [dimension.maxMissing, dimension.maxMissing + 1]) {
        const answers = previewAnswers(scale);
        for (const id of dimension.items.slice(0, excludedCount)) answers[id] = -1;
        const score = scoreAssessment(scale, answers, { age: 12, region: "CN", role });
        const issues = completionIssues(rules, answers);
        expect(issues.filter(issue => issue.kind === "required_missing")).toEqual([]);
        expect(issues.filter(issue => issue.kind === "insufficient_coverage").map(issue => issue.dimensionKey)).toEqual(score.dimensions.filter(item => item.raw === null && !scale.dimensions.find(source => source.key === item.key)?.optional).map(item => item.key));
        expect(issues.length === 0).toBe(score.status === "valid");
      }
    }
  });
});
