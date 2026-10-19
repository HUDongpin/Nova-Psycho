import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type SurveyRecord } from "../src/components/api";
import { AssessmentDraftSession } from "../src/components/draft-session";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const record = (): SurveyRecord => ({ id: "synthetic-completion", status: "pending", childName: "Synthetic", scaleTitle: "Synthetic", demo: true, description: "", surveyJson: {}, draftAnswers: { q1: -1 }, draftRevision: 0, consentRequired: false });

describe("completion review belongs to one open draft", () => {
  it("starts without a review and retains an attempted review when the language remounts", () => {
    const draft = new AssessmentDraftSession(record());
    expect(draft.getSnapshot()).toMatchObject({ completionAttempted: false });
    draft.setAcknowledged(true, "zh-CN");
    draft.markCompletionAttempted();
    draft.setAcknowledged(false, "zh-HK");
    draft.observeServer(record());
    expect(draft.getSnapshot()).toMatchObject({ completionAttempted: true, answers: { q1: -1 } });
    expect(new AssessmentDraftSession({ ...record(), id: "another-task" }).getSnapshot()).toMatchObject({ completionAttempted: false });
    draft.dispose();
  });

  it("keeps a persisted draft saved when submission needs more information, then clears stale server issues on an edit", async () => {
    const issues = [{ kind: "insufficient_coverage", dimensionKey: "learning", itemIds: ["q1", "q2"], answered: 0, required: 2, total: 2, unansweredItemIds: [], excludedItemIds: ["q1", "q2"] }];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === "PATCH"
      ? new Response(JSON.stringify({ revision: 1, ok: true }))
      : new Response(JSON.stringify({ error: "Incomplete", code: "INCOMPLETE_TRIAD", completionIssues: issues }), { status: 422 }));
    vi.stubGlobal("fetch", fetcher);
    const draft = new AssessmentDraftSession(record());
    draft.setAcknowledged(true, "zh-CN");
    draft.update({ q1: -1, q2: -1 }, "zh-CN");
    await expect(draft.submit("zh-CN")).rejects.toBeInstanceOf(ApiError);
    expect(draft.getSnapshot()).toMatchObject({ status: "saved", error: null, revision: 1, hasUnsavedChanges: false, submitting: false, completionAttempted: true, completionIssues: issues, answers: { q1: -1, q2: -1 } });
    draft.setAcknowledged(false, "zh-HK");
    expect(draft.getSnapshot().completionIssues).toEqual(issues);
    draft.setAcknowledged(true, "zh-HK");
    draft.update({ q1: -1, q2: 2 }, "zh-HK");
    expect(draft.getSnapshot()).toMatchObject({ status: "unsaved", completionAttempted: true, completionIssues: [], answers: { q1: -1, q2: 2 } });
    expect(fetcher.mock.calls.map(call => call[1]?.method)).toEqual(["PATCH", "POST"]);
    draft.dispose();
  });

  it.each([500, 401, 409])("does not hide an actual save failure with status %s", async status => {
    const code = status === 409 ? "DRAFT_CONFLICT" : status === 401 ? "UNAUTHENTICATED" : "REQUEST_FAILED";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Save failed", code }), { status })));
    const draft = new AssessmentDraftSession(record());
    draft.setAcknowledged(true, "zh-CN");
    draft.markCompletionAttempted();
    draft.update({ q1: -1, q2: -1 }, "zh-CN");
    await expect(draft.submit("zh-CN")).rejects.toBeInstanceOf(ApiError);
    const snapshot = draft.getSnapshot();
    expect(snapshot.hasUnsavedChanges).toBe(true);
    expect(snapshot.completionIssues).toEqual([]);
    if (status === 401) expect(snapshot.authenticationPaused).toBe(true);
    else expect(snapshot.status).toBe(status === 409 ? "conflict" : "failed");
    draft.dispose();
  });
});
