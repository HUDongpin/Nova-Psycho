import { describe, expect, it } from "vitest";
import { hasGeneratingReports, nextReportRefreshDelay, REPORT_REFRESH_WINDOW_MS } from "../src/components/report-refresh";

describe("report refresh eligibility", () => {
  it("does not poll while waiting for another respondent or after completion", () => {
    expect(hasGeneratingReports([])).toBe(false);
    expect(hasGeneratingReports([{ status: "queued", phase: "waiting" }, { status: "pending" }, { status: "published" }, { status: "failed" }])).toBe(false);
  });

  it("checks actual triad generation and ordinary queued reports", () => {
    expect(hasGeneratingReports([{ status: "queued", phase: "reporting" }])).toBe(true);
    expect(hasGeneratingReports([{ status: "queued", phase: null }])).toBe(true);
    expect(hasGeneratingReports([{ status: "queued" }])).toBe(true);
  });
});

describe("report refresh budget", () => {
  it("allows six progressively spaced checks within two minutes", () => {
    const start = 1000, calls: number[] = [];
    let now = start, attempts = 0;
    for (;;) {
      const delay = nextReportRefreshDelay(start, attempts, now);
      if (delay === null) break;
      now += delay; calls.push(now - start); attempts++;
    }
    expect(calls).toEqual([3500, 10_500, 25_500, 55_500, 85_500, 115_500]);
    expect(now - start).toBeLessThanOrEqual(REPORT_REFRESH_WINDOW_MS);
  });

  it("counts hidden time and slow responses against the same deadline", () => {
    expect(nextReportRefreshDelay(1000, 0, 121_000)).toBeNull();
    expect(nextReportRefreshDelay(1000, 3, 96_000)).toBeNull();
    expect(nextReportRefreshDelay(1000, 1, 110_000)).toBe(7000);
  });
});
