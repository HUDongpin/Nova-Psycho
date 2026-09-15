import {describe,it,expect} from "vitest";
import type {AssessmentSnapshot} from "../src/domain/types";
import {demoScale,demoAdvice,demoTemplate} from "../src/domain/demo";
import {scoreAssessment} from "../src/domain/scoring";
import {eligibleAdviceIds,modelInput,selectNarrative,unwrapJson} from "../src/domain/narrative";
const answers={q1:1,q2:2,q3:1,q4:2,q5:1,q6:2,q7:1,q8:2,q9:0};
function snapshot():AssessmentSnapshot{return {scale:demoScale,score:scoreAssessment(demoScale,answers,{age:12,role:"student",region:"CN"}),advice:{id:"advice",version:"1.0.0",content:demoAdvice},template:{id:"template",version:"1.0.0",content:demoTemplate},childName:"PRIVATE_NAME_123",grade:"PRIVATE_SCHOOL_GRADE",submittedAt:"2026-09-10T00:00:00Z",aiConsented:true};}
const settings={enabled:true,url:"https://example.invalid/compatible-mode/v1",key:"synthetic-test-key",model:"test-model",scope:"CN"};
const reply=(content:unknown)=>(async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(content)}}]}),{status:200})) as typeof fetch;
describe("constrained narrative and failover",()=>{
  it("never sends identity, grade, raw answers, or free text to a model",()=>{
    const s=snapshot();const body=JSON.stringify(modelInput(s));expect(body).not.toContain(s.childName);expect(body).not.toContain(s.grade);expect(body).not.toContain('"q1"');expect(body).not.toContain('"items"');
  });
  it("accepts ordering of only existing compatible advice IDs",async()=>{
    const s=snapshot(),ids=eligibleAdviceIds(s).reverse();const r=await selectNarrative(s,settings,reply({adviceIds:ids}));expect(r.generationMode).toBe("ai");expect(r.selectedAdviceIds).toEqual(ids);
  });
  it.each([{adviceIds:["diagnosis"]},{adviceIds:["listen"],diagnosis:"depression"},{adviceIds:["listen","listen"]},"I diagnosed the child"])("falls back on unsafe or malformed output",async output=>{
    const r=await selectNarrative(snapshot(),settings,reply(output));expect(r.generationMode).toBe("template");expect(r.selectedAdviceIds).toEqual(eligibleAdviceIds(snapshot()));
  });
  it("uses a complete template after network failure",async()=>{
    const r=await selectNarrative(snapshot(),settings,async()=>{throw new Error("network");});expect(r.generationMode).toBe("template");expect(r.selectedAdviceIds.length).toBeGreaterThan(0);
  });
  it("does not call AI for risk, missing consent or wrong region",async()=>{
    for(const s of [{...snapshot(),aiConsented:false},{...snapshot(),score:{...snapshot().score,risk:true}}]){
      let called=false;const r=await selectNarrative(s,settings,async()=>{called=true;throw new Error();});expect(called).toBe(false);expect(r.generationMode).toBe("template");
    }
    expect((await selectNarrative(snapshot(),{...settings,scope:"HK"})).fallbackReason).toBe("region_mismatch");
  });
});
// Behaviour confirmed against the Model Studio (Bailian) documentation rather than a live
// call. These cases encode the provider behaviours the adapter has to survive.
describe("adapter robustness against documented provider behaviour",()=>{
  const capture=()=>{
    const calls:{url:string;body:string}[]=[];
    const fetcher=(async(input:RequestInfo|URL,init?:RequestInit)=>{
      calls.push({url:String(input),body:String(init?.body??"")});
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({adviceIds:eligibleAdviceIds(snapshot())})}}]}),{status:200});
    }) as typeof fetch;
    return {calls,fetcher};
  };
  const respond=(content:string)=>(async()=>new Response(JSON.stringify({choices:[{message:{content}}]}),{status:200})) as typeof fetch;
  it("requests JSON object mode and satisfies the mandatory JSON keyword",async()=>{
    const {calls,fetcher}=capture();await selectNarrative(snapshot(),settings,fetcher);
    const body=JSON.parse(calls[0].body);
    expect(body.response_format).toEqual({type:"json_object"});
    expect(calls[0].url).toBe(`${settings.url}/chat/completions`);
    expect((body.messages as {content:string}[]).some(message=>message.content.includes("JSON"))).toBe(true);
  });
  it("sends no token cap, which the provider documents as truncating structured output",async()=>{
    const {calls,fetcher}=capture();await selectNarrative(snapshot(),settings,fetcher);
    const body=JSON.parse(calls[0].body);
    expect(body.max_tokens).toBeUndefined();expect(body.max_completion_tokens).toBeUndefined();
  });
  it("recovers JSON fenced by a model that accepted response_format but ignored it",async()=>{
    const ids=eligibleAdviceIds(snapshot());
    const r=await selectNarrative(snapshot(),settings,respond(`\`\`\`json\n${JSON.stringify({adviceIds:ids})}\n\`\`\``));
    expect(r.generationMode).toBe("ai");expect(r.selectedAdviceIds).toEqual(ids);
  });
  it("distinguishes a reasoning-only reply from a transport failure",async()=>{
    const reasoningOnly=(async()=>new Response(JSON.stringify({choices:[{message:{content:"",reasoning_content:"thinking"}}]}),{status:200})) as typeof fetch;
    expect((await selectNarrative(snapshot(),settings,reasoningOnly)).fallbackReason).toBe("thinking_model_output");
  });
  it.each([
    ["truncated JSON",'{"adviceIds":["listen"'],
    ["non-JSON envelope","<html>bad gateway</html>"],
    ["empty answer",""]
  ])("classifies %s as invalid output, not a provider outage",async(_label,content)=>{
    expect((await selectNarrative(snapshot(),settings,respond(content))).fallbackReason).toBe("invalid_output");
  });
  it("leaves fenced and unfenced payloads equivalent",()=>{
    expect(unwrapJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(unwrapJson('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(unwrapJson('{"a":1}')).toBe('{"a":1}');
  });
});
