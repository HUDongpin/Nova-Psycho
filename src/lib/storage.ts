import { createCipheriv,createDecipheriv,randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getConfig } from "./config";
function location(key:string):string{
  if(!/^[0-9a-f-]{36}\.[0-9a-f-]{36}\.zh-(CN|HK)\.pdf\.enc$/.test(key))throw new Error("Invalid private report key");
  return path.join(getConfig().reportDir,key);
}
export async function writePrivatePdf(key:string,pdf:Buffer):Promise<void>{
  const config=getConfig();await fs.mkdir(config.reportDir,{recursive:true,mode:0o700});
  const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",config.reportKey,nonce);
  const encrypted=Buffer.concat([cipher.update(pdf),cipher.final()]);
  const file=Buffer.concat([Buffer.from("NOVA1"),nonce,cipher.getAuthTag(),encrypted]);
  const dest=location(key),temp=`${dest}.${randomBytes(8).toString("hex")}.tmp`;
  try{await fs.writeFile(temp,file,{mode:0o600});await fs.rename(temp,dest);}catch(e){await fs.rm(temp,{force:true}).catch(()=>{});throw e;}
}
export async function readPrivatePdf(key:string):Promise<Buffer>{
  const file=await fs.readFile(location(key));
  if(file.subarray(0,5).toString()!=="NOVA1")throw new Error("Invalid encrypted report");
  const decipher=createDecipheriv("aes-256-gcm",getConfig().reportKey,file.subarray(5,17));decipher.setAuthTag(file.subarray(17,33));return Buffer.concat([decipher.update(file.subarray(33)),decipher.final()]);
}
export async function removePrivatePdf(key:string):Promise<void>{await fs.rm(location(key),{force:true});}
export async function listPrivatePdfKeys():Promise<string[]>{
  try{return (await fs.readdir(getConfig().reportDir)).filter(k=>/^[0-9a-f-]{36}\.[0-9a-f-]{36}\.zh-(CN|HK)\.pdf\.enc$/.test(k));}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return [];throw e;}
}
