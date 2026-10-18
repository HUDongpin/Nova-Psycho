import { describe, it, expect } from "vitest";
import { scoreAssessment, compareResults, ScoringError } from "../src/domain/scoring";
import { pair, scaleFixture } from "./fixtures";
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
  it("does not count a dimension whose only item is hidden by showIf as missing", () => {
    const scale = scaleFixture();
    scale.riskRules = [];
    scale.items = [
      { id: "gate", label: pair("gate"), choices: [0, 1].map(value => ({ value, label: pair(String(value)) })), reverse: false, required: true },
      { id: "only", label: pair("only"), choices: [0, 1, 2, 3].map(value => ({ value, label: pair(String(value)) })), reverse: false, required: true, showIf: { itemId: "gate", anyOf: [1] } }
    ];
    scale.dimensions = [{ key: "only", label: pair("only"), items: ["only"], aggregation: "sum", maxMissing: 0, prorate: false, higherMeans: "more_support", bands: [] }];
    const hidden = scoreAssessment(scale, { gate: 0 }, ctx);
    expect(hidden.dimensions[0]).toMatchObject({ raw: null, totalItems: 0, missing: [], answered: 0 });
    expect(hidden.reasons).not.toContain("dimension_items_missing");
    expect(hidden.status).toBe("valid");
    const shown = scoreAssessment(scale, { gate: 1 }, ctx);
    expect(shown.dimensions[0].missing).toEqual(["only"]);
    expect(shown.reasons).toContain("dimension_items_missing");
  });
});
