import { describe, expect, it } from "vitest";
import * as scales from "../src/domain/triad-scales";
import { parseStoredScale, instrumentWriteBlockReason } from "../src/domain/validation";
import { scoreAssessment } from "../src/domain/scoring";
import { previewAnswers } from "../src/domain/triad-report";

const submittedAt = "2026-10-23T04:00:00.000Z";

describe("new staged intake definitions", () => {
  it("adds new parent/child versions and a separate unscored TOPE form without changing current legacy IDs", () => {
    expect(scales.stagedParentScale?.version).toBe("2.1.0");
    expect(scales.stagedChildScale?.version).toBe("2.1.0");
    expect(scales.topeStaffScale?.id).toBe("growth-tope-observation");
    expect(scales.currentTriadScaleIds.teacher).toBe("growth-teacher@2.0.0");
    expect(scales.stagedTriadScaleIds).toEqual({ parent: "growth-parent@2.1.0", student: "growth-child@2.1.0", teacher: "growth-tope-observation@1.0.0" });
    for (const scale of [scales.stagedParentScale, scales.stagedChildScale, scales.topeStaffScale]) {
      expect(parseStoredScale(scale)).toEqual(scale);
      expect(scale.dimensions).toEqual([]);
      expect(scale.resultMode).toBe("support-intake");
      expect(scale.minAge).toBe(8);
      expect(scale.maxAge).toBe(17);
      expect(instrumentWriteBlockReason(scale, "service")).toBeNull();
      expect(instrumentWriteBlockReason({ ...scale, resultMode: "scored" }, "service")).toBe("UNVALIDATED_INSTRUMENT");
      const answers = previewAnswers(scale);
      expect(scoreAssessment(scale, answers, { age: 12, region: "CN", role: scale.roles[0] }).status).toBe("valid");
    }
  });
});

describe("student family-report sharing choice", () => {
  it("has an explicit no-share path and never infers a summary from ordinary answers", async () => {
    const { studentSharingSnapshot } = await import("../src/domain/student-sharing");
    for (const answers of [{}, { c_share_support: [0] }, { c22: "PRIVATE_WISH", c13_1: 4, c_share_confirm: 1 }]) {
      expect(studentSharingSnapshot(scales.stagedChildScale, answers, submittedAt)).toEqual({ noticeVersion: "tope-student-sharing-2026-10-v1", selectedIds: [], confirmed: false, confirmedAt: submittedAt });
    }
    expect(studentSharingSnapshot(scales.childScaleSupportIntake, { c_share_support: [1], c_share_confirm: 1 }, submittedAt)).toBeUndefined();
  });

  it("records only up to three chosen approved sentences after positive confirmation", async () => {
    const { studentSharingSnapshot } = await import("../src/domain/student-sharing");
    expect(studentSharingSnapshot(scales.stagedChildScale, { c_share_support: [1, 3, 5], c_share_confirm: 1 }, submittedAt)).toEqual({
      noticeVersion: "tope-student-sharing-2026-10-v1", selectedIds: ["smaller_steps", "patient_listening", "recent_stress_support"], confirmed: true, confirmedAt: submittedAt
    });
    for (const selected of [[1, 2, 3, 4], [1, 1], [0, 1], [99]]) {
      expect(() => studentSharingSnapshot(scales.stagedChildScale, { c_share_support: selected, c_share_confirm: 1 }, submittedAt)).toThrow();
    }
    for (const confirmation of [undefined, 0]) expect(() => studentSharingSnapshot(scales.stagedChildScale, { c_share_support: [1], c_share_confirm: confirmation }, submittedAt)).toThrow();
  });
});
