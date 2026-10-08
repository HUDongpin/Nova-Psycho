export interface ReportRetryState {
  status:string;
  jobState:string|null;
  hasSnapshot:boolean;
  hasAnswers:boolean;
  hasSubmission:boolean;
  isTriad:boolean;
  hasRoundSources:boolean;
  hasConsent:boolean;
}

export type ReportRetryBlocker="TRIAD_LEGACY_REVIEW_REQUIRED"|"GUARDIAN_CONSENT_REQUIRED"|"REPORT_NOT_FAILED";

export function reportRetryBlocker(state:ReportRetryState):ReportRetryBlocker|null {
  if(state.isTriad&&!state.hasRoundSources)return "TRIAD_LEGACY_REVIEW_REQUIRED";
  if(!state.hasConsent)return "GUARDIAN_CONSENT_REQUIRED";
  if(state.status==="queued"&&state.jobState==="ready")return null;
  if(state.status!=="failed"||state.jobState!=="failed"||!state.hasSnapshot||!state.hasAnswers||!state.hasSubmission)return "REPORT_NOT_FAILED";
  return null;
}
