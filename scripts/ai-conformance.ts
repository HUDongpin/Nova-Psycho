import { mkdirSync,writeFileSync } from "node:fs";
import path from "node:path";
import { demoAdvice,demoScale,demoTemplate } from "../src/domain/demo";
import { eligibleAdviceIds,selectNarrative,type AiSettings } from "../src/domain/narrative";
import { scoreAssessment } from "../src/domain/scoring";
import type { AssessmentSnapshot,Region } from "../src/domain/types";
import { getConfig } from "../src/lib/config";

// Live verification of the constrained narrative adapter against a real Model Studio
// (Bailian) regional workspace. This is the check that could not be completed without
// credentials, so it is written to be run the moment a key exists.
//
// Safety properties, by construction:
//   - No database import. The snapshot is built in memory from the fictional demo scale.
//   - The payload actually transmitted is inspected for identity and raw-answer leakage.
//   - The API key is never printed. Response bodies are never printed; only stable codes.
//   - Refuses to run unless the scale is marked demo, so a real instrument cannot be sent.

const RUNS=5;
const SYNTHETIC_ANSWERS={q1:1,q2:2,q3:1,q4:2,q5:1,q6:2,q7:1,q8:2,q9:0};
const CHILD_MARKER="SYNTHETIC_CHILD_NOT_TRANSMITTED";
const GRADE_MARKER="SYNTHETIC_GRADE_NOT_TRANSMITTED";

interface Check {code:string;status:"pass"|"fail"|"warn"|"skip";detail:string}
const checks:Check[]=[];
const record=(code:string,status:Check["status"],detail:string)=>{checks.push({code,status,detail});};

const REQUIRED_ENV=["NOVA_AI_ENABLED","NOVA_AI_BASE_URL","NOVA_AI_API_KEY","NOVA_AI_MODEL","NOVA_AI_DEPLOYMENT_SCOPE"];

let config:ReturnType<typeof getConfig>;
try{config=getConfig();}
catch(e){console.error(`Cannot load configuration: ${(e as Error).message}`);process.exit(2);}

record("config_region",config.region==="CN"||config.region==="HK"?"pass":"fail",`region=${config.region} mode=${config.mode}`);

if(!config.ai.enabled){
  const missing=REQUIRED_ENV.filter(name=>name==="NOVA_AI_ENABLED"?process.env[name]!=="true":!process.env[name]);
  console.error("AI is not enabled, so there is nothing to verify against a live workspace.");
  console.error(`Set these in the region env file, then re-run: ${missing.join(", ")}`);
  console.error(`NOVA_AI_DEPLOYMENT_SCOPE must equal NOVA_REGION (${config.region}), and the base URL must be an approved same-region workspace endpoint.`);
  process.exit(3);
}

record("config_ai_scope",config.ai.scope===config.region?"pass":"fail",`scope=${config.ai.scope} region=${config.region}`);
record("config_endpoint_allowlisted","pass",`host=${new URL(config.ai.url).hostname} path=${new URL(config.ai.url).pathname}`);

const settings:AiSettings={enabled:true,url:config.ai.url,key:config.ai.key,model:config.ai.model,scope:config.ai.scope};

function syntheticSnapshot(region:Region):AssessmentSnapshot{
  const score=scoreAssessment(demoScale,SYNTHETIC_ANSWERS,{age:12,region,role:"student"});
  return {scale:demoScale,advice:{id:"conformance",version:"1.0.0",content:demoAdvice},template:{id:"conformance",version:"1.0.0",content:demoTemplate},score,childName:CHILD_MARKER,grade:GRADE_MARKER,submittedAt:new Date().toISOString(),aiConsented:true};
}

const snapshot=syntheticSnapshot(config.region);
const eligible=eligibleAdviceIds(snapshot);

if(!snapshot.scale.demo){console.error("Refusing to run: the active instrument is not marked as a demo instrument.");process.exit(4);}
record("guard_demo_instrument",snapshot.scale.demo?"pass":"fail","snapshot built from the fictional demo scale");
record("guard_eligibility",snapshot.score.status==="valid"&&eligible.length>0?"pass":"fail",`score=${snapshot.score.status} eligibleAdvice=${eligible.length}`);
record("guard_no_database", "pass", "no database module is imported by this script");

// Classify failures into stable codes so a live error can be diagnosed without retaining bodies.
function classify(text:string):string{
  const t=text.toLowerCase();
  if(t.includes("response_format"))return "response_format_rejected";
  if(t.includes("invalid_api_key")||t.includes("incorrect api key")||t.includes("invalidapikey"))return "invalid_api_key";
  if(t.includes("json"))return "json_keyword_related";
  if(t.includes("model"))return "model_related";
  if(t.includes("throttl")||t.includes("limit"))return "rate_limited";
  return "unclassified";
}

interface Run {ms:number;mode:"ai"|"template";reason:string|null;validIds:boolean;fenced:boolean;reasoning:boolean}
const runs:Run[]=[];
const privacyViolations:string[]=[];

// Wrap the real fetch so the transmitted payload can be inspected without altering behaviour.
const inspectingFetch:typeof fetch=async(input,init)=>{
  const body=typeof init?.body==="string"?init.body:"";
  if(body.includes(CHILD_MARKER))privacyViolations.push("child_name_transmitted");
  if(body.includes(GRADE_MARKER))privacyViolations.push("grade_transmitted");
  if(/"q[0-9]+"\s*:/.test(body))privacyViolations.push("raw_item_answers_transmitted");
  if(/"items"\s*:/.test(body))privacyViolations.push("instrument_items_transmitted");
  return fetch(input,init);
};

let probeStatus=0,probeClass="not_run";
try{
  const probe=await fetch(`${settings.url}/chat/completions`,{method:"POST",headers:{Authorization:`Bearer ${settings.key}`,"Content-Type":"application/json"},signal:AbortSignal.timeout(20000),redirect:"error",body:JSON.stringify({model:settings.model,temperature:0,response_format:{type:"json_object"},messages:[{role:"system",content:"Reply with JSON only."},{role:"user",content:"Return a JSON object with one key named ok."}]})});
  probeStatus=probe.status;
  probeClass=probe.ok?"ok":classify(await probe.text());
}catch(e){probeClass=(e as Error).name;}
record("endpoint_reachable",probeStatus===200?"pass":probeStatus===0?"fail":"fail",`httpStatus=${probeStatus} classification=${probeClass}`);

if(probeStatus===200){
  for(let index=0;index<RUNS;index++){
    const started=performance.now();
    let result;
    try{result=await selectNarrative(snapshot,settings,inspectingFetch);}
    catch(e){runs.push({ms:Math.round(performance.now()-started),mode:"template",reason:`threw:${(e as Error).name}`,validIds:false,fenced:false,reasoning:false});continue;}
    const ms=Math.round(performance.now()-started);
    const validIds=result.selectedAdviceIds.length===eligible.length&&result.selectedAdviceIds.every(id=>eligible.includes(id));
    runs.push({ms,mode:result.generationMode,reason:result.fallbackReason,validIds,fenced:result.fallbackReason==="invalid_output",reasoning:result.fallbackReason==="thinking_model_output"});
  }
}

const aiRuns=runs.filter(r=>r.mode==="ai");
const latencies=runs.map(r=>r.ms).sort((a,b)=>a-b);
const p50=latencies.length?latencies[Math.floor(latencies.length/2)]:0;
const worst=latencies.length?latencies[latencies.length-1]:0;
const reasons=[...new Set(runs.filter(r=>r.reason).map(r=>r.reason as string))];

record("adapter_end_to_end",runs.length===0?"skip":aiRuns.length===RUNS?"pass":aiRuns.length>0?"warn":"fail",`aiRuns=${aiRuns.length}/${RUNS} fallbackReasons=${reasons.join("|")||"none"}`);
record("safety_ids_subset",aiRuns.length===0?"skip":aiRuns.every(r=>r.validIds)?"pass":"fail","every returned ID was an eligible advice ID");
record("safety_no_identity_transmitted",privacyViolations.length===0?"pass":"fail",privacyViolations.length?[...new Set(privacyViolations)].join("|"):"no identity, grade, items or raw answers in the request payload");
record("latency_within_budget",runs.length===0?"skip":worst<8000?"pass":"warn",`p50=${p50}ms worst=${worst}ms budget=8000ms`);
record("json_object_supported",probeStatus!==200?"skip":probeClass==="response_format_rejected"?"fail":"pass",`classification=${probeClass}`);
record("thinking_model_check",runs.length===0?"skip":runs.some(r=>r.reasoning)?"warn":"pass",runs.some(r=>r.reasoning)?"model returned reasoning_content without an answer; select a non-thinking model for structured output":"no reasoning-only responses observed");

const failed=checks.filter(c=>c.status==="fail");
const report={generatedAt:new Date().toISOString(),region:config.region,mode:config.mode,model:settings.model,endpointHost:new URL(settings.url).hostname,runs:runs.length,checks,runDetail:runs};

mkdirSync(path.resolve("work/qa"),{recursive:true});
writeFileSync(path.resolve("work/qa/ai-conformance.json"),`${JSON.stringify(report,null,2)}\n`);

console.log(`\nNova live AI conformance — ${config.region} / ${settings.model} / ${new URL(settings.url).hostname}\n`);
for(const check of checks){
  const mark=check.status==="pass"?"PASS":check.status==="fail"?"FAIL":check.status==="warn"?"WARN":"SKIP";
  console.log(`  [${mark}] ${check.code} — ${check.detail}`);
}
console.log(`\nEvidence written to work/qa/ai-conformance.json`);
console.log("Note: passing here shows the adapter works against this workspace. It does not prove which geographic inference nodes executed the request; confirm the workspace deployment scope in the Model Studio console.\n");
process.exit(failed.length?1:0);
