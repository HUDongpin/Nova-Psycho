import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import fs from "node:fs/promises";
import {chromium,type BrowserContext,type Page} from "playwright";
import pg from "pg";
import {parentScale} from "../src/domain/triad-scales";

const base=process.env.NOVA_PUBLIC_URL!,region=process.env.NOVA_REGION!;
assert.equal(process.env.NOVA_AI_ENABLED,"false");assert.equal(process.env.NOVA_MODE,"demo");
assert.ok(["http://127.0.0.1:3140","http://127.0.0.1:3141"].includes(base));
assert.match(process.env.DATABASE_URL!,/127\.0\.0\.1:55440\/nova_draft_20261008_(cn|hk)$/);
const output="work/qa/draft-fixes-20261008/session";
await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
const db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();
const contexts:BrowserContext[]=[],checks:unknown[]=[],errors:string[]=[];
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function deferred(){let resolve:()=>void=()=>undefined;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function call(context:BrowserContext,path:string,body?:unknown,method=body===undefined?"GET":"POST"){
  const response=await context.request.fetch(base+path,{method,headers:{Origin:base},...(body===undefined?{}:{data:body})});
  const data=await response.json().catch(()=>null);assert.ok(response.ok(),`${method} ${path}: ${response.status()} ${data?.code??""}`);return data;
}
type Fixture={context:BrowserContext;page:Page;id:string;userId:string;familyId:string;username:string;password:string;events:{method:string;path:string}[]};
async function fixture(name:string,open=true):Promise<Fixture>{
  const context=await browser.newContext({viewport:{width:1440,height:1000}});contexts.push(context);
  await context.route("**/*",route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  const username=`session_${name}_${randomUUID()}`,password=randomUUID()+"A9!";
  const family=await call(context,"/api/triad/parent",{parentName:"合成恢复家长",username,password,relationship:"母亲",childName:`合成恢复${name}`,birthDate:"2014-01-01",grade:"初中",accepted:true});
  const workspace=await call(context,"/api/workspace"),assessment=workspace.assessments.find((a:any)=>a.familyId===family.familyId);assert.ok(assessment);
  const answers:Record<string,unknown>={};for(const item of parentScale.items){if(item.id==="p_worry")break;answers[item.id]=item.gate??(item.kind==="multi"?[item.choices[0].value]:item.choices[0].value);}
  await call(context,`/api/assessments/${assessment.id}`,{answers,acknowledged:true,revision:0},"PATCH");
  const page=await context.newPage(),events:Fixture["events"]=[];
  page.on("request",r=>{const path=new URL(r.url()).pathname;if(path.startsWith("/api/assessments/"))events.push({method:r.method(),path});});
  if(open){await page.goto(base+"/#assessment/"+assessment.id);await page.locator(".survey-assent-panel input").check();await page.locator(".survey-questions textarea").waitFor();}
  return {context,page,id:assessment.id,userId:workspace.user.id,familyId:family.familyId,username,password,events};
}
async function expire(f:Fixture){await db.query("UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE user_id=$1",[f.userId]);}
async function guard(page:Page){return page.evaluate(()=>{const event=new Event("beforeunload",{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;});}
async function refreshToLogin(f:Fixture){await f.page.locator(".refresh-button").click();await f.page.locator(".login-card input[name=username]").waitFor();await f.page.locator(".draft-recovery-notice").waitFor();assert.equal(await guard(f.page),true);}
async function login(f:Fixture,as=f){await f.page.locator("input[name=username]").fill(as.username);await f.page.locator("input[name=password]").fill(as.password);await f.page.locator(".login-card form button.primary").click();}
async function stored(f:Fixture){return (await db.query("SELECT draft_revision,draft_answers FROM assessments WHERE id=$1",[f.id])).rows[0]??null;}
async function check(name:string,fn:()=>Promise<unknown>){const result=await fn();checks.push({name,passed:true,...result as object});console.log(`PASS ${name}`);}
try{
  await check("held-real-save-does-not-rebase-later-local-edits",async()=>{
    const f=await fixture("held_success"),seen=deferred(),release=deferred();
    const first=`合成已送出_${randomUUID()}`,latest=`合成后来输入_${randomUUID()}`;
    let intercepted=false;
    await f.page.route(`**/api/assessments/${f.id}?*`,async route=>{
      if(route.request().method()!=="PATCH"||intercepted){await route.continue();return;}
      intercepted=true;const response=await route.fetch();assert.equal(response.status(),200);seen.resolve();await release.promise;
      await route.fulfill({response}).catch(()=>undefined);
    });
    await f.page.locator(".survey-questions textarea").fill(first);await seen.promise;
    await f.page.locator(".survey-questions textarea").fill(latest);await expire(f);await refreshToLogin(f);
    await login(f);await f.page.locator(".draft-conflict textarea").waitFor();
    assert.ok((await f.page.locator(".draft-conflict textarea").inputValue()).includes(latest));
    const count=f.events.filter(e=>e.method==="PATCH").length;release.resolve();await delay(1000);
    assert.ok((await f.page.locator(".draft-conflict textarea").inputValue()).includes(latest));
    assert.equal((await stored(f)).draft_answers.p_worry,first);
    assert.equal(f.events.filter(e=>e.method==="PATCH").length,count);assert.equal(await guard(f.page),true);
    await f.page.screenshot({path:`${output}/${region}-held-save-conflict.png`});
    return {assessmentId:f.id,realFirstSaveCommitted:true,latestLocalTextPreserved:true,noAutomaticRebase:true,noLateExtraWrite:true};
  });
  await check("held-old-401-does-not-expire-a-reauthenticated-owner",async()=>{
    const f=await fixture("held_401"),seen=deferred(),release=deferred();let intercepted=false;
    await expire(f);
    await f.page.route(`**/api/assessments/${f.id}?*`,async route=>{
      if(route.request().method()!=="PATCH"||intercepted){await route.continue();return;}
      intercepted=true;const response=await route.fetch();assert.equal(response.status(),401);seen.resolve();await release.promise;
      await route.fulfill({response}).catch(()=>undefined);
    });
    const marker=`合成保留旧401_${randomUUID()}`;
    await f.page.locator(".survey-questions textarea").fill(marker);await seen.promise;await refreshToLogin(f);
    await login(f);await f.page.locator(".survey-assent-panel input").waitFor();
    release.resolve();await delay(900);
    assert.equal(await f.page.locator(".login-card").count(),0);assert.equal(await f.page.locator(".survey-assent-panel input").isChecked(),false);
    assert.equal((await stored(f)).draft_answers.p_worry,undefined);
    await f.page.locator(".survey-assent-panel input").check();
    // Restored text is answered, so the existing navigation opens the following
    // unanswered choice. Return through the real UI after renewing assent.
    await f.page.getByRole("button",{name:/上一题|上一題/,exact:true}).click();
    assert.equal(await f.page.locator(".survey-questions textarea").inputValue(),marker);
    for(let n=0;n<50&&(await stored(f)).draft_answers.p_worry!==marker;n++)await delay(100);
    assert.equal((await stored(f)).draft_answers.p_worry,marker);assert.equal(await guard(f.page),false);
    return {assessmentId:f.id,late401DidNotLogout:true,exactTextSavedAfterRenewedAssent:true};
  });
  await check("explicit-mismatch-discard-can-continue-as-another-account",async()=>{
    const a=await fixture("discard_a"),b=await fixture("discard_b",false),marker=`合成需放弃_${randomUUID()}`;
    await expire(a);await a.page.locator(".survey-questions textarea").fill(marker);await refreshToLogin(a);await login(a,b);
    await a.page.locator(".draft-account-mismatch").waitFor();assert.equal((await a.page.locator("body").innerText()).includes(marker),false);
    const start=a.events.length;a.page.once("dialog",dialog=>dialog.accept());
    await a.page.getByRole("button",{name:/放弃草稿并使用当前账号|捨棄草稿並使用目前帳號/}).click();
    await a.page.locator(".sidebar-user").waitFor();assert.equal((await call(a.context,"/api/session")).user.id,b.userId);
    assert.equal(await guard(a.page),false);await delay(900);assert.equal(a.events.slice(start).filter(e=>e.method==="PATCH"||e.method==="POST").length,0);
    assert.equal((await stored(a)).draft_answers.p_worry,undefined);
    await a.page.locator(".sidebar").getByRole("button",{name:/退出登录|登出/,exact:true}).click();
    await a.page.locator(".login-card").waitFor();assert.equal(await a.page.locator(".draft-recovery-notice").count(),0);
    return {assessmentId:a.id,explicitDiscardRequired:true,otherAccountActive:true,oldAnswersNeverSent:true,logoutStillWorks:true};
  });
  await check("unavailable-draft-has-an-explicit-exit-without-private-content",async()=>{
    const f=await fixture("discard_deleted"),marker=`合成已删除问卷_${randomUUID()}`;
    await expire(f);await f.page.locator(".survey-questions textarea").fill(marker);await refreshToLogin(f);
    await db.query("DELETE FROM assessments WHERE id=$1 AND respondent_id=$2",[f.id,f.userId]);await login(f);
    await f.page.locator(".draft-access-blocked").waitFor();assert.equal((await f.page.locator("body").innerText()).includes(marker),false);assert.equal(await guard(f.page),true);
    f.page.once("dialog",dialog=>dialog.accept());await f.page.getByRole("button",{name:/放弃此草稿|捨棄此草稿/}).click();
    await f.page.locator(".sidebar-user").waitFor();assert.equal(await guard(f.page),false);
    await f.page.locator(".sidebar").getByRole("button",{name:/退出登录|登出/,exact:true}).click();await f.page.locator(".login-card").waitFor();
    assert.equal(await f.page.locator(".draft-recovery-notice").count(),0);assert.equal(await stored(f),null);
    return {assessmentId:f.id,unavailableContentHidden:true,explicitDiscardClearedGuard:true,logoutSucceeded:true,noAssessmentRecreated:true};
  });
}catch(error){errors.push(error instanceof Error?error.message:String(error));process.exitCode=1;}
finally{
  await fs.writeFile(`${output}/browser-${region}.json`,JSON.stringify({passed:errors.length===0,region,checks,errors},null,2)+"\n");
  console.log(JSON.stringify({region,passed:errors.length===0,checks:checks.length,errors}));
  for(const context of contexts)await context.close();await browser.close();await db.end();
}
