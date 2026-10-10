import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium,type BrowserContext,type Page} from 'playwright';

const base=process.env.NOVA_PUBLIC_URL!;assert.ok(['http://127.0.0.1:3120','http://127.0.0.1:3121'].includes(base));
assert.equal(process.env.NOVA_AI_ENABLED,'false');assert.equal(process.env.NOVA_MODE,'demo');
const out=path.resolve(`work/qa/three-fixes-20261008/logout-races-${process.env.NOVA_REGION}-${Date.now()}`);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const checks:unknown[]=[],errors:string[]=[];
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
async function context(){const c=await browser.newContext({viewport:{width:1440,height:1000}});await c.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());return c;}
async function call(c:BrowserContext,route:string,data?:unknown,method=data===undefined?'GET':'POST'){
 const r=await c.request.fetch(base+route,{method,headers:{Origin:base},...(data===undefined?{}:{data})});assert.ok(r.ok(),`${method} ${route} ${r.status()}`);return r.json();
}
const staff=await context(),session=await call(staff,'/api/session');assert.equal(session.mode,'demo');
await call(staff,'/api/auth/demo',{accountId:session.demoAccounts.find((a:{role:string})=>a.role==='admin').id});
async function fixture(){
 const f=await call(staff,'/api/families',{familyName:'合成退出竞态家庭',childName:'合成孩子',birthDate:`${new Date().getUTCFullYear()-7}-01-01`,grade:'小学二年级',guardianLabel:'合成家长'});
 await call(staff,`/api/families/${f.id}/consent`,{accepted:true,guardianName:'合成家长',reference:'local-synthetic-fixture'});
 const invitation=await call(staff,`/api/families/${f.id}/invites`,{role:'parent'}),c=await context();
 const token=new URLSearchParams(new URL(invitation.url).hash.slice(1)).get('token'),username='logout-'+randomUUID(),password=randomUUID()+'aA9';
 await call(c,'/api/invite',{token,name:'合成竞态家长',username,password});const user=(await call(c,'/api/session')).user;
 const a=await call(staff,'/api/assessments',{familyId:f.id,respondentId:user.id,scaleVersionId:'nova-family-demo@1.0.0',locale:'zh-CN'});
 const page=await c.newPage();page.on('pageerror',e=>errors.push(e.name));await page.goto(base+'/#assessment/'+a.id);await page.locator('.survey-assent-panel input').check();
 const events:{operation:string;status:number}[]=[];
 page.on('response',r=>{const pathname=new URL(r.url()).pathname;if(pathname==='/api/auth/logout'||pathname===`/api/assessments/${a.id}`&&r.request().method()==='PATCH')events.push({operation:pathname.endsWith('logout')?'logout':'draft',status:r.status()});});
 return {c,page,id:a.id,events,login:()=>call(c,'/api/auth/login',{username,password})};
}
async function choose(page:Page,index=0){await page.locator('.survey-questions label').filter({has:page.locator('input[type=radio]')}).nth(index).click();}
const logout=(p:Page)=>p.locator('.sidebar').getByRole('button',{name:/退出登录|登出/,exact:true});
const loggedOut=(p:Page)=>p.getByRole('heading',{name:/登录工作空间|登入工作空間/}).waitFor();
try{
 {
  const f=await fixture(),entered=deferred(),release=deferred();let patches=0;
  await f.page.route(`**/api/assessments/${f.id}?*`,async r=>{if(r.request().method()!=='PATCH')return r.continue();patches++;if(patches===1){entered.resolve();await release.promise;}await r.continue();});
  await choose(f.page);await entered.promise;await choose(f.page,1);await logout(f.page).click();
  await f.page.waitForFunction(()=>document.querySelector<HTMLFieldSetElement>('.survey-questions')?.disabled===true);assert.equal(f.events.some(e=>e.operation==='logout'),false);
  await f.page.screenshot({path:path.join(out,'pending-logout.png')});release.resolve();await loggedOut(f.page);await f.login();
  const saved=await call(f.c,`/api/assessments/${f.id}`);assert.equal(saved.draftAnswers.q1,1);assert.equal(saved.draftRevision,2);
  assert.deepEqual(f.events,[{operation:'draft',status:200},{operation:'draft',status:200},{operation:'logout',status:200}]);
  checks.push({case:'in-flight-save-plus-newest-edit',events:f.events,revision:saved.draftRevision});await f.c.close();
 }
 {
  const f=await fixture();let patchAttempts=0;
  await f.page.route(`**/api/assessments/${f.id}?*`,async r=>{if(r.request().method()!=='PATCH')return r.continue();patchAttempts++;await r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'合成保存失败',code:'TEST_SAVE_FAILURE'})});});
  await choose(f.page);await logout(f.page).click();await f.page.getByText(/已保留登录状态|已保留登入狀態/).waitFor();
  assert.ok((await call(f.c,'/api/session')).user);assert.equal(f.events.some(e=>e.operation==='logout'),false);assert.equal(await f.page.locator('.survey-questions').evaluate(e=>(e as HTMLFieldSetElement).disabled),false);
  await f.page.screenshot({path:path.join(out,'failed-save-keeps-session.png')});await f.page.unroute(`**/api/assessments/${f.id}?*`);
  await f.page.locator('.error-notice').getByRole('button',{name:/退出登录|登出/,exact:true}).click();await loggedOut(f.page);await f.login();const saved=await call(f.c,`/api/assessments/${f.id}`);assert.equal(saved.draftAnswers.q1,0);
  checks.push({case:'failed-save-retains-login-and-retry',patchAttempts,events:f.events});await f.c.close();
 }
 {
  const f=await fixture(),entered=deferred(),release=deferred();
  await f.page.route(`**/api/assessments/${f.id}?*`,async r=>{if(r.request().method()!=='PATCH')return r.continue();entered.resolve();await release.promise;await r.continue();});
  await choose(f.page);await f.page.locator('.back-link').click();await entered.promise;await logout(f.page).click();assert.equal(f.events.some(e=>e.operation==='logout'),false);
  release.resolve();await loggedOut(f.page);await f.login();const saved=await call(f.c,`/api/assessments/${f.id}`);assert.equal(saved.draftAnswers.q1,0);
  assert.deepEqual(f.events,[{operation:'draft',status:200},{operation:'logout',status:200}]);checks.push({case:'leave-questionnaire-then-logout',events:f.events});await f.c.close();
 }
 {
  const f=await fixture();await choose(f.page);const otherLocale=process.env.NOVA_REGION==='HK'?'简':'繁';
  await f.page.getByRole('button',{name:otherLocale,exact:true}).click();await f.page.locator('.survey-assent-panel input').waitFor();await logout(f.page).click();await loggedOut(f.page);await f.login();
  const saved=await call(f.c,`/api/assessments/${f.id}`);assert.equal(saved.draftAnswers.q1,0);assert.ok(f.events.every(e=>e.status===200));checks.push({case:'locale-remount-then-logout',events:f.events});await f.c.close();
 }
 {
  const f=await fixture();await call(f.c,`/api/assessments/${f.id}`,{answers:{q1:2},acknowledged:true,revision:0},'PATCH');
  await choose(f.page);await logout(f.page).click();await f.page.getByText(/已保留登录状态|已保留登入狀態/).waitFor();await f.page.locator('.draft-conflict').waitFor();
  assert.ok((await call(f.c,'/api/session')).user);assert.equal(f.events.some(e=>e.operation==='logout'),false);assert.ok(f.events.some(e=>e.status===409));
  await f.page.getByRole('button',{name:/重新载入最新草稿|重新載入最新草稿|载入最新草稿|載入最新草稿/}).click();await f.page.locator('.survey-assent-panel input').waitFor();await logout(f.page).click();await loggedOut(f.page);
  checks.push({case:'conflict-blocks-logout-until-reload',events:f.events});await f.c.close();
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,checks,evidence:out}));
}catch(e){errors.push(e instanceof Error?e.message:String(e));console.error(JSON.stringify({passed:false,checks,errors,evidence:out}));process.exitCode=1;}
finally{await writeFile(path.join(out,'results.json'),JSON.stringify({passed:!errors.length,checks,errors},null,2));await browser.close();}
