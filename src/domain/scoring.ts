import type { Comparison, DimensionScore, Region, RespondentRole, ScaleDefinition, ScoreResult } from "./types";
export class ScoringError extends Error {}
export function validateAnswers(scale: ScaleDefinition, answers: Record<string, unknown>): asserts answers is Record<string, number> {
  if (!answers || Array.isArray(answers) || typeof answers !== "object") throw new ScoringError("Answers must be an object");
  const items=new Map(scale.items.map(item=>[item.id,item]));
  for(const [id,value] of Object.entries(answers)) {
    const item=items.get(id);
    if(!item || typeof value!=="number" || !Number.isFinite(value) || !item.choices.some(c=>c.value===value)) {
      throw new ScoringError("Unknown item or invalid response value");
    }
  }
}
export function scoreAssessment(scale: ScaleDefinition, answers: Record<string, unknown>, context: {age:number; region:Region; role:RespondentRole}): ScoreResult {
  validateAnswers(scale,answers);
  const reasons:string[]=[];
  if(!Number.isInteger(context.age)||context.age<scale.minAge||context.age>scale.maxAge) reasons.push("instrument_age");
  if(context.age<scale.norm.minAge||context.age>scale.norm.maxAge) reasons.push("norm_age");
  if(!scale.regions.includes(context.region)||!scale.norm.regions.includes(context.region)) reasons.push("region");
  if(!scale.roles.includes(context.role)) reasons.push("respondent_role");
  const riskMessages=scale.riskRules.filter(rule=>rule.values.includes(answers[rule.itemId])).map(rule=>rule.message);
  const base={scaleId:scale.id,scaleVersion:scale.version,respondentRole:context.role,region:context.region,age:context.age,demo:scale.demo,norm:structuredClone(scale.norm),risk:riskMessages.length>0,riskMessages};
  if(reasons.length) return {...base,status:"ineligible",reasons,dimensions:[]};
  const items=new Map(scale.items.map(item=>[item.id,item]));
  const dimensions:DimensionScore[]=scale.dimensions.map(d=>{
    const selected=d.items.map(id=>items.get(id)!);
    const missing=selected.filter(i=>answers[i.id]===undefined).map(i=>i.id);
    const answered=selected.filter(i=>answers[i.id]!==undefined);
    const min=selected.reduce((n,i)=>n+Math.min(...i.choices.map(c=>c.value)),0)/(d.aggregation==="mean"?selected.length:1);
    const max=selected.reduce((n,i)=>n+Math.max(...i.choices.map(c=>c.value)),0)/(d.aggregation==="mean"?selected.length:1);
    let raw:number|null=null;
    if(answered.length>0 && missing.length<=d.maxMissing) {
      let sum=answered.reduce((n,i)=>{
        const value=answers[i.id];
        return n+(i.reverse?Math.min(...i.choices.map(c=>c.value))+Math.max(...i.choices.map(c=>c.value))-value:value);
      },0);
      if(d.aggregation==="mean") sum/=answered.length;
      else if(d.prorate && missing.length>0) sum*=selected.length/answered.length;
      raw=Math.round(sum*1e6)/1e6;
    }
    const band=raw===null?null:[...d.bands].sort((a,b)=>b.minimum-a.minimum).find(b=>raw!>=b.minimum)??null;
    return {key:d.key,label:d.label,raw,min,max,answered:answered.length,totalItems:selected.length,missing,prorated:raw!==null&&missing.length>0&&d.prorate,band,higherMeans:d.higherMeans};
  });
  const requiredMissing=scale.items.filter(i=>i.required&&answers[i.id]===undefined);
  if(requiredMissing.length) reasons.push("required_items_missing");
  if(dimensions.some(d=>d.raw===null)) reasons.push("dimension_items_missing");
  return {...base,status:reasons.length?"incomplete":"valid",reasons,dimensions};
}
export function compareResults(current: ScoreResult, previous: ScoreResult | null, previousDate?:string, sameRespondent = true): Comparison {
  if(!previous) return {available:false,reason:"first_assessment"};
  if(!sameRespondent || current.respondentRole!==previous.respondentRole) return {available:false,reason:"different_respondent"};
  if(current.scaleId!==previous.scaleId||current.scaleVersion!==previous.scaleVersion||current.region!==previous.region||JSON.stringify(current.norm)!==JSON.stringify(previous.norm)) return {available:false,reason:"incompatible_version"};
  if(current.status!=="valid"||previous.status!=="valid") return {available:false,reason:"incomplete"};
  const changes=current.dimensions.flatMap(d=>{
    const p=previous.dimensions.find(v=>v.key===d.key);
    return p?.raw!==null && p?.raw!==undefined && d.raw!==null ? [{key:d.key,label:d.label,delta:Math.round((d.raw-p.raw)*1e6)/1e6,higherMeans:d.higherMeans}]:[];
  });
  return changes.length===current.dimensions.length?{available:true,previousDate,changes}:{available:false,reason:"incompatible_version"};
}
