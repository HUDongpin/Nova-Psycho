import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getConfig } from "./config";
import type { Locale, Role } from "../domain/types";
export class HttpError extends Error{constructor(public status:number,message:string,public code="REQUEST_FAILED"){super(message);}}
export function localeOf(request:Request):Locale{return new URL(request.url).searchParams.get("locale")==="zh-HK"?"zh-HK":"zh-CN";}
export function json(value:unknown,status=200):NextResponse{return NextResponse.json(value,{status,headers:{"Cache-Control":"no-store"}});}
export async function body(request:Request):Promise<unknown>{
  if(!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))throw new HttpError(415,"请使用 JSON 格式提交。","CONTENT_TYPE");
  if(Number(request.headers.get("content-length")??0)>600000)throw new HttpError(413,"提交内容过大。","PAYLOAD_SIZE");
  const reader=request.body?.getReader();if(!reader)throw new HttpError(400,"缺少提交内容。","INVALID_JSON");
  const chunks:Uint8Array[]=[];let length=0;
  while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>600000){await reader.cancel();throw new HttpError(413,"提交内容过大。","PAYLOAD_SIZE");}chunks.push(value);}
  try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new HttpError(400,"JSON 格式有误。","INVALID_JSON");}
}
export function checkOrigin(request:Request):void{
  if(request.headers.get("origin")!==getConfig().publicUrl)throw new HttpError(403,"请求来源不被允许。","ORIGIN_DENIED");
}
export function requireRole(actual:Role,allowed:Role[]):void{if(!allowed.includes(actual))throw new HttpError(403,"您没有执行此操作的权限。","ROLE_DENIED");}
export function validateId(id:string):string{if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new HttpError(404,"未找到该记录。","NOT_FOUND");return id;}
export async function handle(fn:()=>Promise<Response>):Promise<Response>{
  try{return await fn();}catch(e){
    if(e instanceof HttpError)return json({error:e.message,code:e.code},e.status);
    if(e instanceof ZodError)return json({error:"输入不符合要求，请检查必填项和格式。",code:"VALIDATION_FAILED"},422);
    if(e instanceof Error&&"code"in e&&e.code==="23505")return json({error:"该记录已存在，请刷新后重试。",code:"ALREADY_EXISTS"},409);
    // Log only a stable error class, never SQL, parameters, request bodies, or provider responses.
    console.error("nova_request_failed",e instanceof Error?e.name:"UnknownError");
    return json({error:"暂时无法完成操作，请稍后重试。",code:"INTERNAL_ERROR"},500);
  }
}
