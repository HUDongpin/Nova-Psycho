import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextResponse } from "next/server";
import type { Actor, Role } from "../domain/types";
import { getConfig } from "./config";
import { query,transaction } from "./db";
import { HttpError } from "./http";
const scrypt=promisify(scryptCallback);
export const hashToken=(token:string)=>createHash("sha256").update(token).digest("hex");
export async function hashPassword(password:string):Promise<string>{
  const salt=randomBytes(16).toString("hex");const derived=await scrypt(password,salt,64) as Buffer;return `${salt}:${derived.toString("hex")}`;
}
export async function checkPassword(password:string,stored:string|null):Promise<boolean>{
  const [salt,key]=(stored??"00000000000000000000000000000000:"+"00".repeat(64)).split(":");
  const derived=await scrypt(password,salt,64) as Buffer;
  const expected=Buffer.from(key??"","hex");
  return Boolean(stored)&&expected.length===derived.length&&timingSafeEqual(expected,derived);
}
export function cookieName():string{return `nova_${getConfig().region.toLowerCase()}_session`;}
function sessionToken(request:Request):string|null{
  const target=`${cookieName()}=`;const raw=request.headers.get("cookie")?.split(";").map(v=>v.trim()).find(v=>v.startsWith(target))?.slice(target.length);
  return raw&&/^[a-f0-9]{96}$/.test(raw)?raw:null;
}
export async function actorOf(request:Request,required=true):Promise<Actor|null>{
  const token=sessionToken(request);let actor:Actor|null=null;
  if(token){
    const rows=await query<{id:string;name:string;role:Role;region:Actor["region"]}>("SELECT u.id,u.name,u.role,u.region FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.region=$2 AND u.region=$2 AND s.expires_at>now() AND NOT u.disabled AND ($3::boolean OR NOT u.demo)",[hashToken(token),getConfig().region,getConfig().mode==="demo"]);
    actor=rows[0]??null;
  }
  if(!actor&&required)throw new HttpError(401,"请先登录。","UNAUTHENTICATED");
  return actor;
}
export async function requireActor(request:Request):Promise<Actor>{return (await actorOf(request,true))!;}
function setSessionCookie(response:NextResponse,token:string):void{
  response.cookies.set(cookieName(),token,{httpOnly:true,secure:getConfig().mode==="service",sameSite:"lax",path:"/",maxAge:43200});
}
export async function setSession(response:NextResponse,userId:string):Promise<void>{
  const config=getConfig(),token=randomBytes(48).toString("hex");
  const created=await query("INSERT INTO sessions(token_hash,user_id,region,expires_at) SELECT $1,id,$3,now()+interval '12 hours' FROM users WHERE id=$2 AND region=$3 AND NOT disabled RETURNING token_hash",[hashToken(token),userId,config.region]);
  if(!created[0])throw new HttpError(410,"账号已撤销，请联系服务人员。","ACCOUNT_REVOKED");
  setSessionCookie(response,token);
}
export async function setPasswordSession(response:NextResponse,username:string,password:string):Promise<void>{
  const config=getConfig();
  const rows=await query<{id:string;password_hash:string|null}>("SELECT id,password_hash FROM users WHERE username=$1 AND region=$2 AND NOT disabled AND ($3::boolean OR NOT demo)",[username,config.region,config.mode==="demo"]);
  const candidate=rows[0];
  // Keep expensive password verification outside the transaction, including the
  // dummy hash for an unknown account. Only its verified credential can log in.
  const verified=await checkPassword(password,candidate?.password_hash??null);
  if(!verified||!candidate)throw new HttpError(401,"账号或密码不正确。","INVALID_CREDENTIALS");
  const token=randomBytes(48).toString("hex");
  await transaction(async client=>{
    // Recovery locks the user before changing credentials and deleting sessions.
    // Take the same lock, then use a NEW statement snapshot after any lock wait.
    const locked=await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE",[candidate.id]);
    if(!locked.rows[0])throw new HttpError(401,"账号或密码不正确。","INVALID_CREDENTIALS");
    const current=await client.query("SELECT password_hash FROM users WHERE id=$1 AND region=$2 AND NOT disabled AND ($3::boolean OR NOT demo)",[candidate.id,config.region,config.mode==="demo"]);
    if(current.rows[0]?.password_hash!==candidate.password_hash)throw new HttpError(401,"账号或密码不正确。","INVALID_CREDENTIALS");
    await client.query("INSERT INTO sessions(token_hash,user_id,region,expires_at) VALUES($1,$2,$3,now()+interval '12 hours')",[hashToken(token),candidate.id,config.region]);
  });
  setSessionCookie(response,token);
}
export async function endSession(request:Request,response:NextResponse):Promise<void>{
  const token=sessionToken(request);if(token)await query("DELETE FROM sessions WHERE token_hash=$1 AND region=$2",[hashToken(token),getConfig().region]);
  response.cookies.set(cookieName(),"",{httpOnly:true,secure:getConfig().mode==="service",sameSite:"lax",path:"/",maxAge:0});
}
export async function limitLogin(username:string):Promise<void>{
  for(const [key,limit] of [[`user:${username.toLowerCase()}`,8],["global",300]] as const){
    const rows=await query<{attempts:number}>(`INSERT INTO login_attempts(key_hash,attempts,window_started) VALUES($1,1,now()) ON CONFLICT(key_hash) DO UPDATE SET attempts=CASE WHEN login_attempts.window_started<now()-interval '15 minutes' THEN 1 ELSE login_attempts.attempts+1 END,window_started=CASE WHEN login_attempts.window_started<now()-interval '15 minutes' THEN now() ELSE login_attempts.window_started END RETURNING attempts`,[hashToken(key)]);
    if(rows[0].attempts>limit)throw new HttpError(429,"尝试次数过多，请稍后再试。","RATE_LIMITED");
  }
}
export async function audit(actor:Actor|null,action:string,entityId:string|null=null):Promise<void>{
  await query("INSERT INTO audit_events(region,actor_id,action,entity_id) VALUES($1,$2,$3,$4)",[getConfig().region,actor?.id??null,action,entityId]);
}
export type AuditEventRow = { id: string; action: string; entity_id: string | null; created_at: Date | string };
export async function listAuditEvents(region: "CN" | "HK"): Promise<AuditEventRow[]>{
  return query<AuditEventRow>("SELECT id,action,entity_id,created_at FROM audit_events WHERE region=$1 ORDER BY id DESC LIMIT 500",[region]);
}
