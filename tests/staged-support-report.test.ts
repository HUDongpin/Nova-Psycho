import { describe, expect, it } from "vitest";
import { demoAdvice, demoTemplate } from "../src/domain/demo";
import { reportHtml } from "../src/domain/report-html";
import { scoreAssessment } from "../src/domain/scoring";
import { composeTriad, previewAnswers, type TriadSource } from "../src/domain/triad-report";
import { parentScaleSupportIntake, childScaleSupportIntake, teacherScaleSupportIntake, stagedParentScale, stagedChildScale, topeStaffScale } from "../src/domain/triad-scales";
import { studentSharingSnapshot, STUDENT_SUPPORT_OPTIONS } from "../src/domain/student-sharing";
import { parentReportWordAllowed } from "../src/domain/report-privacy";
import type { ReportPayload, ScaleDefinition } from "../src/domain/types";

const submittedAt = "2026-10-23T04:00:00.000Z";
function source(original: ScaleDefinition): TriadSource {
  const scale = structuredClone(original);
  const answers = previewAnswers(scale);
  return { role: scale.roles[0], scale, answers, score: scoreAssessment(scale, answers, { age: 12, region: "CN", role: scale.roles[0] }), submittedAt };
}
function payload(from: TriadSource[], staged = true): ReportPayload {
  const parent = from.find(item => item.role === "parent")!;
  return {
    scale: parent.scale, score: parent.score, advice: { id: "test-advice", version: "1.0.0", content: demoAdvice },
    template: { id: "test-template", version: "1.0.0", content: demoTemplate }, childName: "合成家庭", grade: "初中",
    submittedAt, aiConsented: false, selectedAdviceIds: [], generationMode: "template", fallbackReason: "support_intake",
    aiModel: null, comparison: { available: false, reason: "not_scored" }, triad: composeTriad(from, { staged })
  };
}

describe("staged support report", () => {
  it("makes the parent's first report and states the sources still missing", () => {
    const p = payload([source(stagedParentScale)]);
    expect(p.triad?.title["zh-CN"]).toBe("首次家长报告");
    const html = reportHtml(p, "zh-CN");
    expect(html).toContain("当前资料仅来自家长");
    expect(html).toContain("尚未收到学生资料和 TOPE 现场观察");
    expect(html).not.toContain("三份都交齐后自动生成");
    expect(html).not.toMatch(/原始分|report-comparison/);
  });

  it("labels the addition of student information without exposing private answers", () => {
    const student = source(stagedChildScale);
    student.answers.c22 = "PRIVATE_CHILD_WISH";
    const p = payload([source(stagedParentScale), student]);
    expect(p.triad?.title["zh-CN"]).toBe("跟进报告：新增学生资料");
    expect(reportHtml(p, "zh-CN")).not.toContain("PRIVATE_CHILD_WISH");
  });

  it("publishes only explicitly confirmed sentences, independently from private responses", () => {
    const student = source(stagedChildScale);
    student.answers.c_share_support = [1, 3];
    student.answers.c_share_confirm = 1;
    student.studentSharing = studentSharingSnapshot(student.scale, student.answers, submittedAt);
    for (const item of student.scale.items) {
      if (item.kind === "text") student.answers[item.id] = "PRIVATE_CHILD_WRITING";
      item.label = { "zh-CN": "PRIVATE_CHILD_PROMPT", "zh-HK": "PRIVATE_CHILD_PROMPT" };
      item.choices.forEach(choice => { choice.label = { "zh-CN": "PRIVATE_CHILD_CHOICE", "zh-HK": "PRIVATE_CHILD_CHOICE" }; });
    }
    const p = payload([source(stagedParentScale), student]);
    expect(p.triad?.supportIntake?.studentShared?.sentences).toEqual([STUDENT_SUPPORT_OPTIONS[0].label, STUDENT_SUPPORT_OPTIONS[2].label]);
    for (const locale of ["zh-CN", "zh-HK"] as const) {
      const html = reportHtml(p, locale);
      expect(html).toContain(STUDENT_SUPPORT_OPTIONS[0].label[locale]);
      expect(html).toContain(STUDENT_SUPPORT_OPTIONS[2].label[locale]);
      expect(html).not.toContain("PRIVATE_CHILD_");
    }
  });

  it("does not expose sentences for absent, unconfirmed, wrong-version, excessive, replayed or legacy sharing records", () => {
    const valid = studentSharingSnapshot(stagedChildScale, { c_share_support: [1], c_share_confirm: 1 }, submittedAt)!;
    for (const snapshot of [undefined, { ...valid, confirmed: false }, { ...valid, noticeVersion: "unknown" }, { ...valid, selectedIds: ["unknown"] }, { ...valid, selectedIds: ["smaller_steps", "balanced_routine", "patient_listening", "clear_help_person"] }, { ...valid, confirmedAt: "2026-10-22T00:00:00.000Z" }, { ...valid, confirmedAt: "invalid" }]) {
      const student = source(stagedChildScale);
      student.studentSharing = snapshot;
      const report = composeTriad([source(stagedParentScale), student], { staged: true });
      expect(report.supportIntake?.studentShared).toBeUndefined();
    }
    const legacy = source(childScaleSupportIntake);
    legacy.studentSharing = valid;
    expect(composeTriad([source(stagedParentScale), legacy], { staged: true }).supportIntake?.studentShared).toBeUndefined();
  });

  it("separates TOPE observed versus reported information and never publishes staff writing", () => {
    const observer = source(topeStaffScale);
    observer.answers.o_visit_date = "2026-10-22";
    observer.answers.o_task_source = 2;
    observer.answers.o_communication_source = 3;
    observer.answers.o_private_notes = "PRIVATE_TOPE_NOTE";
    const p = payload([source(stagedParentScale), observer]);
    expect(p.triad?.title["zh-CN"]).toBe("跟进报告：新增现场观察");
    expect(p.triad?.sources[1]).toMatchObject({ label: { "zh-CN": "TOPE 现场观察" }, visitDate: "2026-10-22" });
    expect(p.triad?.supportIntake?.concerns.find(item => item.itemId === "o_task")?.informationSource?.["zh-CN"]).toBe("家长转述");
    expect(p.triad?.supportIntake?.concerns.find(item => item.itemId === "o_communication")?.informationSource?.["zh-CN"]).toBe("学生自述");
    for (const locale of ["zh-CN", "zh-HK"] as const) {
      const html = reportHtml(p, locale);
      expect(html).toContain(locale === "zh-CN" ? "TOPE 现场观察" : "TOPE 現場觀察");
      expect(html).not.toMatch(/教师观察|教師觀察|过去三个月在学校|過去三個月在學校|PRIVATE_TOPE_NOTE/);
    }
    observer.answers.o_visit_date = "PRIVATE_DATE_TEXT";
    expect(JSON.stringify(composeTriad([source(stagedParentScale), observer], { staged: true }))).not.toContain("PRIVATE_DATE_TEXT");
    expect(parentReportWordAllowed(topeStaffScale, { id: "o_private_notes", report: "words" })).toBe(false);
  });

  it("identifies a comprehensive follow-up and report revision without comparison scores", () => {
    const p = payload([source(stagedParentScale), source(stagedChildScale), source(topeStaffScale)]);
    p.revision = { roundId: "synthetic-round", version: 3, sourceAssessmentIds: ["parent", "student", "observer"], sourceRoles: ["parent", "student", "teacher"], generatedAt: submittedAt };
    expect(p.triad?.title["zh-CN"]).toBe("综合跟进报告");
    const html = reportHtml(p, "zh-CN");
    expect(html).toContain("报告版本 3");
    expect(html).not.toMatch(/三份都交齐后|原始分|report-comparison/);
  });

  it("requires the parent intake before any staged report and preserves deterministic safety warnings", () => {
    expect(() => composeTriad([source(stagedChildScale)], { staged: true })).toThrow("parent support intake");
    const student = source(stagedChildScale);
    student.score.risk = true;
    student.score.riskMessages = [{ "zh-CN": "合成安全提示", "zh-HK": "合成安全提示" }];
    const p = payload([source(stagedParentScale), student]);
    expect(p.triad?.safety).toEqual(student.score.riskMessages);
    expect(reportHtml(p, "zh-CN")).toContain("合成安全提示");
  });

  it("leaves existing complete school-teacher report semantics unchanged", () => {
    const p = payload([source(parentScaleSupportIntake), source(childScaleSupportIntake), source(teacherScaleSupportIntake)], false);
    expect(p.triad?.title["zh-CN"]).toBe("当前困难与支持建议");
    const html = reportHtml(p, "zh-CN");
    expect(html).toContain("教师观察");
    expect(html).toContain("三份都交齐后自动生成");
    expect(html).not.toContain("TOPE 现场观察");
  });
});
