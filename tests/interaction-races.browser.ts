import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium,type BrowserContext} from 'playwright';

const mode=process.argv[2];assert.ok(mode==='baseline'||mode==='fixed');
const base=process.env.NOVA_PUBLIC_URL!;assert.ok(['http://127.0.0.1:3120','http://127.0.0.1:3121'].includes(base));
assert.equal(process.env.NOVA_MODE,'demo');assert.equal(process.env.NOVA_AI_ENABLED,'false');
const locale=process.env.NOVA_REGION==='HK'?'zh-HK':'zh-CN';
const out=path.resolve(`work/qa/three-fixes-20261008/${mode}-${locale}`);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const evidence:{mode:string;locale:string;checks:unknown[];errors:string[];passed:boolean}={mode,locale,checks:[],errors:[],passed:false};
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function context(){const c=await browser.newContext({viewport:{width:1440,height:1000}});await c.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());return c;}
async function call(c:BrowserContext,route:string,data?:unknown,method=data===undefined?'GET':'POST',headers={}){
 const r=await c.request.fetch(base+route,{method,headers:{Origin:base,...headers},...(data===undefined?{}:{data})});assert.ok(r.ok(),`${method} ${route} ${r.status()}`);return r.json();
}
try{
 const staff=await context();const session=await call(staff,'/api/session');assert.equal(session.mode,'demo');
 await call(staff,'/api/auth/demo',{accountId:session.demoAccounts.find((a:{role:string})=>a.role==='admin').id});
 const family=await call(staff,'/api/families',{familyName:'合成竞态测试家庭',childName:'合成孩子',birthDate:`${new Date().getUTCFullYear()-7}-01-01`,grade:'小学二年级',guardianLabel:'合成家长'});
 await call(staff,`/api/families/${family.id}/consent`,{accepted:true,guardianName:'合成家长',reference:'local-synthetic-fixture'});
 let token='';
 if(process.argv[3]==='logout-only'){
  const invitation=await call(staff,`/api/families/${family.id}/invites`,{role:'parent'});
  token=new URLSearchParams(new URL(invitation.url).hash.slice(1)).get('token')!;
 }else{
 const p=await staff.newPage();p.on('pageerror',e=>evidence.errors.push(e.name));await p.goto(base+'/#family/'+family.id);
 await p.getByRole('button',{name:/邀请成员|邀請成員/,exact:true}).click();
 const dialog=p.getByRole('dialog'),select=dialog.locator('select');await select.selectOption('parent');
 let requestedRole='';await p.route('**/api/families/*/invites*',async route=>{requestedRole=route.request().postDataJSON().role;await delay(1500);await route.continue();});
 await dialog.getByRole('button',{name:/生成邀请链接|產生邀請連結/,exact:true}).click();
 await p.waitForFunction(()=>Boolean(document.querySelector('button[disabled]')));
 const roleLockedWhilePending=await select.isDisabled();
 if(mode==='baseline')await select.selectOption('teacher');else assert.equal(roleLockedWhilePending,true);
 await dialog.locator('.invitation-result').waitFor();const badge=await dialog.locator('.badge').innerText();
 const invitationUrl=await dialog.locator('.invitation-result input').inputValue();token=new URLSearchParams(new URL(invitationUrl).hash.slice(1)).get('token')!;
 const info=await call(staff,'/api/invite',undefined,'GET',{'x-invitation-token':token});
 assert.equal(requestedRole,'parent');assert.equal(info.role,'parent');assert.match(badge,mode==='baseline'?/教师|教師/:/家长|家長/);
 evidence.checks.push({case:'invitation-delayed-role',requestedRole,actualRole:info.role,badge,roleLockedWhilePending});
 // Mask the invitation token in screenshots and keep it out of receipts.
 await p.screenshot({animations:'disabled',path:path.join(out,'invitation.png'),mask:[dialog.locator('.invitation-result input')]});
 if(mode==='fixed'){
  await select.selectOption('teacher');assert.equal(await dialog.locator('.invitation-result').count(),0);
  await dialog.getByRole('button',{name:/生成邀请链接|產生邀請連結/,exact:true}).click();await dialog.locator('.invitation-result').waitFor();
  const teacherUrl=await dialog.locator('.invitation-result input').inputValue();const teacherToken=new URLSearchParams(new URL(teacherUrl).hash.slice(1)).get('token')!;
  assert.equal((await call(staff,'/api/invite',undefined,'GET',{'x-invitation-token':teacherToken})).role,'teacher');assert.match(await dialog.locator('.badge').innerText(),/教师|教師/);
  evidence.checks.push({case:'invitation-subsequent-teacher',passed:true});
 }
 await p.keyboard.press('Escape');await p.getByRole('button',{name:/添加观察|新增觀察/,exact:true}).click();
 const observation=p.getByRole('dialog'),body=observation.locator('textarea');
 assert.equal(await body.getAttribute('maxlength'),mode==='baseline'?'5000':'4000');
 if(mode==='baseline'){
  await body.fill('测'.repeat(4001));const response=p.waitForResponse(r=>new URL(r.url()).pathname==='/api/observations');await observation.getByRole('button',{name:/保存|儲存/,exact:true}).click();assert.equal((await response).status(),422);evidence.checks.push({case:'observation-4001',status:422,inputLimit:5000});
 }else{
  await body.fill('测'.repeat(4001));assert.equal((await body.inputValue()).length,4000);
  await p.screenshot({animations:'disabled',path:path.join(out,'observation-limit.png')});
  const response=p.waitForResponse(r=>new URL(r.url()).pathname==='/api/observations');await observation.getByRole('button',{name:/保存|儲存/,exact:true}).click();assert.equal((await response).status(),201);
  const w=await call(staff,'/api/workspace');assert.equal(w.observations.find((o:{familyId:string})=>o.familyId===family.id).body.length,4000);
  const tooLong=await staff.request.post(base+'/api/observations',{headers:{Origin:base},data:{familyId:family.id,body:'测'.repeat(4001)}});assert.equal(tooLong.status(),422);evidence.checks.push({case:'observation-boundaries',uiMax:4000,savedLength:4000,direct4001Status:422});
 }
 await p.screenshot({animations:'disabled',path:path.join(out,'observation.png')});await p.close();
 }
 const respondent=await context();const username='race-'+randomUUID(),password=randomUUID()+'aA9';
 await call(respondent,'/api/invite',{token,name:'合成作答家长',username,password});
 const account=(await call(respondent,'/api/session')).user;
 async function task(){return call(staff,'/api/assessments',{familyId:family.id,respondentId:account.id,scaleVersionId:'nova-family-demo@1.0.0',locale});}
 const a=await task();const page=await respondent.newPage();page.on('pageerror',e=>evidence.errors.push(e.name));
 await page.goto(base+'/#assessment/'+a.id);await page.locator('.survey-assent-panel input').check();
 const events:{path:string;status:number}[]=[];page.on('response',r=>{const pathname=new URL(r.url()).pathname;if(pathname==='/api/auth/logout'||(pathname===`/api/assessments/${a.id}`&&r.request().method()==='PATCH'))events.push({path:pathname.endsWith('logout')?'logout':'draft',status:r.status()});});
 await page.locator('.survey-questions').evaluate(element=>{if((element as HTMLFieldSetElement).disabled)throw Error('Questionnaire still locked');});
 await page.locator('.survey-questions label').filter({has:page.locator('input[type=radio]')}).first().click();
 await page.getByRole('button',{name:/退出登录|登出/,exact:true}).click();await page.getByRole('heading',{name:/登录工作空间|登入工作空間/}).waitFor();await delay(900);
 await call(respondent,'/api/auth/login',{username,password});const saved=await call(respondent,`/api/assessments/${a.id}`);
 if(mode==='baseline'){assert.deepEqual(events,[{path:'logout',status:200},{path:'draft',status:401}]);assert.deepEqual(saved.draftAnswers,{});}else{assert.deepEqual(events,[{path:'draft',status:200},{path:'logout',status:200}]);assert.equal(saved.draftAnswers.q1,0);}
 evidence.checks.push({case:'immediate-logout',events,savedAnswerCount:Object.keys(saved.draftAnswers).length});
 await page.screenshot({animations:'disabled',path:path.join(out,'logout.png')});await page.close();
 evidence.passed=true;console.log(JSON.stringify(evidence));
}catch(e){evidence.errors.push(e instanceof Error?e.message:String(e));console.error(JSON.stringify(evidence));process.exitCode=1;}
finally{await writeFile(path.join(out,'results.json'),JSON.stringify(evidence,null,2));await browser.close();}
