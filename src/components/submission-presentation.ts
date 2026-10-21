import { isAdult, type AssessmentStatus, type Role, type SubmissionPhase } from "./api";

export type SubmissionDisplayState = "privacy" | "submitted" | "waiting" | "consent" | "reporting" | "failed" | "ready";

export function submissionDisplayState({ role, phase, status, reportId, reportHeld = false, privacyRefreshRequired = false }: {
  role: Role;
  phase: SubmissionPhase;
  status?: AssessmentStatus;
  reportId: string | null;
  reportHeld?: boolean;
  privacyRefreshRequired?: boolean;
}): SubmissionDisplayState {
  if (!isAdult(role)) return "submitted";
  if (privacyRefreshRequired) return "privacy";
  if (reportId) return "ready";
  if (phase === "consent" || reportHeld) return "consent";
  if (status === "failed") return "failed";
  if (phase === "waiting") return "waiting";
  if (phase === "reporting" || status === "queued") return "reporting";
  return "submitted";
}
