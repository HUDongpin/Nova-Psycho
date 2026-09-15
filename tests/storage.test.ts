import { describe,it,expect,beforeEach,afterEach,vi } from "vitest";
import { mkdtempSync,readFileSync,readdirSync,rmSync,statSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { listPrivatePdfKeys,readPrivatePdf,removePrivatePdf,writePrivatePdf } from "../src/lib/storage";

// The private report store. Two things matter here beyond round-tripping: the key is
// used to build a filesystem path, so it must not be able to escape the report
// directory; and the encryption must fail closed on tampering rather than return junk.

const REPORT_KEY="ab".repeat(32);
const KEY="11111111-2222-4333-8444-555555555555.99999999-8888-4777-8666-555555555555.zh-CN.pdf.enc";
let dir:string;

beforeEach(()=>{
  dir=mkdtempSync(path.join(tmpdir(),"nova-storage-"));
  vi.stubEnv("NOVA_REGION","CN");vi.stubEnv("NOVA_MODE","demo");
  vi.stubEnv("DATABASE_URL","postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR",dir);
  vi.stubEnv("NOVA_REPORT_KEY",REPORT_KEY);
});
afterEach(()=>{rmSync(dir,{recursive:true,force:true});vi.unstubAllEnvs();});

describe("private report keys cannot escape the report directory",()=>{
  it.each([
    ["path traversal with ../","../../etc/passwd"],
    ["absolute path","/etc/passwd"],
    ["traversal inside a plausible name","11111111-2222-4333-8444-555555555555/../../etc/passwd.zh-CN.pdf.enc"],
    ["null byte","11111111-2222-4333-8444-555555555555.99999999-8888-4777-8666-555555555555.zh-CN.pdf.enc\u0000.txt"],
    ["empty string",""],
    ["wrong suffix","11111111-2222-4333-8444-555555555555.99999999-8888-4777-8666-555555555555.zh-CN.pdf"],
    ["unknown region","11111111-2222-4333-8444-555555555555.99999999-8888-4777-8666-555555555555.zh-XX.pdf.enc"],
    ["non-hex characters","zzzzzzzz-2222-4333-8444-555555555555.99999999-8888-4777-8666-555555555555.zh-CN.pdf.enc"]
  ])("refuses %s",async(_label,key)=>{
    await expect(writePrivatePdf(key,Buffer.from("x"))).rejects.toThrow(/Invalid private report key/);
    await expect(readPrivatePdf(key)).rejects.toThrow();
    await expect(removePrivatePdf(key)).rejects.toThrow();
  });
  it("writes nothing outside the report directory when traversal is attempted",async()=>{
    await expect(writePrivatePdf("../escaped.pdf.enc",Buffer.from("x"))).rejects.toThrow();
    expect(readdirSync(path.dirname(dir))).not.toContain("escaped.pdf.enc");
  });
  it("accepts a well-formed key",async()=>{
    await expect(writePrivatePdf(KEY,Buffer.from("%PDF-1.4"))).resolves.toBeUndefined();
  });
});

describe("encrypted report round trip",()=>{
  it("returns exactly what was stored",async()=>{
    const pdf=Buffer.from("%PDF-1.4 synthetic body\n%%EOF");
    await writePrivatePdf(KEY,pdf);
    expect(await readPrivatePdf(KEY)).toEqual(pdf);
  });
  it("does not leave the plaintext readable on disk",async()=>{
    await writePrivatePdf(KEY,Buffer.from("%PDF-1.4 SECRET-MARKER %%EOF"));
    const onDisk=readdirSync(dir).map(name=>readFileSync(path.join(dir,name)).toString("latin1")).join("");
    expect(onDisk).not.toContain("SECRET-MARKER");
  });
  it("stores the file with owner-only permissions",async()=>{
    await writePrivatePdf(KEY,Buffer.from("%PDF"));
    expect(statSync(path.join(dir,KEY)).mode & 0o777).toBe(0o600);
  });
  it("fails closed when the ciphertext is tampered with",async()=>{
    await writePrivatePdf(KEY,Buffer.from("%PDF-1.4 body %%EOF"));
    const file=path.join(dir,KEY);
    const bytes=readFileSync(file);
    bytes[bytes.length-1]^=0xff;
    writeFileSync(file,bytes);
    await expect(readPrivatePdf(KEY)).rejects.toThrow();
  });
  it("refuses a file that is not in the expected envelope",async()=>{
    writeFileSync(path.join(dir,KEY),Buffer.from("NOPE"+randomBytes(64).toString("hex")));
    await expect(readPrivatePdf(KEY)).rejects.toThrow(/Invalid encrypted report/);
  });
  it("produces a different ciphertext for identical plaintext",async()=>{
    const other="11111111-2222-4333-8444-555555555555.99999999-8888-4777-8666-555555555555.zh-HK.pdf.enc";
    await writePrivatePdf(KEY,Buffer.from("%PDF identical"));
    await writePrivatePdf(other,Buffer.from("%PDF identical"));
    const a=readFileSync(path.join(dir,KEY));
    const b=readFileSync(path.join(dir,other));
    expect(a.equals(b)).toBe(false);
  });
});

describe("listing and removal",()=>{
  it("lists only well-formed report keys",async()=>{
    await writePrivatePdf(KEY,Buffer.from("%PDF"));
    writeFileSync(path.join(dir,"stray.txt"),"ignore me");
    writeFileSync(path.join(dir,".DS_Store"),"");
    expect(await listPrivatePdfKeys()).toEqual([KEY]);
  });
  it("returns an empty list rather than throwing when the directory is absent",async()=>{
    rmSync(dir,{recursive:true,force:true});
    await expect(listPrivatePdfKeys()).resolves.toEqual([]);
  });
  it("removes a stored report",async()=>{
    await writePrivatePdf(KEY,Buffer.from("%PDF"));
    await removePrivatePdf(KEY);
    expect(readdirSync(dir)).not.toContain(KEY);
  });
  it("removing a missing report is not an error",async()=>{
    await expect(removePrivatePdf(KEY)).resolves.toBeUndefined();
  });
});
