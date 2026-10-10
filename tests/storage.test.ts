import { describe,it,expect,beforeEach,afterEach,vi } from "vitest";
import { mkdtempSync,readFileSync,readdirSync,rmSync,statSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";

const lockCalls:string[]=[];
const lockClient={query:vi.fn(async(sql:string)=>{lockCalls.push(String(sql));return {rows:[]};})};
vi.mock("../src/lib/db",()=>({
  query:vi.fn(),
  transaction:vi.fn(async(fn:(c:unknown)=>Promise<unknown>)=>fn(lockClient))
}));

import { listPrivatePdfKeys,readPrivatePdf,removePrivatePdf,writePrivatePdf,MAX_PRIVATE_PDF_BYTES } from "../src/lib/storage";
import { query } from "../src/lib/db";
import { REPORT_RETENTION_LOCK_CLASS,REPORT_RETENTION_LOCK_ID } from "../src/lib/report-retention";

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
  lockCalls.length=0;lockClient.query.mockClear();
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
  it("refuses a PDF that cannot be delivered within the function payload limit",async()=>{
    vi.stubEnv("NOVA_REPORT_STORAGE","database");
    const bytes=Buffer.alloc(MAX_PRIVATE_PDF_BYTES+1);bytes.write("%PDF");
    await expect(writePrivatePdf(KEY,bytes)).rejects.toThrow(/oversized/);
    expect(readdirSync(dir)).toEqual([]);
  });
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

describe("database report storage",()=>{
  const stored=new Map<string,Buffer>();
  const insert=vi.fn(async(_sql:string,values:unknown[])=>{
    stored.set(String(values[0]),values[3] as Buffer);
    return {rows:[{file_key:values[0]}]};
  });
  const client={query:insert} as unknown as PoolClient;
  beforeEach(()=>{
    vi.stubEnv("NOVA_REPORT_STORAGE","database");stored.clear();insert.mockClear();
    vi.mocked(query).mockReset();
    vi.mocked(query).mockImplementation((async(_sql:string,values:unknown[])=>{
      const bytes=stored.get(String(values[0]));return bytes?[{encrypted_body:bytes}]:[];
    }) as never);
  });
  it("requires the publication transaction and never falls back to disk",async()=>{
    await expect(writePrivatePdf(KEY,Buffer.from("%PDF body"))).rejects.toThrow(/publication/);
    expect(readdirSync(dir)).toEqual([]);
  });
  it("round trips the same encrypted envelope without exposing plaintext",async()=>{
    const pdf=Buffer.from("%PDF synthetic-private-marker");
    await writePrivatePdf(KEY,pdf,client);
    expect(await readPrivatePdf(KEY)).toEqual(pdf);
    expect(stored.get(KEY)?.subarray(0,5).toString()).toBe("NOVA1");
    expect(stored.get(KEY)?.includes(Buffer.from("synthetic-private-marker"))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    expect(insert.mock.calls[0][1][4]).toBe("CN");
    expect(vi.mocked(query).mock.calls[0][1]).toEqual([KEY,"CN"]);
  });
  it("rejects a missing owner rather than publishing an unowned file",async()=>{
    const absent={query:vi.fn(async()=>({rows:[]}))} as unknown as PoolClient;
    await expect(writePrivatePdf(KEY,Buffer.from("%PDF body"),absent)).rejects.toThrow(/owner/);
  });
  it("rejects tampered database ciphertext",async()=>{
    await writePrivatePdf(KEY,Buffer.from("%PDF body"),client);
    const bytes=stored.get(KEY)!;bytes[bytes.length-1]^=0xff;
    await expect(readPrivatePdf(KEY)).rejects.toThrow();
  });
  it("deletes only the selected regional file without waiting on a filesystem backup lock",async()=>{
    await removePrivatePdf(KEY);
    expect(vi.mocked(query)).toHaveBeenCalledWith("DELETE FROM report_files WHERE file_key=$1 AND region=$2",[KEY,"CN"]);
    expect(lockClient.query).not.toHaveBeenCalled();
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
  it("takes a shared advisory transaction lock before unlinking",async()=>{
    await writePrivatePdf(KEY,Buffer.from("%PDF"));
    await removePrivatePdf(KEY);
    expect(lockCalls.some(sql=>sql.includes("pg_advisory_xact_lock_shared"))).toBe(true);
    expect(lockClient.query).toHaveBeenCalledWith("SELECT pg_advisory_xact_lock_shared($1, $2)",[REPORT_RETENTION_LOCK_CLASS,REPORT_RETENTION_LOCK_ID]);
  });
  it("does not take the retention lock for an invalid key",async()=>{
    await expect(removePrivatePdf("../escaped.pdf.enc")).rejects.toThrow(/Invalid private report key/);
    expect(lockClient.query).not.toHaveBeenCalled();
  });
});
