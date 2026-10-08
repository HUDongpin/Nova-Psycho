import {describe,it,expect,beforeEach,afterEach,vi} from "vitest";
import {ApiError,type SurveyRecord} from "../src/components/api";
vi.mock("../src/components/api",async importOriginal=>({...await importOriginal<typeof import("../src/components/api")>(),api:vi.fn()}));
import {api} from "../src/components/api";
import {AccountDraftStore} from "../src/components/account-drafts";
const mockApi=vi.mocked(api),locale="zh-CN" as const;
const owner={id:"owner-a",region:"CN" as const},other={id:"owner-b",region:"CN" as const};
const record=(over:Partial<SurveyRecord>={}):SurveyRecord=>({id:"assessment-a",status:"pending",childName:"Synthetic private child",scaleTitle:"Synthetic",demo:true,description:"",surveyJson:{},draftAnswers:{},draftRevision:0,consentRequired:false,...over});
function dirtyStore(expired=vi.fn()){
  const store=new AccountDraftStore(expired);store.activate(owner);
  const draft=store.remember(owner,record());draft.setAcknowledged(true,locale);draft.update({note:"private synthetic answer"},locale);
  return {store,draft,expired};
}
beforeEach(()=>{vi.useFakeTimers();mockApi.mockReset();});
afterEach(()=>vi.useRealTimers());
describe("single-owner draft bank",()=>{
  it("retains an anonymous owner's dirty draft but exposes no active bank",()=>{
    const {store,draft}=dirtyStore();store.suspend();
    expect(store.state).toBe("suspended");expect(store.hasUnsavedChanges()).toBe(true);
    expect(store.get(owner,record().id)).toBeUndefined();
    expect(draft.getSnapshot().authenticationPaused).toBe(true);
  });
  it("makes a different account explicitly resolve the retained bank",()=>{
    const {store,draft}=dirtyStore();store.suspend();
    expect(store.activate(other)).toBe(false);expect(store.state).toBe("mismatch");
    expect(store.get(other,record().id)).toBeUndefined();expect(store.get(owner,record().id)).toBeUndefined();
    expect(store.hasUnsavedChanges()).toBe(true);
    expect(store.activate(owner)).toBe(true);expect(store.get(owner,record().id)).toBe(draft);
    expect(draft.getSnapshot().authenticationPaused).toBe(true);
  });
  it("binds ownership to region as well as user id",()=>{
    const {store}=dirtyStore();store.suspend();
    expect(store.activate({...owner,region:"HK"})).toBe(false);
    expect(store.hasUnsavedChanges()).toBe(true);
  });
  it("can retire a fully clean bank on a verified identity change",()=>{
    const store=new AccountDraftStore(vi.fn());store.activate(owner);store.remember(owner,record());
    expect(store.activate(other)).toBe(true);expect(store.values(other)).toEqual([]);
  });
  it("discards only after the explicit choice to use the other account",()=>{
    const {store}=dirtyStore();store.suspend();store.activate(other);
    store.discardAndActivate(other);
    expect(store.state).toBe("active");expect(store.values(other)).toEqual([]);expect(store.hasUnsavedChanges()).toBe(false);
  });
  it("freshly reads before a same-owner draft can write again",async()=>{
    const {store,draft}=dirtyStore();store.suspend();store.activate(owner);
    mockApi.mockResolvedValueOnce(record());await store.load(owner,record().id,locale);
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi.mock.calls[0][2]?.method).not.toBe("PATCH");
    expect(draft.getSnapshot()).toMatchObject({authenticationPaused:false,hasUnsavedChanges:true,answers:{note:"private synthetic answer"}});
    await vi.advanceTimersByTimeAsync(1000);expect(mockApi).toHaveBeenCalledTimes(1);
  });
  it.each([403,404,500])("retains a blocked draft after fresh GET %i until an explicit discard",async status=>{
    const {store,draft}=dirtyStore();store.suspend();store.activate(owner);
    mockApi.mockRejectedValueOnce(new ApiError("Synthetic unavailable","NOT_FOUND",status));
    await expect(store.load(owner,record().id,locale)).rejects.toMatchObject({status});
    expect(store.get(owner,record().id)).toBe(draft);expect(store.hasUnsavedChanges()).toBe(true);
    expect(draft.getSnapshot().authenticationPaused).toBe(true);
    store.discard(owner,record().id);expect(store.hasUnsavedChanges()).toBe(false);
  });
  it("does not let an old 401 pause a newer owner after explicit discard",async()=>{
    let reject:(error:unknown)=>void=()=>undefined;
    const {store,expired}=dirtyStore();store.suspend();store.activate(owner);
    mockApi.mockImplementationOnce(()=>new Promise((_resolve,fail)=>{reject=fail;}));
    const oldRead=store.load(owner,record().id,locale).catch(()=>undefined);
    await vi.advanceTimersByTimeAsync(0);store.suspend();store.discardAndActivate(other);
    reject(new ApiError("Old response","UNAUTHENTICATED",401));await oldRead;
    expect(expired).not.toHaveBeenCalled();expect(store.state).toBe("active");expect(store.isCurrent(other,store.epoch)).toBe(true);
  });
  it("ignores an old success instead of installing another owner's assessment",async()=>{
    let release:(value:unknown)=>void=()=>undefined;
    const {store}=dirtyStore();store.suspend();store.activate(owner);
    mockApi.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve as typeof release;}));
    const oldRead=store.load(owner,record().id,locale).catch(()=>undefined);
    await vi.advanceTimersByTimeAsync(0);store.suspend();store.discardAndActivate(other);
    release(record());await oldRead;expect(store.values(other)).toEqual([]);
  });
  it("does not clear another owner's bank from a stale logout callback",()=>{
    const {store}=dirtyStore();store.discardAndActivate(other);const draft=store.remember(other,record());
    draft.setAcknowledged(true,locale);draft.update({note:"other private"},locale);
    store.clearAfterLogout(owner);expect(store.hasUnsavedChanges()).toBe(true);
    store.clearAfterLogout(other);expect(store.hasUnsavedChanges()).toBe(false);expect(store.state).toBe("empty");
  });
});
