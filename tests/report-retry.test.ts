import { describe,expect,it } from "vitest";
import { reportRetryBlocker,type ReportRetryState } from "../src/domain/report-retry";

const failed:ReportRetryState={status:"failed",jobState:"failed",hasSnapshot:true,hasAnswers:true,hasSubmission:true,isTriad:false,hasRoundSources:false,hasConsent:true};

describe("report retry eligibility",()=>{
  it("allows a complete failed report",()=>expect(reportRetryBlocker(failed)).toBeNull());
  it.each(["pending","published","queued"])("rejects status %s",status=>{
    expect(reportRetryBlocker({...failed,status})).toBe("REPORT_NOT_FAILED");
  });
  it.each([null,"ready","running","done"])("rejects job state %s",jobState=>{
    expect(reportRetryBlocker({...failed,jobState})).toBe("REPORT_NOT_FAILED");
  });
  it.each(["hasSnapshot","hasAnswers","hasSubmission"] as const)("requires %s",key=>{
    expect(reportRetryBlocker({...failed,[key]:false})).toBe("REPORT_NOT_FAILED");
  });
  it("requires current complete guardian consent",()=>{
    expect(reportRetryBlocker({...failed,hasConsent:false})).toBe("GUARDIAN_CONSENT_REQUIRED");
  });
  it("requires bound sources for triad reports",()=>{
    expect(reportRetryBlocker({...failed,isTriad:true})).toBe("TRIAD_LEGACY_REVIEW_REQUIRED");
    expect(reportRetryBlocker({...failed,isTriad:true,hasRoundSources:true})).toBeNull();
  });
  it("keeps ready queued retries idempotent after consent and legacy checks",()=>{
    const queued={...failed,status:"queued",jobState:"ready",hasSnapshot:false,hasAnswers:false,hasSubmission:false};
    expect(reportRetryBlocker(queued)).toBeNull();
    expect(reportRetryBlocker({...queued,hasConsent:false})).toBe("GUARDIAN_CONSENT_REQUIRED");
    expect(reportRetryBlocker({...queued,isTriad:true,hasConsent:false})).toBe("TRIAD_LEGACY_REVIEW_REQUIRED");
  });
});
