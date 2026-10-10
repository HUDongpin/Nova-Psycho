import { beforeEach,afterEach,describe,it,expect,vi } from "vitest";
import path from "node:path";
import { tmpdir } from "node:os";

const mocks=vi.hoisted(()=>({
  launch:vi.fn(),launchPersistentContext:vi.fn(),executablePath:vi.fn(),setGraphicsMode:vi.fn(),
  existsSync:vi.fn(),mkdtemp:vi.fn(),readFile:vi.fn(),rm:vi.fn()
}));
vi.mock("playwright",()=>({chromium:{launch:mocks.launch,launchPersistentContext:mocks.launchPersistentContext}}));
vi.mock("@sparticuz/chromium",()=>({default:{
  executablePath:mocks.executablePath,
  args:["--headless=shell","--no-sandbox","--disable-web-security","--allow-running-insecure-content"],
  set setGraphicsMode(value:boolean){mocks.setGraphicsMode(value);}
}}));
vi.mock("node:fs",()=>({existsSync:mocks.existsSync}));
vi.mock("node:fs/promises",()=>({mkdtemp:mocks.mkdtemp,readFile:mocks.readFile,rm:mocks.rm}));

function fakeContext(){
  const page={setContent:vi.fn().mockResolvedValue(undefined),addStyleTag:vi.fn().mockResolvedValue(undefined),evaluate:vi.fn().mockResolvedValue(undefined),pdf:vi.fn().mockResolvedValue(Buffer.from("%PDF-1.7 synthetic renderer result"))};
  return {page,route:vi.fn().mockResolvedValue(undefined),newPage:vi.fn().mockResolvedValue(page),close:vi.fn().mockResolvedValue(undefined)};
}
function deferred<T>(){
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});
  return {promise,resolve};
}
beforeEach(()=>{
  vi.resetModules();vi.clearAllMocks();
  vi.stubEnv("VERCEL","");vi.stubEnv("NOVA_CHROMIUM_EXECUTABLE","");
  mocks.existsSync.mockReturnValue(false);
  mocks.executablePath.mockResolvedValue("/tmp/chromium");
  mocks.readFile.mockResolvedValue(Buffer.from("OTTO bundled test font"));
  mocks.rm.mockResolvedValue(undefined);
  let count=0;mocks.mkdtemp.mockImplementation(async(prefix:string)=>`${prefix}${++count}`);
});
afterEach(()=>{vi.unstubAllEnvs();});

describe("PDF runtime selection and ownership",()=>{
  it("keeps the explicit local/Docker executable and shared-browser lifecycle",async()=>{
    vi.stubEnv("NOVA_CHROMIUM_EXECUTABLE","/usr/bin/local-chromium");
    const context=fakeContext(),close=vi.fn();
    mocks.launch.mockResolvedValue({isConnected:()=>true,newContext:vi.fn().mockResolvedValue(context),close});
    const {renderPdf,closePdfBrowser}=await import("../src/lib/pdf");
    await renderPdf("<p>local</p>");await renderPdf("<p>local again</p>");
    expect(mocks.launch).toHaveBeenCalledOnce();
    expect(mocks.launch).toHaveBeenCalledWith({headless:true,executablePath:"/usr/bin/local-chromium",timeout:30000});
    expect(mocks.launchPersistentContext).not.toHaveBeenCalled();
    expect(mocks.executablePath).not.toHaveBeenCalled();expect(mocks.readFile).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledTimes(2);
    await closePdfBrowser();expect(close).toHaveBeenCalledOnce();
  });

  it.each([["zh-CN","NotoSansCJKsc-Regular.otf"],["zh-HK","NotoSansCJKhk-Regular.otf"]])("uses packaged Chromium and an offline bundled font for %s",async(locale,file)=>{
    vi.stubEnv("VERCEL","1");vi.stubEnv("NOVA_CHROMIUM_EXECUTABLE","/not/the/vercel/browser");
    const context=fakeContext();mocks.launchPersistentContext.mockResolvedValue(context);
    const {renderPdf}=await import("../src/lib/pdf");
    const html=`<!DOCTYPE html><html lang="${locale}"><body>家庭成長</body></html>`;
    await renderPdf(html);
    const profile=`${path.join(tmpdir(),"nova-pdf-")}1`;
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.executablePath).toHaveBeenCalledWith();
    expect(mocks.setGraphicsMode).toHaveBeenCalledWith(false);
    expect(mocks.launchPersistentContext).toHaveBeenCalledWith(profile,{
      executablePath:"/tmp/chromium",args:["--headless=shell","--no-sandbox"],headless:true,timeout:30000,
      javaScriptEnabled:false,offline:true,serviceWorkers:"block"
    });
    expect(context.route).toHaveBeenCalledWith("**/*",expect.any(Function));
    const abort=vi.fn();await context.route.mock.calls[0][1]({abort});expect(abort).toHaveBeenCalledOnce();
    expect(mocks.readFile).toHaveBeenCalledWith(path.join(process.cwd(),"assets","fonts",file));
    expect(context.page.addStyleTag).not.toHaveBeenCalled();
    expect(context.page.setContent).toHaveBeenCalledWith(expect.stringContaining("data:font/otf;base64,"),{waitUntil:"load",timeout:20000});
    expect(context.page.setContent.mock.calls[0][0]).toContain("<body>家庭成長</body>");
    expect(context.page.evaluate).toHaveBeenCalledOnce();
    expect(context.page.evaluate.mock.invocationCallOrder[0]).toBeLessThan(context.page.pdf.mock.invocationCallOrder[0]);
    expect(context.close).toHaveBeenCalledOnce();
    expect(mocks.rm).toHaveBeenCalledWith(profile,{recursive:true,force:true});
    expect(context.close.mock.invocationCallOrder[0]).toBeLessThan(mocks.rm.mock.invocationCallOrder[0]);
  });

  it("closes the invocation and removes its profile after a render failure",async()=>{
    vi.stubEnv("VERCEL","1");const context=fakeContext();context.page.pdf.mockRejectedValue(new Error("render failed"));
    mocks.launchPersistentContext.mockResolvedValue(context);
    const {renderPdf}=await import("../src/lib/pdf");
    await expect(renderPdf("<p>failure</p>")).rejects.toThrow("render failed");
    expect(context.close).toHaveBeenCalledOnce();expect(mocks.rm).toHaveBeenCalledOnce();
  });

  it("removes a profile even when browser launch or close fails",async()=>{
    vi.stubEnv("VERCEL","1");mocks.launchPersistentContext.mockRejectedValueOnce(new Error("launch failed"));
    const {renderPdf}=await import("../src/lib/pdf");
    await expect(renderPdf("<p>launch</p>")).rejects.toThrow("launch failed");
    expect(mocks.rm).toHaveBeenCalledTimes(1);
    const context=fakeContext();context.close.mockRejectedValue(new Error("close failed"));mocks.launchPersistentContext.mockResolvedValueOnce(context);
    await expect(renderPdf("<p>close</p>")).rejects.toThrow("close failed");
    expect(mocks.rm).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid PDF output and still cleans up",async()=>{
    vi.stubEnv("VERCEL","1");const context=fakeContext();context.page.pdf.mockResolvedValue(Buffer.from("not a PDF"));
    mocks.launchPersistentContext.mockResolvedValue(context);
    const {renderPdf}=await import("../src/lib/pdf");
    await expect(renderPdf("<p>invalid</p>")).rejects.toThrow("Invalid PDF render");
    expect(context.close).toHaveBeenCalledOnce();expect(mocks.rm).toHaveBeenCalledOnce();
  });

  it("isolates overlapping renders while initializing packaged assets only once",async()=>{
    vi.stubEnv("VERCEL","1");
    const extraction=deferred<string>(),firstPdf=deferred<Buffer>(),secondPdf=deferred<Buffer>();
    mocks.executablePath.mockReturnValue(extraction.promise);
    const first=fakeContext(),second=fakeContext();first.page.pdf.mockReturnValue(firstPdf.promise);second.page.pdf.mockReturnValue(secondPdf.promise);
    mocks.launchPersistentContext.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const {renderPdf,closePdfBrowser}=await import("../src/lib/pdf");
    const firstRender=renderPdf("<p>first</p>"),secondRender=renderPdf("<p>second</p>");
    await vi.waitFor(()=>expect(mocks.executablePath).toHaveBeenCalledOnce());
    expect(mocks.launchPersistentContext).not.toHaveBeenCalled();
    extraction.resolve("/tmp/chromium");
    await vi.waitFor(()=>expect(second.page.pdf).toHaveBeenCalledOnce());
    expect(mocks.launchPersistentContext.mock.calls[0][0]).not.toBe(mocks.launchPersistentContext.mock.calls[1][0]);
    await closePdfBrowser();expect(first.close).not.toHaveBeenCalled();expect(second.close).not.toHaveBeenCalled();
    firstPdf.resolve(Buffer.from("%PDF-first"));await firstRender;
    expect(first.close).toHaveBeenCalledOnce();expect(second.close).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledTimes(1);
    secondPdf.resolve(Buffer.from("%PDF-second"));await secondRender;
    expect(second.close).toHaveBeenCalledOnce();expect(mocks.rm).toHaveBeenCalledTimes(2);
  });

  it("fails closed for a missing bundled font and permits a later retry",async()=>{
    vi.stubEnv("VERCEL","1");mocks.readFile.mockRejectedValueOnce(new Error("missing font"));
    const {renderPdf}=await import("../src/lib/pdf");
    await expect(renderPdf("<p>missing</p>")).rejects.toThrow("missing font");
    expect(mocks.mkdtemp).not.toHaveBeenCalled();expect(mocks.launchPersistentContext).not.toHaveBeenCalled();
    const context=fakeContext();mocks.launchPersistentContext.mockResolvedValue(context);
    await renderPdf("<p>retry</p>");expect(mocks.readFile).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a partially extracted Chromium after initialization fails",async()=>{
    vi.stubEnv("VERCEL","1");mocks.executablePath.mockRejectedValue(new Error("extraction failed"));
    const {renderPdf}=await import("../src/lib/pdf");
    await expect(renderPdf("<p>first</p>")).rejects.toThrow("extraction failed");
    await expect(renderPdf("<p>retry</p>")).rejects.toThrow("extraction failed");
    expect(mocks.executablePath).toHaveBeenCalledOnce();expect(mocks.launchPersistentContext).not.toHaveBeenCalled();
    expect(mocks.mkdtemp).not.toHaveBeenCalled();
  });
});
