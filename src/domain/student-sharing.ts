import type { ScaleDefinition, StudentSharingSnapshot, TextPair } from "./types";
import { pair } from "./zh-pair";

export type { StudentSharingSnapshot } from "./types";
export const STUDENT_SHARING_NOTICE_VERSION = "tope-student-sharing-2026-10-v1";
export const STUDENT_SHARING_ITEM_ID = "c_share_support";
export const STUDENT_SHARING_CONFIRM_ID = "c_share_confirm";
export const STUDENT_SUPPORT_OPTIONS = [
  { id: "smaller_steps", value: 1, label: pair("我希望把任务分成更小的步骤。") },
  { id: "balanced_routine", value: 2, label: pair("我希望学习、休息和活动的安排更平衡。") },
  { id: "patient_listening", value: 3, label: pair("我希望有人耐心听我说。") },
  { id: "clear_help_person", value: 4, label: pair("我希望明确遇到困难时可以找谁帮忙。") },
  { id: "recent_stress_support", value: 5, label: pair("我希望得到应对最近压力的支持。") }
] as const;

export function isStagedStudentScale(scale: Pick<ScaleDefinition, "id" | "version" | "bundle" | "resultMode">): boolean {
  return scale.id === "growth-child" && scale.version === "2.1.0" && scale.bundle === "growth-triad" && scale.resultMode === "support-intake";
}

/** This is built on the server from explicit sharing choices, never from private answers. */
export function studentSharingSnapshot(scale: ScaleDefinition, answers: Record<string, unknown>, submittedAt: string): StudentSharingSnapshot | undefined {
  if (!isStagedStudentScale(scale)) return undefined;
  if (!Number.isFinite(Date.parse(submittedAt))) throw new Error("Invalid student sharing submission time");
  const selected = answers[STUDENT_SHARING_ITEM_ID];
  const noShare = selected === undefined || (Array.isArray(selected) && (selected.length === 0 || (selected.length === 1 && selected[0] === 0)));
  if (noShare) return { noticeVersion: STUDENT_SHARING_NOTICE_VERSION, selectedIds: [], confirmed: false, confirmedAt: submittedAt };
  if (!Array.isArray(selected) || selected.length > 3 || new Set(selected).size !== selected.length || selected.some(value => !STUDENT_SUPPORT_OPTIONS.some(option => option.value === value))) {
    throw new Error("Choose no more than three approved student support sentences");
  }
  if (answers[STUDENT_SHARING_CONFIRM_ID] !== 1) throw new Error("Student sharing requires preview confirmation");
  return {
    noticeVersion: STUDENT_SHARING_NOTICE_VERSION,
    selectedIds: selected.map(value => STUDENT_SUPPORT_OPTIONS.find(option => option.value === value)!.id),
    confirmed: true,
    confirmedAt: submittedAt
  };
}

/** Fail closed on absent, historical, malformed, or unconfirmed sharing records. */
export function approvedStudentSharing(scale: ScaleDefinition, snapshot: StudentSharingSnapshot | undefined): { selectedIds: string[]; sentences: TextPair[] } | undefined {
  if (!isStagedStudentScale(scale) || !snapshot || snapshot.noticeVersion !== STUDENT_SHARING_NOTICE_VERSION || snapshot.confirmed !== true || !Number.isFinite(Date.parse(snapshot.confirmedAt))) return undefined;
  if (!Array.isArray(snapshot.selectedIds) || snapshot.selectedIds.length === 0 || snapshot.selectedIds.length > 3 || new Set(snapshot.selectedIds).size !== snapshot.selectedIds.length) return undefined;
  const options = snapshot.selectedIds.map(id => STUDENT_SUPPORT_OPTIONS.find(option => option.id === id));
  if (options.some(option => !option)) return undefined;
  return { selectedIds: [...snapshot.selectedIds], sentences: options.map(option => ({ ...option!.label })) };
}
