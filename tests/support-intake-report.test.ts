import { describe, expect, it } from "vitest";
import { demoAdvice, demoTemplate } from "../src/domain/demo";
import { reportHtml } from "../src/domain/report-html";
import { scoreAssessment } from "../src/domain/scoring";
import { compareTriad } from "../src/domain/triad-comparison";
import { composeTriad, previewAnswers, type TriadSource } from "../src/domain/triad-report";
import { childScaleStaffNotes, childScaleSupportIntake, parentScaleStaffNotes, parentScaleSupportIntake, teacherScaleStaffNotes, teacherScaleSupportIntake } from "../src/domain/triad-scales";
import type { Locale, ReportPayload, ScaleDefinition } from "../src/domain/types";
import { pair } from "../src/domain/zh-pair";

const submittedAt = "2026-10-23T04:00:00.000Z";
const expectedIds = {
  concerns: ["p_focus", "q20_1", "q20_2", "q20_3", "q20_4", "q20_5", "q20_6", "q20_8", "q21_1", "q21_3", "q21_4", "t_focus", "t13_1", "t13_2", "t13_4", "t13_5", "t13_7", "t14_1"],
  supports: ["q16_1", "q18_1", "q18_2", "q19_1", "q19_5", "t11_1", "t12_2"],
  actions: ["q31", "t22", "t21"]
};

// A broad synthetic definition verifies the explicit parent-report allowlist,
// including when private items remain present in a frozen questionnaire.
function source(original: ScaleDefinition): TriadSource {
  const scale = structuredClone(original);
  scale.version = "2.0.0";
  scale.resultMode = "support-intake";
  scale.dimensions = [];
  const answers = previewAnswers(scale);
  return { role: scale.roles[0], scale, answers, score: scoreAssessment(scale, answers, { age: 12, region: "CN", role: scale.roles[0] }), submittedAt };
}

function sources(): TriadSource[] {
  return [source(childScaleStaffNotes), source(parentScaleStaffNotes), source(teacherScaleStaffNotes)];
}

function payload(from: TriadSource[]): ReportPayload {
  const parent = from.find(item => item.role === "parent")!;
  return {
    scale: parent.scale, score: parent.score,
    advice: { id: "synthetic-advice", version: "1.0.0", content: demoAdvice },
    template: { id: "synthetic-template", version: "1.0.0", content: demoTemplate },
    childName: "合成简版孩子", grade: "初中", submittedAt, aiConsented: true,
    selectedAdviceIds: [], generationMode: "template", fallbackReason: "support_intake", aiModel: null,
    comparison: { available: false, reason: "not_scored" }, triad: composeTriad(from)
  };
}

describe("support intake parent report", () => {
  it("reports only the approved adult observations with their original response anchors and periods", () => {
    const from = sources();
    const before = JSON.stringify(from);
    const report = composeTriad(from);
    expect(report.resultMode).toBe("support-intake");
    expect(report.domains).toEqual([]);
    expect(report.portrait).toEqual([]);
    expect(report.situations).toEqual([]);
    expect(report.priorities).toEqual([]);
    expect(report.words).toEqual([]);
    expect(report.comparisons).toEqual([]);
    for (const section of ["concerns", "supports", "actions"] as const) {
      expect(report.supportIntake?.[section].map(item => item.itemId)).toEqual(expectedIds[section]);
      for (const row of report.supportIntake![section]) {
        expect(["parent", "teacher"]).toContain(row.role);
        const owner = from.find(item => item.role === row.role)!;
        const item = owner.scale.items.find(item => item.id === row.itemId)!;
        const answer = owner.answers[item.id];
        const values = typeof answer === "number" ? [answer] : Array.isArray(answer) ? answer : [];
        expect(row.prompt).toEqual(item.label);
        expect(row.responses).toEqual(typeof answer === "string" ? [{ "zh-CN": answer.trim(), "zh-HK": answer.trim() }] : values.map(value => item.choices.find(choice => choice.value === value)!.label));
      }
    }
    expect(report.supportIntake!.concerns.find(item => item.itemId === "q20_1")?.period).toEqual(pair("过去四周"));
    expect(report.supportIntake!.supports.find(item => item.itemId === "q16_1")?.period).toEqual(pair("过去三个月"));
    expect(report.supportIntake!.supports.find(item => item.itemId === "t11_1")?.period).toEqual(pair("过去三个月在学校的直接观察"));
    expect(report.supportIntake!.nextStep).toEqual(pair("从上述关注中共同选一项，商定一项具体支持，明确由谁参与，并在四至六周后回顾。"));
    expect(JSON.stringify(from)).toBe(before);
  });

  it("does not disclose child answers, private adult context or staff writing, even through new fields", () => {
    const original = sources();
    const changed = structuredClone(original);
    for (const owner of changed) {
      const allowed = new Set(Object.values(expectedIds).flat());
      for (const item of owner.scale.items) {
        if (owner.role !== "student" && allowed.has(item.id)) continue;
        item.label = pair(`PRIVATE_PROMPT_${owner.role}_${item.id}`);
        for (const choice of item.choices) choice.label = pair(`PRIVATE_CHOICE_${owner.role}_${item.id}`);
        if (item.kind === "text") owner.answers[item.id] = `PRIVATE_TEXT_${owner.role}_${item.id}`;
        else if (item.kind === "multi") owner.answers[item.id] = [item.choices.at(-1)!.value];
        else owner.answers[item.id] = item.choices.at(-1)!.value;
      }
    }
    // Risk messages are the frozen, permitted safety summaries; do not recompute
    // arbitrary fixture mutations into new signals for this privacy assertion.
    expect(composeTriad(changed)).toEqual(composeTriad(original));
    expect(JSON.stringify(composeTriad(changed))).not.toContain("PRIVATE_");
    for (const locale of ["zh-CN", "zh-HK"] as const) expect(reportHtml(payload(changed), locale)).not.toContain("PRIVATE_");
  });

  it("keeps original safety messages while excluding the underlying safety answer and staff note", () => {
    const from = sources();
    from[0].score.risk = true;
    from[0].score.riskMessages = [pair("保留的合成安全提示")];
    from[0].answers.c19 = "PRIVATE_CHILD_WRITING";
    const report = composeTriad(from);
    expect(report.safety).toEqual(from[0].score.riskMessages);
    expect(JSON.stringify(report)).not.toContain("PRIVATE_CHILD_WRITING");
    expect(reportHtml(payload(from), "zh-CN")).toContain("保留的合成安全提示");
  });

  it("respects staff-only and hidden items even if their IDs are on the public allowlist", () => {
    const from = sources();
    const teacher = from.find(item => item.role === "teacher")!;
    teacher.scale.items.find(item => item.id === "t21")!.report = "staff";
    teacher.answers.t21 = "PRIVATE_NEW_STAFF_NOTE";
    const parent = from.find(item => item.role === "parent")!;
    parent.scale.items.find(item => item.id === "q16_1")!.showIf = { itemId: "q22", anyOf: [1] };
    parent.answers.q22 = [7];
    const report = composeTriad(from);
    expect(report.supportIntake?.actions.some(item => item.itemId === "t21")).toBe(false);
    expect(report.supportIntake?.supports.some(item => item.itemId === "q16_1")).toBe(false);
    expect(JSON.stringify(report)).not.toContain("PRIVATE_NEW_STAFF_NOTE");
  });

  it("composes the actual 2.0.0 questionnaires without requiring omitted legacy questions", () => {
    const from = [source(childScaleSupportIntake), source(parentScaleSupportIntake), source(teacherScaleSupportIntake)];
    expect(from.every(item => item.score.status === "valid")).toBe(true);
    const report = composeTriad(from);
    for (const section of ["concerns", "supports", "actions"] as const) expect(report.supportIntake?.[section].map(item => item.itemId)).toEqual(expectedIds[section]);
  });

  it.each(["zh-CN", "zh-HK"] as Locale[])("renders support actions without invented scores or insufficient-data sections in %s", locale => {
    const p = payload(sources());
    const html = reportHtml(p, locale);
    expect(html).toContain(locale === "zh-CN" ? "当前困难与支持建议" : "當前困難與支持建議");
    expect(html).toContain(p.triad!.supportIntake!.nextStep[locale]);
    expect(html).toContain(locale === "zh-CN" ? "家长观察" : "家長觀察");
    expect(html).toContain(locale === "zh-CN" ? "教师观察" : "教師觀察");
    expect(html).not.toMatch(/report-comparison|report-domain-|report-portrait|原始平均分|原始分|有效回答还不够|有效回答還不夠|资料不足|資料不足|数据不足|數據不足/);
  });

  it("escapes approved teacher action text without translating user writing", () => {
    const from = sources();
    const teacher = from.find(item => item.role === "teacher")!;
    teacher.answers.t21 = "<script>synthetic_action()</script>";
    const p = payload(from);
    expect(p.triad!.supportIntake!.actions.find(item => item.itemId === "t21")?.responses).toEqual([{ "zh-CN": teacher.answers.t21, "zh-HK": teacher.answers.t21 }]);
    expect(reportHtml(p, "zh-CN")).toContain("&lt;script&gt;synthetic_action()&lt;/script&gt;");
    expect(reportHtml(p, "zh-CN")).not.toContain("<script>synthetic_action()");
  });

  it("does not compare short forms with either short or historical rounds", () => {
    const current = sources().map(item => ({ ...item, respondentId: item.role }));
    const historical = sources().map(item => ({ ...item, respondentId: item.role, scale: { ...item.scale, resultMode: "scored" as const, version: "1.3.0" } }));
    for (const previous of [null, current, historical]) {
      expect(compareTriad(current, previous).every(item => !item.available && item.reason === "not_scored")).toBe(true);
    }
    expect(compareTriad(historical, current).every(item => !item.available && item.reason === "not_scored")).toBe(true);
  });

  it("rejects mixed scored and support-intake sources instead of making a partial report", () => {
    const mixed = sources();
    delete mixed[0].scale.resultMode;
    expect(() => composeTriad(mixed)).toThrow("Mixed triad result modes");
  });
});
