import { existsSync } from "node:fs";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium,type Browser,type BrowserContext } from "playwright";
let browser:Browser|null=null;
let serverlessRuntime:Promise<{executablePath:string;args:string[]}>|null=null;
const fontStyles=new Map<string,Promise<string>>();
async function getBrowser(){
  if(browser?.isConnected())return browser;
  const localChrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const executablePath=process.env.NOVA_CHROMIUM_EXECUTABLE||(process.platform==="darwin"&&existsSync(localChrome)?localChrome:undefined);
  browser=await chromium.launch({headless:true,executablePath,timeout:30000});return browser;
}
function getServerlessRuntime(){
  // Only immutable runtime assets are shared. Keep a failed extraction rejected:
  // retrying in this process could reuse the package's partial /tmp binary.
  serverlessRuntime??=(async()=>{
    const {default:packed}=await import("@sparticuz/chromium");
    packed.setGraphicsMode=false;
    const executablePath=await packed.executablePath();
    const args=packed.args.filter(arg=>arg!=="--disable-web-security"&&arg!=="--allow-running-insecure-content");
    return {executablePath,args};
  })();
  return serverlessRuntime;
}
function serverlessFontStyle(html:string):Promise<string>{
  const file=/<html\b[^>]*\blang=["']zh-(?:HK|TW|Hant)["']/i.test(html)?"NotoSansCJKhk-Regular.otf":"NotoSansCJKsc-Regular.otf";
  let style=fontStyles.get(file);
  if(!style){
    style=readFile(path.join(process.cwd(),"assets","fonts",file)).then(font=>`@font-face{font-family:"Nova CJK";src:url(data:font/otf;base64,${font.toString("base64")}) format("opentype");font-weight:400;font-style:normal;font-display:block}body,h1,h2,.brand,.score{font-family:"Nova CJK",sans-serif!important}`).catch(error=>{fontStyles.delete(file);throw error;});
    fontStyles.set(file,style);
  }
  return style;
}
async function renderInContext(context:BrowserContext,html:string,fontStyle?:string):Promise<Buffer>{
  await context.route("**/*",route=>route.abort());
  let documentHtml=html;
  if(fontStyle){
    // addStyleTag waits for an onload callback that disabled page JavaScript
    // cannot run. Parse the font CSS with the document instead.
    const style=`<style>${fontStyle}</style>`;
    documentHtml=/<\/head\s*>/i.test(html)?html.replace(/<\/head\s*>/i,`${style}</head>`)
      : /<html\b[^>]*>/i.test(html)?html.replace(/<html\b[^>]*>/i,match=>`${match}<head>${style}</head>`)
        : `<!DOCTYPE html><html><head>${style}</head><body>${html}</body></html>`;
  }
  const page=await context.newPage();await page.setContent(documentHtml,{waitUntil:"load",timeout:20000});
  if(fontStyle){
    await page.evaluate(async()=>{
      const loaded=await document.fonts.load('16px "Nova CJK"',"家庭成長学习");
      await document.fonts.ready;
      if(loaded.length!==1||!document.fonts.check('16px "Nova CJK"',"家庭成長学习"))throw new Error("Bundled PDF font did not load");
    });
  }
  const result=await page.pdf({format:"A4",printBackground:true,preferCSSPageSize:true,displayHeaderFooter:true,headerTemplate:"<span></span>",footerTemplate:'<div style="font-size:8px;width:100%;text-align:center;color:#748378">Nova Psycho Helper · <span class="pageNumber"></span> / <span class="totalPages"></span></div>'});
  if(result.subarray(0,4).toString()!=="%PDF")throw new Error("Invalid PDF render");return result;
}
async function renderServerlessPdf(html:string):Promise<Buffer>{
  const [runtime,fontStyle]=await Promise.all([getServerlessRuntime(),serverlessFontStyle(html)]);
  const profile=await mkdtemp(path.join(tmpdir(),"nova-pdf-"));
  let context:BrowserContext|undefined;
  try{
    context=await chromium.launchPersistentContext(profile,{...runtime,headless:true,timeout:30000,javaScriptEnabled:false,offline:true,serviceWorkers:"block"});
    return await renderInContext(context,html,fontStyle);
  }finally{
    try{await context?.close();}finally{await rm(profile,{recursive:true,force:true});}
  }
}
export async function renderPdf(html:string):Promise<Buffer>{
  if(process.env.VERCEL==="1")return renderServerlessPdf(html);
  const browser=await getBrowser(),context=await browser.newContext({javaScriptEnabled:false});
  try{return await renderInContext(context,html);}finally{await context.close();}
}
export async function closePdfBrowser(){await browser?.close();browser=null;}
