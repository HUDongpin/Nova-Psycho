import type { Assessment } from "./api";

const delays = [3500, 7000, 15_000, 30_000] as const;
export const REPORT_REFRESH_WINDOW_MS = 120_000;

export function hasGeneratingReports(assessments: readonly Pick<Assessment, "status" | "phase">[]): boolean {
  return assessments.some(item => item.status === "queued" && item.phase !== "waiting");
}

export function nextReportRefreshDelay(startedAt: number, attempts: number, now: number): number | null {
  const delay = delays[Math.min(attempts, delays.length - 1)];
  return now + delay <= startedAt + REPORT_REFRESH_WINDOW_MS ? delay : null;
}
