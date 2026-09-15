import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {PoolClient} from "pg";
import type { Actor, AdviceLibrary, ContentSnapshot, ReportTemplate, ScaleDefinition } from "../domain/types";
import { ensureAdviceReferences,parseAdvice,parseScale,parseTemplate } from "../domain/validation";
import { audit } from "./auth";
import { query,transaction } from "./db";
import { HttpError,requireRole } from "./http";
export async function currentContent<T=AdviceLibrary|ReportTemplate>(kind:"advice"|"template",client?:PoolClient):Promise<ContentSnapshot<T>>{
  const sql="SELECT id,version,content FROM content_versions WHERE kind=$1 ORDER BY created_at DESC,id DESC LIMIT 1";
  const r=client?(await client.query(sql,[kind])).rows:await query(sql,[kind]);
  if(!r[0])throw new HttpError(409,"请先配置报告内容。","CONTENT_NOT_CONFIGURED");
  return {id:r[0].id,version:r[0].version,content:r[0].content as T};
}
// Serialize content/scale publication and assignment so an in-flight assignment cannot lose its advice dependency.
export async function lockContent(client:PoolClient):Promise<void>{await client.query("SELECT pg_advisory_xact_lock(742681,1)");}
export async function getScale(id:string,client?:PoolClient):Promise<{id:string;definition:ScaleDefinition;status:string}>{
  const sql="SELECT id,definition,status FROM scales WHERE id=$1";
  const r=client?(await client.query(sql,[id])).rows:await query(sql,[id]);if(!r[0])throw new HttpError(404,"未找到量表版本。","SCALE_NOT_FOUND");return r[0] as {id:string;definition:ScaleDefinition;status:string};
}
export async function importScale(actor:Actor,input:unknown){
  requireRole(actor.role,["admin"]);const {definition}=z.object({definition:z.unknown()}).strict().parse(input);const d=parseScale(definition);
  if(!d.regions.includes(actor.region))throw new HttpError(422,"该量表不适用于当前服务地区。","SCALE_REGION");
  const id=`${d.id}@${d.version}`;
  await transaction(async client=>{
    await lockContent(client);const advice=await currentContent<AdviceLibrary>("advice",client);
    try{ensureAdviceReferences(d,advice.content);}catch{throw new HttpError(422,"量表引用的建议不存在，或与测评维度不匹配。","ADVICE_MISMATCH");}
    await client.query("INSERT INTO scales(id,scale_id,version,definition) VALUES($1,$2,$3,$4)",[id,d.id,d.version,JSON.stringify(d)]);
  });await audit(actor,"scale.imported",id);return {id};
}
export async function setScaleStatus(actor:Actor,id:string,input:unknown){
  requireRole(actor.role,["admin"]);const {status}=z.object({status:z.enum(["active","retired"])}).strict().parse(input);
  await transaction(async client=>{
    await lockContent(client);const scale=await getScale(id,client);
    if(status==="active"){
      const advice=await currentContent<AdviceLibrary>("advice",client);
      try{ensureAdviceReferences(scale.definition,advice.content);}catch{throw new HttpError(422,"请先恢复该量表需要的建议，再启用此版本。","ADVICE_MISMATCH");}
    }
    await client.query("UPDATE scales SET status=$1 WHERE id=$2",[status,id]);
  });await audit(actor,"scale.status_changed",id);return {ok:true};
}
export async function createContent(actor:Actor,kind:"advice"|"template",input:unknown){
  requireRole(actor.role,["admin"]);const d=z.object({version:z.string().regex(/^\d+\.\d+\.\d+$/),content:z.unknown()}).strict().parse(input);
  const content=kind==="advice"?parseAdvice(d.content):parseTemplate(d.content);
  const id=randomUUID();
  await transaction(async client=>{
    await lockContent(client);
    if(kind==="advice"){
      const scales=await client.query("SELECT s.definition FROM scales s WHERE s.status='active' OR EXISTS(SELECT 1 FROM assessments a WHERE a.scale_version_id=s.id AND a.status='pending')");
      try{for(const s of scales.rows)ensureAdviceReferences(s.definition,content as AdviceLibrary);}catch{throw new HttpError(422,"新的建议库必须保留启用中量表和未完成测评需要的建议。","ADVICE_MISMATCH");}
    }
    await client.query("INSERT INTO content_versions(id,kind,version,content) VALUES($1,$2,$3,$4)",[id,kind,d.version,JSON.stringify(content)]);
  });await audit(actor,`${kind}.version_created`,id);return {id};
}
