import {describe,it,expect} from "vitest";
import {demoScale,demoAdvice,demoTemplate} from "../src/domain/demo";
import {triadScales} from "../src/domain/triad-scales";
import {instrumentWriteBlockReason,ensureAdviceReferences,parseAdvice,parseScale,parseTemplate} from "../src/domain/validation";
describe("versioned instrument ingestion",()=>{
  it("accepts the explicitly synthetic instrument and content",()=>{expect(parseScale(demoScale).demo).toBe(true);parseAdvice(demoAdvice);parseTemplate(demoTemplate);ensureAdviceReferences(demoScale,demoAdvice);});
  it("rejects a non-demo instrument whose norm is not validated",()=>{
    expect(()=>parseScale({...demoScale,demo:false})).toThrow(/Unvalidated instruments must be labelled demo/);
    expect(()=>parseScale({
      ...demoScale,
      demo:false,
      rights:{digital:true,commercial:true,reference:"operator-managed acquisition"},
      norm:{...demoScale.norm,validated:false},
    })).toThrow(/Unvalidated instruments must be labelled demo/);
  });
  it("accepts a non-demo instrument once its norm is validated, without treating rights flags as blockers",()=>{
    const scale=parseScale({
      ...demoScale,
      demo:false,
      rights:{digital:false,commercial:false,reference:"operator-managed acquisition"},
      norm:{...demoScale.norm,validated:true},
    });
    expect(scale.demo).toBe(false);
    expect(scale.norm.validated).toBe(true);
    expect(scale.rights.digital).toBe(false);
    expect(scale.rights.commercial).toBe(false);
  });
  it("keeps an unvalidated demo instrument importable",()=>{
    const scale=parseScale({...demoScale,demo:true,norm:{...demoScale.norm,validated:false}});
    expect(scale.demo).toBe(true);
    expect(scale.norm.validated).toBe(false);
  });
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


describe("instrument write admission",()=>{
  it.each(triadScales)("allows the known non-clinical triad $id@$version in service mode without changing its labels",scale=>{
    const original=structuredClone(scale);
    expect(instrumentWriteBlockReason(scale,"service")).toBeNull();
    expect(instrumentWriteBlockReason({...scale,demo:true},"service")).toBeNull();
    expect(scale).toEqual(original);
    expect(scale.norm.validated).toBe(false);
  });
  it.each([
    {...triadScales[0],bundle:undefined},
    {...triadScales[0],bundle:"unknown-bundle"},
    {...triadScales[0],id:"unknown-child"},
    {...triadScales[0],version:"99.0.0"},
    {...demoScale,bundle:"growth-triad"},
  ])("does not approve an unrelated or unknown triad identity %#",scale=>{
    expect(instrumentWriteBlockReason(scale,"service")).toBe("UNVALIDATED_INSTRUMENT");
  });
  it.each([
    ["service",false,false,"UNVALIDATED_INSTRUMENT"],
    ["service",true,false,"UNVALIDATED_INSTRUMENT"],
    ["service",true,true,"DEMO_INSTRUMENT"],
    ["service",false,true,null],
    ["demo",true,false,null],
    ["demo",false,false,null],
  ] as const)("uses mode=%s demo=%s validated=%s",(mode,demo,validated,reason)=>{
    expect(instrumentWriteBlockReason({demo,norm:{validated}},mode)).toBe(reason);
  });
  it("fails closed for missing validation metadata in service mode",()=>{
    expect(instrumentWriteBlockReason({demo:false},"service")).toBe("UNVALIDATED_INSTRUMENT");
  });
});
