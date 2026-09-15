import {describe,it,expect} from "vitest";
import {demoScale,demoAdvice,demoTemplate} from "../src/domain/demo";
import {ensureAdviceReferences,parseAdvice,parseScale,parseTemplate} from "../src/domain/validation";
describe("versioned instrument ingestion",()=>{
  it("accepts the explicitly synthetic instrument and content",()=>{expect(parseScale(demoScale).demo).toBe(true);parseAdvice(demoAdvice);parseTemplate(demoTemplate);ensureAdviceReferences(demoScale,demoAdvice);});
  it("rejects service instruments without confirmed rights or applicable norms",()=>{expect(()=>parseScale({...demoScale,demo:false})).toThrow();});
  it("rejects references to missing or repeated items",()=>{const s=structuredClone(demoScale);s.dimensions[0].items=["unknown"];expect(()=>parseScale(s)).toThrow();s.dimensions[0].items=["q1","q1"];expect(()=>parseScale(s)).toThrow();});
  it("rejects unsupported band boundaries, risks and ambiguous formula fields",()=>{
    const a=structuredClone(demoScale);a.dimensions[0].bands[0].minimum=1;expect(()=>parseScale(a)).toThrow();
    const b=structuredClone(demoScale);b.riskRules[0].values=[99];expect(()=>parseScale(b)).toThrow();
    expect(()=>parseScale({...demoScale,sql_scoring_formula:"SELECT secret"})).toThrow();
  });
  it("prevents advice from an unrelated dimension being attached",()=>{const s=structuredClone(demoScale);s.dimensions[0].bands[0].adviceIds=["routine"];expect(()=>ensureAdviceReferences(s,demoAdvice)).toThrow();});
  it("rejects unequal item ranges when a partial mean could exceed the full-scale maximum",()=>{
    const s=structuredClone(demoScale);s.dimensions[0].aggregation="mean";s.dimensions[0].items=["q1","q2"];s.dimensions[0].maxMissing=1;
    s.items[0].choices=s.items[0].choices.slice(0,2);s.items[1].choices=[{value:0,label:{"zh-CN":"0","zh-HK":"0"}},{value:100,label:{"zh-CN":"100","zh-HK":"100"}}];
    expect(()=>parseScale(s)).toThrow();
  });
});
