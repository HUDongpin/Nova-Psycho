import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium, type BrowserContext} from 'playwright';
import {parentScale, childScale, teacherScale} from '../src/domain/triad-scales';
import {previewAnswers} from '../src/domain/triad-report';
import {closeDatabase} from '../src/lib/db';
import {processOneJob} from '../src/lib/worker';
import {closePdfBrowser} from '../src/lib/pdf';
const mode=process.argv[2];assert.ok(mode==='baseline'||mode==='fixed');
const integration=process.env.NOVA_INTEGRATION_OUTPUT_DIR!==undefined;
assert.equal(process.cwd(),'/Volumes/Mars/Nova Psycho Helper');
const scope=path.resolve(`work/qa/fixes-20261007/${integration?'06-integration-regression':'04-waiting-refresh'}`);
const out=path.resolve(process.env.NOVA_INTEGRATION_OUTPUT_DIR??scope), base=process.env.NOVA_PUBLIC_URL??'http://127.0.0.1:3114';
assert.ok(out===scope||out.startsWith(scope+path.sep),'Evidence must remain in the matching task directory');
assert.equal(base,integration?'http://127.0.0.1:3100':'http://127.0.0.1:3114');
const url=new URL(process.env.DATABASE_URL!);assert.equal(url.pathname,integration?'/nova_fix06_20261007_cn':'/nova_fix04_20261007_cn');assert.ok(['localhost','127.0.0.1'].includes(url.hostname));assert.equal(process.env.NOVA_AI_ENABLED,'false');
assert.ok(path.resolve(process.env.NOVA_REPORT_DIR??'').startsWith(scope+path.sep),'Private reports must remain in the matching task directory');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const result:any={mode,status:'running',checks:[],browserErrors:[]};
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function context(){const c=await browser.newContext({viewport:{width:1440,height:1000}});await c.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());return c;}
async function call(c:BrowserContext,path:string,data?:unknown){const r=await c.request.fetch(base+path,{method:data===undefined?'GET':'POST',headers:{Origin:base},...(data===undefined?{}:{data})});assert.ok(r.ok(),`${path.split('?')[0]} ${r.status()}`);return r.json();}
try{
 const contexts={parent:await context(),student:await context(),teacher:await context()};
 const suffix=randomUUID().slice(0,8),password=randomUUID()+'aA9';
 const started=await call(contexts.parent,'/api/triad/parent',{parentName:'合成刷新家长',username:`refresh-${suffix}-parent`,password,relationship:'母亲',childName:'合成刷新孩子',birthDate:'2013-06-15',grade:'小学四至六年级',accepted:true});
 for(const role of ['student','teacher'] as const)await call(contexts[role],'/api/triad/join',{code:started.joinCode,role,name:'合成刷新'+role,username:`refresh-${suffix}-${role}`,password});
 const ids:Record<string,string>={};const pages:any={};const scales={parent:parentScale,student:childScale,teacher:teacherScale};
 for(const role of ['parent','student','teacher'] as const){ids[role]=(await call(contexts[role],'/api/workspace')).assessments.find((a:any)=>a.canRespond).id;pages[role]=await contexts[role].newPage();pages[role].on('pageerror',(e:Error)=>result.browserErrors.push(e.name));}
 const submit=async(role:keyof typeof contexts)=>call(contexts[role],`/api/assessments/${ids[role]}/submit`,{answers:previewAnswers(scales[role],'calm'),acknowledged:true,revision:0});
 await submit('parent');const page=pages.parent;const requests:number[]=[];
 page.on('request',(r:any)=>{if(new URL(r.url()).pathname==='/api/workspace')requests.push(Date.now());});
 await page.goto(base);await page.getByRole('heading',{name:/欢迎回来/}).waitFor();
 const before=await call(contexts.parent,'/api/workspace');assert.equal(before.reports.length,0);assert.equal(before.assessments.find((a:any)=>a.id===ids.parent).phase,'waiting');
 await page.screenshot({path:`${out}/${mode}-waiting.png`,fullPage:true});
 let submittedPage:any;
 if(mode==='fixed'){
  submittedPage=await contexts.parent.newPage();await submittedPage.goto(base+'/#assessment/'+ids.parent);
  await submittedPage.getByText('已完成提交',{exact:true}).waitFor();
  assert.equal(await submittedPage.getByRole('button',{name:'查看报告',exact:true}).count(),0);
 }
 const beforeRequests=requests.length;
 for(const role of ['student','teacher'] as const){await pages[role].goto(base);await pages[role].getByRole('heading',{name:'测评任务',exact:true}).waitFor();await submit(role);}
 assert.equal(await processOneJob(),true);
 const backend=await call(contexts.parent,'/api/workspace');assert.equal(backend.reports.length,1);assert.ok(backend.assessments.every((a:any)=>a.status==='published'));
 result.reportId=backend.reports[0].id;result.familyId=started.familyId;result.assessmentIds=ids;
 await delay(11000);
 const text=await page.locator('main').innerText();result.backendReports=backend.reports.length;result.automaticWorkspaceRequests=requests.length-beforeRequests;result.pageHasReport=await page.getByRole('button',{name:'查看报告',exact:true}).count()>0;result.reportCountOne=text.includes('已生成报告\n1');
 await page.screenshot({path:`${out}/${mode}-after.png`,fullPage:true});
 if(mode==='baseline'){assert.equal(result.pageHasReport,false);assert.equal(result.automaticWorkspaceRequests,0);result.checks.push('original_bug_reproduced_backend_1_page_0_auto_requests_0');}
 else{assert.ok(result.pageHasReport);assert.ok(result.reportCountOne);assert.ok(result.automaticWorkspaceRequests>0&&result.automaticWorkspaceRequests<=10);result.checks.push('parent_untouched_dashboard_report_auto_visible_count_1');}
 const response=page.waitForResponse((r:any)=>new URL(r.url()).pathname==='/api/workspace');await page.getByRole('button',{name:'刷新',exact:true}).click();assert.equal((await response).status(),200);await page.getByRole('button',{name:'查看报告',exact:true}).first().waitFor();result.checks.push('manual_refresh_still_works');
 if(mode==='fixed'){
  await submittedPage.getByRole('button',{name:'查看报告',exact:true}).waitFor();
  await submittedPage.screenshot({path:`${out}/fixed-submitted-ready.png`,fullPage:true});
  const reportRequest=submittedPage.waitForResponse((r:any)=>new URL(r.url()).pathname==='/api/reports/'+result.reportId);
  await submittedPage.getByRole('button',{name:'查看报告',exact:true}).click();assert.equal((await reportRequest).status(),200);
  await submittedPage.locator('.report-frame').waitFor();
  const pdf=await contexts.parent.request.get(base+'/api/reports/'+result.reportId+'/pdf');assert.equal(pdf.status(),200);await writeFile(`${out}/fixed-report.pdf`,await pdf.body());
  result.checks.push('submitted_panel_auto_report_entry_opens_authorized_report_and_pdf');
  const stopped=requests.length;await delay(8000);assert.equal(requests.length,stopped);result.checks.push('published_stops_polling');
  for(const role of ['student','teacher'] as const){await pages[role].reload();await pages[role].getByRole('heading',{name:'测评任务',exact:true}).waitFor();assert.equal(await pages[role].getByRole('button',{name:'查看报告',exact:true}).count(),0);const w=await call(contexts[role],'/api/workspace');assert.equal(w.reports.length,0);for(const suffix of ['','/document','/pdf'])assert.equal((await contexts[role].request.get(base+'/api/reports/'+result.reportId+suffix)).status(),403);}
  result.checks.push('student_teacher_no_reports_UI_workspace_JSON_HTML_PDF_denied');
  await page.getByRole('button',{name:'繁',exact:true}).click();await page.getByRole('button',{name:'查看報告',exact:true}).first().waitFor();
  assert.equal((await page.getByRole('button',{name:'繁',exact:true}).getAttribute('aria-pressed')),'true');
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'開啟導覽',exact:true}).click();
  await page.locator('.sidebar-open').waitFor();await page.keyboard.press('Escape');assert.equal(await page.locator('.sidebar-open').count(),0);
  await page.getByRole('button',{name:'開啟導覽',exact:true}).click();await page.locator('nav a[href="#reports"]').click();
  await page.getByRole('heading',{name:'成長報告',exact:true}).waitFor();assert.equal(await page.locator('.sidebar-open').count(),0);
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.sidebar')!).visibility==='hidden');
  await page.screenshot({path:`${out}/fixed-mobile-hk.png`,fullPage:true});
  result.checks.push('language_switch_and_mobile_menu_navigation_escape');
 }
 result.status='passed';console.log(JSON.stringify({mode,status:result.status,backendReports:result.backendReports,automaticWorkspaceRequests:result.automaticWorkspaceRequests,pageHasReport:result.pageHasReport,checks:result.checks}));
}catch(e){result.status='failed';result.error=e instanceof Error?e.message:'Unknown error';console.error('probe_failed '+result.error);process.exitCode=1;}
finally{await writeFile(`${out}/${mode}.json`,JSON.stringify(result,null,2));await browser.close();await closePdfBrowser();await closeDatabase();}
