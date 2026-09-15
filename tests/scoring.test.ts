import { describe, it, expect } from "vitest";
import { scoreAssessment, compareResults, ScoringError } from "../src/domain/scoring";
import { scaleFixture } from "./fixtures";
const ctx = {age:12,region:"CN" as const,role:"student" as const};
describe("authoritative scoring", () => {
  it("uses item reverse scoring and threshold minimum exactly", () => {
    const r=scoreAssessment(scaleFixture(),{a:3,b:2,c:0},ctx);
    expect(r.status).toBe("valid"); expect(r.dimensions[0].raw).toBe(4); expect(r.dimensions[0].band?.key).toBe("high");
  });
  it("does not turn missing answers into zero", () => {
    const r=scoreAssessment(scaleFixture(),{a:1,c:0},ctx);
    expect(r.status).toBe("incomplete"); expect(r.dimensions[0].raw).toBeNull(); expect(r.dimensions[0].missing).toEqual(["b"]);
  });
  it("only prorates when explicitly authorized by that dimension", () => {
    const s=scaleFixture();s.dimensions[0].maxMissing=1;s.dimensions[0].prorate=true;
    const r=scoreAssessment(s,{a:2,c:0},ctx);expect(r.dimensions[0].raw).toBe(4);expect(r.dimensions[0].prorated).toBe(true);
  });
  it("does not invent a score when every dimension item is missing", () => {
    const s=scaleFixture();s.dimensions[0].maxMissing=2;s.dimensions[0].prorate=true;
    expect(scoreAssessment(s,{c:0},ctx).dimensions[0].raw).toBeNull();
  });
  it.each([-1,4,1.5,"2",null,true])("rejects a malformed response %s", value => {
    expect(()=>scoreAssessment(scaleFixture(),{a:value,b:0,c:0},ctx)).toThrow(ScoringError);
  });
  it("rejects injected scores and unknown items",()=>{
    expect(()=>scoreAssessment(scaleFixture(),{a:0,b:0,c:0,total:0},ctx)).toThrow(ScoringError);
  });
  it("returns an ineligible result rather than applying out-of-age norms",()=>{
    const r=scoreAssessment(scaleFixture(),{a:1,b:1,c:0},{...ctx,age:5});expect(r.status).toBe("ineligible");expect(r.dimensions).toEqual([]);
  });
  it("requires both instrument and norm region eligibility",()=>{
    const s=scaleFixture();s.norm.regions=["HK"];
    expect(scoreAssessment(s,{a:1,b:1,c:0},ctx).status).toBe("ineligible");
  });
  it("keeps risk flags even when dimensional answers are incomplete",()=>{
    const r=scoreAssessment(scaleFixture(),{c:3},ctx);expect(r.risk).toBe(true);expect(r.status).toBe("incomplete");
  });
  it("does not compare parents and children or incompatible versions",()=>{
    const a=scoreAssessment(scaleFixture(),{a:3,b:0,c:0},ctx);
    const b=scoreAssessment(scaleFixture(),{a:0,b:3,c:0},{...ctx,role:"parent"});
    expect(compareResults(a,b).available).toBe(false);
    expect(compareResults(a,{...a,scaleVersion:"2.0.0"}).reason).toBe("incompatible_version");
    expect(compareResults(a,a,undefined,false).reason).toBe("different_respondent");
  });
  it("compares only raw score changes for the same instrument and respondent",()=>{
    const current=scoreAssessment(scaleFixture(),{a:0,b:3,c:0},ctx);
    const prior=scoreAssessment(scaleFixture(),{a:3,b:0,c:0},ctx);
    expect(compareResults(current,prior,"2026-08-01").changes?.[0].delta).toBe(-6);
  });
});
