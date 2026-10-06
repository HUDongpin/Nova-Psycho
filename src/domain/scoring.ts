import type { Comparison, DimensionScore, Region, RespondentRole, ScaleDefinition, ScaleItem, ScoreResult, StoredAnswer } from "./types";
export class ScoringError extends Error {}
const kindOf=(item:ScaleItem)=>item.kind??"single";
export function answerVisible(answers:Record<string,unknown>,item:ScaleItem):boolean{
  if(!item.showIf)return true;
  const current=answers[item.showIf.itemId];
  const values=typeof current==="number"?[current]:Array.isArray(current)?current.filter((value):value is number=>typeof value==="number"):[];
  return item.showIf.anyOf.some(value=>values.includes(value));
}
function usableRange(item:ScaleItem):[number,number]{
  const usable=item.choices.filter(choice=>!item.excludeValues?.includes(choice.value));
  return [Math.min(...usable.map(choice=>choice.value)),Math.max(...usable.map(choice=>choice.value))];
}
function numericScore(item:ScaleItem,answers:Record<string,StoredAnswer>):number|undefined{
  const value=answers[item.id];
  if(typeof value!=="number"||item.excludeValues?.includes(value))return undefined;
  return value;
}
export function validateAnswers(scale: ScaleDefinition, answers: Record<string, unknown>): asserts answers is Record<string, StoredAnswer> {
  if (!answers || Array.isArray(answers) || typeof answers !== "object") throw new ScoringError("Answers must be an object");
  const items=new Map(scale.items.map(item=>[item.id,item]));
  for(const [id,value] of Object.entries(answers)) {
    const item=items.get(id);
    if(!item) throw new ScoringError("Unknown item or invalid response value");
    const kind=kindOf(item);
    const single=kind==="single"&&typeof value==="number"&&Number.isFinite(value)&&item.choices.some(choice=>choice.value===value);
    const multi=kind==="multi"&&Array.isArray(value)&&value.every(entry=>typeof entry==="number"&&item.choices.some(choice=>choice.value===entry))&&new Set(value).size===value.length&&value.length>0&&(!item.maxChoices||value.length<=item.maxChoices);
    const writing=kind==="text"&&typeof value==="string"&&value.trim().length>0&&value.length<=2000;
    if(!(single||multi||writing)) throw new ScoringError("Unknown item or invalid response value");
  }
}
export function scoreAssessment(scale: ScaleDefinition, answers: Record<string, unknown>, context: {age:number; region:Region; role:RespondentRole}): ScoreResult {
  validateAnswers(scale,answers);
  const reasons:string[]=[];
  if(!Number.isInteger(context.age)||context.age<scale.minAge||context.age>scale.maxAge) reasons.push("instrument_age");
  if(context.age<scale.norm.minAge||context.age>scale.norm.maxAge) reasons.push("norm_age");
  if(!scale.regions.includes(context.region)||!scale.norm.regions.includes(context.region)) reasons.push("region");
  if(!scale.roles.includes(context.role)) reasons.push("respondent_role");
  const riskMessages=scale.riskRules.filter(rule=>{
    const value=answers[rule.itemId];
    const selected=typeof value==="number"?[value]:Array.isArray(value)?value.filter((entry):entry is number=>typeof entry==="number"):[];
    return selected.some(entry=>rule.values.includes(entry));
  }).map(rule=>rule.message);
  const base={scaleId:scale.id,scaleVersion:scale.version,respondentRole:context.role,region:context.region,age:context.age,demo:scale.demo,norm:structuredClone(scale.norm),risk:riskMessages.length>0,riskMessages};
  if(reasons.length) return {...base,status:"ineligible",reasons,dimensions:[]};
  const items=new Map(scale.items.map(item=>[item.id,item]));
  const dimensions:DimensionScore[]=scale.dimensions.map(d=>{
    const selected=d.items.map(id=>items.get(id)!);
    const missing=selected.filter(i=>numericScore(i,answers)===undefined).map(i=>i.id);
    const answered=selected.filter(i=>numericScore(i,answers)!==undefined);
    const min=selected.reduce((n,i)=>n+usableRange(i)[0],0)/(d.aggregation==="mean"?selected.length:1);
    const max=selected.reduce((n,i)=>n+usableRange(i)[1],0)/(d.aggregation==="mean"?selected.length:1);
    let raw:number|null=null;
    if(answered.length>0 && missing.length<=d.maxMissing) {
      let sum=answered.reduce((n,i)=>{
        const value=numericScore(i,answers)!;
        const [low,high]=usableRange(i);
        return n+(i.reverse?low+high-value:value);
      },0);
      if(d.aggregation==="mean") sum/=answered.length;
      else if(d.prorate && missing.length>0) sum*=selected.length/answered.length;
      raw=Math.round(sum*1e6)/1e6;
    }
    const band=raw===null?null:[...d.bands].sort((a,b)=>b.minimum-a.minimum).find(b=>raw!>=b.minimum)??null;
    return {key:d.key,label:d.label,raw,min,max,answered:answered.length,totalItems:selected.length,missing,prorated:raw!==null&&missing.length>0&&d.prorate,band,higherMeans:d.higherMeans};
  });
  const requiredMissing=scale.items.filter(i=>{
    if(!i.required||!answerVisible(answers,i))return false;
    const value=answers[i.id];
    if(kindOf(i)==="text")return typeof value!=="string"||value.trim().length===0;
    if(kindOf(i)==="multi")return !Array.isArray(value)||value.length===0;
    return typeof value!=="number";
  });
  if(requiredMissing.length) reasons.push("required_items_missing");
  if(dimensions.some(d=>d.raw===null&&!scale.dimensions.find(source=>source.key===d.key)?.optional)) reasons.push("dimension_items_missing");
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
