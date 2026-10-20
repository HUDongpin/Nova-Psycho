import { describe, expect, it } from "vitest";
import { answerVisible, scoreAssessment } from "../src/domain/scoring";
import { compareTriad, type TriadComparisonSource } from "../src/domain/triad-comparison";
import { previewAnswers } from "../src/domain/triad-report";
import { childScaleStaffNotes as childScale, parentScaleStaffNotes as parentScale, parentScaleV1, teacherScaleStaffNotes as teacherScale } from "../src/domain/triad-scales";
import type { ScaleDefinition } from "../src/domain/types";

const priorDate = "2026-06-01T00:00:00.000Z";
const currentDate = "2026-09-15T00:00:00.000Z";

function source(original: ScaleDefinition, submittedAt = currentDate, values: Record<string, number> = {}, age = 12): TriadComparisonSource {
  const scale = structuredClone(original);
  const preview = structuredClone(scale);
  for (const item of preview.items) {
    if (item.id === "c_age" || item.id === "p_age") item.choices = item.choices.filter(choice => choice.value === age);
  }
  const answers = previewAnswers(preview);
  for (const [key, value] of Object.entries(values)) {
    for (const id of scale.dimensions.find(dimension => dimension.key === key)!.items) answers[id] = value;
  }
  for (const item of scale.items) if (!answerVisible(answers, item, age)) delete answers[item.id];
  const role = scale.roles[0];
  return { role, respondentId: `private-synthetic-${role}`, scale, score: scoreAssessment(scale, answers, { age, region: "CN", role }), submittedAt };
}

function round(submittedAt = currentDate) {
  return [source(childScale, submittedAt), source(parentScale, submittedAt), source(teacherScale, submittedAt)];
}

describe("triad longitudinal comparison", () => {
  it("compares each role independently with both endpoints and the correct score direction", () => {
    const current = [source(childScale, currentDate, { c7: 5 }), source(parentScale, currentDate, { q20: 1 }), source(teacherScale)];
    const previous = [source(childScale, priorDate, { c7: 3 }), source(parentScale, priorDate, { q20: 3 }), source(teacherScale, priorDate)];
    const result = compareTriad([...current].reverse(), previous);
    expect(result.map(item => item.role)).toEqual(["student", "parent", "teacher"]);
    expect(result.every(item => item.available && item.currentDate === currentDate && item.previousDate === priorDate)).toBe(true);
    expect(result[0].changes!.find(item => item.key === "c7")).toMatchObject({ previous: 3, current: 5, delta: 2, higherMeans: "more_strength" });
    expect(result[1].changes!.find(item => item.key === "q20")).toMatchObject({ previous: 3, current: 1, delta: -2, higherMeans: "more_support" });
    expect(result[2].changes!.every(item => item.delta === 0)).toBe(true);
  });

  it("records first assessment separately for every role when no complete prior round exists", () => {
    expect(compareTriad(round(), null)).toEqual(["student", "parent", "teacher"].map(role => ({
      role, currentDate, available: false, reason: "first_assessment"
    })));
  });

  it("does not compare a new person merely because their role is the same", () => {
    const previous = round(priorDate);
    previous[2].respondentId = "private-old-teacher";
    const result = compareTriad(round(), previous);
    expect(result.map(item => item.available)).toEqual([true, true, false]);
    expect(result[2]).toMatchObject({ reason: "different_respondent", previousDate: priorDate });
    expect(result[2].changes).toBeUndefined();
  });

  it.each(["current", "previous"] as const)("requires a recorded %s respondent identity", side => {
    const current = round(), previous = round(priorDate);
    (side === "current" ? current : previous)[1].respondentId = "";
    expect(compareTriad(current, previous)[1]).toMatchObject({ available: false, reason: "different_respondent" });
  });

  it("rejects identities missing at runtime rather than matching two undefined values", () => {
    const current = round(), previous = round(priorDate);
    Reflect.deleteProperty(current[0], "respondentId");
    Reflect.deleteProperty(previous[0], "respondentId");
    expect(compareTriad(current, previous)[0]).toMatchObject({ available: false, reason: "different_respondent" });
  });

  it("keeps unchanged child and teacher versions comparable when the parent version changes", () => {
    const previous = [source(childScale, priorDate), source(parentScaleV1, priorDate), source(teacherScale, priorDate)];
    const result = compareTriad(round(), previous);
    expect(result.map(item => item.available)).toEqual([true, false, true]);
    expect(result[1]).toMatchObject({ reason: "incompatible_version", previousDate: priorDate });
  });

  it.each(["region", "norm", "scale-id", "score-version"] as const)("does not compare incompatible %s metadata", mismatch => {
    const previous = round(priorDate);
    if (mismatch === "region") previous[0].score.region = "HK";
    if (mismatch === "norm") previous[0].score.norm.source = "Different frozen norm";
    if (mismatch === "scale-id") previous[0].score.scaleId = "another-child-instrument";
    if (mismatch === "score-version") previous[0].score.scaleVersion = "2.0.0";
    expect(compareTriad(round(), previous)[0]).toMatchObject({ available: false, reason: "incompatible_version" });
  });

  it.each(["current", "previous"] as const)("does not partially compare a required incomplete %s result", side => {
    const current = round(), previous = round(priorDate);
    (side === "current" ? current : previous)[1] = source(parentScale, side === "current" ? currentDate : priorDate, { q14: -1 });
    expect((side === "current" ? current : previous)[1].score.status).toBe("incomplete");
    const result = compareTriad(current, previous);
    expect(result.map(item => item.available)).toEqual([true, false, true]);
    expect(result[1]).toMatchObject({ reason: "incomplete" });
    expect(result[1].changes).toBeUndefined();
  });

  it("keeps available child dimensions comparable below age 12 and names the omitted age-gated dimension", () => {
    const current = source(childScale, currentDate, { c7: 5 }, 11);
    const previous = source(childScale, priorDate, { c7: 2 }, 11);
    expect(current.score.status).toBe("valid");
    expect(previous.score.status).toBe("valid");
    const [result] = compareTriad([current], [previous]);
    expect(result.available).toBe(true);
    expect(result.changes!.find(item => item.key === "c7")!.delta).toBe(3);
    expect(result.changes!.some(item => item.key === "c18")).toBe(false);
    expect(result.omitted).toEqual([{ key: "c18", label: childScale.dimensions.find(item => item.key === "c18")!.label }]);
  });

  it("does not invent a baseline for a dimension that becomes available at age 12", () => {
    const current = source(childScale), previous = source(childScale, priorDate, {}, 11);
    expect(previous.score.dimensions.find(item => item.key === "c18")).toMatchObject({ raw: null, min: 0, max: 0, totalItems: 0 });
    expect(current.score.dimensions.find(item => item.key === "c18")).toMatchObject({ raw: 4, min: 1, max: 5, totalItems: 6 });
    const [result] = compareTriad([current], [previous]);
    expect(result.available).toBe(true);
    expect(result.omitted?.map(item => item.key)).toEqual(["c18"]);
    expect(result.changes!.some(item => item.key === "c18")).toBe(false);
  });

  it("excludes parent portrait scores even when their raw values change", () => {
    const current = source(parentScale, currentDate, { q24: 5, q25: 4, q26: 3, q27: 2, q28: 1, q29: 5 });
    const previous = source(parentScale, priorDate, { q24: 1, q25: 1, q26: 1, q27: 1, q28: 1, q29: 1 });
    const [result] = compareTriad([current], [previous]);
    expect(result.available).toBe(true);
    expect(result.changes!.map(item => item.key)).toEqual(parentScale.dimensions.filter(item => item.domain !== "portrait").map(item => item.key));
    expect(result.omitted).toBeUndefined();
  });

  it("rejects a missing or duplicate prior role instead of mixing sources", () => {
    const previous = round(priorDate);
    const result = compareTriad(round(), [previous[0], previous[0], previous[1]]);
    expect(result.map(item => item.available)).toEqual([false, true, false]);
    expect(result[0].reason).toBe("incomplete");
    expect(result[2].reason).toBe("incomplete");
  });

  it("does not produce a delta for a required null score even if a malformed snapshot calls it valid", () => {
    const previous = round(priorDate);
    previous[0].score.dimensions[0].raw = null;
    const result = compareTriad(round(), previous)[0];
    expect(result).toMatchObject({ available: false, reason: "incomplete" });
    expect(result.changes).toBeUndefined();
  });

  it.each(["missing", "range", "direction"] as const)("rejects incompatible dimension %s", mismatch => {
    const previous = round(priorDate);
    if (mismatch === "missing") previous[0].score.dimensions.shift();
    if (mismatch === "range") previous[0].score.dimensions[0].max = 100;
    if (mismatch === "direction") previous[0].score.dimensions[0].higherMeans = "more_support";
    expect(compareTriad(round(), previous)[0]).toMatchObject({ available: false, reason: "incompatible_version" });
  });

  it("preserves frozen inputs and emits no respondent identity or unscored answer material", () => {
    const current = round(), previous = round(priorDate);
    const before = structuredClone({ current, previous });
    const result = compareTriad(current, previous);
    expect({ current, previous }).toEqual(before);
    expect(JSON.stringify(result)).not.toContain("private-synthetic-");
    expect(JSON.stringify(result)).not.toContain("respondentId");
    expect(JSON.stringify(result)).not.toContain("answers");
    expect(JSON.stringify(result)).not.toContain("13800001111");
  });
});
