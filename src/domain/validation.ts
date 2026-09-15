import { z } from "zod";
import type { AdviceLibrary, ReportTemplate, ScaleDefinition } from "./types";
const key=z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).refine(v=>!["constructor","prototype"].includes(v));
const localized=z.object({"zh-CN":z.string().trim().min(1).max(4000),"zh-HK":z.string().trim().min(1).max(4000)}).strict();
const roles=z.enum(["student","parent","teacher"]);
const regions=z.enum(["CN","HK"]);
const item=z.object({id:key,label:localized,observerLabel:localized.optional(),choices:z.array(z.object({value:z.number().int().min(-100).max(100),label:localized}).strict()).min(2).max(20),reverse:z.boolean(),required:z.boolean()}).strict();
const band=z.object({minimum:z.number().finite(),key,label:localized,explanation:localized,adviceIds:z.array(key).max(12)}).strict();
export const scaleSchema=z.object({
  id:key,version:z.string().regex(/^\d+\.\d+\.\d+$/),title:localized,description:localized,demo:z.boolean(),source:z.string().trim().min(1).max(1000),
  rights:z.object({digital:z.boolean(),commercial:z.boolean(),reference:z.string().trim().min(1).max(1000)}).strict(),
  minAge:z.number().int().min(3).max(25),maxAge:z.number().int().min(3).max(25),regions:z.array(regions).min(1).max(2),roles:z.array(roles).min(1).max(3),retakeDays:z.number().int().min(0).max(730),
  norm:z.object({label:localized,source:z.string().trim().min(1).max(1000),regions:z.array(regions).min(1).max(2),minAge:z.number().int().min(3).max(25),maxAge:z.number().int().min(3).max(25),validated:z.boolean()}).strict(),
  items:z.array(item).min(1).max(300),
  dimensions:z.array(z.object({key,label:localized,items:z.array(key).min(1).max(300),aggregation:z.enum(["sum","mean"]),maxMissing:z.number().int().min(0).max(299),prorate:z.boolean(),higherMeans:z.enum(["more_support","more_strength"]),bands:z.array(band).max(20)}).strict()).min(1).max(40),
  riskRules:z.array(z.object({itemId:key,values:z.array(z.number().int()).min(1).max(20),message:localized}).strict()).max(30)
}).strict().superRefine((s,ctx)=>{
  const fail=(message:string)=>ctx.addIssue({code:"custom",message});
  if(s.minAge>s.maxAge||s.norm.minAge>s.norm.maxAge)fail("Age interval is invalid");
  if(s.norm.minAge>s.minAge||s.norm.maxAge<s.maxAge)fail("Norm age interval must cover the instrument");
  if(s.regions.some(r=>!s.norm.regions.includes(r)))fail("Norm region must cover the instrument");
  if(!s.demo && (!s.rights.digital||!s.rights.commercial||!s.norm.validated))fail("Service instruments require electronic/commercial permission and verified applicable norms");
  if(new Set(s.items.map(i=>i.id)).size!==s.items.length)fail("Item IDs must be unique");
  if(new Set(s.dimensions.map(d=>d.key)).size!==s.dimensions.length)fail("Dimension IDs must be unique");
  for(const i of s.items)if(new Set(i.choices.map(c=>c.value)).size!==i.choices.length)fail("Choice values must be unique");
  const items=new Map(s.items.map(i=>[i.id,i]));
  for(const d of s.dimensions){
    if(d.items.some(id=>!items.has(id)))fail("Dimension refers to an unknown item");
    if(new Set(d.items).size!==d.items.length)fail("Dimension contains duplicate items");
    if(d.maxMissing>=d.items.length)fail("Every dimension must require at least one answer");
    if(d.aggregation==="mean"&&d.prorate)fail("Mean aggregation does not require prorating");
    if(new Set(d.bands.map(b=>b.minimum)).size!==d.bands.length)fail("Band boundaries must be unique");
    if(new Set(d.bands.map(b=>b.key)).size!==d.bands.length)fail("Band IDs must be unique");
    const ranges=d.items.map(id=>items.get(id)).filter(Boolean).map(i=>[Math.min(...i!.choices.map(c=>c.value)),Math.max(...i!.choices.map(c=>c.value))]);
    const minimum=ranges.reduce((n,r)=>n+r[0],0)/(d.aggregation==="mean"?ranges.length:1);
    const maximum=ranges.reduce((n,r)=>n+r[1],0)/(d.aggregation==="mean"?ranges.length:1);
    if(d.bands.length && (Math.min(...d.bands.map(b=>b.minimum))!==minimum || d.bands.some(b=>b.minimum<minimum||b.minimum>maximum)))fail("Bands must start at the minimum score and remain in range");
    if((d.prorate||(d.aggregation==="mean"&&d.maxMissing>0))&&ranges.some(r=>r[0]!==ranges[0]?.[0]||r[1]!==ranges[0]?.[1]))fail("Partial mean/prorating requires equal item ranges");
    if(d.aggregation==="sum"&&d.maxMissing>0&&!d.prorate&&ranges.some(r=>r[0]!==0))fail("Partial unadjusted sums require zero-based items");
  }
  for(const rule of s.riskRules){const i=items.get(rule.itemId);if(!i||rule.values.some(v=>!i.choices.some(c=>c.value===v)))fail("Risk rule refers to an unknown item or response");}
});
export const adviceSchema=z.object({title:localized,blocks:z.array(z.object({id:key,title:localized,body:localized,source:z.string().trim().min(1).max(1000),dimensionKeys:z.array(key).max(40)}).strict()).min(1).max(100)}).strict().superRefine((s,ctx)=>{
  if(new Set(s.blocks.map(b=>b.id)).size!==s.blocks.length)ctx.addIssue({code:"custom",message:"Advice IDs must be unique"});
});
export const templateSchema=z.object({title:localized,introduction:localized,limitation:localized,nextStep:localized}).strict();
export function parseScale(value:unknown):ScaleDefinition{return scaleSchema.parse(value);}
export function parseAdvice(value:unknown):AdviceLibrary{return adviceSchema.parse(value);}
export function parseTemplate(value:unknown):ReportTemplate{return templateSchema.parse(value);}
export function ensureAdviceReferences(scale:ScaleDefinition,library:AdviceLibrary):void{
  const available=new Map(library.blocks.map(b=>[b.id,b]));
  for(const dimension of scale.dimensions)for(const band of dimension.bands)for(const id of band.adviceIds){
    const block=available.get(id);
    if(!block||!block.dimensionKeys.includes(dimension.key))throw new Error("Advice references do not match the scale dimensions");
  }
}
