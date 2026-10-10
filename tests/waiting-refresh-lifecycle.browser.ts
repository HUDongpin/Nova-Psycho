import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium, type BrowserContext, type Page} from 'playwright';
import {parentScale} from '../src/domain/triad-scales';
import {previewAnswers} from '../src/domain/triad-report';
const integration=process.env.NOVA_INTEGRATION_OUTPUT_DIR!==undefined;
assert.equal(process.cwd(),'/Volumes/Mars/Nova Psycho Helper');
const scope=path.resolve(`work/qa/fixes-20261007/${integration?'06-integration-regression':'04-waiting-refresh'}`);
const out=path.resolve(process.env.NOVA_INTEGRATION_OUTPUT_DIR??scope), base=process.env.NOVA_PUBLIC_URL??'http://127.0.0.1:3114';
assert.ok(out===scope||out.startsWith(scope+path.sep),'Evidence must remain in the matching task directory');
assert.equal(base,integration?'http://127.0.0.1:3100':'http://127.0.0.1:3114');
const database=new URL(process.env.DATABASE_URL!);assert.equal(database.pathname,integration?'/nova_fix06_20261007_cn':'/nova_fix04_20261007_cn');assert.ok(['localhost','127.0.0.1'].includes(database.hostname));assert.equal(process.env.NOVA_AI_ENABLED,'false');
assert.ok(path.resolve(process.env.NOVA_REPORT_DIR??'').startsWith(scope+path.sep),'Private reports must remain in the matching task directory');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const evidence:any={status:'running',checks:[],browserErrors:[]};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const match='**/api/workspace?*';
async function call(c:BrowserContext,path:string,data?:unknown){const r=await c.request.fetch(base+path,{method:data===undefined?'GET':'POST',headers:{Origin:base},...(data===undefined?{}:{data})});assert.ok(r.ok(),`${path} ${r.status()}`);return r.json();}
async function waiting(){
 const c=await browser.newContext({viewport:{width:1440,height:1000}});await c.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
 const id=randomUUID().slice(0,8);await call(c,'/api/triad/parent',{parentName:'合成刷新生命周期家长',username:'lifecycle-'+id,password:randomUUID()+'aA9',relationship:'母亲',childName:'合成生命周期孩子',birthDate:'2013-06-15',grade:'小学四至六年级',accepted:true});
 const w=await call(c,'/api/workspace');const assessment=w.assessments.find((a:any)=>a.canRespond);await call(c,`/api/assessments/${assessment.id}/submit`,{answers:previewAnswers(parentScale,'calm'),acknowledged:true,revision:0});
 const page=await c.newPage();page.on('pageerror',e=>evidence.browserErrors.push(e.name));await page.goto(base);await page.getByRole('heading',{name:/欢迎回来/}).waitFor();
 return {c,page};
}
async function loginVisible(page:Page){await page.getByRole('button',{name:'登录',exact:true}).waitFor();}
try{
 {
  const {c,page}=await waiting();let active=0,max=0,count=0;let entered!:()=>void;const started=new Promise<void>(r=>entered=r);
  await page.route(match,async route=>{count++;active++;max=Math.max(max,active);entered();const response=await route.fetch();await sleep(7800);await route.fulfill({response}).catch(()=>{});active--;});
  await started;await page.getByRole('button',{name:'刷新',exact:true}).click();await sleep(4200);assert.equal(count,1,'Manual refresh joins slow automatic request');assert.equal(max,1);
  await sleep(7800);assert.ok(count>=2&&count<=3,'Next request only after completion plus delay');assert.equal(max,1);evidence.slow={count,maxConcurrent:max};evidence.checks.push('slow_poll_single_flight_manual_refresh_coalesces');await page.unrouteAll({behavior:'wait'});await c.close();
 }
 {
  const {c,page}=await waiting();let oldEntered!:()=>void,releaseOld!:()=>void;const started=new Promise<void>(r=>oldEntered=r),release=new Promise<void>(r=>releaseOld=r);let oldRequests=0;
  await page.route(match,async route=>{if(new URL(route.request().url()).searchParams.get('locale')==='zh-CN'){oldRequests++;const response=await route.fetch();oldEntered();await release;const data=await response.json();data.user.name='STALE_OLD_LOCALE';await route.fulfill({json:data}).catch(()=>{});}else await route.continue();});
  await started;const hk=page.waitForResponse(r=>r.url().includes('/api/workspace?locale=zh-HK'));await page.getByRole('button',{name:'繁',exact:true}).click();assert.equal((await hk).status(),200);releaseOld();await sleep(1200);
  assert.equal(await page.getByText('STALE_OLD_LOCALE').count(),0);await page.getByRole('button',{name:'登出',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'繁',exact:true}).getAttribute('aria-pressed'),'true');
  const oldCount=oldRequests;await sleep(4000);assert.equal(oldRequests,oldCount,'Old locale polling stopped');evidence.checks.push('locale_change_aborts_old_response_and_old_timer');await c.close();
 }
 {
  const {c,page}=await waiting();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);let requests=0;
  await page.route(match,async route=>{requests++;const response=await route.fetch();entered();await held;await route.fulfill({response}).catch(()=>{});});await started;
  await page.getByRole('button',{name:'退出登录',exact:true}).click();await loginVisible(page);release();await sleep(8000);assert.equal(requests,1);await loginVisible(page);assert.equal(await page.locator('.app-shell').count(),0);evidence.checks.push('logout_aborts_pending_request_does_not_restore_workspace_stops_timer');await c.close();
 }
 {
  const {c,page}=await waiting();let failures=0;await page.route('**/api/auth/logout?*',route=>route.fulfill({status:500,json:{error:'Synthetic logout failure',code:'TEST_FAILURE'}}));
  await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByText('Synthetic logout failure').waitFor();
  await page.route(match,async route=>{failures++;await route.continue();});await sleep(4200);assert.ok(failures>=1&&failures<=2);await page.getByRole('button',{name:'退出登录',exact:true}).waitFor();evidence.checks.push('failed_logout_restores_waiting_poll');await c.close();
 }
 {
  const {c,page}=await waiting();let requests=0;await page.route(match,route=>{requests++;return route.fulfill({status:401,json:{error:'Synthetic expired session',code:'UNAUTHENTICATED'}});});await loginVisible(page);await sleep(8000);assert.equal(requests,1);evidence.checks.push('401_clears_workspace_and_stops_polling');await c.close();
 }
 {
  const {c,page}=await waiting();let requests=0;const times:number[]=[];await page.route(match,route=>{requests++;times.push(Date.now());return route.fulfill({status:503,json:{error:'Synthetic temporary failure',code:'TEST_FAILURE'}});});await sleep(12000);assert.ok(requests>=2&&requests<=4);assert.ok(times.slice(1).every((n,i)=>n-times[i]>=3400));evidence.transientFailure={requests,intervals:times.slice(1).map((n,i)=>n-times[i])};
  await page.unroute(match);const recovered=page.waitForResponse(r=>r.url().includes('/api/workspace')&&r.status()===200);await recovered;assert.equal(await page.getByText('Synthetic temporary failure').count(),0);evidence.checks.push('errors_retry_at_bounded_frequency_then_recover');
  let later=0;page.on('request',r=>{if(new URL(r.url()).pathname==='/api/workspace')later++;});await page.goto('about:blank');const stopped=later;await sleep(8000);assert.equal(later,stopped);evidence.checks.push('unmount_navigation_stops_requests');await c.close();
 }
 assert.deepEqual(evidence.browserErrors,[]);evidence.status='passed';console.log(JSON.stringify(evidence));
}catch(e){evidence.status='failed';evidence.error=e instanceof Error?e.message:'Unknown error';console.error('lifecycle_failed '+evidence.error);process.exitCode=1;}
finally{await writeFile(`${out}/lifecycle.json`,JSON.stringify(evidence,null,2));await browser.close();}
