import { createCipheriv,createDecipheriv,randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import { getConfig } from "./config";
import { query,transaction } from "./db";
import { tryAcquireSharedReportRetentionLock,assertPrivatePdfKey,PRIVATE_PDF_KEY_PATTERN,privatePdfPath } from "./report-retention";
export const MAX_PRIVATE_PDF_BYTES=4*1024*1024;
const UUID_PATTERN="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PRIVATE_PDF_TEMP_PATTERN=new RegExp(`^(${UUID_PATTERN})\\.(${UUID_PATTERN})\\.zh-(?:CN|HK)\\.pdf\\.enc\\.[0-9a-f]{16}\\.tmp$`);
const PRIVATE_PDF_TEMP_GRACE_MS=24*60*60*1000;
function location(key:string):string{
  return privatePdfPath(getConfig().reportDir,key);
}
export async function writePrivatePdf(key:string,pdf:Buffer,client?:PoolClient,reportJobId?:string):Promise<void>{
  assertPrivatePdfKey(key);
  const config=getConfig();
  if((config.reportStorage==="database"&&pdf.length>MAX_PRIVATE_PDF_BYTES)||pdf.subarray(0,4).toString()!=="%PDF")throw new Error("Invalid or oversized private PDF");
  const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",config.reportKey,nonce);
  const encrypted=Buffer.concat([cipher.update(pdf),cipher.final()]);
  const file=Buffer.concat([Buffer.from("NOVA1"),nonce,cipher.getAuthTag(),encrypted]);
  if(config.reportStorage==="database"){
    if(!client)throw new Error("Database PDFs must be stored inside report publication");
    if(reportJobId&&key.slice(0,36)!==reportJobId)throw new Error("Private PDF job identity mismatch");
    const inserted=reportJobId?await client.query(`INSERT INTO report_files(file_key,report_id,family_id,region,locale,encrypted_body)
      SELECT $1,j.id,a.family_id,a.region,$3,$4 FROM report_jobs j JOIN assessments a ON a.id=j.assessment_id
      WHERE j.id=$2 AND a.region=$5 AND j.report_version IS NOT NULL RETURNING file_key`,
      [key,reportJobId,key.endsWith(".zh-CN.pdf.enc")?"zh-CN":"zh-HK",file,config.region]):await client.query(`INSERT INTO report_files(file_key,report_id,family_id,region,locale,encrypted_body)
      SELECT $1,id,family_id,region,$3,$4 FROM assessments WHERE id=$2 AND region=$5 RETURNING file_key`,
    [key,key.slice(0,36),key.endsWith(".zh-CN.pdf.enc")?"zh-CN":"zh-HK",file,config.region]);
    if(inserted.rows.length!==1)throw new Error("Private PDF owner is unavailable");
    return;
  }
  await fs.mkdir(config.reportDir,{recursive:true,mode:0o700});
  const dest=location(key),temp=`${dest}.${randomBytes(8).toString("hex")}.tmp`;
  try{await fs.writeFile(temp,file,{mode:0o600});await fs.rename(temp,dest);}catch(e){await fs.rm(temp,{force:true}).catch(()=>{});throw e;}
}
export async function readPrivatePdf(key:string):Promise<Buffer>{
  assertPrivatePdfKey(key);
  const config=getConfig();
  const file=config.reportStorage==="database"
    ?(await query<{encrypted_body:Buffer}>("SELECT encrypted_body FROM report_files WHERE file_key=$1 AND region=$2",[key,config.region]))[0]?.encrypted_body
    :await fs.readFile(location(key));
  if(!file||file.length<37||(config.reportStorage==="database"&&file.length>MAX_PRIVATE_PDF_BYTES+33)||file.subarray(0,5).toString()!=="NOVA1")throw new Error("Invalid encrypted report");
  const decipher=createDecipheriv("aes-256-gcm",getConfig().reportKey,file.subarray(5,17));decipher.setAuthTag(file.subarray(17,33));return Buffer.concat([decipher.update(file.subarray(33)),decipher.final()]);
}
export async function removePrivatePdf(key:string):Promise<"done"|"busy">{
  assertPrivatePdfKey(key);
  if(getConfig().reportStorage==="database"){
    await query("DELETE FROM report_files WHERE file_key=$1 AND region=$2",[key,getConfig().region]);
    return "done";
  }
  const dest=location(key);
  return transaction(async client=>{
    if(!await tryAcquireSharedReportRetentionLock(client))return "busy";
    await fs.rm(dest,{force:true});
    return "done";
  });
}
export async function listPrivatePdfKeys():Promise<string[]>{
  if(getConfig().reportStorage==="database")return (await query<{file_key:string}>("SELECT file_key FROM report_files WHERE region=$1",[getConfig().region])).map(row=>row.file_key);
  try{return (await fs.readdir(getConfig().reportDir)).filter(k=>PRIVATE_PDF_KEY_PATTERN.test(k));}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return [];throw e;}
}
export async function cleanAbandonedPrivatePdfTemps():Promise<void>{
  const config=getConfig();if(config.reportStorage==="database")return;
  const names=await fs.readdir(config.reportDir).catch(error=>{if((error as NodeJS.ErrnoException).code==="ENOENT")return [];throw error;});
  for(const name of names){
    const matched=PRIVATE_PDF_TEMP_PATTERN.exec(name);if(!matched)continue;
    const filename=path.join(config.reportDir,name);
    const stats=await fs.lstat(filename).catch(error=>{if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;});
    if(!stats?.isFile()||Date.now()-stats.mtimeMs<PRIVATE_PDF_TEMP_GRACE_MS)continue;
    const running=await query<{claim_token:string|null}>(`SELECT j.claim_token FROM report_jobs j JOIN assessments a ON a.id=j.assessment_id
      WHERE (j.assessment_id=$1 OR j.id=$1) AND a.region=$2 AND j.state='running'`,[matched[1],config.region]);
    if(running.some(job=>job.claim_token===matched[2]))continue;
    await fs.rm(filename,{force:true});
  }
}
