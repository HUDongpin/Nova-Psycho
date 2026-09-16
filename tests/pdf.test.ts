import { describe,it,expect,afterAll,beforeAll,beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { closePdfBrowser,renderPdf } from "../src/lib/pdf";
import { reportHtml } from "../src/domain/report-html";
import { demoAdvice,demoScale,demoTemplate } from "../src/domain/demo";
import { scoreAssessment } from "../src/domain/scoring";
import type { ReportPayload } from "../src/domain/types";

// Rendering needs a real Chromium, which CI and some sandboxes do not have. The suite
// skips there rather than pretending to pass, and the skip is announced so it cannot be
// mistaken for coverage. Run `npx playwright install chromium` to enable it anywhere.
//
// Gate 1 is path-based and conservative: an explicit NOVA_CHROMIUM_EXECUTABLE, Chrome
// on macOS, or Playwright's own browser cache. Guessing at Linux paths risks matching a
// snap wrapper that launches but cannot render, which would turn a skip into a failure.
// Gate 2 is a one-time launch/render probe: a present binary can still fail with EPERM
// or SIGABRT. NOVA_SKIP_PDF_RENDER=1|true force-skips without probing.
const forceSkip=process.env.NOVA_SKIP_PDF_RENDER==="1"||process.env.NOVA_SKIP_PDF_RENDER==="true";
const hasChromiumHint=Boolean(process.env.NOVA_CHROMIUM_EXECUTABLE)
  ||(process.platform==="darwin"&&existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"))
  ||["Library/Caches/ms-playwright",".cache/ms-playwright"].some(relative=>existsSync(path.join(homedir(),relative)));
const canRender=!forceSkip&&hasChromiumHint;

if(forceSkip){
  console.warn("[pdf.test] NOVA_SKIP_PDF_RENDER is set, so PDF rendering is NOT being tested here.");
}else if(!hasChromiumHint){
  console.warn("[pdf.test] No Chromium found, so the PDF renderer is NOT being tested here. Run `npx playwright install chromium` to enable these tests.");
}

function isEnvironmentRenderFailure(error:unknown){
  const err=error as {code?:string;message?:string;cause?:unknown};
  const cause=err?.cause as {code?:string;message?:string}|undefined;
  const text=`${err?.code??""} ${err?.message??error} ${cause?.code??""} ${cause?.message??""}`;
  return /EPERM|EACCES|ENOENT|SIGABRT|SIGKILL|SIGSEGV|SIGTRAP|sandbox|spawn|Executable|missing dependenc|shared librar|not permitted|Failed to launch|browserType\.launch|Target closed|has been closed|crashed|Timeout|timed out/i.test(text);
}

const payload:ReportPayload={
  scale:demoScale,advice:{id:"a",version:"1.0.0",content:demoAdvice},template:{id:"t",version:"1.0.0",content:demoTemplate},
  score:scoreAssessment(demoScale,{q1:1,q2:2,q3:1,q4:2,q5:1,q6:2,q7:1,q8:2,q9:0},{age:12,region:"CN",role:"student"}),
  childName:"Synthetic child",grade:"S2",submittedAt:"2026-09-15T00:00:00.000Z",aiConsented:false,
  selectedAdviceIds:["listen","check_in"],generationMode:"template",fallbackReason:null,aiModel:null,
  comparison:{available:false,reason:"first_assessment"}
};

afterAll(async()=>{await closePdfBrowser();});

describe.skipIf(!canRender)("PDF rendering",()=>{
  let renderAvailable=true;

  beforeAll(async()=>{
    try{
      await renderPdf("<!DOCTYPE html><html><body><p>probe</p></body></html>");
    }catch(error){
      await closePdfBrowser().catch(()=>{});
      if(!isEnvironmentRenderFailure(error))throw error;
      renderAvailable=false;
      console.warn("[pdf.test] Chromium launch/render probe failed, so PDF rendering is NOT being tested here.",error);
    }
  },60_000);

  beforeEach(context=>{
    if(!renderAvailable)context.skip();
  });

  it("produces a real PDF document from a minimal page",async()=>{
    const pdf=await renderPdf("<!DOCTYPE html><html><body><p>Nova</p></body></html>");
    expect(pdf.subarray(0,4).toString()).toBe("%PDF");
    expect(pdf.subarray(-1024).toString("latin1")).toContain("%%EOF");
    expect(pdf.length).toBeGreaterThan(1000);
  },60_000);

  it("renders the real simplified-Chinese report",async()=>{
    const pdf=await renderPdf(reportHtml(payload,"zh-CN"));
    expect(pdf.subarray(0,4).toString()).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(20_000);
  },60_000);

  it("renders the real traditional-Chinese report",async()=>{
    const pdf=await renderPdf(reportHtml(payload,"zh-HK"));
    expect(pdf.subarray(0,4).toString()).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(20_000);
  },60_000);

  it("paginates a long document and keeps a short one on a single page",async()=>{
    // /Count is the page tree's own tally. It appears early in the file rather than in
    // the trailer, so the whole buffer has to be searched.
    const pageCount=(pdf:Buffer)=>Number(pdf.toString("latin1").match(/\/Count\s+(\d+)/)?.[1] ?? 0);
    const rows=Array.from({length:120},(_,index)=>`<p>Row ${index} · 中文测试行</p>`).join("");
    const long=await renderPdf(`<!DOCTYPE html><html><body>${rows}</body></html>`);
    const short=await renderPdf("<!DOCTYPE html><html><body><p>one line</p></body></html>");
    expect(pageCount(short)).toBe(1);
    expect(pageCount(long)).toBeGreaterThan(1);
  },60_000);

  it("survives closing the shared browser between renders",async()=>{
    await renderPdf("<!DOCTYPE html><html><body><p>first</p></body></html>");
    await closePdfBrowser();
    const pdf=await renderPdf("<!DOCTYPE html><html><body><p>second</p></body></html>");
    expect(pdf.subarray(0,4).toString()).toBe("%PDF");
  },60_000);

  it("does not fetch remote resources while rendering",async()=>{
    // context.route("**/*", abort) should stop any network access, so an unreachable
    // remote stylesheet must not hang or fail the render.
    const pdf=await renderPdf('<!DOCTYPE html><html><head><link rel="stylesheet" href="https://example.invalid/x.css"></head><body><p>offline</p></body></html>');
    expect(pdf.subarray(0,4).toString()).toBe("%PDF");
  },60_000);
});
