import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import type { PoolClient } from "pg";
import type { AdviceLibrary,AssessmentSnapshot,ContentSnapshot,Locale,ReportPayload,StoredAnswer } from "../src/domain/types";
import { demoTemplate } from "../src/domain/demo";
import { childScale,parentScale,teacherScale } from "../src/domain/triad-scales";
import { previewAnswers } from "../src/domain/triad-report";
import { scoreAssessment } from "../src/domain/scoring";

vi.mock("../src/lib/db",()=>({query:vi.fn(),transaction:vi.fn()}));
vi.mock("../src/lib/pdf",()=>({renderPdf:vi.fn(),closePdfBrowser:vi.fn()}));
vi.mock("../src/lib/storage",()=>({writePrivatePdf:vi.fn(),removePrivatePdf:vi.fn(),listPrivatePdfKeys:vi.fn(),cleanAbandonedPrivatePdfTemps:vi.fn()}));
import { query,transaction } from "../src/lib/db";
import { renderPdf } from "../src/lib/pdf";
import { removePrivatePdf,writePrivatePdf } from "../src/lib/storage";
import { processReportJob } from "../src/lib/worker";

const JOB_ID="77777777-7777-4777-8777-777777777777";
const FAMILY_ID="88888888-8888-4888-8888-888888888888";
const ROUND_ID="99999999-9999-4999-8999-999999999999";
const IDS=["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222","33333333-3333-4333-8333-333333333333"];
const pair=(text:string)=>({"zh-CN":text,"zh-HK":text});
const advice:ContentSnapshot<AdviceLibrary>={
  id:"synthetic-triad-advice",version:"1.0.0",content:{
    title:pair("合成建议库"),
    blocks:[
      {id:"cognition-a",title:pair("认知支持甲"),body:pair("合成认知建议正文"),source:"Synthetic fixture",dimensionKeys:[],triadApplicability:{domainKeys:["cognition"],roles:["student","parent","teacher"]}},
      {id:"connection-b",title:pair("关系支持乙"),body:pair("合成关系建议正文"),source:"Synthetic fixture",dimensionKeys:[],triadApplicability:{domainKeys:["connection"],roles:["student","parent","teacher"]}}
    ]
  }
};
interface SourceRow {
  id:string;family_id:string;triad_round_id:string;respondent_id:string;respondent_role:"student"|"parent"|"teacher";
  answers:Record<string,StoredAnswer>;submitted_at:string;snapshot:AssessmentSnapshot;
}
let sources:SourceRow[];
let pinnedIds:string[];
let effectiveAiConsentIds:string[];
let parentReportGranted:boolean;
let afterFamilyLock:()=>void;
let afterRender:()=>void;
let transactionOpen:boolean;
let publicationCount:number;
let persisted:{payload:ReportPayload;keys:Record<Locale,string>;documents:Record<Locale,string>}|undefined;
let events:string[];
const provider=vi.fn<typeof fetch>();
const nativeFetch=vi.fn<typeof fetch>();
const client={query:vi.fn()};

function response(ids=["connection-b","cognition-a"]):Response {
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({adviceIds:ids})}}]}),{status:200});
}
function frozenSources():SourceRow[] {
  return [childScale,parentScale,teacherScale].map((scale,index)=>{
    const role=scale.roles[0],answers=previewAnswers(scale,"calm"),submittedAt="2026-10-20T00:00:00.000Z";
    const snapshot:AssessmentSnapshot={
      scale,advice:structuredClone(advice),template:{id:"synthetic-template",version:"1.0.0",content:demoTemplate},
      score:scoreAssessment(scale,answers,{age:12,region:"CN",role}),childName:"PRIVATE_CHILD",grade:"PRIVATE_GRADE",submittedAt,aiConsented:true
    };
    return {id:IDS[index],family_id:FAMILY_ID,triad_round_id:ROUND_ID,respondent_id:IDS[index],respondent_role:role,answers,submitted_at:submittedAt,snapshot};
  });
}
function currentAiRows(){return effectiveAiConsentIds.map(id=>({id}));}
function isAiConsentRead(sql:string){return sql.startsWith("SELECT")&&sql.includes("FROM consents c")&&sql.includes("ai_processing");}

beforeEach(()=>{
  vi.clearAllMocks();
  const env={
    NOVA_REGION:"CN",NOVA_MODE:"demo",DATABASE_URL:"postgresql://synthetic.invalid/nova",
    NOVA_PUBLIC_URL:"http://127.0.0.1:3197",NOVA_REPORT_DIR:"work/test-private",NOVA_REPORT_KEY:"ab".repeat(32),
    NOVA_REPORT_STORAGE:"filesystem",NOVA_WORKER_MODE:"continuous",NOVA_AI_ENABLED:"true",NOVA_TRIAD_AI_ENABLED:"true",
    NOVA_AI_BASE_URL:"https://llm-synthetic.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    NOVA_AI_API_KEY:"synthetic-key",NOVA_AI_MODEL:"synthetic-model",NOVA_AI_DEPLOYMENT_SCOPE:"CN",VERCEL:"0"
  };
  for(const [key,value] of Object.entries(env))vi.stubEnv(key,value);
  vi.stubGlobal("fetch",nativeFetch);
  nativeFetch.mockImplementation(async()=>{throw new Error("Unexpected external request");});
  provider.mockImplementation(async()=>{expect(transactionOpen).toBe(true);return response();});
  sources=frozenSources();pinnedIds=[...IDS];effectiveAiConsentIds=["consent-b","consent-a"];parentReportGranted=true;
  afterFamilyLock=()=>{};afterRender=()=>{};transactionOpen=false;publicationCount=0;persisted=undefined;events=[];
  vi.mocked(query).mockImplementation((async(sql:string,values:unknown[]=[])=>{
    events.push(`query:${sql}`);
    if(sql.includes("WITH candidate AS"))return [{id:JOB_ID,assessment_id:IDS[1],attempts:1,source_assessment_ids:pinnedIds}];
    if(sql.includes("SELECT * FROM assessments WHERE id="))return [sources.find(source=>source.id===IDS[1])];
    if(sql.includes("SELECT id,respondent_role,answers"))return sources;
    if(sql.includes("WITH prior_round AS"))return [];
    if(isAiConsentRead(sql))return currentAiRows();
    if(sql.startsWith("SELECT pdf_keys FROM reports"))return persisted?[{pdf_keys:persisted.keys}]:[];
    if(sql.includes("UPDATE report_jobs SET state=$1"))return [{assessment_id:IDS[1],source_assessment_ids:pinnedIds,available_at:"2026-10-20T00:00:10.000Z"}];
    throw new Error(`Unexpected synthetic query: ${String(values.length)}`);
  }) as typeof query);
  client.query.mockImplementation(async(sql:string,values:unknown[]=[])=>{
    events.push(`transaction:${sql}`);
    if(sql.includes("FROM families")&&sql.includes("FOR UPDATE")){afterFamilyLock();return {rows:[{id:FAMILY_ID}]};}
    if(sql.includes("FROM report_jobs")&&sql.includes("FOR UPDATE"))return {rows:[{id:JOB_ID}]};
    if(sql.includes("AS scopes FROM consents WHERE family_id=$1"))return {rows:[...(parentReportGranted?[{id:"parent-report",scopes:["parent_report"]}]:[]),...effectiveAiConsentIds.map(id=>({id,scopes:["ai_processing"]}))]};
    if(isAiConsentRead(sql))return {rows:currentAiRows()};
    if(sql.startsWith("INSERT INTO reports")){
      publicationCount++;
      persisted={payload:JSON.parse(String(values[3])),keys:JSON.parse(String(values[4])),documents:JSON.parse(String(values[6]))};
    }
    return {rows:[{id:JOB_ID}]};
  });
  vi.mocked(transaction).mockImplementation(async fn=>{
    expect(transactionOpen).toBe(false);transactionOpen=true;
    try{return await fn(client as unknown as PoolClient);}finally{transactionOpen=false;}
  });
  vi.mocked(renderPdf).mockImplementation(async html=>{
    expect(transactionOpen).toBe(true);events.push("render");afterRender();
    return Buffer.from(`%PDF-1.4 synthetic ${html}`);
  });
  vi.mocked(writePrivatePdf).mockImplementation(async()=>undefined);
  vi.mocked(removePrivatePdf).mockImplementation(async()=>{expect(transactionOpen).toBe(false);return "done";});
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});

describe("triad AI worker publication",()=>{
  it("uses one injected request to publish approved ordering from the three pinned snapshots",async()=>{
    const original=sources.map(source=>structuredClone(source.snapshot.score));
    await expect(processReportJob(JOB_ID,{narrativeFetcher:provider})).resolves.toEqual({status:"published"});
    expect(provider).toHaveBeenCalledTimes(1);expect(nativeFetch).not.toHaveBeenCalled();
    expect(persisted?.payload).toMatchObject({generationMode:"ai",aiModel:"synthetic-model",fallbackReason:null,selectedAdviceIds:["connection-b","cognition-a"]});
    expect(sources.map(source=>source.snapshot.score)).toEqual(original);
    const body=JSON.stringify(provider.mock.calls[0][1]?.body);
    expect(body).not.toContain("PRIVATE_CHILD");expect(body).not.toContain("PRIVATE_GRADE");
    for(const role of ["student","parent","teacher"])expect(body).toContain(role);
    expect(publicationCount).toBe(1);
    expect(client.query).toHaveBeenCalledWith("UPDATE assessments SET status='published' WHERE id=ANY($1::uuid[])",[IDS]);
    for(const locale of ["zh-CN","zh-HK"] as const){
      const html=persisted!.documents[locale];
      expect(html).toContain("关系支持乙");expect(html).toContain("认知支持甲");
      expect(html.indexOf("关系支持乙")).toBeLessThan(html.indexOf("认知支持甲"));
    }
  });

  it.each(["NOVA_TRIAD_AI_ENABLED","NOVA_AI_ENABLED"])("automatically publishes a complete template when %s is off",async flag=>{
    vi.stubEnv(flag,"false");
    await expect(processReportJob(JOB_ID,{narrativeFetcher:provider})).resolves.toEqual({status:"published"});
    expect(provider).not.toHaveBeenCalled();expect(nativeFetch).not.toHaveBeenCalled();
    expect(persisted?.payload).toMatchObject({generationMode:"template",aiModel:null,selectedAdviceIds:["cognition-a","connection-b"],fallbackReason:flag==="NOVA_TRIAD_AI_ENABLED"?"triad_ai_disabled":"ai_disabled"});
  });

  it.each([0,1,2])("does not retroactively authorize source %i from a later current grant",async index=>{
    sources[index].snapshot.aiConsented=false;
    await expect(processReportJob(JOB_ID,{narrativeFetcher:provider})).resolves.toEqual({status:"published"});
    expect(provider).not.toHaveBeenCalled();
    expect(persisted?.payload).toMatchObject({generationMode:"template",fallbackReason:"no_ai_consent",aiModel:null});
  });

  it("does not contact the model after current AI consent is withdrawn",async()=>{
    effectiveAiConsentIds=[];
    await expect(processReportJob(JOB_ID,{narrativeFetcher:provider})).resolves.toEqual({status:"published"});
    expect(provider).not.toHaveBeenCalled();
    expect(persisted?.payload).toMatchObject({generationMode:"template",fallbackReason:"no_ai_consent"});
  });

  it.each([0,1,2])("keeps source %i safety messaging and never invokes AI",async index=>{
    sources[index].snapshot.score.risk=true;
    sources[index].snapshot.score.riskMessages=[pair("合成安全提示")];
    await expect(processReportJob(JOB_ID,{narrativeFetcher:provider})).resolves.toEqual({status:"published"});
    expect(provider).not.toHaveBeenCalled();
    expect(persisted?.payload).toMatchObject({generationMode:"template",fallbackReason:"risk_template",score:{risk:true}});
    expect(persisted?.documents["zh-CN"]).toContain("合成安全提示");
    expect(persisted?.documents["zh-HK"]).toContain("合成安全提示");
  });

  it("publishes template output on provider failure without retrying the job",async()=>{
    provider.mockRejectedValueOnce(new Error("SYNTHETIC_PROVIDER_ERROR"));
    await expect(processReportJob(JOB_ID,{narrativeFetcher:provider})).resolves.toEqual({status:"published"});
    expect(provider).toHaveBeenCalledTimes(1);
    expect(persisted?.payload).toMatchObject({generationMode:"template",fallbackReason:"provider_unavailable",aiModel:null});
    expect(vi.mocked(query).mock.calls.some(([sql])=>sql.includes("UPDATE report_jobs SET state=$1"))).toBe(false);
  });

  it.each([{ids:[]},{ids:["replacement-consent"]}])("falls back before rendering if AI consent changes in flight ($ids)",async replacement=>{
    provider.mockImplementationOnce(async()=>{effectiveAiConsentIds=replacement.ids;return response();});
    await expect(processReportJob(JOB_ID,{narrativeFetcher:provider})).resolves.toEqual({status:"published"});
    expect(provider).toHaveBeenCalledTimes(1);expect(renderPdf).toHaveBeenCalledTimes(2);
    expect(persisted?.payload).toMatchObject({generationMode:"template",fallbackReason:"ai_consent_changed",aiModel:null,selectedAdviceIds:["cognition-a","connection-b"]});
  });

  it("treats the same consent record set in a different order as unchanged",async()=>{
    provider.mockImplementationOnce(async()=>{effectiveAiConsentIds.reverse();return response();});
    await expect(processReportJob(JOB_ID,{narrativeFetcher:provider})).resolves.toEqual({status:"published"});
    expect(persisted?.payload.generationMode).toBe("ai");expect(renderPdf).toHaveBeenCalledTimes(2);
  });

  it.each(["render","locked-publication"])("rebuilds both locales once without another AI call after revocation at %s",async point=>{
    if(point==="render")afterRender=()=>{effectiveAiConsentIds=[];};
    else afterFamilyLock=()=>{effectiveAiConsentIds=[];};
    await expect(processReportJob(JOB_ID,{narrativeFetcher:provider})).resolves.toEqual({status:"published"});
    expect(provider).toHaveBeenCalledTimes(1);expect(renderPdf).toHaveBeenCalledTimes(4);
    expect(publicationCount).toBe(1);
    expect(persisted?.payload).toMatchObject({generationMode:"template",fallbackReason:"ai_consent_changed",aiModel:null,selectedAdviceIds:["cognition-a","connection-b"]});
    const keys=vi.mocked(writePrivatePdf).mock.calls.map(([key])=>key);
    expect(new Set(keys).size).toBe(4);
    expect(vi.mocked(removePrivatePdf).mock.calls.map(([key])=>key)).toEqual(keys.slice(0,2));
    expect(Object.values(persisted!.keys)).toEqual(keys.slice(2));
    expect(vi.mocked(query).mock.calls.filter(([sql])=>sql.includes("WITH candidate AS"))).toHaveLength(1);
    const transactions=events.filter(event=>event.startsWith("transaction:"));
    expect(transactions.findIndex(sql=>sql.includes("FROM families"))).toBeLessThan(transactions.findIndex(sql=>sql.includes("FROM report_jobs")));
    expect(transactions.findIndex(sql=>isAiConsentRead(sql.slice("transaction:".length)))).toBeGreaterThan(transactions.findIndex(sql=>sql.includes("FROM report_jobs")));
  });

  it("writes only the rebuilt database PDFs inside the successful publication transaction",async()=>{
    vi.stubEnv("NOVA_REPORT_STORAGE","database");
    afterFamilyLock=()=>{effectiveAiConsentIds=[];};
    vi.mocked(writePrivatePdf).mockImplementation(async(_key,_pdf,publicationClient)=>{
      expect(transactionOpen).toBe(true);expect(publicationClient).toBe(client);
    });
    await expect(processReportJob(JOB_ID,{narrativeFetcher:provider})).resolves.toEqual({status:"published"});
    expect(provider).toHaveBeenCalledTimes(1);expect(renderPdf).toHaveBeenCalledTimes(4);
    expect(writePrivatePdf).toHaveBeenCalledTimes(2);expect(removePrivatePdf).not.toHaveBeenCalled();
    expect(persisted?.payload.generationMode).toBe("template");
  });

  it("retains the parent-report pause when that permission is withdrawn during inference",async()=>{
    provider.mockImplementationOnce(async()=>{parentReportGranted=false;return response();});
    await expect(processReportJob(JOB_ID,{narrativeFetcher:provider})).resolves.toEqual({status:"paused"});
    expect(provider).toHaveBeenCalledTimes(1);expect(publicationCount).toBe(0);
    expect(events.some(event=>event.includes("state='paused'"))).toBe(true);
    expect(renderPdf).not.toHaveBeenCalled();expect(removePrivatePdf).not.toHaveBeenCalled();
  });

  it("still pauses if parent-report permission is withdrawn during the template rebuild",async()=>{
    let renders=0;
    afterRender=()=>{renders++;effectiveAiConsentIds=[];if(renders===3)parentReportGranted=false;};
    await expect(processReportJob(JOB_ID,{narrativeFetcher:provider})).resolves.toEqual({status:"paused"});
    expect(provider).toHaveBeenCalledTimes(1);expect(renderPdf).toHaveBeenCalledTimes(3);expect(publicationCount).toBe(0);
    const written=vi.mocked(writePrivatePdf).mock.calls.map(([key])=>key);
    expect(vi.mocked(removePrivatePdf).mock.calls.map(([key])=>key)).toEqual(written);
  });

  it.each(["duplicate-id","missing-source","foreign-snapshot-region","wrong-role"])("rejects invalid pinned sources before the model (%s)",async mode=>{
    if(mode==="duplicate-id")pinnedIds=[IDS[0],IDS[0],IDS[1]];
    if(mode==="missing-source")sources=sources.slice(0,2);
    if(mode==="foreign-snapshot-region")sources[0].snapshot.score.region="HK";
    if(mode==="wrong-role")sources[0].snapshot.score.respondentRole="parent";
    await expect(processReportJob(JOB_ID,{narrativeFetcher:provider})).resolves.toMatchObject({status:"retry_at"});
    expect(provider).not.toHaveBeenCalled();expect(renderPdf).not.toHaveBeenCalled();expect(publicationCount).toBe(0);
  });
});
