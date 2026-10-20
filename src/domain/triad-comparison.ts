import type { RespondentRole, ScaleDefinition, ScoreResult, TriadRoleComparison } from "./types";

export interface TriadComparisonSource {
  role: RespondentRole;
  respondentId: string;
  scale: ScaleDefinition;
  score: ScoreResult;
  submittedAt: string;
}

const ROLE_ORDER: RespondentRole[] = ["student", "parent", "teacher"];

// The worker supplies one complete prior round. Never search further back for a
// compatible person or instrument: every role describes this same pair of rounds.
export function compareTriad(current: TriadComparisonSource[], previous: TriadComparisonSource[] | null): TriadRoleComparison[] {
  return [...current].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)).map(source => {
    const base = { role: source.role, currentDate: source.submittedAt };
    if (previous === null) return { ...base, available: false, reason: "first_assessment" };
    const candidates = previous.filter(candidate => candidate.role === source.role);
    if (candidates.length !== 1) return { ...base, available: false, reason: "incomplete" };
    const prior = candidates[0];
    const dates = { ...base, previousDate: prior.submittedAt };
    if (!source.respondentId || !prior.respondentId || source.respondentId !== prior.respondentId ||
      source.score.respondentRole !== source.role || prior.score.respondentRole !== prior.role) {
      return { ...dates, available: false, reason: "different_respondent" };
    }
    if (source.scale.id !== prior.scale.id || source.scale.version !== prior.scale.version ||
      source.score.scaleId !== prior.score.scaleId || source.score.scaleVersion !== prior.score.scaleVersion ||
      source.score.region !== prior.score.region || JSON.stringify(source.score.norm) !== JSON.stringify(prior.score.norm)) {
      return { ...dates, available: false, reason: "incompatible_version" };
    }
    if (source.score.status !== "valid" || prior.score.status !== "valid") {
      return { ...dates, available: false, reason: "incomplete" };
    }
    // Parent self-portraits remain descriptive. They are not child outcome scores.
    const dimensions = source.scale.dimensions.filter(dimension => dimension.domain !== "portrait");
    const priorDimensions = prior.scale.dimensions.filter(dimension => dimension.domain !== "portrait");
    if (dimensions.length !== priorDimensions.length) return { ...dates, available: false, reason: "incompatible_version" };
    const changes: NonNullable<TriadRoleComparison["changes"]> = [];
    const omitted: NonNullable<TriadRoleComparison["omitted"]> = [];
    for (const dimension of dimensions) {
      const oldDefinition = priorDimensions.find(candidate => candidate.key === dimension.key);
      const now = source.score.dimensions.find(candidate => candidate.key === dimension.key);
      const before = prior.score.dimensions.find(candidate => candidate.key === dimension.key);
      if (!oldDefinition || !now || !before || dimension.domain !== oldDefinition.domain ||
        dimension.aggregation !== oldDefinition.aggregation || Boolean(dimension.optional) !== Boolean(oldDefinition.optional) ||
        now.higherMeans !== before.higherMeans) {
        return { ...dates, available: false, reason: "incompatible_version" };
      }
      if (now.raw === null || before.raw === null) {
        if (!dimension.optional) return { ...dates, available: false, reason: "incomplete" };
        // A hidden age-gated dimension has a zero range and no baseline score.
        // Omit it before checking ranges for dimensions with numeric endpoints.
        omitted.push({ key: dimension.key, label: now.label });
        continue;
      }
      if (now.min !== before.min || now.max !== before.max) return { ...dates, available: false, reason: "incompatible_version" };
      if (!Number.isFinite(now.raw) || !Number.isFinite(before.raw)) return { ...dates, available: false, reason: "incomplete" };
      changes.push({
        key: dimension.key, label: now.label, previous: before.raw, current: now.raw,
        delta: Math.round((now.raw - before.raw) * 1e6) / 1e6, higherMeans: now.higherMeans
      });
    }
    return changes.length
      ? { ...dates, available: true, changes, ...(omitted.length ? { omitted } : {}) }
      : { ...dates, available: false, reason: "incomplete", ...(omitted.length ? { omitted } : {}) };
  });
}
