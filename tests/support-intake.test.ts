import { createHash } from "node:crypto";
import { Model } from "survey-core";
import { describe, expect, it } from "vitest";
import * as instruments from "../src/domain/triad-scales";
import { completionIssues, completionRules } from "../src/domain/completion";
import { answerVisible, compareResults, scoreAssessment, validateAnswers } from "../src/domain/scoring";
import { surveyDefinition } from "../src/domain/survey";
import { previewAnswers } from "../src/domain/triad-report";
import { parseStoredScale } from "../src/domain/validation";
import type { RespondentRole, ScaleDefinition, StoredAnswer } from "../src/domain/types";

const approved = {
  parent: ["p_assent", "p_together", "p_changes", "p_history", "p_focus", "p_duration", "q20_1", "q20_2", "q20_3", "q20_4", "q20_5", "q20_6", "q20_8", "q21_1", "q21_3", "q21_4", "q22", "q16_1", "q18_1", "q18_2", "q19_1", "q19_5", "q31", "p_support", "q37"],
  student: ["c_assent", "c_company", "c_help", "c14", "c8_3", "c8_5", "c11_1", "c9_1", "c9_6", "c11_2", "c12_1", "c12_2", "c13_1", "c13_2", "c13_3", "c13_4", "c13_6", "c13_8", "c22", "c23"],
  teacher: ["t_assent", "t_known", "t_focus", "t15", "t13_1", "t13_2", "t13_4", "t13_5", "t13_7", "t14_1", "t11_1", "t12_2", "t17", "t21", "t22"]
} satisfies Record<RespondentRole, string[]>;
const conditional = { parent: ["q23"], student: ["c15", "c16"], teacher: ["t16"] };
const wish = { parent: "q37", student: "c22", teacher: "t21" };
const checklist = { parent: "q22", student: "c14", teacher: "t15" };
const short = () => ({ parent: instruments.parentScaleSupportIntake, student: instruments.childScaleSupportIntake, teacher: instruments.teacherScaleSupportIntake });
const previous = { parent: instruments.parentScaleStaffNotes, student: instruments.childScaleStaffNotes, teacher: instruments.teacherScaleStaffNotes };
const roles = ["parent", "student", "teacher"] as const;
const context = (role: RespondentRole, age = 12) => ({ age, region: "CN" as const, role });
function ordinaryAnswers(scale: ScaleDefinition): Record<string, StoredAnswer> {
  const answers = previewAnswers(scale);
  for (const item of scale.items) if (item.kind === "text" && !item.required) delete answers[item.id];
  return answers;
}

describe("versioned support intake questionnaires", () => {
  it("makes only the new versions defaults and keeps explicit long-form defaults", () => {
    expect(instruments.currentTriadScaleIds).toEqual({ parent: "growth-parent@2.0.0", student: "growth-child@2.0.0", teacher: "growth-teacher@2.0.0" });
    expect(instruments.legacyTriadScaleIds).toEqual({ parent: "growth-parent@1.3.0", student: "growth-child@1.3.0", teacher: "growth-teacher@1.2.0" });
  });

  it.each(roles)("contains exactly the approved %s items, without supplements or age extras", role => {
    const scale = short()[role];
    expect(scale).toBeDefined();
    expect(scale.version).toBe("2.0.0");
    expect(scale.resultMode).toBe("support-intake");
    expect(scale.dimensions).toEqual([]);
    expect(scale.items.map(item => item.id).sort()).toEqual([...approved[role], ...conditional[role]].sort());
    expect(scale.items.some(item => item.supplementFor || item.visibleFromAge)).toBe(false);
    expect(scale.items.filter(item => item.kind === "text" && !item.showIf).map(item => item.id)).toEqual([wish[role]]);
    expect(scale.items.find(item => item.id === wish[role])?.required).toBe(false);
    expect(scale.items.find(item => item.id === checklist[role])!.page).toBe("safety");
    expect(scale.items.findIndex(item => item.id === checklist[role])).toBeLessThan(5);
    expect(parseStoredScale(scale)).toEqual(scale);
    expect(scale.norm.validated).toBe(false);
    expect(scale.norm.source).not.toContain("75 percent");
  });

  it.each(roles)("preserves %s wording, answer choices, time windows and safety dependencies", role => {
    const scale = short()[role];
    for (const item of scale.items) {
      const original = previous[role].items.find(entry => entry.id === item.id)!;
      expect(item.label).toEqual(original.label);
      expect(item.choices).toEqual(original.choices);
      expect(item.showIf).toEqual(original.showIf);
      expect(item.excludeValues).toEqual(original.excludeValues);
      expect(item.gate).toBe(original.gate);
      expect(item.report).toBe(original.report);
      if (item.id !== wish[role]) expect(item.required).toBe(original.required);
    }
    expect(scale.riskRules).toEqual(previous[role].riskRules);
    const state = scale.items.find(item => item.id === (role === "parent" ? "q20_1" : role === "student" ? "c13_1" : "t13_1"))!;
    expect(state.pageTitle?.["zh-CN"]).toContain(role === "student" ? "两周" : "四周");
    if (role !== "student") {
      const support = scale.items.find(item => item.id === (role === "parent" ? "q16_1" : "t11_1"))!;
      expect(support.pageTitle?.["zh-CN"]).toContain("三个月");
      for (const id of role === "parent" ? ["q21_1", "q21_3", "q21_4"] : ["t15", "t16"]) {
        expect(scale.items.find(item => item.id === id)?.pageTitle?.["zh-CN"]).toContain("四周");
      }
    }
  });

  it.each(roles)("renders the same %s normal count at ages 8, 11, 12 and 17 in both locales", role => {
    const scale = short()[role];
    for (const age of [8, 11, 12, 17]) for (const locale of ["zh-CN", "zh-HK"] as const) {
      const model = new Model(surveyDefinition(scale, role, locale, { age }));
      model.data = ordinaryAnswers(scale);
      expect(model.getAllQuestions().filter(question => question.isVisible)).toHaveLength(approved[role].length);
      expect(model.getAllQuestions().map(question => question.name).sort()).toEqual(scale.items.map(item => item.id).sort());
    }
  });

  it.each(roles)("accepts honest unknown responses and no ordinary writing for %s without scoring", role => {
    const scale = short()[role], answers = ordinaryAnswers(scale);
    for (const item of scale.items) if (item.excludeValues?.includes(-1)) answers[item.id] = -1;
    expect(completionIssues(completionRules(scale, 12), answers)).toEqual([]);
    expect(scoreAssessment(scale, answers, context(role))).toMatchObject({ status: "valid", resultMode: "support-intake", dimensions: [], risk: false });
    const missing = { ...answers }; delete missing[approved[role][1]];
    expect(scoreAssessment(scale, missing, context(role))).toMatchObject({ status: "incomplete", reasons: ["required_items_missing"] });
    expect(() => validateAnswers(scale, { ...answers, removed_long_form_item: 1 })).toThrow();
  });

  it.each(roles)("preserves all %s safety options and conditional completion requirements", role => {
    const scale = short()[role], item = scale.items.find(item => item.id === checklist[role])!;
    for (const choice of item.choices) {
      const answers = ordinaryAnswers(scale);
      answers[item.id] = [choice.value];
      for (const followId of conditional[role]) {
        const follow = scale.items.find(entry => entry.id === followId)!;
        if (answerVisible(answers, follow)) {
          if (follow.kind === "text") answers[followId] = "SYNTHETIC safety observation";
          else if (follow.kind === "multi") answers[followId] = [3];
          else answers[followId] = 3;
        } else delete answers[followId];
      }
      const score = scoreAssessment(scale, answers, context(role));
      const expected = scale.riskRules.some(rule => rule.itemId === item.id && rule.values.includes(choice.value));
      expect(score.risk).toBe(expected);
      expect(score.status).toBe("valid");
      const model = new Model(surveyDefinition(scale, role, "zh-CN", { age: 12 })); model.data = answers;
      const visibleFollowups = conditional[role].filter(id => answerVisible(answers, scale.items.find(entry => entry.id === id)!));
      expect(model.getAllQuestions().filter(question => question.isVisible)).toHaveLength(approved[role].length + visibleFollowups.length);
      for (const followId of visibleFollowups) if (scale.items.find(entry => entry.id === followId)!.required) {
        const missing = { ...answers }; delete missing[followId];
        expect(completionIssues(completionRules(scale), missing)).toContainEqual({ kind: "required_missing", itemId: followId });
      }
    }
    const exclusive = item.choices.find(choice => choice.exclusive)!;
    expect(() => validateAnswers(scale, { ...ordinaryAnswers(scale), [item.id]: [1, exclusive.value] })).toThrow();
  });

  it("retains the child's immediate-danger and after-completion safety rules", () => {
    const scale = short().student, answers = ordinaryAnswers(scale);
    const immediate = scoreAssessment(scale, { ...answers, c14: [7], c15: 2 }, context("student"));
    expect(immediate.riskMessages).toEqual(scale.riskRules.filter(rule => (rule.itemId === "c14" && rule.values.includes(7)) || (rule.itemId === "c15" && rule.values.includes(2))).map(rule => rule.message));
    const closing = scoreAssessment(scale, { ...answers, c23: 3 }, context("student"));
    expect(closing.risk).toBe(true);
    expect(closing.riskMessages).toEqual(scale.riskRules.filter(rule => rule.itemId === "c23").map(rule => rule.message));
  });
});

describe("support intake validation and comparison boundaries", () => {
  it("allows empty dimensions only in explicit support-intake mode", () => {
    const empty = { ...instruments.parentScaleStaffNotes, dimensions: [] };
    expect(() => parseStoredScale(empty)).toThrow();
    expect(() => parseStoredScale({ ...empty, resultMode: "scored" })).toThrow();
    expect(parseStoredScale({ ...empty, resultMode: "support-intake" }).dimensions).toEqual([]);
    expect(() => parseStoredScale({ ...instruments.parentScaleStaffNotes, resultMode: "support-intake" })).toThrow();
    expect(() => parseStoredScale({ ...empty, resultMode: "support-intake", bundle: undefined })).toThrow();
  });

  it("never reports a score comparison when either side is a support intake", () => {
    const scale = short().parent;
    const intake = scoreAssessment(scale, ordinaryAnswers(scale), context("parent"));
    const legacy = scoreAssessment(previous.parent, previewAnswers(previous.parent), context("parent"));
    for (const prior of [null, intake, legacy]) expect(compareResults(intake, prior)).toEqual({ available: false, reason: "not_scored" });
    expect(compareResults(legacy, intake)).toEqual({ available: false, reason: "not_scored" });
    expect(compareResults(legacy, legacy).available).toBe(true);
  });

  it("leaves all eleven historical scale definitions byte-identical", () => {
    const frozen = {
      "growth-child@1.0.0": "6342cc8dc27843e1d03f4689bcd1d22f925aec01892da414279dffb709fb4dcd",
      "growth-child@1.1.0": "099640bf90c6e6802a391eac49ab9a9839819d622f1725b72428acc89ff37c4b",
      "growth-child@1.2.0": "a09634e93906490416a48980946e160d113f532c71b8275a817a94d68cd46d49",
      "growth-child@1.3.0": "cc26d5245c94a726957c17e723e8b405fe6865fb7623309b5006dc0b3af30c6e",
      "growth-parent@1.0.0": "e6262dc928c2945d491ce8ebf96f6eada93997e683642729d8b1cda190a64d57",
      "growth-parent@1.1.0": "b6499e2db001aab776e3bee1a9c27b6a539f6b1960e6040424b355ebfac91b6f",
      "growth-parent@1.2.0": "f1522d3e505036b9a86ba9e0af6e3629b1c7dfd8b216068125ac5d587d8ebb58",
      "growth-parent@1.3.0": "cdd3b10c1759754dc826eef173377044d2da46f11a1f91953cf95cd189d02077",
      "growth-teacher@1.0.0": "03ef49144eac9e2e5dbe138afa4f8ef5e6c642ac78a949bfdd33382e64bf21f8",
      "growth-teacher@1.1.0": "032d46ab2c78768f4f289537d036694530ec9de153ea54152fefd4e976fd97f2",
      "growth-teacher@1.2.0": "c29faa15a8bff0435ef6614aa23be7de57fc7545d3a3e2e7d081e7eae827098d"
    };
    for (const [id, hash] of Object.entries(frozen)) {
      const scale = instruments.triadScales.find(scale => `${scale.id}@${scale.version}` === id);
      expect(createHash("sha256").update(JSON.stringify(scale)).digest("hex"), id).toBe(hash);
    }
  });
});
