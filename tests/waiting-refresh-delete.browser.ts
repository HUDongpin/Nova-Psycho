import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium, type BrowserContext} from 'playwright';
import {parentScale, childScale, teacherScale} from '../src/domain/triad-scales';
import {previewAnswers} from '../src/domain/triad-report';
import {pool,closeDatabase} from '../src/lib/db';
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
assert.equal(database.pathname,integration?'/nova_fix06_20261007_cn':'/nova_fix04_delete_20261007_cn');
assert.ok(['localhost','127.0.0.1'].includes(database.hostname));
assert.equal(process.env.NOVA_AI_ENABLED,'false');assert.equal(process.env.NOVA_PUBLIC_URL,base);
assert.ok(path.resolve(process.env.NOVA_REPORT_DIR??'').startsWith(scope+path.sep),'Private reports must remain in the matching task directory');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const evidence:{status:string;cases:Record<string,unknown>[];errors:string[]}={status:'running',cases:[],errors:[]};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function context(){const c=await browser.newContext({viewport:{width:1440,height:1000}});await c.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());return c;}
async function call(c:BrowserContext,url:string,data?:unknown){const r=await c.request.fetch(base+url,{method:data===undefined?'GET':'POST',headers:{Origin:base},...(data===undefined?{}:{data})});assert.ok(r.ok(),`${url} ${r.status()}`);return r.json();}
try{
 for(const actorRole of ['admin','parent'] as const){
  const record:Record<string,unknown>={actorRole,status:'running'};evidence.cases.push(record);
  try{
   const parent=await context(),id=randomUUID().slice(0,8),password=randomUUID()+'aA9',childName='合成删除竞争'+id;
   const f=await call(parent,'/api/triad/parent',{parentName:'合成删除家长',username:'delete-'+id,password,relationship:'母亲',childName,birthDate:'2013-06-15',grade:'小学四至六年级',accepted:true});
   let reportId:string|undefined;
   if(actorRole==='admin'){
    const p=(await call(parent,'/api/workspace')).assessments[0];reportId=p.id;
    await call(parent,`/api/assessments/${p.id}/submit`,{answers:previewAnswers(parentScale,'calm'),acknowledged:true,revision:0});
    for(const role of ['student','teacher'] as const){const c=await context();await call(c,'/api/triad/join',{code:f.joinCode,role,name:'合成删除'+role,username:role+'-'+id,password});const a=(await call(c,'/api/workspace')).assessments.find((a:{canRespond:boolean})=>a.canRespond);await call(c,`/api/assessments/${a.id}/submit`,{answers:previewAnswers(role==='student'?childScale:teacherScale,'calm'),acknowledged:true,revision:0});await c.close();}
    assert.equal(await processOneJob(),true);
   }
   const actor=actorRole==='admin'?await context():parent;
   if(actorRole==='admin'){const adminId=randomUUID();await pool().query("INSERT INTO users(id,region,username,name,role,demo) VALUES($1,'CN',$2,'合成删除管理员','admin',true)",[adminId,'delete-admin-'+id]);await call(actor,'/api/auth/demo',{accountId:adminId});}
   const page=await actor.newPage();page.on('pageerror',e=>evidence.errors.push(e.name));await page.goto(base+'/#family/'+f.familyId);await page.getByRole('button',{name:'删除家庭数据',exact:true}).waitFor();
   let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);
   const metrics={requests:0,active:0,maxConcurrent:0,oldFamily:false,oldReport:false,newFamilyCounts:[] as number[]};
   await page.route('**/api/workspace?*',async route=>{metrics.requests++;const n=metrics.requests;metrics.active++;metrics.maxConcurrent=Math.max(metrics.maxConcurrent,metrics.active);try{const r=await route.fetch(),w=await r.json();if(n===1){assert.ok(w.assessments.every((a:{status:string})=>a.status!=='queued'));metrics.oldFamily=w.families.some((a:{id:string})=>a.id===f.familyId);metrics.oldReport=w.reports.some((a:{id:string})=>a.id===reportId);entered();await gate;}else metrics.newFamilyCounts.push(w.families.filter((a:{id:string})=>a.id===f.familyId).length);await route.fulfill({response:r}).catch(()=>{});}finally{metrics.active--;}});
   await page.getByRole('button',{name:'刷新',exact:true}).click();await ready;
   await page.getByRole('button',{name:'删除家庭数据',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByRole('textbox').fill(childName);
   const deleted=page.waitForResponse(r=>r.request().method()==='DELETE'&&new URL(r.url()).pathname==='/api/families/'+f.familyId);
   await dialog.getByRole('button',{name:'永久删除',exact:true}).click();assert.equal((await deleted).status(),200);
   const session=await call(actor,'/api/session');assert.equal(Boolean(session.user),actorRole==='admin');
   assert.equal((await pool().query('SELECT id FROM families WHERE id=$1',[f.familyId])).rowCount,0);
   await sleep(250);release();await sleep(6500);record.metrics=metrics;record.sessionActive=Boolean(session.user);
   await page.screenshot({path:`${out}/delete-${label}-${actorRole}.png`,fullPage:true});
   assert.equal(metrics.maxConcurrent,1);
   if(actorRole==='admin'){
    assert.equal(metrics.oldFamily,true);assert.equal(metrics.oldReport,true);assert.ok(metrics.requests>=2,'Admin deletion must issue a workspace read after the held pre-delete read');assert.ok(metrics.newFamilyCounts.includes(0));
    assert.equal(await page.getByText(childName+'的家庭',{exact:true}).count(),0);assert.equal((await actor.request.get(base+'/api/reports/'+reportId)).status(),404);record.deletedFamilyAndReportAbsent=true;
   }else{await page.getByRole('button',{name:'登录',exact:true}).waitFor();assert.equal(metrics.requests,1);assert.equal(await page.locator('.app-shell').count(),0);record.parentSessionCleared=true;}
   record.status='passed';await actor.close();if(actor!==parent)await parent.close();
  }catch(error){record.status='failed';record.error=error instanceof Error?error.message:'Unknown error';console.error(`${actorRole}: ${record.error}`);}
 }
 evidence.status=evidence.cases.every(c=>c.status==='passed')&&evidence.errors.length===0?'passed':'failed';if(evidence.status==='failed')process.exitCode=1;console.log(JSON.stringify(evidence));
}finally{await writeFile(`${out}/delete-${label}.json`,JSON.stringify(evidence,null,2));await browser.close();await closePdfBrowser();await closeDatabase();}
