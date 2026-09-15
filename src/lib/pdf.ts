import { existsSync } from "node:fs";
import { chromium,type Browser } from "playwright";
let browser:Browser|null=null;
async function getBrowser(){
  if(browser?.isConnected())return browser;
  const localChrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const executablePath=process.env.NOVA_CHROMIUM_EXECUTABLE||(process.platform==="darwin"&&existsSync(localChrome)?localChrome:undefined);
  browser=await chromium.launch({headless:true,executablePath,timeout:30000});return browser;
}
export async function renderPdf(html:string):Promise<Buffer>{
  const browser=await getBrowser(),context=await browser.newContext({javaScriptEnabled:false});
  try{
    await context.route("**/*",route=>route.abort());
    const page=await context.newPage();await page.setContent(html,{waitUntil:"load",timeout:20000});
    const result=await page.pdf({format:"A4",printBackground:true,preferCSSPageSize:true,displayHeaderFooter:true,headerTemplate:"<span></span>",footerTemplate:'<div style="font-size:8px;width:100%;text-align:center;color:#748378">Nova Psycho Helper · <span class="pageNumber"></span> / <span class="totalPages"></span></div>'});
    if(result.subarray(0,4).toString()!=="%PDF")throw new Error("Invalid PDF render");return result;
  }finally{await context.close();}
}
export async function closePdfBrowser(){await browser?.close();browser=null;}
