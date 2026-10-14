import type { ConsentChoices, Family } from "./api";

export type ConsentScopeName = "assessment" | "parent_report" | "sensitive_data" | "ai_processing";

const scopeKey = {
  assessment: "assessment",
  sensitiveData: "sensitive_data",
  parentReport: "parent_report",
  aiProcessing: "ai_processing",
} as const;

export function activeConsentChoices(family: Pick<Family, "consent" | "consents">): ConsentChoices {
  return family.consents ?? { assessment: family.consent, sensitiveData: family.consent, parentReport: family.consent, aiProcessing: false };
}

// Saving the form only adds purposes that were not already active.
// Unchecking a pre-checked purpose is ignored; withdrawal is a separate action.
export function grantsFromConsentForm(current: ConsentChoices, next: ConsentChoices): ConsentScopeName[] {
  return (Object.keys(scopeKey) as (keyof typeof scopeKey)[]).filter(key => next[key] && !current[key]).map(key => scopeKey[key]);
}
