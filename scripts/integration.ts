import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import fs from "node:fs/promises";
import type {Workspace,Session} from "../src/components/api";
type Client={base:string;cookie:string};
const results:{name:string;passed:boolean;durationMs:number}[]=[];
async function request(c:Client,path:string,method="GET",data?:unknown,headers:Record<string,string>={}){
  return fetch(c.base+path,{method,headers:{...(c.cookie?{Cookie:c.cookie}:{}),...(method!=="GET"?{Origin:c.base}:{}),...(data===undefined?{}:{"Content-Type":"application/json"}),...headers},body:data===undefined?undefined:JSON.stringify(data)});
}
async function ok<T>(c:Client,path:string,method="GET",data?:unknown,headers:Record<string,string>={}):Promise<T>{
  const r=await request(c,path,method,data,headers);assert.ok(r.ok,`${method} ${path.split('?')[0]} returned ${r.status}`);return r.json() as Promise<T>;
}
async function login(base:string,role:string,name?:string):Promise<Client>{
  const c={base,cookie:""};const session=await ok<Session>(c,"/api/session");assert.equal(session.mode,"demo","Integration suite only runs against explicit demo environments");
  const account=session.demoAccounts.find(a=>a.role===role&&(!name||a.name.includes(name)));assert.ok(account);
  const r=await request(c,"/api/auth/demo","POST",{accountId:account.id});assert.equal(r.status,200);c.cookie=r.headers.get("set-cookie")!.split(";")[0];return c;
}
async function check(name:string,fn:()=>Promise<void>){const start=Date.now();await fn();results.push({name,passed:true,durationMs:Date.now()-start});console.log(`PASS ${name}`);}
const cn="http://127.0.0.1:3100",hk="http://127.0.0.1:3101";
const admin=await login(cn,"admin"),parent=await login(cn,"parent","林"),student=await login(cn,"student","林"),teacher=await login(cn,"teacher"),staff=await login(cn,"staff","陈"),hkAdmin=await login(hk,"admin");
const adminW=await ok<Workspace>(admin,"/api/workspace"),parentW=await ok<Workspace>(parent,"/api/workspace");
const other=adminW.families.find(f=>!parentW.families.some(p=>p.id===f.id))!;assert.ok(other);
await check("regional databases and sessions are independent",async()=>{
  const h=await ok<Workspace>(hkAdmin,"/api/workspace?locale=zh-HK");assert.equal(h.region,"HK");assert.ok(h.families.every(f=>!adminW.families.some(c=>c.id===f.id)));
  assert.equal((await request({base:hk,cookie:parent.cookie.replace("nova_cn_session","nova_hk_session")},"/api/workspace")).status,401);
  const forged=await ok<Workspace>(parent,"/api/workspace","GET",undefined,{"X-Nova-Role":"admin","X-Nova-Region":"HK"});assert.equal(forged.user.role,"parent");assert.equal(forged.region,"CN");
});
await check("parent/student/teacher/staff see only authorized scope",async()=>{
  assert.equal(parentW.families.length,1);assert.equal(parentW.observations.length,0);assert.equal(parentW.staff.length,0);
  const s=await ok<Workspace>(student,"/api/workspace"),t=await ok<Workspace>(teacher,"/api/workspace"),st=await ok<Workspace>(staff,"/api/workspace");
  assert.equal(s.reports.length,0);assert.equal(t.reports.length,0);assert.equal(s.goals.length,0);assert.ok(s.assessments.every(a=>a.respondentId===s.user.id));assert.ok(st.families.every(f=>f.assignedTo===st.user.id));
  const ownStudentTask=adminW.assessments.find(a=>a.respondentRole==="student"&&a.familyId===parentW.families[0].id)!;
  assert.equal((await request(parent,`/api/assessments/${ownStudentTask.id}`)).status,404);
  assert.equal((await request(student,"/api/families","POST",{})).status,403);
});
await check("cross-family data access and untrusted origins are rejected",async()=>{
  assert.equal((await request(parent,`/api/families/${other.id}/consent`,"POST",{accepted:true,guardianName:"合成家长"})).status,404);
  assert.equal((await request(parent,"/api/goals","POST",{familyId:other.id,title:"不应写入",detail:""})).status,404);
  assert.equal((await request(parent,"/api/goals","POST",{familyId:parentW.families[0].id,title:"不应写入",detail:""},{Origin:"https://untrusted.invalid"})).status,403);
});
let testFamilyId:string|undefined,createdReportId:string|undefined;
try{
  await check("family creation validates date and forbids client region reassignment",async()=>{
    const value={familyName:"自动化测试家庭",childName:"合成孩子",birthDate:"2014-02-30",grade:"六年级",guardianLabel:"母亲"};
    assert.equal((await request(admin,"/api/families","POST",value)).status,422);
    assert.equal((await request(admin,"/api/families","POST",{...value,birthDate:"2014-02-20",region:"HK"})).status,422);
    const f=await ok<{id:string}>(admin,"/api/families","POST",{...value,birthDate:"2014-02-20"});testFamilyId=f.id;
  });
  const acceptedClients:Record<string,Client>={};const acceptedIds:Record<string,string>={};
  await check("one-time invitations create bounded accounts and reject replay",async()=>{
    for(const role of ["parent","student","teacher"]){
      const inv=await ok<{url:string}>(admin,`/api/families/${testFamilyId}/invites`,"POST",{role});
      const token=new URLSearchParams(new URL(inv.url).hash.slice(1)).get("token")!;assert.ok(token);
      const visitor={base:cn,cookie:""};const info=await ok<{role:string}>(visitor,"/api/invite","GET",undefined,{"X-Invitation-Token":token});assert.equal(info.role,role);
      const payload={token,name:`合成${role}`,username:`qa_${role}_${randomBytes(6).toString("hex")}`,password:randomBytes(18).toString("base64url")};
      const r=await request(visitor,"/api/invite","POST",payload);assert.equal(r.status,200);
      const c={base:cn,cookie:r.headers.get("set-cookie")!.split(";")[0]};acceptedClients[role]=c;acceptedIds[role]=(await ok<Session>(c,"/api/session")).user!.id;
      assert.equal((await request(visitor,"/api/invite","POST",payload)).status,404);
      if(role==="parent"){
        const previousCookie=c.cookie;await ok(c,"/api/auth/logout","POST",{});assert.equal((await request({base:cn,cookie:previousCookie},"/api/workspace")).status,401);
        assert.equal((await request(visitor,"/api/auth/login","POST",{username:payload.username,password:"incorrect-synthetic-password"})).status,401);
        const login=await request(visitor,"/api/auth/login","POST",{username:payload.username,password:payload.password});assert.equal(login.status,200);c.cookie=login.headers.get("set-cookie")!.split(";")[0];
      }
    }
  });
  const a=await ok<{id:string}>(admin,"/api/assessments","POST",{familyId:testFamilyId,respondentId:acceptedIds.student,scaleVersionId:adminW.scales[0].id,locale:"zh-CN"});
  const child=acceptedClients.student,guardian=acceptedClients.parent;
  let revision=0;
  await check("guardian consent is required before draft collection and submission",async()=>{
    const detail=await ok<{consentRequired:boolean;draftAnswers:unknown;draftRevision:number}>(child,`/api/assessments/${a.id}`);assert.equal(detail.consentRequired,true);assert.deepEqual(detail.draftAnswers,{});assert.equal(detail.draftRevision,0);
    assert.equal((await request(child,`/api/assessments/${a.id}`,"PATCH",{answers:{q1:2},acknowledged:true,revision:0})).status,409);
    assert.equal((await request(child,`/api/assessments/${a.id}/submit`,"POST",{answers:{q9:0},acknowledged:true,revision:0})).status,409);
    await ok(guardian,`/api/families/${testFamilyId}/consent`,"POST",{accepted:true,guardianName:"合成家长",aiProcessing:false});
  });
  await check("draft autosave persists and malformed/client scores are rejected",async()=>{
    assert.equal((await request(child,`/api/assessments/${a.id}`,"PATCH",{answers:{q1:2},revision:0})).status,422);
    assert.equal((await request(child,`/api/assessments/${a.id}`,"PATCH",{answers:{q1:2},acknowledged:false,revision:0})).status,422);
    const saved=await ok<{revision:number}>(child,`/api/assessments/${a.id}`,"PATCH",{answers:{q1:2,q2:3},acknowledged:true,revision:0});revision=saved.revision;assert.equal(revision,1);
    assert.deepEqual((await ok<{draftAnswers:unknown}>(child,`/api/assessments/${a.id}`)).draftAnswers,{q1:2,q2:3});
    assert.equal((await request(child,`/api/assessments/${a.id}/submit`,"POST",{answers:{q1:2,total:99,q9:0},acknowledged:true,revision})).status,422);
    assert.equal((await request(child,`/api/assessments/${a.id}/submit`,"POST",{answers:{q1:"2",q9:0},acknowledged:true,revision})).status,422);
    assert.equal((await request(child,`/api/assessments/${a.id}/submit`,"POST",{answers:{q9:0},acknowledged:false,revision})).status,422);
  });
  await check("stale draft writes and stale final submissions cannot overwrite newer answers",async()=>{
    assert.equal((await request(child,`/api/assessments/${a.id}`,"PATCH",{answers:{q1:0},acknowledged:true,revision:0})).status,409);
    assert.equal((await request(child,`/api/assessments/${a.id}/submit`,"POST",{answers:{q9:0},acknowledged:true,revision:0})).status,409);
    assert.deepEqual((await ok<{draftAnswers:unknown}>(child,`/api/assessments/${a.id}`)).draftAnswers,{q1:2,q2:3});
  });
  const final={answers:{q1:1,q2:2,q3:1,q4:2,q5:1,q6:2,q7:1,q8:2,q9:0},acknowledged:true,revision};
  await check("concurrent repeated submissions create one immutable assessment/report",async()=>{
    const responses=await Promise.all([request(child,`/api/assessments/${a.id}/submit`,"POST",final),request(child,`/api/assessments/${a.id}/submit`,"POST",final)]);assert.ok(responses.every(r=>r.ok));
    assert.equal((await request(child,`/api/assessments/${a.id}`,"PATCH",{answers:{q1:0},acknowledged:true,revision})).status,409);
    const deadline=Date.now()+90000;
    while(Date.now()<deadline){const w=await ok<Workspace>(guardian,"/api/workspace");const report=w.reports.find(r=>r.assessmentId===a.id);if(report){createdReportId=report.id;assert.equal(w.reports.filter(r=>r.assessmentId===a.id).length,1);assert.equal(report.dimensions[0].raw,4);assert.equal(report.generationMode,"template");break;}await new Promise(r=>setTimeout(r,1000));}
    assert.ok(createdReportId,"worker must automatically publish the report within 90 seconds");
  });
  await check("bilingual HTML/PDF publish directly and require parent authorization",async()=>{
    await fs.mkdir("work/qa",{recursive:true});
    for(const locale of ["zh-CN","zh-HK"]){
      const r=await request(guardian,`/api/reports/${createdReportId}/document?locale=${locale}`);assert.equal(r.status,200);const html=await r.text();assert.match(html,/Nova|nova/);assert.ok(!html.includes('"q1"'));assert.ok(html.includes(locale==="zh-CN"?"演示报告":"示範報告"));
      const pdf=await request(guardian,`/api/reports/${createdReportId}/pdf?locale=${locale}`);assert.equal(pdf.status,200);const bytes=Buffer.from(await pdf.arrayBuffer());assert.equal(bytes.subarray(0,4).toString(),"%PDF");await fs.writeFile(`work/qa/parent-report-${locale}.pdf`,bytes);
    }
    assert.equal((await request(child,`/api/reports/${createdReportId}`)).status,403);
    assert.equal((await request(parent,`/api/reports/${createdReportId}`)).status,404);
    assert.equal((await request({base:cn,cookie:""},`/api/reports/${createdReportId}/pdf`)).status,401);
  });
  await check("goals persist, observations stay private, scale versions reject overwrite",async()=>{
    const g=await ok<{id:string}>(guardian,"/api/goals","POST",{familyId:testFamilyId,title:"合成行动",detail:"一起安排交流时间"});await ok(guardian,`/api/goals/${g.id}`,"PATCH",{status:"completed"});
    await ok(admin,"/api/observations","POST",{familyId:testFamilyId,body:"PRIVATE_STAFF_NOTE_TEST"});const w=await ok<Workspace>(guardian,"/api/workspace");assert.equal(w.observations.length,0);assert.ok(w.goals.some(x=>x.id===g.id&&x.status==="completed"));
    const definition=await ok<object>(admin,"/api/scales/example");assert.equal((await request(admin,"/api/scales","POST",{definition})).status,409);
    assert.equal((await request(guardian,"/api/scales","POST",{definition})).status,403);
  });
  await check("retake interval is enforced for the same person and scale version",async()=>{
    const r=await request(guardian,"/api/assessments","POST",{familyId:testFamilyId,respondentId:acceptedIds.student,scaleVersionId:adminW.scales[0].id,locale:"zh-CN"});assert.equal(r.status,409);
  });
  await check("risk plus missing answers automatically produces a limited safety-first report",async()=>{
    const task=await ok<{id:string}>(admin,"/api/assessments","POST",{familyId:testFamilyId,respondentId:acceptedIds.parent,scaleVersionId:adminW.scales[0].id,locale:"zh-HK"});
    await ok(guardian,`/api/assessments/${task.id}/submit`,"POST",{answers:{q9:1},acknowledged:true,revision:0});
    let riskReportId:string|undefined;const deadline=Date.now()+90000;
    while(Date.now()<deadline){const w=await ok<Workspace>(guardian,"/api/workspace");const r=w.reports.find(r=>r.assessmentId===task.id);if(r){assert.equal(r.risk,true);assert.ok(r.dimensions.every(d=>d.raw===null));riskReportId=r.id;break;}await new Promise(r=>setTimeout(r,1000));}
    assert.ok(riskReportId);const html=await(await request(guardian,`/api/reports/${riskReportId}/document?locale=zh-HK`)).text();assert.ok(html.indexOf("請先關注安全")<html.indexOf("家長可以嘗試的下一步"));assert.ok(html.includes("先獲得適合的支持"));
    const pdf=await request(guardian,`/api/reports/${riskReportId}/pdf?locale=zh-HK`);assert.equal(pdf.status,200);await fs.writeFile("work/qa/risk-incomplete-report.pdf",Buffer.from(await pdf.arrayBuffer()));
  });
  await check("family deletion revokes sessions, invitations and report access",async()=>{
    const invite=await ok<{url:string}>(admin,`/api/families/${testFamilyId}/invites`,"POST",{role:"teacher"});const token=new URLSearchParams(new URL(invite.url).hash.slice(1)).get("token")!;
    await ok(guardian,`/api/families/${testFamilyId}`,"DELETE",{confirmation:"合成孩子"});
    assert.equal((await request(guardian,"/api/workspace")).status,401);assert.equal((await request(admin,`/api/reports/${createdReportId}`)).status,404);assert.equal((await request({base:cn,cookie:""},"/api/invite","GET",undefined,{"X-Invitation-Token":token})).status,404);testFamilyId=undefined;
  });
  await check("Hong Kong reports and same-version longitudinal changes are present",async()=>{
    const w=await ok<Workspace>(hkAdmin,"/api/workspace?locale=zh-HK");assert.ok(w.reports.length>0);assert.ok(w.reports.some(r=>r.comparison.available));const r=w.reports[0];assert.ok(r.title.includes("測評"));
    const pdf=await request(hkAdmin,`/api/reports/${r.id}/pdf?locale=zh-HK`);assert.equal(pdf.status,200);await fs.writeFile("work/qa/hong-kong-report.pdf",Buffer.from(await pdf.arrayBuffer()));
  });
}finally{
  if(testFamilyId)await request(admin,`/api/families/${testFamilyId}`,"DELETE",{confirmation:"合成孩子"});
  await fs.mkdir("work/qa",{recursive:true});await fs.writeFile("work/qa/api-integration-results.json",JSON.stringify({timestamp:new Date().toISOString(),regions:["CN","HK"],syntheticDataOnly:true,results},null,2));
}
console.log(`Integration acceptance passed: ${results.length} checks.`);
