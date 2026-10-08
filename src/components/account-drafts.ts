import {api,ApiError,type Locale,type Region,type SurveyRecord} from "./api";
import {AssessmentDraftSession} from "./draft-session";

export interface DraftOwner { id:string; region:Region }
type BankState="empty"|"active"|"suspended"|"mismatch";
const sameOwner=(left:DraftOwner|null,right:DraftOwner)=>left?.id===right.id&&left.region===right.region;

/** One page-memory bank, kept separate from its temporary authentication state. */
export class AccountDraftStore {
  private owner:DraftOwner|null=null;
  private drafts=new Map<string,AssessmentDraftSession>();
  private lifecycle=0;
  private phase:BankState="empty";
  constructor(private readonly onAuthenticationLost:()=>void){}
  get state(){return this.phase;}
  get epoch(){return this.lifecycle;}
  get activeOwner(){return this.phase==="active"&&this.owner?{...this.owner}:null;}
  isCurrent(owner:DraftOwner,epoch:number){return this.phase==="active"&&sameOwner(this.owner,owner)&&epoch===this.lifecycle;}
  private requireOwner(owner:DraftOwner,epoch=this.lifecycle){
    if(!this.isCurrent(owner,epoch))throw new ApiError("The account session changed.","DRAFT_SESSION_CHANGED",409);
  }
  hasUnsavedChanges(){return [...this.drafts.values()].some(draft=>draft.getSnapshot().hasUnsavedChanges||draft.getSnapshot().submitting);}
  activate(owner:DraftOwner):boolean{
    if(!sameOwner(this.owner,owner)){
      if(this.hasUnsavedChanges()){
        this.suspend();this.phase="mismatch";return false;
      }
      this.discardAll();this.owner={...owner};
    }
    if(this.phase!=="active")this.lifecycle+=1;
    this.phase="active";
    return true;
  }
  suspend(){
    if(this.phase==="empty")return;
    if(this.phase!=="suspended")this.lifecycle+=1;
    this.phase="suspended";
    for(const draft of this.drafts.values())draft.suspendAuthentication();
  }
  private authenticationLost(owner:DraftOwner){
    if(this.phase!=="active"||!sameOwner(this.owner,owner))return;
    this.suspend();this.onAuthenticationLost();
  }
  get(owner:DraftOwner,id:string){return this.isCurrent(owner,this.lifecycle)?this.drafts.get(id):undefined;}
  values(owner:DraftOwner){return this.isCurrent(owner,this.lifecycle)?[...this.drafts.values()]:[];}
  remember(owner:DraftOwner,record:SurveyRecord){
    this.requireOwner(owner);
    const existing=this.drafts.get(record.id);
    if(existing){
      if(existing.getSnapshot().authenticationPaused)existing.resumeFromServer(record);
      else existing.observeServer(record);
      return existing;
    }
    const draft=new AssessmentDraftSession(record,()=>this.authenticationLost(owner));
    this.drafts.set(record.id,draft);return draft;
  }
  async load(owner:DraftOwner,id:string,locale:Locale,signal?:AbortSignal){
    const epoch=this.lifecycle;this.requireOwner(owner,epoch);
    const existing=this.drafts.get(id);
    try{
      // Paused controllers never flush here. Their next operation must be GET.
      if(existing)await existing.prepareForReload(locale);
      this.requireOwner(owner,epoch);
      if(signal?.aborted)throw new DOMException("Aborted","AbortError");
      const record=await api<SurveyRecord>(`/api/assessments/${encodeURIComponent(id)}`,locale,{signal});
      this.requireOwner(owner,epoch);
      if(signal?.aborted)throw new DOMException("Aborted","AbortError");
      const draft=this.remember(owner,record);
      return {record,draft};
    }catch(error){
      if(this.isCurrent(owner,epoch)&&!signal?.aborted&&error instanceof ApiError){
        if(error.status===401)this.authenticationLost(owner);
        else if(error.status===403||error.status===404)existing?.suspendAuthentication();
      }
      throw error;
    }
  }
  discard(owner:DraftOwner,id:string){
    this.requireOwner(owner);
    this.drafts.get(id)?.dispose();this.drafts.delete(id);
  }
  discardAll(){
    this.lifecycle+=1;
    for(const draft of this.drafts.values())draft.dispose();
    this.drafts.clear();this.owner=null;this.phase="empty";
  }
  discardAndActivate(owner:DraftOwner){this.discardAll();this.activate(owner);}
  clearAfterLogout(owner:DraftOwner){if(sameOwner(this.owner,owner))this.discardAll();}
}
