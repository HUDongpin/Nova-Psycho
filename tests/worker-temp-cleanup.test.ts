import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";

vi.mock("../src/lib/db",()=>({query:vi.fn(),transaction:vi.fn()}));
import { query } from "../src/lib/db";
import { cleanAbandonedPrivatePdfTemps } from "../src/lib/storage";
import { cleanOrphanReports } from "../src/lib/worker";

const assessmentId="11111111-2222-4333-8444-555555555555";
const token="99999999-8888-4777-8666-555555555555";
const key=`${assessmentId}.${token}.zh-CN.pdf.enc`;
const tempName=`${key}.0123456789abcdef.tmp`;
const stale=new Date(Date.now()-25*60*60*1000);
let dir:string;

beforeEach(async()=>{
  const root=path.resolve("work/qa/review-pass3/worker");
  await fs.mkdir(root,{recursive:true});dir=await fs.mkdtemp(path.join(root,"temp-fixture-"));
  vi.stubEnv("NOVA_REGION","CN");vi.stubEnv("NOVA_MODE","demo");
  vi.stubEnv("DATABASE_URL","postgresql://synthetic.invalid/nova");vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3197");
  vi.stubEnv("NOVA_REPORT_STORAGE","filesystem");vi.stubEnv("NOVA_REPORT_DIR",dir);vi.stubEnv("NOVA_REPORT_KEY","ab".repeat(32));
  vi.stubEnv("NOVA_WORKER_MODE","continuous");vi.stubEnv("NOVA_AI_ENABLED","false");
  vi.mocked(query).mockReset().mockResolvedValue([]);
});
afterEach(async()=>{await fs.rm(dir,{recursive:true,force:true});vi.unstubAllEnvs();vi.restoreAllMocks();});

async function stagedTemp(name=tempName,modified=stale){
  const filename=path.join(dir,name);await fs.writeFile(filename,Buffer.from("NOVA1 synthetic interrupted ciphertext"));
  await fs.utimes(filename,modified,modified);return filename;
}

describe("abandoned encrypted report temporaries",()=>{
  it("removes an aged encrypted file left by a process killed before rename after its family is gone",async()=>{
    const source=pathToFileURL(path.resolve("src/lib/storage.ts")).href;
    const script=`import fs from 'node:fs/promises';
      fs.rename=async()=>{process.stdout.write('TEMP_READY\\n');await new Promise(()=>{});};
      setInterval(()=>{},1000);
      const {writePrivatePdf}=await import(${JSON.stringify(source)});
      await writePrivatePdf(${JSON.stringify(key)},Buffer.from('%PDF-1.4 SYNTHETIC CRASH MARKER'));`;
    const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",script],{cwd:process.cwd(),env:{PATH:process.env.PATH,NODE_ENV:"test",NOVA_REGION:"CN",NOVA_MODE:"demo",DATABASE_URL:"postgresql://synthetic.invalid/nova",NOVA_PUBLIC_URL:"http://127.0.0.1:3197",NOVA_REPORT_STORAGE:"filesystem",NOVA_REPORT_DIR:dir,NOVA_REPORT_KEY:"ab".repeat(32),NOVA_AI_ENABLED:"false"},stdio:["ignore","pipe","pipe"]});
    const exited=once(child,"exit");
    try{
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error("Synthetic writer did not reach rename")),10000);
        child.stdout.on("data",chunk=>{if(String(chunk).includes("TEMP_READY")){clearTimeout(timer);resolve();}});
        child.once("error",error=>{clearTimeout(timer);reject(error);});
        child.once("exit",()=>{clearTimeout(timer);reject(new Error("Synthetic writer exited before interruption"));});
      });
      child.kill("SIGKILL");expect((await exited)[1]).toBe("SIGKILL");
    }finally{child.kill("SIGKILL");await exited;}
    const files=await fs.readdir(dir);expect(files).toHaveLength(1);expect(files[0]).toMatch(/\.tmp$/);
    const file=path.join(dir,files[0]),bytes=await fs.readFile(file);
    expect(bytes.subarray(0,5).toString()).toBe("NOVA1");expect(bytes.includes(Buffer.from("SYNTHETIC CRASH MARKER"))).toBe(false);
    await fs.utimes(file,stale,stale);
    await cleanOrphanReports();
    expect(await fs.readdir(dir)).toEqual([]);
  },15000);
  it("preserves recent temporaries without querying their owner",async()=>{
    await stagedTemp(tempName,new Date());await cleanOrphanReports();
    expect(await fs.readdir(dir)).toEqual([tempName]);expect(query).not.toHaveBeenCalled();
  });
  it("preserves an aged temporary belonging to the current running claim even after lease expiry",async()=>{
    await stagedTemp();vi.mocked(query).mockResolvedValue([{claim_token:token,lease_until:new Date(0)}]);
    await cleanOrphanReports();expect(await fs.readdir(dir)).toEqual([tempName]);
  });
  it("removes an aged temporary after a replacement claim fences the old writer",async()=>{
    const replacement="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",replacementName=tempName.replace(token,replacement);
    await stagedTemp();await stagedTemp(replacementName);vi.mocked(query).mockResolvedValue([{claim_token:replacement}]);
    await cleanOrphanReports();expect(await fs.readdir(dir)).toEqual([replacementName]);
  });
  it("preserves encrypted bytes when ownership cannot be checked",async()=>{
    await stagedTemp();vi.mocked(query).mockRejectedValue(new Error("Synthetic database unavailable"));
    await expect(cleanOrphanReports()).rejects.toThrow("Synthetic database unavailable");
    expect(await fs.readdir(dir)).toEqual([tempName]);
  });
  it("ignores malformed names and non-file entries",async()=>{
    const malformed=`${"-".repeat(36)}.${token}.zh-CN.pdf.enc.0123456789abcdef.tmp`;
    await stagedTemp(malformed);await stagedTemp(`${key}.not-a-generated-suffix.tmp`);
    await fs.mkdir(path.join(dir,tempName));await fs.utimes(path.join(dir,tempName),stale,stale);
    await fs.symlink("synthetic-missing-target",path.join(dir,tempName.replace("zh-CN","zh-HK")));
    await cleanOrphanReports();expect(await fs.readdir(dir)).toHaveLength(4);expect(query).not.toHaveBeenCalled();
  });
  it("tolerates a temporary disappearing between enumeration and stat",async()=>{
    const filename=await stagedTemp();
    vi.spyOn(fs,"lstat").mockImplementationOnce(async()=>{await fs.rm(filename);throw Object.assign(new Error("Synthetic rename"),{code:"ENOENT"});});
    await cleanAbandonedPrivatePdfTemps();expect(await fs.readdir(dir)).toEqual([]);expect(query).not.toHaveBeenCalled();
  });
  it("tolerates a concurrent cleanup removing the same temporary",async()=>{
    const filename=await stagedTemp();
    vi.mocked(query).mockImplementationOnce(async()=>{await fs.rm(filename);return [];});
    await cleanAbandonedPrivatePdfTemps();expect(await fs.readdir(dir)).toEqual([]);
  });
});
