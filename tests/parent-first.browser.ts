/** Real synthetic local browser journeys; continuous workers publish all reports. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { Locale, Region, ScaleDefinition } from "../src/domain/types";
import type { Workspace, Session } from "../src/components/api";
import { stagedParentScale, stagedChildScale, topeStaffScale } from "../src/domain/triad-scales";
const origins={CN:"http://127.0.0.1:3370",HK:"http://127.0.0.1:3371"};
const output=path.resolve("work/parent-first-20261023/browser");await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.NOVA_CHROMIUM_EXECUTABLE??"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
const contexts=new Set<BrowserContext>(),errors:string[]=[],results:{scenario:string;firstReportMs:number;versions:number;passed:boolean}[]=[];
type Client={context:BrowserContext;page:Page;origin:string;locale:Locale};
async function client(region:Region,locale:Locale,mobile:boolean):Promise<Client>{
  const origin=origins[region],context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1360,height:1000},isMobile:mobile,hasTouch:mobile,reducedMotion:"reduce",serviceWorkers:"block"});
  contexts.add(context);context.setDefaultTimeout(20000);
  await context.addInitScript(locale=>localStorage.setItem("nova-locale",locale),locale);
  await context.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await context.newPage();page.on("pageerror",error=>errors.push(error.message));
  const c={context,page,origin,locale},session=await json<Session>(c,"/api/session");
  assert.equal(session.mode,"demo");assert.equal(session.region,region);assert.equal(session.authProvider,"local");
  return c;
}
async function response(c:Client,endpoint:string,method="GET",data?:unknown){
  assert.ok(endpoint.startsWith("/api/"));
  return c.context.request.fetch(c.origin+endpoint,{method,headers:{Origin:c.origin},maxRedirects:0,...(data===undefined?{}:{data})});
}
async function json<T>(c:Client,endpoint:string,method="GET",data?:unknown):Promise<T>{
  const r=await response(c,endpoint,method,data);assert.ok(r.ok(),`${method} ${endpoint}: ${r.status()}`);return r.json() as Promise<T>;
}
const workspace=(c:Client)=>json<Workspace>(c,`/api/workspace?locale=${c.locale}`);
async function loginDemo(c:Client,role:"admin"|"staff"){
  const s=await json<Session>(c,"/api/session");const account=s.demoAccounts.find(a=>a.role===role&&(role==="admin"||/[陈陳]/.test(a.name)));assert.ok(account);
  await json(c,"/api/auth/demo","POST",{accountId:account.id});return account.id;
}
const credentials=(role:"parent"|"student")=>({role,name:`合成现场验收${role}`,username:`staged_browser_${role}_${randomBytes(6).toString("hex")}`,password:randomBytes(24).toString("base64url")});
async function capture(c:Client,label:string){await c.page.screenshot({path:path.join(output,`${label}.png`),fullPage:true,animations:"disabled"});}
async function noOverflow(page:Page){const sizes=await page.evaluate(()=>[innerWidth,document.documentElement.scrollWidth,document.body.scrollWidth]);assert.ok(sizes[1]<=sizes[0]+1&&sizes[2]<=sizes[0]+1,"No horizontal overflow");}
async function fill(c:Client,id:string,scale:ScaleDefinition,label:string,share:boolean){
  const page=c.page;
  await page.goto(`${c.origin}/#assessment/${id}`);
  await page.locator('.survey-container[data-stage="intro"]').waitFor();
  await page.locator(".survey-assent-panel input[type=checkbox]").check();await page.getByTestId("survey-start").click();
  const visited=new Set<string>();
  for(let step=0;step<50;step++){
    if(await page.locator('.survey-container[data-stage="review"]').isVisible())break;
    const question=page.locator(".survey-questions .sd-question[data-name]:visible");await question.first().waitFor();assert.equal(await question.count(),1);
    const name=(await question.getAttribute("data-name"))!,item=scale.items.find(i=>i.id===name);assert.ok(item);visited.add(name);
    if(item.kind==="text"){
      if(name==="o_visit_date")await question.locator("textarea").fill("2026-10-23");
      else if(name==="c22"||name==="o_private_notes")await question.locator("textarea").fill(`PRIVATE_SYNTHETIC_${name}`);
    }else{
      const fixed:Record<string,number[]>={q22:[7],c14:[6],c23:[1],o_safety:[3],c_share_support:share?[1,3]:[0],c_share_confirm:[1]};
      const values=fixed[name]??[item.gate??item.choices[0].value];
      for(const value of values){const input=question.locator(`input[value="${value}"]`);if(!await input.isChecked())await input.locator("xpath=ancestor::label[1]").click();}
    }
    await noOverflow(page);await page.getByTestId("survey-next").click();
    await page.waitForFunction(previous=>Boolean(document.querySelector('.survey-container[data-stage="review"]'))||Array.from(document.querySelectorAll<HTMLElement>(".survey-questions .sd-question[data-name]")).find(node=>node.offsetHeight>0)?.dataset.name!==previous,name);
  }
  await page.locator('.survey-container[data-stage="review"]').waitFor();
  if(scale===stagedChildScale){
    const preview=page.getByTestId("student-sharing-preview");await preview.waitFor();
    if(share){
      assert.equal(await page.getByTestId("survey-submit").isEnabled(),false,"Final preview needs explicit confirmation");
      assert.equal(await preview.locator("li").count(),2);assert.ok(!(await preview.innerText()).includes("PRIVATE_SYNTHETIC"));
      await preview.locator('input[type="checkbox"]').check();
    }else assert.equal(await preview.locator("li").count(),0);
  }
  assert.equal(await page.getByTestId("survey-submit").isEnabled(),true);await noOverflow(page);await capture(c,`${label}-review`);
  const sent=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/assessments/${id}/submit`&&r.request().method()==="POST");
  const start=Date.now();await page.getByTestId("survey-submit").click();const r=await sent;assert.equal(r.status(),200);assert.equal((await r.json()).status,"submitted");
  await page.getByTestId("submission-state").waitFor();assert.ok(visited.size>10);
  return start;
}
async function waitVersion(parent:Client,familyId:string,version:number){
  const deadline=Date.now()+90000;
  while(Date.now()<deadline){const w=await workspace(parent);const report=w.reports.find(r=>r.familyId===familyId&&r.revision?.version===version);if(report)return report;await new Promise(resolve=>setTimeout(resolve,400));}
  assert.fail(`Continuous worker must automatically publish version ${version}`);
}
let passed=false;
try{
  for(const [region,locale,mobile,studentFirst,share] of [["CN","zh-CN",false,true,true],["CN","zh-CN",true,false,false],["HK","zh-HK",false,false,true],["HK","zh-HK",true,true,false]] as const){
    const scenario=`${region.toLowerCase()}-${mobile?"mobile":"desktop"}-${studentFirst?"student":"staff"}-first`;
    const parent=await client(region,locale,mobile),staff=await client(region,locale,mobile),student=await client(region,locale,mobile),admin=await client(region,locale,false);
    const staffId=await loginDemo(staff,"staff");await loginDemo(admin,"admin");
    await json(parent,"/api/auth/register","POST",credentials("parent"));
    const family=await json<{familyId:string;joinCode:string}>(parent,`/api/triad/family?locale=${locale}`,"POST",{requestId:randomUUID(),relationship:"母亲",childName:`合成首次到访${scenario}`,birthDate:"2014-06-01",grade:"初中",assessment:true,sensitiveData:true,parentReport:true});
    try{
      const task=(await workspace(parent)).assessments.find(a=>a.familyId===family.familyId)!;
      assert.equal((await workspace(parent)).families[0].members.length,1);
      const start=await fill(parent,task.id,stagedParentScale,`${scenario}-parent`,false);
      const first=await waitVersion(parent,family.familyId,1);
      await parent.page.getByTestId("submission-state").locator("button.primary").waitFor({timeout:90000});
      const firstReportMs=Date.now()-start;
      const firstPdf=await response(parent,`/api/reports/${first.id}/pdf?locale=${locale}`),firstHash=createHash("sha256").update(await firstPdf.body()).digest("hex");
      await capture(parent,`${scenario}-first-report-ready`);
      await json(admin,`/api/families/${family.familyId}/assignment`,"PATCH",{assignedTo:staffId});
      await staff.page.goto(`${staff.origin}/#family/${family.familyId}`);await staff.page.getByTestId("start-staff-observation").waitFor();
      await parent.page.goto(`${parent.origin}/#family/${family.familyId}`);await parent.page.locator('[data-report-version="1"]').waitFor();
      for(const [index,role] of (studentFirst?["student","staff"]:["staff","student"]).entries()){
        if(role==="student"){
          await json(student,`/api/triad/join?locale=${locale}`,"POST",{...credentials("student"),code:family.joinCode});
          const task=(await workspace(student)).assessments.find(a=>a.familyId===family.familyId)!;
          const malformed=await response(student,`/api/assessments/${task.id}/submit`,"POST",{answers:{c_share_support:1},revision:0,acknowledged:true});
          assert.equal(malformed.status(),422,"Malformed sharing is validation failure, not a server exception");
          await fill(student,task.id,stagedChildScale,`${scenario}-student`,share);
        }else{
          await staff.page.goto(`${staff.origin}/#family/${family.familyId}`);await staff.page.getByTestId("start-staff-observation").click();
          await staff.page.waitForURL(/#assessment\//);const id=staff.page.url().split("#assessment/")[1];
          await fill(staff,id,topeStaffScale,`${scenario}-staff`,false);
        }
        const report=await waitVersion(parent,family.familyId,index+2);
        // Parent stays on family page: polling must reveal the update without reload.
        await parent.page.locator(`.report-revision-label[data-report-version="${index+2}"]`).first().waitFor({timeout:90000});
        const html=(await response(parent,`/api/reports/${report.id}/document?locale=${locale}`));assert.ok(html.ok());assert.ok(!(await html.text()).includes("PRIVATE_SYNTHETIC"));
      }
      await capture(parent,`${scenario}-report-history`);await noOverflow(parent.page);
      assert.equal(createHash("sha256").update(await (await response(parent,`/api/reports/${first.id}/pdf?locale=${locale}`)).body()).digest("hex"),firstHash);
      const list=(await workspace(parent)).reports.filter(r=>r.familyId===family.familyId);assert.equal(list.length,3);
      const latest=list.find(r=>r.revision?.version===3)!;
      for(const lang of ["zh-CN","zh-HK"] as const){
        const r=await response(parent,`/api/reports/${latest.id}/pdf?locale=${lang}`);assert.ok(r.ok());const bytes=await r.body();assert.equal(bytes.subarray(0,4).toString(),"%PDF");await fs.writeFile(path.join(output,`${scenario}-${lang}.pdf`),bytes,{mode:0o600});
      }
      assert.equal((await response(student,`/api/reports/${latest.id}/pdf?locale=${locale}`)).status(),403);
      results.push({scenario,firstReportMs,versions:3,passed:true});console.log(`PASS ${scenario}: first report visible after ${firstReportMs} ms; 3 immutable versions`);
    }catch(error){for(const [role,c] of Object.entries({parent,staff,student}))await capture(c,`${scenario}-${role}-failure`).catch(()=>{});throw error;}
    finally{for(const c of [parent,staff,student,admin]){await c.context.close();contexts.delete(c.context);}}
  }
  assert.deepEqual(errors,[]);passed=true;
}finally{
  for(const c of contexts)await c.close();await browser.close();
  await fs.writeFile(path.join(output,"results.json"),JSON.stringify({passed,syntheticOnly:true,realLocalApi:true,automaticContinuousWorker:true,results,browserErrors:errors},null,2),{mode:0o600});
}
