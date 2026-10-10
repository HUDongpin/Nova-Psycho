import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium, type BrowserContext, type Page} from 'playwright';
import {parentScale, childScale, teacherScale} from '../src/domain/triad-scales';
import {previewAnswers} from '../src/domain/triad-report';
import {pool, closeDatabase} from '../src/lib/db';
import {processOneJob} from '../src/lib/worker';
import {closePdfBrowser} from '../src/lib/pdf';

const label=process.argv[2]??'after';assert.ok(['before','after'].includes(label));
const integration=process.env.NOVA_INTEGRATION_OUTPUT_DIR!==undefined;
assert.equal(process.cwd(),'/Volumes/Mars/Nova Psycho Helper');
const scope=path.resolve(`work/qa/fixes-20261007/${integration?'06-integration-regression':'04-waiting-refresh'}`);
const out=path.resolve(process.env.NOVA_INTEGRATION_OUTPUT_DIR??path.join(scope,'followup-mutation'));
const base=process.env.NOVA_PUBLIC_URL??'http://127.0.0.1:3114';
assert.ok(out===scope||out.startsWith(scope+path.sep),'Evidence must remain in the matching task directory');
assert.equal(base,integration?'http://127.0.0.1:3100':'http://127.0.0.1:3114');
const database=new URL(process.env.DATABASE_URL!);
assert.equal(database.pathname,integration?'/nova_fix06_20261007_cn':'/nova_fix04_followup_20261007_cn');
assert.ok(['localhost','127.0.0.1'].includes(database.hostname));
assert.equal(process.env.NOVA_AI_ENABLED,'false');assert.equal(process.env.NOVA_PUBLIC_URL,base);
assert.ok(path.resolve(process.env.NOVA_REPORT_DIR??'').startsWith(scope+path.sep),'Private reports must remain in the matching task directory');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const evidence:{label:string;status:string;cases:Record<string,unknown>[];browserErrors:string[]}={label,status:'running',cases:[],browserErrors:[]};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function context(){const c=await browser.newContext({viewport:{width:1440,height:1000}});await c.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());return c;}
async function call(c:BrowserContext,url:string,data?:unknown,method=data===undefined?'GET':'POST'){
 const response=await c.request.fetch(base+url,{method,headers:{Origin:base},...(data===undefined?{}:{data})});
 assert.ok(response.ok(),`${url} status ${response.status()}`);return response.json();
}
async function family(){
 const parent=await context(),suffix=randomUUID().slice(0,8),password=randomUUID()+'aA9';
 const started=await call(parent,'/api/triad/parent',{parentName:'合成突变家长',username:`mutation-${suffix}-parent`,password,relationship:'母亲',childName:'合成突变孩子',birthDate:'2013-06-15',grade:'小学四至六年级',accepted:true});
 const workspace=await call(parent,'/api/workspace');assert.equal(workspace.assessments.length,1);
 const id=workspace.assessments[0].id;assert.equal(workspace.assessments[0].status,'pending');
 const joinOthers=async()=>{
  for(const role of ['student','teacher'] as const){const c=await context();await call(c,'/api/triad/join',{code:started.joinCode,role,name:'合成突变'+role,username:`mutation-${suffix}-${role}`,password});const w=await call(c,'/api/workspace');const assessment=w.assessments.find((a:{canRespond:boolean})=>a.canRespond);await call(c,`/api/assessments/${assessment.id}/submit`,{answers:previewAnswers(role==='student'?childScale:teacherScale,'calm'),acknowledged:true,revision:0});await c.close();}
 };
 return {parent,id,familyId:started.familyId,joinOthers};
}
async function open(c:BrowserContext,hash:string){const page=await c.newPage();page.on('pageerror',e=>evidence.browserErrors.push(e.name));await page.goto(base+'/#'+hash);return page;}
async function holdOldWorkspace(page:Page,status:number=200){
 let release!:()=>void,entered!:(value:unknown)=>void;
 const gate=new Promise<void>(resolve=>release=resolve),ready=new Promise<unknown>(resolve=>entered=resolve);
 const metrics={requests:0,active:0,maxConcurrent:0,oldStatuses:[] as string[],responses:[] as string[][]};
 await page.route('**/api/workspace?*',async route=>{
  metrics.requests++;const n=metrics.requests;metrics.active++;metrics.maxConcurrent=Math.max(metrics.maxConcurrent,metrics.active);
  try{
   const response=await route.fetch();const data=await response.json();
   if(n===1){metrics.oldStatuses=data.assessments.map((a:{status:string})=>a.status);entered(data);await gate;}
   metrics.responses.push(data.assessments.map((a:{status:string})=>a.status));
   if(n===1&&status!==200)await route.fulfill({status,json:{code:'SYNTHETIC_FAILURE',error:'Synthetic pre-mutation failure'}}).catch(()=>{});
   else await route.fulfill({response}).catch(()=>{});
  }finally{metrics.active--;}
 });
 await page.getByRole('button',{name:'刷新',exact:true}).click();await ready;
 return {release,metrics};
}
async function publish(id:string){for(let attempt=0;attempt<8;attempt++){if((await pool().query('SELECT id FROM reports WHERE id=$1',[id])).rowCount)return;assert.equal(await processOneJob(),true);}throw Error('Target report did not publish');}
async function run(name:string,body:(record:Record<string,unknown>)=>Promise<void>){const record:Record<string,unknown>={name,status:'running'};evidence.cases.push(record);try{await body(record);record.status='passed';}catch(error){record.status='failed';record.error=error instanceof Error?error.message:'Unknown error';console.error(`${name}: ${record.error}`);}}
try{
 for(const oldStatus of [200,503])await run(`UI_submit_old_${oldStatus}`,async record=>{
  const f=await family();
  await call(f.parent,`/api/assessments/${f.id}`,{answers:previewAnswers(parentScale,'calm'),acknowledged:true,revision:0},'PATCH');
  const page=await open(f.parent,'assessment/'+f.id);await page.locator('.survey-assent-panel input[type=checkbox]').check();
  const submit=page.getByRole('button',{name:'确认提交',exact:true});await submit.waitFor();
  const hold=await holdOldWorkspace(page,oldStatus);record.oldStatuses=hold.metrics.oldStatuses;assert.deepEqual(hold.metrics.oldStatuses,['pending']);
  const accepted=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/assessments/${f.id}/submit`);await submit.click();assert.equal((await accepted).status(),200);
  await page.getByText('已完成提交',{exact:true}).waitFor();
  assert.equal((await call(f.parent,'/api/workspace')).assessments[0].status,'queued');
  await sleep(250);hold.release();await sleep(8000);
  record.metrics=hold.metrics;await page.screenshot({path:`${out}/${label}-${oldStatus}-submitted.png`,fullPage:true});
  assert.ok(hold.metrics.requests>=2,'Mutation must issue a workspace request after the held pre-submit read');
  assert.equal(hold.metrics.maxConcurrent,1,'Workspace reads must remain serial');
  assert.ok(hold.metrics.responses.slice(1).some(s=>s.includes('queued')),'Post-submit queued status must be observed');
  if(oldStatus===200){await f.joinOthers();await publish(f.id);await page.getByRole('button',{name:'查看报告',exact:true}).waitFor({timeout:12000});record.autoReportVisible=true;await page.screenshot({path:`${out}/${label}-submitted-report.png`,fullPage:true});}
  await f.parent.close();
 });
 await run('UI_retry_held_failed_snapshot',async record=>{
  const f=await family();await call(f.parent,`/api/assessments/${f.id}/submit`,{answers:previewAnswers(parentScale,'calm'),acknowledged:true,revision:0});await f.joinOthers();
  const staffId=randomUUID(),staff=await context();
  await pool().query("INSERT INTO users(id,region,username,name,role,demo) VALUES($1,'CN',$2,'合成补修负责人','staff',true)",[staffId,'mutation-staff-'+staffId]);
  await pool().query('UPDATE families SET assigned_to=$1 WHERE id=$2',[staffId,f.familyId]);
  await pool().query("UPDATE report_jobs SET state='failed',attempts=3,last_error_code='SYNTHETIC_FAILURE' WHERE assessment_id=$1",[f.id]);
  await pool().query("UPDATE assessments SET status='failed' WHERE family_id=$1 AND status='queued'",[f.familyId]);
  await call(staff,'/api/auth/demo',{accountId:staffId});const page=await open(staff,'assessments');
  const retry=page.getByRole('button',{name:/重新排队生成报告/}).first();await retry.waitFor();
  const hold=await holdOldWorkspace(page);assert.ok(hold.metrics.oldStatuses.every(s=>s==='failed'));record.oldStatuses=hold.metrics.oldStatuses;
  const accepted=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/retry-report'));await retry.click();assert.equal((await accepted).status(),200);
  assert.ok((await call(staff,'/api/workspace')).assessments.every((a:{status:string})=>a.status==='queued'));
  await sleep(250);hold.release();await sleep(8000);record.metrics=hold.metrics;
  record.retryButtons=await page.getByRole('button',{name:/重新排队生成报告/}).count();await page.screenshot({path:`${out}/${label}-retry.png`,fullPage:true});
  assert.ok(hold.metrics.requests>=2,'Retry must issue a workspace request after the held failed read');assert.equal(hold.metrics.maxConcurrent,1);assert.equal(record.retryButtons,0);
  assert.ok(hold.metrics.responses.slice(1).some(s=>s.every(status=>status==='queued')));await publish(f.id);
  await page.getByRole('button',{name:'查看报告',exact:true}).first().waitFor({timeout:12000});record.autoReportVisible=true;const stopped=hold.metrics.requests;await sleep(7500);assert.equal(hold.metrics.requests,stopped);
  await staff.close();await f.parent.close();
 });
 if(label==='after')await run('UI_submit_then_logout_cancels_followup',async record=>{
  const f=await family();await call(f.parent,`/api/assessments/${f.id}`,{answers:previewAnswers(parentScale,'calm'),acknowledged:true,revision:0},'PATCH');
  const page=await open(f.parent,'assessment/'+f.id);await page.locator('.survey-assent-panel input[type=checkbox]').check();
  const hold=await holdOldWorkspace(page);const accepted=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/assessments/${f.id}/submit`);
  await page.getByRole('button',{name:'确认提交',exact:true}).click();assert.equal((await accepted).status(),200);await page.getByText('已完成提交',{exact:true}).waitFor();
  await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByRole('button',{name:'登录',exact:true}).waitFor();
  hold.release();await sleep(7500);record.metrics=hold.metrics;assert.equal(hold.metrics.requests,1,'Cancelled post-mutation refresh must not revive after logout');
  assert.equal(await page.locator('.app-shell').count(),0);await f.parent.close();
 });
 evidence.status=evidence.cases.every(c=>c.status==='passed')&&evidence.browserErrors.length===0?'passed':'failed';
 if(evidence.status==='failed')process.exitCode=1;
 console.log(JSON.stringify({status:evidence.status,cases:evidence.cases,browserErrors:evidence.browserErrors}));
}finally{await writeFile(`${out}/${label}.json`,JSON.stringify(evidence,null,2));await browser.close();await closePdfBrowser();await closeDatabase();}
