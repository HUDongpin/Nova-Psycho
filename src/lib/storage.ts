import { createCipheriv,createDecipheriv,randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import type { PoolClient } from "pg";
import { getConfig } from "./config";
import { query,transaction } from "./db";
import { acquireSharedReportRetentionLock,assertPrivatePdfKey,PRIVATE_PDF_KEY_PATTERN,privatePdfPath } from "./report-retention";
export const MAX_PRIVATE_PDF_BYTES=4*1024*1024;
function location(key:string):string{
  return privatePdfPath(getConfig().reportDir,key);
}
export async function writePrivatePdf(key:string,pdf:Buffer,client?:PoolClient):Promise<void>{
  assertPrivatePdfKey(key);
  const config=getConfig();
  if((config.reportStorage==="database"&&pdf.length>MAX_PRIVATE_PDF_BYTES)||pdf.subarray(0,4).toString()!=="%PDF")throw new Error("Invalid or oversized private PDF");
  const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",config.reportKey,nonce);
  const encrypted=Buffer.concat([cipher.update(pdf),cipher.final()]);
  const file=Buffer.concat([Buffer.from("NOVA1"),nonce,cipher.getAuthTag(),encrypted]);
  if(config.reportStorage==="database"){
    if(!client)throw new Error("Database PDFs must be stored inside report publication");
    const inserted=await client.query(`INSERT INTO report_files(file_key,report_id,family_id,region,locale,encrypted_body)
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
export async function removePrivatePdf(key:string):Promise<void>{
  assertPrivatePdfKey(key);
  if(getConfig().reportStorage==="database"){
    await query("DELETE FROM report_files WHERE file_key=$1 AND region=$2",[key,getConfig().region]);
    return;
  }
  const dest=location(key);
  await transaction(async client=>{
    await acquireSharedReportRetentionLock(client);
    await fs.rm(dest,{force:true});
  });
}
export async function listPrivatePdfKeys():Promise<string[]>{
  if(getConfig().reportStorage==="database")return (await query<{file_key:string}>("SELECT file_key FROM report_files WHERE region=$1",[getConfig().region])).map(row=>row.file_key);
  try{return (await fs.readdir(getConfig().reportDir)).filter(k=>PRIVATE_PDF_KEY_PATTERN.test(k));}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return [];throw e;}
}
