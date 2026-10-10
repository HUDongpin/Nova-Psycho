import { describe,it,expect,beforeEach,afterEach,vi } from "vitest";
import { ApiError,type SurveyRecord } from "../src/components/api";

// Keep ApiError and errorMessage real so `instanceof ApiError` still works inside the
// controller; only the transport call is replaced.
vi.mock("../src/components/api",async importOriginal=>{
  const actual=await importOriginal<typeof import("../src/components/api")>();
  return {...actual,api:vi.fn()};
});
import { api } from "../src/components/api";
import { AssessmentDraftSession } from "../src/components/draft-session";

const mockApi=vi.mocked(api);
const LOCALE="zh-CN" as const;
const record=(over:Partial<SurveyRecord>={}):SurveyRecord=>({
  id:"11111111-2222-4333-8444-555555555555",status:"pending",childName:"Synthetic",scaleTitle:"Demo",
  demo:true,description:"",surveyJson:{},draftAnswers:{},draftRevision:0,consentRequired:false,...over
});
const ack=(session:AssessmentDraftSession)=>{session.setAcknowledged(true,LOCALE);return session;};
const flush=()=>vi.advanceTimersByTimeAsync(700);

beforeEach(()=>{vi.useFakeTimers();mockApi.mockReset();});
afterEach(()=>{vi.useRealTimers();});

describe("AssessmentDraftSession construction",()=>{
  it("rejects a draft revision the service could not have produced",()=>{
    expect(()=>new AssessmentDraftSession(record({draftRevision:-1}))).toThrow(/Invalid draft revision/);
    expect(()=>new AssessmentDraftSession(record({draftRevision:1.5}))).toThrow(/Invalid draft revision/);
  });
  it("treats a non-pending assessment as already completed",async()=>{
    const session=ack(new AssessmentDraftSession(record({status:"queued"})));
    session.update({q1:1},LOCALE);
    await flush();
    expect(session.getSnapshot().answers).toEqual({});
    expect(mockApi).not.toHaveBeenCalled();
  });
});

describe("assent gating",()=>{
  it("ignores edits before the respondent acknowledges",async()=>{
    const session=new AssessmentDraftSession(record());
    session.update({q1:1},LOCALE);
    await flush();
    expect(session.getSnapshot().answers).toEqual({});
    expect(mockApi).not.toHaveBeenCalled();
  });
  it("ignores edits while guardian consent is outstanding",async()=>{
    const session=ack(new AssessmentDraftSession(record({consentRequired:true})));
    session.update({q1:1},LOCALE);
    await flush();
    expect(session.getSnapshot().answers).toEqual({});
    expect(mockApi).not.toHaveBeenCalled();
  });
  it("cancels a pending write when assent is withdrawn",async()=>{
    const session=ack(new AssessmentDraftSession(record()));
    session.update({q1:1},LOCALE);
    session.setAcknowledged(false,LOCALE);
    await flush();
    expect(mockApi).not.toHaveBeenCalled();
  });
});

describe("debounced saving",()=>{
  it("coalesces rapid edits into a single write",async()=>{
    mockApi.mockResolvedValue({ok:true,revision:1});
    const session=ack(new AssessmentDraftSession(record()));
    session.update({q1:1},LOCALE);
    await vi.advanceTimersByTimeAsync(300);
    session.update({q1:2},LOCALE);
    await vi.advanceTimersByTimeAsync(300);
    session.update({q1:3},LOCALE);
    await flush();
    expect(mockApi).toHaveBeenCalledTimes(1);
  });
  it("does not write when the answers did not actually change",async()=>{
    const session=ack(new AssessmentDraftSession(record({draftAnswers:{q1:2}})));
    session.update({q1:2},LOCALE);
    await flush();
    expect(mockApi).not.toHaveBeenCalled();
    expect(session.getSnapshot().hasUnsavedChanges).toBe(false);
  });
  it("reports unsaved changes until the write is acknowledged",async()=>{
    let release:(value:unknown)=>void=()=>undefined;
    mockApi.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve as (value:unknown)=>void;}));
    const session=ack(new AssessmentDraftSession(record()));
    session.update({q1:1},LOCALE);
    await vi.advanceTimersByTimeAsync(700);
    expect(session.getSnapshot().hasUnsavedChanges).toBe(true);
    release({ok:true,revision:1});
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getSnapshot().hasUnsavedChanges).toBe(false);
    expect(session.getSnapshot().status).toBe("saved");
  });
});

describe("revision handling",()=>{
  it("advances the expected revision only after the server acknowledges it",async()=>{
    mockApi.mockResolvedValue({ok:true,revision:5});
    const session=ack(new AssessmentDraftSession(record()));
    session.update({q1:1},LOCALE);
    await flush();
    expect(session.getSnapshot().revision).toBe(5);
    expect(mockApi).toHaveBeenCalledWith(expect.stringContaining("/api/assessments/"),LOCALE,expect.objectContaining({method:"PATCH",body:expect.objectContaining({revision:0,acknowledged:true})}));
  });
  it("treats a server revision that did not advance as a failure",async()=>{
    mockApi.mockResolvedValue({ok:true,revision:0});
    const session=ack(new AssessmentDraftSession(record()));
    session.update({q1:1},LOCALE);
    await flush();
    expect(session.getSnapshot().status).toBe("failed");
    expect(session.getSnapshot().hasUnsavedChanges).toBe(true);
  });
});

describe("conflict handling",()=>{
  it("stops writing and surfaces a conflict on 409",async()=>{
    mockApi.mockRejectedValue(new ApiError("A newer draft exists.","DRAFT_CONFLICT",409));
    const session=ack(new AssessmentDraftSession(record()));
    session.update({q1:1},LOCALE);
    await flush();
    expect(session.getSnapshot().conflict).toBe(true);
    expect(session.getSnapshot().status).toBe("conflict");
  });
  it("refuses further saves and submissions once conflicted",async()=>{
    mockApi.mockRejectedValue(new ApiError("A newer draft exists.","DRAFT_CONFLICT",409));
    const session=ack(new AssessmentDraftSession(record()));
    session.update({q1:1},LOCALE);
    await flush();
    const callsAfterConflict=mockApi.mock.calls.length;
    session.update({q1:2},LOCALE);
    await flush();
    await expect(session.save(LOCALE)).rejects.toMatchObject({code:"DRAFT_CONFLICT"});
    await expect(session.submit(LOCALE)).rejects.toMatchObject({code:"DRAFT_CONFLICT"});
    expect(mockApi.mock.calls.length).toBe(callsAfterConflict);
  });
  it("never adopts the competing writer's revision",async()=>{
    mockApi.mockRejectedValue(new ApiError("A newer draft exists.","DRAFT_CONFLICT",409));
    const session=ack(new AssessmentDraftSession(record({draftRevision:4})));
    session.update({q1:1},LOCALE);
    await flush();
    expect(session.getSnapshot().revision).toBe(4);
  });
});

describe("write serialization",()=>{
  it("folds a queued save into the in-flight write instead of issuing a second request",async()=>{
    let release:(value:unknown)=>void=()=>undefined;
    mockApi.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve as (value:unknown)=>void;}));
    const session=ack(new AssessmentDraftSession(record()));
    session.update({q1:1},LOCALE);
    const first=session.save(LOCALE);
    session.update({q1:2},LOCALE);
    const second=session.save(LOCALE);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockApi).toHaveBeenCalledTimes(1);
    release({ok:true,revision:1});
    await first;await second;
    // One request went out and it carried the newest answers, so nothing was lost.
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi.mock.calls[0][2]).toMatchObject({body:expect.objectContaining({answers:{q1:2}})});
    expect(session.getSnapshot().hasUnsavedChanges).toBe(false);
  });
  it("never starts a second write while the first is still in flight",async()=>{
    let release:(value:unknown)=>void=()=>undefined;
    mockApi.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve as (value:unknown)=>void;}));
    mockApi.mockResolvedValueOnce({ok:true,revision:2});
    const session=ack(new AssessmentDraftSession(record()));
    session.update({q1:1},LOCALE);
    const first=session.save(LOCALE);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockApi).toHaveBeenCalledTimes(1);
    // An edit arriving mid-flight must queue behind the outstanding write.
    session.update({q1:2},LOCALE);
    const second=session.save(LOCALE);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockApi).toHaveBeenCalledTimes(1);
    release({ok:true,revision:1});
    await first;await second;
    expect(mockApi).toHaveBeenCalledTimes(2);
    // The second write uses the revision the server acknowledged for the first.
    expect(mockApi.mock.calls[1][2]).toMatchObject({body:expect.objectContaining({answers:{q1:2},revision:1})});
  });
  it("does not re-send an edit the server already has",async()=>{
    mockApi.mockResolvedValue({ok:true,revision:1});
    const session=ack(new AssessmentDraftSession(record()));
    session.update({q1:1},LOCALE);
    await session.save(LOCALE);
    await session.save(LOCALE);
    await session.save(LOCALE);
    expect(mockApi).toHaveBeenCalledTimes(1);
  });
});

describe("submission",()=>{
  it("requires acknowledgement before submitting",async()=>{
    const session=new AssessmentDraftSession(record());
    await expect(session.submit(LOCALE)).rejects.toMatchObject({code:"ACKNOWLEDGEMENT_REQUIRED"});
    expect(mockApi).not.toHaveBeenCalled();
  });
  it("flushes the draft and then submits",async()=>{
    mockApi.mockResolvedValueOnce({ok:true,revision:1});
    mockApi.mockResolvedValueOnce({id:"a",status:"queued",reportId:null});
    const session=ack(new AssessmentDraftSession(record()));
    session.update({q1:1},LOCALE);
    const result=await session.submit(LOCALE);
    expect(result.status).toBe("queued");
    expect(mockApi.mock.calls[0][2]).toMatchObject({method:"PATCH"});
    expect(mockApi.mock.calls[1][2]).toMatchObject({method:"POST"});
    expect(String(mockApi.mock.calls[1][0])).toContain("/submit");
    expect(session.getSnapshot().submitting).toBe(false);
  });
  it("clears the submitting flag when the submission fails",async()=>{
    mockApi.mockResolvedValueOnce({ok:true,revision:1});
    mockApi.mockRejectedValueOnce(new ApiError("boom","REQUEST_FAILED",500));
    const session=ack(new AssessmentDraftSession(record()));
    session.update({q1:1},LOCALE);
    await expect(session.submit(LOCALE)).rejects.toThrow("boom");
    expect(session.getSnapshot().submitting).toBe(false);
    expect(session.getSnapshot().status).toBe("failed");
  });
});

describe("observing the server",()=>{
  it("adopts the server snapshot when there are no local edits",()=>{
    const session=new AssessmentDraftSession(record({draftRevision:0}));
    session.observeServer(record({draftRevision:7,draftAnswers:{q1:3}}));
    expect(session.getSnapshot().revision).toBe(7);
    expect(session.getSnapshot().answers).toEqual({q1:3});
    expect(session.getSnapshot().status).toBe("saved");
  });
  it("raises a conflict instead of rebasing outstanding edits onto a newer revision",()=>{
    const session=ack(new AssessmentDraftSession(record({draftRevision:0})));
    session.update({q1:1},LOCALE);
    session.observeServer(record({draftRevision:9}));
    expect(session.getSnapshot().conflict).toBe(true);
    expect(session.getSnapshot().answers).toEqual({q1:1});
  });
  it("marks the session completed once the server reports a non-pending status",()=>{
    const session=ack(new AssessmentDraftSession(record()));
    session.observeServer(record({status:"published"}));
    expect(session.getSnapshot().submitting).toBe(false);
  });
  it("leaves local edits alone when the server revision is unchanged",()=>{
    const session=ack(new AssessmentDraftSession(record({draftRevision:3})));
    session.update({q1:1},LOCALE);
    session.observeServer(record({draftRevision:3}));
    expect(session.getSnapshot().conflict).toBe(false);
    expect(session.getSnapshot().answers).toEqual({q1:1});
  });
});

describe("reload preparation",()=>{
  it("retains a failed draft after its view unsubscribes until a later save is acknowledged",async()=>{
    const session=ack(new AssessmentDraftSession(record()));
    const listener=vi.fn();
    const unsubscribe=session.subscribe(listener);
    mockApi.mockRejectedValueOnce(new Error("Synthetic network failure"));
    session.update({q1:1},LOCALE);
    await flush();
    expect(session.getSnapshot().status).toBe("failed");
    unsubscribe();
    listener.mockClear();
    mockApi.mockRejectedValueOnce(new Error("Synthetic network failure"));
    await session.prepareForReload(LOCALE);
    expect(session.getSnapshot()).toMatchObject({status:"failed",hasUnsavedChanges:true,answers:{q1:1},revision:0});
    expect(listener).not.toHaveBeenCalled();
    mockApi.mockResolvedValueOnce({ok:true,revision:1});
    await session.prepareForReload(LOCALE);
    expect(session.getSnapshot()).toMatchObject({status:"saved",hasUnsavedChanges:false,answers:{q1:1},revision:1});
    expect(mockApi).toHaveBeenCalledTimes(3);
    expect(listener).not.toHaveBeenCalled();
  });
  it("flushes outstanding edits before reloading",async()=>{
    mockApi.mockResolvedValue({ok:true,revision:1});
    const session=ack(new AssessmentDraftSession(record()));
    session.update({q1:1},LOCALE);
    await session.prepareForReload(LOCALE);
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().hasUnsavedChanges).toBe(false);
  });
  it("does nothing when there is nothing outstanding",async()=>{
    const session=ack(new AssessmentDraftSession(record()));
    await session.prepareForReload(LOCALE);
    expect(mockApi).not.toHaveBeenCalled();
  });
});

describe("logout preparation",()=>{
  it("saves a debounced edit before allowing logout and prevents a cleanup write",async()=>{
    mockApi.mockResolvedValue({ok:true,revision:1});
    const session=ack(new AssessmentDraftSession(record()));
    session.update({q1:1},LOCALE);
    await session.prepareForLogout(LOCALE);
    expect(session.getSnapshot().hasUnsavedChanges).toBe(false);
    expect(session.getSnapshot().loggingOut).toBe(true);
    await session.prepareForReload(LOCALE);
    await flush();
    expect(mockApi).toHaveBeenCalledTimes(1);
  });
  it("waits for an in-flight write then saves the latest edit with its acknowledged revision",async()=>{
    let release:(value:unknown)=>void=()=>undefined;
    mockApi.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve as (value:unknown)=>void;}));
    mockApi.mockResolvedValueOnce({ok:true,revision:2});
    const session=ack(new AssessmentDraftSession(record()));
    session.update({q1:1},LOCALE);
    await flush();
    session.update({q1:2},LOCALE);
    let ready=false;
    const preparing=session.prepareForLogout(LOCALE).then(()=>{ready=true;});
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toBe(false);
    expect(mockApi).toHaveBeenCalledTimes(1);
    release({ok:true,revision:1});
    await preparing;
    expect(mockApi).toHaveBeenCalledTimes(2);
    expect(mockApi.mock.calls[1][2]).toMatchObject({method:"PATCH",body:{answers:{q1:2},revision:1}});
    expect(session.getSnapshot().hasUnsavedChanges).toBe(false);
  });
  it("locks edits synchronously while logout is being prepared",async()=>{
    mockApi.mockResolvedValue({ok:true,revision:1});
    const session=ack(new AssessmentDraftSession(record()));
    session.update({q1:1},LOCALE);
    const preparing=session.prepareForLogout(LOCALE);
    session.update({q1:2},LOCALE);
    session.setAcknowledged(false,LOCALE);
    await preparing;
    expect(session.getSnapshot().answers).toEqual({q1:1});
    expect(session.getSnapshot().hasUnsavedChanges).toBe(false);
  });
  it("rejects a failed save and permits retry after logout is cancelled",async()=>{
    mockApi.mockRejectedValueOnce(new ApiError("Synthetic draft failure","REQUEST_FAILED",500));
    const session=ack(new AssessmentDraftSession(record()));
    session.update({q1:1},LOCALE);
    await expect(session.prepareForLogout(LOCALE)).rejects.toThrow("Synthetic draft failure");
    expect(session.getSnapshot().hasUnsavedChanges).toBe(true);
    session.cancelLogout();
    expect(session.getSnapshot().loggingOut).toBe(false);
    session.update({q1:2},LOCALE);
    mockApi.mockResolvedValueOnce({ok:true,revision:1});
    await session.prepareForLogout(LOCALE);
    expect(mockApi.mock.calls[1][2]).toMatchObject({body:{answers:{q1:2}}});
    expect(session.getSnapshot().hasUnsavedChanges).toBe(false);
  });
  it("does not allow unsaved answers to be discarded after acknowledgement is withdrawn",async()=>{
    const session=ack(new AssessmentDraftSession(record()));
    session.update({q1:1},LOCALE);
    session.setAcknowledged(false,LOCALE);
    await expect(session.prepareForLogout(LOCALE)).rejects.toMatchObject({code:"ACKNOWLEDGEMENT_REQUIRED"});
    expect(session.getSnapshot().hasUnsavedChanges).toBe(true);
    expect(mockApi).not.toHaveBeenCalled();
  });
  it("rejects a conflicting draft without adopting the competing revision",async()=>{
    mockApi.mockRejectedValueOnce(new ApiError("Synthetic conflict","DRAFT_CONFLICT",409));
    const session=ack(new AssessmentDraftSession(record()));
    session.update({q1:1},LOCALE);
    await expect(session.prepareForLogout(LOCALE)).rejects.toMatchObject({code:"DRAFT_CONFLICT"});
    expect(session.getSnapshot().hasUnsavedChanges).toBe(true);
    expect(session.getSnapshot().revision).toBe(0);
    session.cancelLogout();
    await expect(session.prepareForLogout(LOCALE)).rejects.toMatchObject({code:"DRAFT_CONFLICT"});
    expect(mockApi).toHaveBeenCalledTimes(1);
  });
  it("waits for an already running submission even with no unsaved draft",async()=>{
    let release:(value:unknown)=>void=()=>undefined;
    mockApi.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve as (value:unknown)=>void;}));
    const session=ack(new AssessmentDraftSession(record()));
    const submitting=session.submit(LOCALE);
    await vi.advanceTimersByTimeAsync(0);
    let ready=false;
    const preparing=session.prepareForLogout(LOCALE).then(()=>{ready=true;});
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toBe(false);
    release({id:"a",status:"queued",reportId:null});
    await submitting;
    await preparing;
    expect(mockApi).toHaveBeenCalledTimes(1);
  });
  it("retains conflicting local changes after another respondent tab has submitted",async()=>{
    const session=ack(new AssessmentDraftSession(record()));
    session.update({q1:1},LOCALE);
    session.observeServer(record({status:"queued",draftRevision:1,draftAnswers:{q1:2}}));
    await expect(session.prepareForLogout(LOCALE)).rejects.toMatchObject({code:"DRAFT_CONFLICT"});
    expect(session.getSnapshot().hasUnsavedChanges).toBe(true);
    expect(session.getSnapshot().answers).toEqual({q1:1});
    expect(mockApi).not.toHaveBeenCalled();
  });
});

describe("account session disposal",()=>{
  it("prevents a queued save from starting after the account changes",async()=>{
    const session=ack(new AssessmentDraftSession(record()));
    session.update({q1:1},LOCALE);
    const saving=session.save(LOCALE);
    session.dispose();
    await saving;
    await flush();
    expect(mockApi).not.toHaveBeenCalled();
  });
  it("does not submit after the account changes while the draft write is pending",async()=>{
    let release:(value:unknown)=>void=()=>undefined;
    mockApi.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve as (value:unknown)=>void;}));
    const session=ack(new AssessmentDraftSession(record()));
    session.update({q1:1},LOCALE);
    const submitting=session.submit(LOCALE);
    const rejected=expect(submitting).rejects.toThrow("Assessment session is no longer active.");
    await vi.advanceTimersByTimeAsync(0);
    session.dispose();
    release({ok:true,revision:1});
    await rejected;
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi.mock.calls[0][2]).toMatchObject({method:"PATCH"});
  });
});

describe("temporary authentication loss",()=>{
  it("pauses on a real 401 while retaining local answers and the unload guard",async()=>{
    const expired=vi.fn();
    const session=ack(new AssessmentDraftSession(record(),expired));
    session.update({q1:1,note:"未保存的合成回答"},LOCALE);
    mockApi.mockRejectedValueOnce(new ApiError("Please sign in","UNAUTHENTICATED",401));
    await flush();
    expect(session.getSnapshot()).toMatchObject({authenticationPaused:true,hasUnsavedChanges:true,answers:{q1:1,note:"未保存的合成回答"},revision:0});
    expect(expired).toHaveBeenCalledTimes(1);
    await session.prepareForReload(LOCALE);
    await flush();
    expect(mockApi).toHaveBeenCalledTimes(1);
  });
  it("requires a fresh record and renewed acknowledgement before writing again",async()=>{
    const session=ack(new AssessmentDraftSession(record()));
    session.update({note:"local"},LOCALE);
    session.suspendAuthentication();
    session.setAcknowledged(true,LOCALE);
    await flush();
    expect(mockApi).not.toHaveBeenCalled();
    session.resumeFromServer(record());
    await flush();
    expect(mockApi).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({authenticationPaused:false,hasUnsavedChanges:true,answers:{note:"local"}});
    mockApi.mockResolvedValueOnce({ok:true,revision:1});
    session.setAcknowledged(true,LOCALE);
    await flush();
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().hasUnsavedChanges).toBe(false);
  });
  it("does not revive saves queued before suspension when the same account returns",async()=>{
    let release:(value:unknown)=>void=()=>undefined;
    mockApi.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve as typeof release;}));
    const session=ack(new AssessmentDraftSession(record()));
    session.update({note:"first"},LOCALE);
    const first=session.save(LOCALE).catch(()=>undefined);
    await vi.advanceTimersByTimeAsync(0);
    session.update({note:"latest"},LOCALE);
    const queued=session.save(LOCALE).catch(()=>undefined);
    session.suspendAuthentication();
    session.resumeFromServer(record());
    session.setAcknowledged(true,LOCALE);session.cancelTimer();
    release({ok:true,revision:1});
    await first;await queued;
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot()).toMatchObject({revision:0,answers:{note:"latest"},hasUnsavedChanges:true,status:"unsaved"});
  });
  it.each([401,409])("ignores a stale %i response after a later authenticated read",async status=>{
    let reject:(value:unknown)=>void=()=>undefined;
    mockApi.mockImplementationOnce(()=>new Promise((_resolve,fail)=>{reject=fail;}));
    const expired=vi.fn(),session=ack(new AssessmentDraftSession(record(),expired));
    session.update({note:"retained"},LOCALE);
    const first=session.save(LOCALE).catch(()=>undefined);
    await vi.advanceTimersByTimeAsync(0);
    session.suspendAuthentication();session.resumeFromServer(record());
    reject(new ApiError("stale",status===401?"UNAUTHENTICATED":"DRAFT_CONFLICT",status));
    await first;
    expect(expired).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({authenticationPaused:false,conflict:false,revision:0,hasUnsavedChanges:true});
  });
  it("cancels an old submit intention captured before suspension even after resume",async()=>{
    let release:(value:unknown)=>void=()=>undefined;
    mockApi.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve as typeof release;}));
    const session=ack(new AssessmentDraftSession(record()));
    session.update({note:"retained"},LOCALE);
    const saving=session.save(LOCALE).catch(()=>undefined);
    await vi.advanceTimersByTimeAsync(0);
    const submitting=session.submit(LOCALE).catch(()=>undefined);
    session.suspendAuthentication();session.resumeFromServer(record());session.setAcknowledged(true,LOCALE);session.cancelTimer();
    release({ok:true,revision:1});
    await saving;await submitting;
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot()).toMatchObject({submitting:false,hasUnsavedChanges:true});
  });
  it("reconciles a submitted server record without replaying an uncertain submission",async()=>{
    let release:(value:unknown)=>void=()=>undefined;
    mockApi.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve as typeof release;}));
    const session=ack(new AssessmentDraftSession(record({draftAnswers:{note:"saved"}})));
    const submitting=session.submit(LOCALE).catch(()=>undefined);
    await vi.advanceTimersByTimeAsync(0);
    session.suspendAuthentication();expect(session.getSnapshot().hasUnsavedChanges).toBe(true);
    session.resumeFromServer(record({status:"queued"}));
    release({id:record().id,status:"queued",reportId:null});await submitting;
    expect(session.getSnapshot()).toMatchObject({hasUnsavedChanges:false,submitting:false,authenticationPaused:false});
    await expect(session.submit(LOCALE)).rejects.toThrow("already submitted");expect(mockApi).toHaveBeenCalledTimes(1);
  });
  it("preserves dirty answers as a conflict when the fresh revision or status changed",()=>{
    for(const server of [record({draftRevision:2,draftAnswers:{note:"server"}}),record({status:"published"})]){
      const session=ack(new AssessmentDraftSession(record()));session.update({note:"local"},LOCALE);
      session.suspendAuthentication();session.resumeFromServer(server);
      expect(session.getSnapshot()).toMatchObject({authenticationPaused:false,conflict:true,hasUnsavedChanges:true,answers:{note:"local"},revision:0});
    }
  });
  it("keeps consent-revoked answers without letting cleanup or submit write them",async()=>{
    const session=ack(new AssessmentDraftSession(record()));session.update({note:"local"},LOCALE);
    session.suspendAuthentication();session.resumeFromServer(record({consentRequired:true}));
    session.setAcknowledged(true,LOCALE);await session.prepareForReload(LOCALE);await flush();
    await expect(session.submit(LOCALE)).rejects.toMatchObject({code:"ACKNOWLEDGEMENT_REQUIRED"});
    expect(mockApi).not.toHaveBeenCalled();expect(session.getSnapshot().answers).toEqual({note:"local"});
  });
  it("does not let failed logout cancellation reactivate an expired session",async()=>{
    const session=ack(new AssessmentDraftSession(record()));session.update({note:"local"},LOCALE);
    session.suspendAuthentication();session.cancelLogout();
    await expect(session.prepareForLogout(LOCALE)).rejects.toMatchObject({code:"DRAFT_AUTHENTICATION_PAUSED"});
    expect(session.getSnapshot().authenticationPaused).toBe(true);expect(mockApi).not.toHaveBeenCalled();
  });
});
