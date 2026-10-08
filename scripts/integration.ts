import assert from "node:assert/strict";
import {createHash,randomBytes} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {Assessment,Locale,Report,Session,SurveyRecord,Workspace} from "../src/components/api";
import {demoScale} from "../src/domain/demo";
import {previewAnswers} from "../src/domain/triad-report";
import {childScale,parentScale,teacherScale} from "../src/domain/triad-scales";
import type {AdviceLibrary,ContentSnapshot,ReportTemplate,RespondentRole,ScaleDefinition,StoredAnswer} from "../src/domain/types";

type Client={base:string;cookie:string};
type Result={name:string;passed:boolean;durationMs:number;error?:string};
type Documents=Record<Locale,{html:string;pdfSha256:string}>;
type Triad={familyId:string;clients:Record<RespondentRole,Client>;tasks:Record<RespondentRole,Assessment>};
const results:Result[]=[];
const runId=`${new Date().toISOString().replace(/[:.]/g,"-")}-${randomBytes(4).toString("hex")}`;
const nonce=randomBytes(6).toString("hex");
const demoId="nova-family-demo@1.0.0";
const roles=["parent","student","teacher"] as const;
const definitions={parent:parentScale,student:childScale,teacher:teacherScale};
const outputDir=path.resolve(process.env.NOVA_INTEGRATION_OUTPUT_DIR??`work/qa/integration-${runId}`);
const outputRelative=path.relative(path.resolve("work"),outputDir);
assert.ok(outputRelative&&!outputRelative.startsWith("..")&&!path.isAbsolute(outputRelative),"Integration evidence must be stored inside work/");
await fs.mkdir(outputDir,{recursive:true});
const resultFile=path.join(outputDir,"api-integration-results.json");
// Claim this result file before any HTTP mutation; never replace another run's evidence.
await fs.writeFile(resultFile,"{}",{flag:"wx"});
const fixtures:{familyId:string;scenario:string;deleted:boolean}[]=[];
let completed=false;
let failure:string|undefined;

function localBase(value:string):string{
  const url=new URL(value);
  assert.ok(url.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(url.hostname)&&!url.username&&!url.password&&url.pathname==="/"&&!url.search&&!url.hash,"Integration URLs must be plain loopback HTTP origins");
  return url.origin;
}
async function request(c:Client,route:string,method="GET",data?:unknown,headers:Record<string,string>={}){
  assert.ok(route.startsWith("/api/")&&!route.includes("\\"),"Only local API routes are allowed");
  return fetch(localBase(c.base)+route,{method,redirect:"error",signal:AbortSignal.timeout(30000),headers:{...(c.cookie?{Cookie:c.cookie}:{}),...(method!=="GET"?{Origin:c.base}:{}),...(data===undefined?{}:{"Content-Type":"application/json"}),...headers},body:data===undefined?undefined:JSON.stringify(data)});
}
async function ok<T>(c:Client,route:string,method="GET",data?:unknown,headers:Record<string,string>={}):Promise<T>{
  const response=await request(c,route,method,data,headers);
  if(!response.ok){const error=await response.json().catch(()=>null);assert.fail(`${method} ${route.split("?")[0]} returned ${response.status} (${typeof error?.code==="string"?error.code:"no error code"})`);}
  return response.json() as Promise<T>;
}
async function rejected(c:Client,route:string,method:string,data:unknown,status:number,code:string,headers:Record<string,string>={}){
  const response=await request(c,route,method,data,headers);
  assert.equal(response.status,status,`${method} ${route.split("?")[0]} must reject with ${code}`);
  const error=await response.json() as {code?:string};assert.equal(error.code,code);
}
function sessionClient(base:string,response:Response):Client{
  const cookie=response.headers.get("set-cookie");assert.ok(cookie,"Authentication must return a session cookie");
  return {base,cookie:cookie.split(";")[0]};
}
async function login(base:string,role:string,name?:string):Promise<Client>{
  const visitor={base,cookie:""},session=await ok<Session>(visitor,"/api/session");
  assert.equal(session.mode,"demo","Integration suite only runs against explicit demo environments");
  const matches=session.demoAccounts.filter(account=>account.role===role&&(!name||account.name.includes(name)));
  assert.equal(matches.length,1,`Expected one named synthetic ${role} account`);
  const response=await request(visitor,"/api/auth/demo","POST",{accountId:matches[0].id});assert.equal(response.status,200);
  return sessionClient(base,response);
}
async function writeResults(){
  await fs.writeFile(resultFile,JSON.stringify({timestamp:new Date().toISOString(),runId,completed,passed:completed&&!failure,syntheticDataOnly:true,loopbackOnly:true,aiEnabled:false,regions:["CN","HK"],fixtures,results,...(failure?{failure}:{})},null,2));
}
async function check<T>(name:string,fn:()=>Promise<T>):Promise<T>{
  const start=Date.now();
  try{const value=await fn();results.push({name,passed:true,durationMs:Date.now()-start});console.log(`PASS ${name}`);return value;}
  catch(error){failure=error instanceof Error?error.message:"Unknown integration failure";results.push({name,passed:false,durationMs:Date.now()-start,error:failure});throw error;}
  finally{await writeResults();}
}
const workspace=(client:Client,locale:Locale="zh-CN")=>ok<Workspace>(client,`/api/workspace?locale=${locale}`);
const birthDateForAge=(age:number)=>`${new Date().getUTCFullYear()-age}-01-01`;
const sha256=(value:Buffer|string)=>createHash("sha256").update(value).digest("hex");
async function waitReport(client:Client,match:(report:Report)=>boolean,locale:Locale="zh-CN"):Promise<Report>{
  const deadline=Date.now()+90000;
  while(Date.now()<deadline){const found=(await workspace(client,locale)).reports.filter(match);if(found.length){assert.equal(found.length,1,"Exactly one report must match the fixed scenario");return found[0];}await new Promise(resolve=>setTimeout(resolve,1000));}
  assert.fail("Worker must automatically publish the expected report within 90 seconds");
}
async function documents(client:Client,reportId:string,prefix?:string):Promise<Documents>{
  const result={} as Documents;
  for(const locale of ["zh-CN","zh-HK"] as const){
    const response=await request(client,`/api/reports/${reportId}/document?locale=${locale}`);assert.equal(response.status,200);
    const html=await response.text();assert.match(html,/Nova|nova/);assert.ok(html.includes(`lang="${locale}"`));
    const pdf=await request(client,`/api/reports/${reportId}/pdf?locale=${locale}`);assert.equal(pdf.status,200);assert.match(pdf.headers.get("content-type")??"",/application\/pdf/);
    const bytes=Buffer.from(await pdf.arrayBuffer());assert.equal(bytes.subarray(0,4).toString(),"%PDF");assert.ok(bytes.length>1000);
    if(prefix){await fs.writeFile(path.join(outputDir,`${prefix}-${locale}.html`),html,{flag:"wx"});await fs.writeFile(path.join(outputDir,`${prefix}-${locale}.pdf`),bytes,{flag:"wx"});}
    result[locale]={html,pdfSha256:sha256(bytes)};
  }
  return result;
}
function familyTask(w:Workspace,familyId:string,role:RespondentRole,scaleId:string):Assessment{
  const tasks=w.assessments.filter(a=>a.familyId===familyId&&a.respondentRole===role&&a.scaleVersionId===scaleId);assert.equal(tasks.length,1);return tasks[0];
}
function triadAnswers(scale:ScaleDefinition,role:RespondentRole):Record<string,StoredAnswer>{
  const fixture=structuredClone(scale);
  for(const item of fixture.items)if(item.id==="c_age"||item.id==="p_age")item.choices=item.choices.filter(choice=>choice.value===12);
  const answers=previewAnswers(fixture,"risk");
  for(const item of scale.items)if(typeof answers[item.id]==="string")answers[item.id]=`${role==="student"?"STUDENT_PRIVATE":item.report==="staff"?"STAFF_PRIVATE":"ADULT_WORDS"}_${role}_${nonce}_${item.id}`;
  return answers;
}
async function registerTriad(base:string,locale:Locale):Promise<Triad>{
  const region=locale==="zh-CN"?"cn":"hk",visitor={base,cookie:""};
  const response=await request(visitor,`/api/triad/parent?locale=${locale}`,"POST",{parentName:"合成三方家长",username:`qa_triad_${region}_parent_${nonce}`,password:randomBytes(18).toString("base64url"),relationship:"母亲",childName:"合成三方孩子",birthDate:birthDateForAge(12),grade:"初中",accepted:true});assert.equal(response.status,201);
  const created=await response.json() as {familyId:string;userId:string;joinCode:string};fixtures.push({familyId:created.familyId,scenario:`triad-age-12-${region}`,deleted:false});
  const clients={parent:sessionClient(base,response)} as Record<RespondentRole,Client>;
  for(const role of ["student","teacher"] as const){const joined=await request(visitor,`/api/triad/join?locale=${locale}`,"POST",{code:created.joinCode,role,name:`合成三方${role}`,username:`qa_triad_${region}_${role}_${nonce}`,password:randomBytes(18).toString("base64url")});assert.equal(joined.status,201);clients[role]=sessionClient(base,joined);}
  const w=await workspace(clients.parent,locale);assert.equal(w.families.find(f=>f.id===created.familyId)?.age,12);
  const tasks={} as Record<RespondentRole,Assessment>;
  for(const role of roles){tasks[role]=familyTask(w,created.familyId,role,`${definitions[role].id}@1.0.0`);assert.equal(tasks[role].status,"pending");assert.equal(tasks[role].canRetryReport,false);assert.equal((await ok<SurveyRecord>(clients[role],`/api/assessments/${tasks[role].id}`)).demo,false);}
  return {familyId:created.familyId,clients,tasks};
}

async function main(){
  const {cn,hk,admin,parent,student,teacher,staff,otherStaff,hkAdmin,adminW,parentW,hkW}=await check("explicit local synthetic environments and fixed instruments",async()=>{
    assert.equal(process.env.NOVA_AI_ENABLED,"false","Run with NOVA_AI_ENABLED=false and AI disabled in both local services");
    const cn=localBase(process.env.NOVA_INTEGRATION_CN_URL??"http://127.0.0.1:3100"),hk=localBase(process.env.NOVA_INTEGRATION_HK_URL??"http://127.0.0.1:3101");assert.notEqual(cn,hk);
    const admin=await login(cn,"admin"),parent=await login(cn,"parent","林"),student=await login(cn,"student","林"),teacher=await login(cn,"teacher"),staff=await login(cn,"staff","陈"),otherStaff=await login(cn,"staff","何"),hkAdmin=await login(hk,"admin");
    const adminW=await workspace(admin),parentW=await workspace(parent),hkW=await workspace(hkAdmin,"zh-HK");
    for(const w of [adminW,hkW]){
      const demo=w.scales.find(scale=>scale.id===demoId);assert.ok(demo);assert.equal(demo.demo,true);assert.equal(demo.status,"active");assert.ok(demo.minAge<=7&&demo.maxAge>=7);assert.deepEqual([...demo.roles].sort(),["parent","student","teacher"]);
      for(const definition of Object.values(definitions)){const scale=w.scales.find(s=>s.id===`${definition.id}@1.0.0`);assert.ok(scale);assert.equal(scale.demo,false);assert.equal(scale.status,"active");assert.deepEqual(scale.roles,definition.roles);assert.ok(scale.minAge<=12&&scale.maxAge>=12);}
      assert.ok(!w.scales.some(scale=>!scale.demo&&scale.status==="active"&&scale.minAge<=7&&scale.maxAge>=7),"Seven-year-old demo scenario must remain outside active official instrument ages");
    }
    return {cn,hk,admin,parent,student,teacher,staff,otherStaff,hkAdmin,adminW,parentW,hkW};
  });
  const ownFamily=parentW.families.find(f=>f.members.some(member=>member.id===parentW.user.id));assert.ok(ownFamily);
  const other=adminW.families.find(f=>!parentW.families.some(p=>p.id===f.id));assert.ok(other);
  const staffId=(await workspace(staff)).user.id,otherStaffId=(await workspace(otherStaff)).user.id;
  await check("regional databases and sessions are independent",async()=>{
    assert.equal(hkW.region,"HK");assert.equal(adminW.region,"CN");assert.ok(hkW.families.every(f=>!adminW.families.some(c=>c.id===f.id)));
    await rejected({base:hk,cookie:parent.cookie.replace("nova_cn_session","nova_hk_session")},"/api/workspace","GET",undefined,401,"UNAUTHENTICATED");
    const forged=await ok<Workspace>(parent,"/api/workspace","GET",undefined,{"X-Nova-Role":"admin","X-Nova-Region":"HK"});assert.equal(forged.user.role,"parent");assert.equal(forged.region,"CN");
  });
  await check("parent/student/teacher/staff see only authorized scope",async()=>{
    assert.equal(parentW.families.length,1);assert.equal(parentW.observations.length,0);assert.equal(parentW.staff.length,0);assert.equal(parentW.staffNotes.length,0);
    const s=await workspace(student),t=await workspace(teacher),st=await workspace(staff);
    assert.equal(s.reports.length,0);assert.equal(t.reports.length,0);assert.equal(s.goals.length,0);assert.ok(s.assessments.every(a=>a.respondentId===s.user.id));assert.ok(t.assessments.every(a=>a.respondentId===t.user.id));
    assert.ok(st.families.every(f=>f.assignedTo===st.user.id||st.alerts.some(alert=>alert.familyId===f.id)),"Staff may see assigned families or families covered by the safety workflow");
    const ownStudentTask=adminW.assessments.find(a=>a.respondentRole==="student"&&a.familyId===ownFamily.id);assert.ok(ownStudentTask);
    await rejected(parent,`/api/assessments/${ownStudentTask.id}`,"GET",undefined,404,"NOT_FOUND");await rejected(student,"/api/families","POST",{},403,"ROLE_DENIED");
  });
  await check("cross-family data access and untrusted origins are rejected",async()=>{
    await rejected(parent,`/api/families/${other.id}/consent`,"POST",{accepted:true,guardianName:"合成家长"},404,"NOT_FOUND");
    await rejected(parent,"/api/goals","POST",{familyId:other.id,title:"不应写入",detail:""},404,"NOT_FOUND");
    await rejected(parent,"/api/goals","POST",{familyId:ownFamily.id,title:"不应写入",detail:""},403,"ORIGIN_DENIED",{Origin:"https://untrusted.invalid"});
  });
  const demoFamily=await check("family creation validates date and forbids client region reassignment",async()=>{
    const value={familyName:"自动化演示测试家庭",childName:"合成孩子",birthDate:"2014-02-30",grade:"小学二年级",guardianLabel:"母亲"};
    await rejected(admin,"/api/families","POST",value,422,"INVALID_BIRTHDATE");
    await rejected(admin,"/api/families","POST",{...value,birthDate:birthDateForAge(7),region:"HK"},422,"VALIDATION_FAILED");
    const f=await ok<{id:string}>(admin,"/api/families","POST",{...value,birthDate:birthDateForAge(7)});fixtures.push({familyId:f.id,scenario:"demo-age-7",deleted:false});
    assert.equal((await workspace(admin)).families.find(family=>family.id===f.id)?.age,7);return f;
  });
  const acceptedClients={} as Record<RespondentRole,Client>,acceptedIds={} as Record<RespondentRole,string>;
  await check("one-time invitations create bounded accounts and reject replay",async()=>{
    for(const role of roles){
      const inv=await ok<{url:string}>(admin,`/api/families/${demoFamily.id}/invites`,"POST",{role}),token=new URLSearchParams(new URL(inv.url).hash.slice(1)).get("token");assert.ok(token);
      const visitor={base:cn,cookie:""},info=await ok<{role:string}>(visitor,"/api/invite","GET",undefined,{"X-Invitation-Token":token});assert.equal(info.role,role);
      const payload={token,name:`合成${role}`,username:`qa_${role}_${nonce}`,password:randomBytes(18).toString("base64url")};
      const response=await request(visitor,"/api/invite","POST",payload);assert.equal(response.status,200);
      const client=sessionClient(cn,response);acceptedClients[role]=client;acceptedIds[role]=(await ok<Session>(client,"/api/session")).user!.id;
      const w=await workspace(client);assert.equal(w.families.length,1);assert.equal(w.families[0].id,demoFamily.id);assert.equal(w.user.role,role);
      await rejected(visitor,"/api/invite","POST",payload,404,"INVALID_INVITATION");
      if(role==="parent"){
        const oldCookie=client.cookie;await ok(client,"/api/auth/logout","POST",{});await rejected({base:cn,cookie:oldCookie},"/api/workspace","GET",undefined,401,"UNAUTHENTICATED");
        await rejected(visitor,"/api/auth/login","POST",{username:payload.username,password:"incorrect-synthetic-password"},401,"INVALID_CREDENTIALS");
        const signedIn=await request(visitor,"/api/auth/login","POST",{username:payload.username,password:payload.password});assert.equal(signedIn.status,200);client.cookie=sessionClient(cn,signedIn).cookie;
      }
    }
  });
  const child=acceptedClients.student,guardian=acceptedClients.parent;
  const a=await check("fixed demo instrument remains assignable in its own age scenario",()=>ok<{id:string}>(admin,"/api/assessments","POST",{familyId:demoFamily.id,respondentId:acceptedIds.student,scaleVersionId:demoId,locale:"zh-CN"}));
  let revision=0;
  await check("guardian consent is required before draft collection and submission",async()=>{
    const detail=await ok<SurveyRecord>(child,`/api/assessments/${a.id}`);assert.equal(detail.demo,true);assert.equal(detail.consentRequired,true);assert.deepEqual(detail.draftAnswers,{});assert.equal(detail.draftRevision,0);
    await rejected(child,`/api/assessments/${a.id}`,"PATCH",{answers:{q1:2},acknowledged:true,revision:0},409,"GUARDIAN_CONSENT_REQUIRED");
    await rejected(child,`/api/assessments/${a.id}/submit`,"POST",{answers:{q9:0},acknowledged:true,revision:0},409,"GUARDIAN_CONSENT_REQUIRED");
    await ok(guardian,`/api/families/${demoFamily.id}/consent`,"POST",{accepted:true,guardianName:"合成家长",aiProcessing:false});
  });
  await check("draft autosave persists and malformed/client scores are rejected",async()=>{
    await rejected(child,`/api/assessments/${a.id}`,"PATCH",{answers:{q1:2},revision:0},422,"VALIDATION_FAILED");
    await rejected(child,`/api/assessments/${a.id}`,"PATCH",{answers:{q1:2},acknowledged:false,revision:0},422,"VALIDATION_FAILED");
    const saved=await ok<{revision:number}>(child,`/api/assessments/${a.id}`,"PATCH",{answers:{q1:2,q2:3},acknowledged:true,revision:0});revision=saved.revision;assert.equal(revision,1);
    assert.deepEqual((await ok<SurveyRecord>(child,`/api/assessments/${a.id}`)).draftAnswers,{q1:2,q2:3});
    await rejected(child,`/api/assessments/${a.id}/submit`,"POST",{answers:{q1:2,total:99,q9:0},acknowledged:true,revision},422,"INVALID_ANSWERS");
    await rejected(child,`/api/assessments/${a.id}/submit`,"POST",{answers:{q1:"2",q9:0},acknowledged:true,revision},422,"INVALID_ANSWERS");
    await rejected(child,`/api/assessments/${a.id}/submit`,"POST",{answers:{q9:0},acknowledged:false,revision},422,"VALIDATION_FAILED");
  });
  await check("stale draft writes and stale final submissions cannot overwrite newer answers",async()=>{
    await rejected(child,`/api/assessments/${a.id}`,"PATCH",{answers:{q1:0},acknowledged:true,revision:0},409,"DRAFT_CONFLICT");
    await rejected(child,`/api/assessments/${a.id}/submit`,"POST",{answers:{q9:0},acknowledged:true,revision:0},409,"DRAFT_CONFLICT");
    assert.deepEqual((await ok<SurveyRecord>(child,`/api/assessments/${a.id}`)).draftAnswers,{q1:2,q2:3});
  });
  const fullDemo={q1:1,q2:2,q3:1,q4:2,q5:1,q6:2,q7:1,q8:2,q9:0},final={answers:fullDemo,acknowledged:true,revision};
  const report=await check("concurrent repeated submissions create one immutable assessment/report",async()=>{
    const responses=await Promise.all([request(child,`/api/assessments/${a.id}/submit`,"POST",final),request(child,`/api/assessments/${a.id}/submit`,"POST",final)]);assert.ok(responses.every(response=>response.ok));
    await rejected(child,`/api/assessments/${a.id}`,"PATCH",{answers:{q1:0},acknowledged:true,revision},409,"DRAFT_CONFLICT");
    const report=await waitReport(guardian,r=>r.assessmentId===a.id);assert.equal(report.dimensions.find(d=>d.key==="connection")?.raw,4);assert.equal(report.generationMode,"template");return report;
  });
  const frozenDemo=await check("bilingual HTML/PDF publish directly and require parent authorization",async()=>{
    const saved=await documents(guardian,report.id,"parent-report");
    for(const locale of ["zh-CN","zh-HK"] as const){assert.ok(!saved[locale].html.includes('"q1"'));assert.ok(saved[locale].html.includes(locale==="zh-CN"?"演示报告":"示範報告"));}
    await rejected(child,`/api/reports/${report.id}`,"GET",undefined,403,"ROLE_DENIED");await rejected(parent,`/api/reports/${report.id}`,"GET",undefined,404,"NOT_FOUND");
    await rejected({base:cn,cookie:""},`/api/reports/${report.id}/pdf`,"GET",undefined,401,"UNAUTHENTICATED");return saved;
  });
  await check("goals persist, observations stay private, scale versions reject overwrite",async()=>{
    const goal=await ok<{id:string}>(guardian,"/api/goals","POST",{familyId:demoFamily.id,title:"合成行动",detail:"一起安排交流时间"});await ok(guardian,`/api/goals/${goal.id}`,"PATCH",{status:"completed"});
    await ok(admin,"/api/observations","POST",{familyId:demoFamily.id,body:"PRIVATE_STAFF_NOTE_TEST"});const w=await workspace(guardian);assert.equal(w.observations.length,0);assert.ok(w.goals.some(g=>g.id===goal.id&&g.status==="completed"));
    const definition=await ok<ScaleDefinition>(admin,"/api/scales/example");assert.equal(`${definition.id}@${definition.version}`,demoId);
    await rejected(admin,"/api/scales","POST",{definition},409,"ALREADY_EXISTS");await rejected(guardian,"/api/scales","POST",{definition},403,"ROLE_DENIED");
  });
  await check("retake interval is enforced for the same person and scale version",()=>rejected(guardian,"/api/assessments","POST",{familyId:demoFamily.id,respondentId:acceptedIds.student,scaleVersionId:demoId,locale:"zh-CN"},409,"RETAKE_INTERVAL"));
  await check("risk plus missing answers automatically produces a limited safety-first demo report",async()=>{
    const task=await ok<{id:string}>(admin,"/api/assessments","POST",{familyId:demoFamily.id,respondentId:acceptedIds.parent,scaleVersionId:demoId,locale:"zh-HK"});
    await ok(guardian,`/api/assessments/${task.id}/submit`,"POST",{answers:{q9:1},acknowledged:true,revision:0});
    const risk=await waitReport(guardian,r=>r.assessmentId===task.id);assert.equal(risk.risk,true);assert.ok(risk.dimensions.every(d=>d.raw===null));assert.equal(risk.generationMode,"template");
    const saved=await documents(guardian,risk.id,"risk-incomplete-report"),html=saved["zh-HK"].html;
    assert.ok(html.indexOf("請先關注安全")>=0&&html.indexOf("請先關注安全")<html.indexOf("家長可以嘗試的下一步"));assert.ok(html.includes("先獲得適合的支持"));
  });
  await check("content versions protect active/pending references and freeze accepted report snapshots",async()=>{
    const oldAdvice=await ok<ContentSnapshot<AdviceLibrary>>(admin,"/api/content/advice"),oldTemplate=await ok<ContentSnapshot<ReportTemplate>>(admin,"/api/content/template");
    let sequence=0;const version=()=>`9000.${Date.now()}.${++sequence}`;
    const extraId=`qa_pending_${nonce}`,block={id:extraId,title:{"zh-CN":"合成版本测试建议","zh-HK":"合成版本測試建議"},body:{"zh-CN":"仅用于本地合成回归。","zh-HK":"僅用於本地合成回歸。"},source:"Synthetic integration fixture only",dimensionKeys:["connection"]};
    const extended={...oldAdvice.content,blocks:[...oldAdvice.content.blocks,block]},adviceVersion=version();
    await ok(admin,"/api/content/advice","POST",{version:adviceVersion,content:extended});await rejected(admin,"/api/content/advice","POST",{version:adviceVersion,content:extended},409,"ALREADY_EXISTS");
    const definition=structuredClone(demoScale);definition.id=`qa-content-demo-${nonce}`;definition.title={"zh-CN":"合成内容版本检查 · 演示","zh-HK":"合成內容版本檢查 · 示範"};
    const dimension=definition.dimensions.find(d=>d.key==="connection");assert.ok(dimension);for(const band of dimension.bands)band.adviceIds=[extraId];
    const imported=await ok<{id:string}>(admin,"/api/scales","POST",{definition});
    await rejected(admin,"/api/content/advice","POST",{version:version(),content:oldAdvice.content},422,"ADVICE_MISMATCH");
    const task=await ok<{id:string}>(admin,"/api/assessments","POST",{familyId:demoFamily.id,respondentId:acceptedIds.teacher,scaleVersionId:imported.id,locale:"zh-CN"});
    await ok(admin,`/api/scales/${imported.id}`,"PATCH",{status:"retired"});await rejected(admin,"/api/content/advice","POST",{version:version(),content:oldAdvice.content},422,"ADVICE_MISMATCH");
    const marker=`SYNTHETIC_TEMPLATE_SNAPSHOT_${nonce}`,templateVersion=version(),template={...oldTemplate.content,introduction:{"zh-CN":marker,"zh-HK":marker}};
    await ok(admin,"/api/content/template","POST",{version:templateVersion,content:template});await rejected(admin,"/api/content/template","POST",{version:templateVersion,content:template},409,"ALREADY_EXISTS");
    const submitted={answers:fullDemo,acknowledged:true,revision:0};await ok(acceptedClients.teacher,`/api/assessments/${task.id}/submit`,"POST",submitted);
    await ok(admin,"/api/content/advice","POST",{version:version(),content:oldAdvice.content});await ok(admin,"/api/content/template","POST",{version:version(),content:oldTemplate.content});
    await rejected(admin,`/api/scales/${imported.id}`,"PATCH",{status:"active"},422,"ADVICE_MISMATCH");await ok(acceptedClients.teacher,`/api/assessments/${task.id}/submit`,"POST",submitted);
    const frozen=await waitReport(guardian,r=>r.assessmentId===task.id),saved=await documents(guardian,frozen.id,"content-snapshot-report");
    for(const locale of ["zh-CN","zh-HK"] as const){assert.ok(saved[locale].html.includes(marker));assert.ok(saved[locale].html.includes(adviceVersion));assert.ok(saved[locale].html.includes(templateVersion));}
    const unchanged=await documents(guardian,report.id);for(const locale of ["zh-CN","zh-HK"] as const){assert.equal(sha256(unchanged[locale].html),sha256(frozenDemo[locale].html));assert.equal(unchanged[locale].pdfSha256,frozenDemo[locale].pdfSha256);}
    assert.equal((await workspace(guardian)).reports.filter(r=>r.assessmentId===task.id).length,1);
  });

  const triad=await check("independent three-party registration creates fixed role instruments",()=>registerTriad(cn,"zh-CN"));
  await check("official role/age gates reject inappropriate assignments and demo fallback",async()=>{
    await rejected(admin,"/api/assessments","POST",{familyId:triad.familyId,respondentId:triad.tasks.student.respondentId,scaleVersionId:"growth-parent@1.0.0",locale:"zh-CN"},422,"INELIGIBLE");
    await rejected(admin,"/api/assessments","POST",{familyId:demoFamily.id,respondentId:acceptedIds.student,scaleVersionId:"growth-child@1.0.0",locale:"zh-CN"},422,"INELIGIBLE");
    for(const role of roles)await rejected(admin,"/api/assessments","POST",{familyId:triad.familyId,respondentId:triad.tasks[role].respondentId,scaleVersionId:demoId,locale:"zh-CN"},409,"DEMO_NOT_ASSIGNABLE");
  });
  await check("admin assignment controls staff report-management scope",async()=>{
    assert.ok(!(await workspace(staff)).families.some(f=>f.id===triad.familyId));
    await rejected(staff,`/api/families/${triad.familyId}/assignment`,"PATCH",{assignedTo:staffId},403,"ROLE_DENIED");await rejected(triad.clients.parent,`/api/families/${triad.familyId}/assignment`,"PATCH",{assignedTo:staffId},403,"ROLE_DENIED");
    const hkStaff=hkW.staff.find(s=>s.name.includes("陳"));assert.ok(hkStaff);await rejected(admin,`/api/families/${triad.familyId}/assignment`,"PATCH",{assignedTo:hkStaff.id},422,"INVALID_STAFF");await rejected(admin,`/api/families/${triad.familyId}/assignment`,"PATCH",{assignedTo:adminW.user.id},422,"INVALID_STAFF");
    await ok(admin,`/api/families/${triad.familyId}/assignment`,"PATCH",{assignedTo:staffId});assert.equal((await workspace(staff)).families.find(f=>f.id===triad.familyId)?.assignedTo,staffId);assert.ok(!(await workspace(otherStaff)).families.some(f=>f.id===triad.familyId));
    await ok(admin,`/api/families/${triad.familyId}/assignment`,"PATCH",{assignedTo:otherStaffId});assert.ok(!(await workspace(staff)).families.some(f=>f.id===triad.familyId));await rejected(staff,`/api/assessments/${triad.tasks.parent.id}/retry-report`,"POST",{},404,"NOT_FOUND");
    await ok(admin,`/api/families/${triad.familyId}/assignment`,"PATCH",{assignedTo:staffId});await rejected(staff,`/api/assessments/${triad.tasks.parent.id}/retry-report`,"POST",{},409,"REPORT_NOT_FAILED");await rejected(triad.clients.parent,`/api/assessments/${triad.tasks.parent.id}/retry-report`,"POST",{},403,"ROLE_DENIED");
  });
  const answers={parent:triadAnswers(parentScale,"parent"),student:triadAnswers(childScale,"student"),teacher:triadAnswers(teacherScale,"teacher")};
  await check("three-party entry gates and required coverage reject incomplete risk submissions",async()=>{
    for(const role of roles){
      const scale=definitions[role],gate=scale.items.find(item=>item.gate!==undefined),required=scale.items.find(item=>item.required&&item.kind==="text"&&!item.showIf);assert.ok(gate&&required);
      await rejected(triad.clients[role],`/api/assessments/${triad.tasks[role].id}/submit`,"POST",{answers:{...answers[role],[gate.id]:0},acknowledged:true,revision:0},422,"ENTRY_GATE");
      const incomplete={...answers[role]};delete incomplete[required.id];await rejected(triad.clients[role],`/api/assessments/${triad.tasks[role].id}/submit`,"POST",{answers:incomplete,acknowledged:true,revision:0},422,"INCOMPLETE_TRIAD");
      assert.equal((await workspace(triad.clients[role])).assessments.find(a=>a.id===triad.tasks[role].id)?.status,"pending");
    }
    await rejected(triad.clients.student,`/api/assessments/${triad.tasks.student.id}/submit`,"POST",{answers:{...answers.student,c7_1:-1,c7_2:-1},acknowledged:true,revision:0},422,"INCOMPLETE_TRIAD");
    assert.equal((await workspace(admin)).alerts.filter(alert=>alert.familyId===triad.familyId).length,0);
  });
  const alertIds:string[]=[];
  for(const [index,role] of (["student","parent","teacher"] as const).entries())await check(`${role} submission raises one immediate safety alert and respects three-party waiting`,async()=>{
    const client=triad.clients[role],task=triad.tasks[role],payload={answers:answers[role],acknowledged:true,revision:0};
    const responses=await Promise.all([request(client,`/api/assessments/${task.id}/submit`,"POST",payload),request(client,`/api/assessments/${task.id}/submit`,"POST",payload)]);assert.ok(responses.every(response=>response.ok));
    const adminView=await workspace(admin),alerts=adminView.alerts.filter(alert=>alert.familyId===triad.familyId);assert.equal(alerts.length,index+1);
    const next=alerts.find(alert=>!alertIds.includes(alert.id));assert.ok(next);alertIds.push(next.id);assert.equal((await workspace(staff)).alerts.filter(alert=>alert.familyId===triad.familyId).length,index+1);
    for(const viewer of roles)assert.equal((await workspace(triad.clients[viewer])).alerts.length,0);
    if(index<2){const w=await workspace(triad.clients.parent);assert.equal(w.reports.filter(r=>r.familyId===triad.familyId).length,0);const submitted=w.assessments.find(a=>a.id===task.id);assert.ok(submitted);assert.equal(submitted.status,"queued");assert.equal(submitted.phase,"waiting");assert.equal(submitted.reportId,null);assert.equal(submitted.canRetryReport,false);}
    await ok(client,`/api/assessments/${task.id}/submit`,"POST",payload);assert.equal((await workspace(admin)).alerts.filter(alert=>alert.familyId===triad.familyId).length,index+1);await rejected(otherStaff,`/api/assessments/${task.id}/retry-report`,"POST",{},404,"NOT_FOUND");
  });
  const combined=await check("three submissions publish one shared combined report with bounded retry capability",async()=>{
    const report=await waitReport(triad.clients.parent,r=>r.familyId===triad.familyId&&r.assessmentId===triad.tasks.parent.id);assert.equal(report.combined,true);assert.equal(report.demo,false);assert.equal(report.generationMode,"template");assert.equal(report.risk,true);
    for(const client of [admin,staff,triad.clients.parent]){const w=await workspace(client);assert.equal(w.reports.filter(r=>r.familyId===triad.familyId).length,1);for(const task of Object.values(triad.tasks)){const current=w.assessments.find(a=>a.id===task.id);assert.ok(current);assert.equal(current.status,"published");assert.equal(current.reportId,report.id);assert.equal(current.canRetryReport,false);}}
    for(const role of ["student","teacher"] as const){const w=await workspace(triad.clients[role]);assert.equal(w.reports.length,0);assert.ok(w.assessments.every(a=>a.respondentId===w.user.id&&a.reportId===null&&!a.canRetryReport));for(const suffix of ["","/document","/pdf"])await rejected(triad.clients[role],`/api/reports/${report.id}${suffix}`,"GET",undefined,403,"ROLE_DENIED");}
    await rejected(parent,`/api/reports/${report.id}`,"GET",undefined,404,"NOT_FOUND");await rejected(hkAdmin,`/api/reports/${report.id}`,"GET",undefined,404,"NOT_FOUND");await rejected(staff,`/api/assessments/${triad.tasks.parent.id}/retry-report`,"POST",{},409,"REPORT_NOT_FAILED");return report;
  });
  await check("combined bilingual documents preserve aggregates/safety and exclude student raw disclosures",async()=>{
    const saved=await documents(triad.clients.parent,combined.id,"triad-parent-report");
    for(const locale of ["zh-CN","zh-HK"] as const){
      const html=saved[locale].html,serialized=JSON.stringify(await ok<object>(triad.clients.parent,`/api/reports/${combined.id}?locale=${locale}`));
      assert.ok(!serialized.includes(`STUDENT_PRIVATE_student_${nonce}`));assert.ok(!serialized.includes("STAFF_PRIVATE_"));assert.ok(!html.includes('"answers"'));assert.ok(html.includes(`ADULT_WORDS_parent_${nonce}`));assert.ok(html.includes(`ADULT_WORDS_teacher_${nonce}`));
      const aggregate=childScale.dimensions.find(d=>d.key==="c7");assert.ok(aggregate);assert.ok(html.includes(aggregate.label[locale]));assert.ok(html.includes("孩子自己"));assert.ok(html.includes("原始平均分 4"));
      for(const rule of childScale.riskRules)assert.ok(html.includes(rule.message[locale]),"Approved child safety templates must remain visible");
      for(const item of childScale.items.filter(item=>item.report==="situation"||item.report==="priorities"||item.report==="words"))assert.ok(!html.includes(item.label[locale]),`Student raw prompt ${item.id} must be excluded`);
      for(const section of ["situations","priorities","words"]){const match=html.match(new RegExp(`<section class="${section}">([\\s\\S]*?)</section>`));assert.ok(match);assert.ok(!match[1].includes("<strong>孩子"),"Raw response sections must contain adults only");}
      const safety=html.indexOf(locale==="zh-CN"?"请先关注安全":"請先關注安全"),observations=html.indexOf(locale==="zh-CN"?"三方看到的情况":"三方看到的情況");assert.ok(safety>=0&&observations>safety);
    }
    assert.equal((await workspace(triad.clients.parent)).staffNotes.length,0);assert.ok((await workspace(staff)).staffNotes.some(note=>note.familyId===triad.familyId&&note.value.startsWith("STAFF_PRIVATE_")));
  });
  await check("safety acknowledgement is authorized, idempotent and never duplicates alerts",async()=>{
    const alertId=alertIds.find(Boolean);assert.ok(alertId);await rejected(triad.clients.parent,`/api/alerts/${alertId}/viewed`,"POST",{},403,"ROLE_DENIED");await rejected(hkAdmin,`/api/alerts/${alertId}/viewed`,"POST",{},404,"NOT_FOUND");
    await ok(staff,`/api/alerts/${alertId}/viewed`,"POST",{});await ok(staff,`/api/alerts/${alertId}/viewed`,"POST",{});assert.equal((await workspace(admin)).alerts.filter(alert=>alert.familyId===triad.familyId).length,2);
    await ok(triad.clients.student,`/api/assessments/${triad.tasks.student.id}/submit`,"POST",{answers:answers.student,acknowledged:true,revision:0});assert.equal((await workspace(admin)).alerts.filter(alert=>alert.familyId===triad.familyId).length,2);assert.equal((await workspace(triad.clients.parent)).reports.filter(r=>r.familyId===triad.familyId).length,1);
  });
  const hkTriad=await check("Hong Kong three-party flow publishes a private combined template report",async()=>{
    const triad=await registerTriad(hk,"zh-HK");
    for(const [index,role] of (["student","parent","teacher"] as const).entries()){
      await ok(triad.clients[role],`/api/assessments/${triad.tasks[role].id}/submit`,"POST",{answers:answers[role],acknowledged:true,revision:0});
      if(index<2){const w=await workspace(triad.clients.parent,"zh-HK");assert.equal(w.reports.length,0);assert.equal(w.assessments.find(a=>a.id===triad.tasks[role].id)?.phase,"waiting");}
    }
    const report=await waitReport(triad.clients.parent,r=>r.familyId===triad.familyId&&r.assessmentId===triad.tasks.parent.id,"zh-HK");assert.equal(report.combined,true);assert.equal(report.generationMode,"template");assert.equal(report.demo,false);
    const w=await workspace(triad.clients.parent,"zh-HK");assert.equal(w.reports.length,1);assert.ok(w.assessments.every(a=>a.status==="published"&&a.reportId===report.id));
    for(const role of ["student","teacher"] as const){assert.equal((await workspace(triad.clients[role],"zh-HK")).reports.length,0);await rejected(triad.clients[role],`/api/reports/${report.id}/pdf?locale=zh-HK`,"GET",undefined,403,"ROLE_DENIED");}
    await rejected(admin,`/api/reports/${report.id}`,"GET",undefined,404,"NOT_FOUND");
    const saved=await documents(triad.clients.parent,report.id,"hong-kong-triad-report");assert.ok(saved["zh-HK"].html.includes("三方看到的情況"));assert.ok(!saved["zh-HK"].html.includes(`STUDENT_PRIVATE_student_${nonce}`));assert.ok(!saved["zh-HK"].html.includes("STAFF_PRIVATE_"));
    return {...triad,reportId:report.id};
  });
  await check("family deletion revokes sessions, invitations and both report types",async()=>{
    for(const scenario of [{admin,familyId:demoFamily.id,guardian,clients:Object.values(acceptedClients),childName:"合成孩子",reportId:report.id},{admin,familyId:triad.familyId,guardian:triad.clients.parent,clients:Object.values(triad.clients),childName:"合成三方孩子",reportId:combined.id},{admin:hkAdmin,familyId:hkTriad.familyId,guardian:hkTriad.clients.parent,clients:Object.values(hkTriad.clients),childName:"合成三方孩子",reportId:hkTriad.reportId}]){
      const invite=await ok<{url:string}>(scenario.admin,`/api/families/${scenario.familyId}/invites`,"POST",{role:"teacher"}),token=new URLSearchParams(new URL(invite.url).hash.slice(1)).get("token");assert.ok(token);
      await ok(scenario.guardian,`/api/families/${scenario.familyId}`,"DELETE",{confirmation:scenario.childName});
      for(const client of scenario.clients)await rejected(client,"/api/workspace","GET",undefined,401,"UNAUTHENTICATED");
      for(const suffix of ["","/document","/pdf"])await rejected(scenario.admin,`/api/reports/${scenario.reportId}${suffix}`,"GET",undefined,404,"NOT_FOUND");
      await rejected({base:scenario.admin.base,cookie:""},"/api/invite","GET",undefined,404,"INVALID_INVITATION",{"X-Invitation-Token":token});fixtures.find(f=>f.familyId===scenario.familyId)!.deleted=true;
    }
  });
  await check("Hong Kong fixed demo reports retain same-version longitudinal changes",async()=>{
    const hkParent=await login(hk,"parent","林"),w=await workspace(hkParent,"zh-HK"),family=w.families.find(f=>f.members.some(m=>m.id===w.user.id));assert.ok(family);
    const taskIds=new Set(w.assessments.filter(a=>a.familyId===family.id&&a.respondentRole==="student"&&a.scaleVersionId===demoId).map(a=>a.id));assert.ok(taskIds.size>=2);
    const report=await waitReport(hkAdmin,r=>taskIds.has(r.assessmentId)&&r.demo&&!r.combined&&r.comparison.available,"zh-HK");assert.ok(report.title.includes("測評"));assert.ok(report.comparison.changes?.some(change=>change.key==="connection"&&Number.isFinite(change.delta)));
    const saved=await documents(hkParent,report.id,"hong-kong-report");assert.ok(saved["zh-HK"].html.includes("僅比較相同填答者與相同量表版本"));assert.ok(saved["zh-HK"].html.includes("示範報告"));
  });
}

try{await main();completed=true;console.log(`Integration acceptance passed: ${results.length} checks.`);}
catch(error){failure??=error instanceof Error?error.message:"Unknown integration failure";console.error(`Integration failed: ${failure}`);process.exitCode=1;}
finally{await writeResults();console.log(`Integration evidence: ${outputDir}`);}
// Failed scenarios remain in the isolated synthetic database for diagnosis.
