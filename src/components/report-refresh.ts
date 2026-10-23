import type { Assessment, Family, ReportJob } from "./api";

const delays = [3500, 7000, 15_000, 30_000] as const;
export const REPORT_REFRESH_WINDOW_MS = 120_000;

export function hasGeneratingReports(assessments: readonly Pick<Assessment, "status" | "phase">[], jobs: readonly Pick<ReportJob, "state">[] = []): boolean {
  return jobs.some(job => job.state === "ready" || job.state === "running") || assessments.some(item => item.status === "queued" && item.phase !== "waiting" && item.phase !== "consent");
}

export function hasOpenStagedFollowup(family:Pick<Family,"reportWorkflow"|"activeRoundId">|undefined,assessments:readonly Pick<Assessment,"roundId"|"respondentRole"|"status">[]):boolean {
  if(family?.reportWorkflow!=="parent_first_v1"||!family.activeRoundId)return false;
  const submitted=new Set(assessments.filter(item=>item.roundId===family.activeRoundId&&item.status!=="pending").map(item=>item.respondentRole));
  return submitted.has("parent")&&(!submitted.has("student")||!submitted.has("teacher"));
}

export function nextReportRefreshDelay(startedAt: number, attempts: number, now: number): number | null {
  const delay = delays[Math.min(attempts, delays.length - 1)];
  return now + delay <= startedAt + REPORT_REFRESH_WINDOW_MS ? delay : null;
}
