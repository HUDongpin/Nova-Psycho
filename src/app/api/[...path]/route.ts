import { z } from "zod";
import { demoScale } from "@/domain/demo";
import { actorOf,audit,checkPassword,endSession,limitLogin,requireActor,setSession } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { query } from "@/lib/db";
import { body,checkOrigin,handle,HttpError,json,localeOf,requireRole } from "@/lib/http";
import { privacyNotice } from "@/lib/privacy";
import { opsStatus } from "@/lib/ops";
import { acceptRecovery, createRecovery, recoveryInfo } from "@/lib/recovery";
import { workspaceFor } from "@/lib/workspace";
import { acceptInvitation,createFamily,createInvitation,deleteFamily,invitationInfo,recordConsent } from "@/lib/families";
import { assessmentDetail,createAssessment,retryReport,saveDraft,submitAssessment } from "@/lib/assessments";
import { reportDetail,reportFor } from "@/lib/reports";
import { readPrivatePdf } from "@/lib/storage";
import { addGoal,addObservation,updateGoal } from "@/lib/care";
import { createContent,currentContent,importScale,setScaleStatus } from "@/lib/content";
export const runtime="nodejs";
export const dynamic="force-dynamic";
type Context={params:Promise<{path:string[]}>};
async function dispatch(request:Request,context:Context):Promise<Response>{return handle(async()=>{
  const {path}=await context.params;const route=path.join("/"),method=request.method,locale=localeOf(request),config=getConfig();
  if(!["GET","HEAD"].includes(method))checkOrigin(request);
  if(method==="GET"&&route==="health"){
    const r=await query("SELECT region FROM deployment_settings");return json({ok:r[0]?.region===config.region,region:config.region,mode:config.mode});
  }
  if(method==="GET"&&route==="session"){
    const user=await actorOf(request,false);const demoAccounts=config.mode==="demo"?await query("SELECT id,name,role FROM users WHERE demo AND region=$1 AND NOT disabled ORDER BY CASE role WHEN 'admin' THEN 1 WHEN 'staff' THEN 2 WHEN 'parent' THEN 3 WHEN 'student' THEN 4 ELSE 5 END,name",[config.region]):[];
    return json({user,region:config.region,mode:config.mode,demoAccounts,siblingUrl:config.siblingUrl});
  }
  if(method==="GET"&&route==="privacy")return json(privacyNotice(config.region,locale));
  if(method==="POST"&&route==="auth/demo"){
    if(config.mode!=="demo")throw new HttpError(404,"未找到该入口。","NOT_FOUND");
    const d=z.object({accountId:z.string().uuid()}).strict().parse(await body(request));const rows=await query("SELECT id FROM users WHERE id=$1 AND region=$2 AND demo AND NOT disabled",[d.accountId,config.region]);
    if(!rows[0])throw new HttpError(403,"演示账号不可用。","INVALID_DEMO_ACCOUNT");const response=json({ok:true});await setSession(response,rows[0].id);return response;
  }
  if(method==="POST"&&route==="auth/login"){
    const d=z.object({username:z.string().trim().toLowerCase().min(1).max(100),password:z.string().min(1).max(256)}).strict().parse(await body(request));await limitLogin(d.username);
    const rows=await query("SELECT id,password_hash FROM users WHERE username=$1 AND region=$2 AND NOT disabled AND ($3::boolean OR NOT demo)",[d.username,config.region,config.mode==="demo"]);
    if(!await checkPassword(d.password,rows[0]?.password_hash??null))throw new HttpError(401,"账号或密码不正确。","INVALID_CREDENTIALS");
    const response=json({ok:true});await setSession(response,rows[0].id);return response;
  }
  if(method==="POST"&&route==="auth/logout"){const response=json({ok:true});await endSession(request,response);return response;}
  if(method==="GET"&&route==="invite")return json(await invitationInfo(request.headers.get("x-invitation-token")??new URL(request.url).searchParams.get("token")));
  if(method==="POST"&&route==="invite"){const id=await acceptInvitation(await body(request));const response=json({ok:true});await setSession(response,id);return response;}
  // Recovery links are unauthenticated, like invitations, but deliberately do not
  // create a session: the account holder signs in with the new password afterwards.
  if(method==="GET"&&route==="recovery")return json(await recoveryInfo(request.headers.get("x-recovery-token")??new URL(request.url).searchParams.get("token")));
  if(method==="POST"&&route==="recovery")return json(await acceptRecovery(await body(request)));
  const actor=await requireActor(request);
  if(method==="GET"&&route==="workspace")return json(await workspaceFor(actor,locale));
  if(method==="POST"&&route==="families")return json(await createFamily(actor,await body(request)),201);
  if(path[0]==="families"&&path[1]){
    if(method==="POST"&&path.length===3&&path[2]==="consent")return json(await recordConsent(actor,path[1],await body(request)));
    if(method==="POST"&&path.length===3&&path[2]==="invites")return json(await createInvitation(actor,path[1],await body(request)),201);
    if(method==="DELETE"&&path.length===2)return json(await deleteFamily(actor,path[1],await body(request)));
  }
  if(method==="POST"&&route==="assessments")return json(await createAssessment(actor,await body(request)),201);
  if(method==="POST"&&path[0]==="users"&&path[1]&&path.length===3&&path[2]==="recovery")return json(await createRecovery(actor,path[1]),201);
  if(path[0]==="assessments"&&path[1]){
    if(method==="GET"&&path.length===2)return json(await assessmentDetail(actor,path[1],locale));
    if(method==="PATCH"&&path.length===2)return json(await saveDraft(actor,path[1],await body(request)));
    if(method==="POST"&&path.length===3&&path[2]==="submit")return json(await submitAssessment(actor,path[1],await body(request)));
    if(method==="POST"&&path.length===3&&path[2]==="retry-report")return json(await retryReport(actor,path[1]));
  }
  if(method==="GET"&&path[0]==="reports"&&path[1]&&path.length<=3){
    const report=await reportFor(actor,path[1]);
    if(path.length===2){await audit(actor,"report.viewed",report.id);return json(reportDetail(report,locale));}
    if(path[2]==="document")return new Response(report.html_documents[locale],{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'"}});
    if(path[2]==="pdf"){
      const pdf=await readPrivatePdf(report.pdf_keys[locale]);await audit(actor,"report.downloaded",report.id);
      return new Response(new Uint8Array(pdf),{headers:{"Content-Type":"application/pdf","Cache-Control":"no-store","Content-Disposition":`attachment; filename="Nova-${report.id.slice(0,8)}-${locale}.pdf"`}});
    }
  }
  if(method==="POST"&&route==="goals")return json(await addGoal(actor,await body(request)),201);
  if(method==="PATCH"&&path[0]==="goals"&&path.length===2)return json(await updateGoal(actor,path[1],await body(request)));
  if(method==="POST"&&route==="observations")return json(await addObservation(actor,await body(request)),201);
  if(method==="GET"&&route==="scales/example"){
    requireRole(actor.role,["admin"]);return new Response(JSON.stringify(demoScale,null,2),{headers:{"Content-Type":"application/json; charset=utf-8","Content-Disposition":"attachment; filename=nova-scale-example.json","Cache-Control":"no-store"}});
  }
  if(method==="POST"&&route==="scales")return json(await importScale(actor,await body(request)),201);
  if(method==="PATCH"&&path[0]==="scales"&&path.length===2)return json(await setScaleStatus(actor,path[1],await body(request)));
  if(path[0]==="content"&&path.length===2&&(path[1]==="advice"||path[1]==="template")){
    requireRole(actor.role,["admin"]);
    if(method==="GET")return json(await currentContent(path[1]));
    if(method==="POST")return json(await createContent(actor,path[1],await body(request)),201);
  }
  if(method==="GET"&&route==="audit"){
    requireRole(actor.role,["admin"]);return json(await query("SELECT id,action,entity_id,created_at FROM audit_events WHERE region=$1 ORDER BY id DESC LIMIT 500",[actor.region]));
  }
  if(method==="GET"&&route==="ops/status"){
    requireRole(actor.role,["admin"]);return json(await opsStatus());
  }
  throw new HttpError(404,"未找到该功能。","NOT_FOUND");
});}
export const GET=dispatch;export const POST=dispatch;export const PATCH=dispatch;export const DELETE=dispatch;
