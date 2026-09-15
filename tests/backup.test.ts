import { describe,it,expect,afterEach,vi } from "vitest";
import { mkdtempSync,readFileSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { backupKeyFromEnv,decryptFile,encryptFile,fingerprintKey,maskUrl,parseDbUrl,pgConnection,sha256File,timestampSlug } from "../scripts/backup-lib";

const created:string[]=[];
function tempFile(contents:Buffer|string):string{
  const dir=mkdtempSync(path.join(tmpdir(),"nova-backup-test-"));created.push(dir);
  const file=path.join(dir,"payload.bin");writeFileSync(file,contents);return file;
}
afterEach(()=>{for(const dir of created.splice(0))rmSync(dir,{recursive:true,force:true});vi.unstubAllEnvs();});

describe("database URL handling",()=>{
  const url="postgresql://nova:s3cret-pw@127.0.0.1:55431/nova_cn";
  it("never exposes the password when a URL is printed",()=>{
    const masked=maskUrl(url);
    expect(masked).not.toContain("s3cret-pw");
    expect(masked).toBe("postgresql://nova:***@127.0.0.1:55431/nova_cn");
  });
  it("parses host, port, user and database",()=>{
    expect(parseDbUrl(url)).toMatchObject({host:"127.0.0.1",port:"55431",user:"nova",database:"nova_cn"});
  });
  it("defaults the port when the URL omits it",()=>{
    expect(parseDbUrl("postgresql://nova:pw@db.internal/nova").port).toBe("5432");
  });
  it("rejects a non-PostgreSQL URL",()=>{
    expect(()=>parseDbUrl("mysql://nova:pw@127.0.0.1/nova")).toThrow();
  });
  // The password must not reach argv, where any local process could read it from ps.
  it("passes the password through the environment, never as an argument",()=>{
    const {args,env,label}=pgConnection(url);
    expect(args.join(" ")).not.toContain("s3cret-pw");
    expect(env.PGPASSWORD).toBe("s3cret-pw");
    expect(args).toEqual(["--host","127.0.0.1","--port","55431","--username","nova","--dbname","nova_cn"]);
    expect(label).toBe("127.0.0.1:55431/nova_cn");
  });
});

describe("key fingerprinting",()=>{
  it("is stable, short, and does not contain the key",()=>{
    const key=Buffer.from("a".repeat(64),"hex");
    const print=fingerprintKey(key);
    expect(print).toBe(fingerprintKey(key));
    expect(print).toHaveLength(16);
    expect(print).not.toContain(key.toString("hex"));
  });
  it("differs for different keys",()=>{
    expect(fingerprintKey(Buffer.from("a".repeat(64),"hex"))).not.toBe(fingerprintKey(Buffer.from("b".repeat(64),"hex")));
  });
  it("rejects a malformed backup key instead of silently truncating it",()=>{
    vi.stubEnv("NOVA_BACKUP_KEY","not-hex");
    expect(()=>backupKeyFromEnv()).toThrow();
    vi.stubEnv("NOVA_BACKUP_KEY","ab".repeat(16));
    expect(()=>backupKeyFromEnv()).toThrow();
    vi.stubEnv("NOVA_BACKUP_KEY","");
    expect(backupKeyFromEnv()).toBeNull();
  });
});

describe("backup archive encryption",()=>{
  const key=Buffer.from("0f".repeat(32),"hex");
  it("round-trips the exact bytes",async()=>{
    const source=tempFile(Buffer.from("PGDMP synthetic dump payload"));
    const encrypted=path.join(path.dirname(source),"enc.bin");
    const restored=path.join(path.dirname(source),"out.bin");
    await encryptFile(source,encrypted,key);
    await decryptFile(encrypted,restored,key);
    expect(readFileSync(restored)).toEqual(readFileSync(source));
  });
  it("does not leave the plaintext readable in the encrypted file",async()=>{
    const source=tempFile(Buffer.from("PGDMP synthetic dump payload"));
    const encrypted=path.join(path.dirname(source),"enc.bin");
    await encryptFile(source,encrypted,key);
    expect(readFileSync(encrypted).toString("latin1")).not.toContain("synthetic dump payload");
  });
  it("fails closed on a wrong key rather than returning garbage",async()=>{
    const source=tempFile(Buffer.from("PGDMP synthetic dump payload"));
    const encrypted=path.join(path.dirname(source),"enc.bin");
    const restored=path.join(path.dirname(source),"out.bin");
    await encryptFile(source,encrypted,key);
    await expect(decryptFile(encrypted,restored,Buffer.from("ff".repeat(32),"hex"))).rejects.toThrow(/does not match, or the file is damaged/);
  });
  it("rejects a file that is not in the expected format",async()=>{
    const source=tempFile(randomBytes(200));
    await expect(decryptFile(source,path.join(path.dirname(source),"out.bin"),key)).rejects.toThrow(/expected encrypted format/);
  });
  it("rejects a file too short to carry a header",async()=>{
    const source=tempFile(Buffer.from("NOVA1"));
    await expect(decryptFile(source,path.join(path.dirname(source),"out.bin"),key)).rejects.toThrow(/too short/);
  });
});

describe("checksums",()=>{
  it("matches a known digest for known content",async()=>{
    // printf 'nova' | shasum -a 256
    expect(await sha256File(tempFile("nova"))).toBe("19e05df6b2e5fb94f3ee7eed2c02d340a1128a00231f5f6949641a143ab3b57a");
  });
  it("changes when a single byte changes",async()=>{
    expect(await sha256File(tempFile("nova"))).not.toBe(await sha256File(tempFile("novb")));
  });
});

describe("backup directory naming",()=>{
  it("produces a filesystem-safe, sortable stamp",()=>{
    const slug=timestampSlug(new Date("2026-09-15T06:42:31.123Z"));
    expect(slug).toBe("2026-09-15T06-42-31-123Z");
    expect(slug).not.toMatch(/[:.]/);
  });
});
