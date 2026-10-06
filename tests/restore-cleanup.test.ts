import { describe,it,expect,afterEach } from "vitest";
import { existsSync,mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decryptFile,encryptFile } from "../scripts/backup-lib";
import { withDecryptedBackup } from "../scripts/restore-lib";

const created:string[]=[];
function tempDir():string{
  const dir=mkdtempSync(path.join(tmpdir(),"nova-restore-test-"));
  created.push(dir);
  return dir;
}
afterEach(()=>{for(const dir of created.splice(0))rmSync(dir,{recursive:true,force:true});});

const key=Buffer.from("0f".repeat(32),"hex");
const wrongKey=Buffer.from("ff".repeat(32),"hex");

async function encryptedPayload(dir:string,name:string,contents:string,useKey=key):Promise<string>{
  const source=path.join(dir,`${name}.src`);
  const encrypted=path.join(dir,`${name}.enc`);
  writeFileSync(source,contents);
  await encryptFile(source,encrypted,useKey);
  return encrypted;
}

describe("decryptFile failed-output removal",()=>{
  it("removes a partially written destination when the key is wrong",async()=>{
    const dir=tempDir();
    const encrypted=await encryptedPayload(dir,"payload","PGDMP synthetic dump payload");
    const destination=path.join(dir,"out.bin");
    await expect(decryptFile(encrypted,destination,wrongKey)).rejects.toThrow(/does not match, or the file is damaged/);
    expect(existsSync(destination)).toBe(false);
  });
});

describe("restore decrypt cleanup",()=>{
  it("does not create a temp directory for an unencrypted backup",async()=>{
    const dir=tempDir();
    const database=path.join(dir,"database.dump");
    const reports=path.join(dir,"reports.tar.gz");
    writeFileSync(database,"dump");
    writeFileSync(reports,"tar");
    writeFileSync(path.join(dir,"keep.txt"),"sibling");
    await withDecryptedBackup(dir,database,reports,false,null,async(dump,archive)=>{
      expect(dump).toBe(database);
      expect(archive).toBe(reports);
    });
    expect(readdirSync(dir).some(name=>name.startsWith(".restore-"))).toBe(false);
    expect(existsSync(path.join(dir,"keep.txt"))).toBe(true);
  });

  it("refuses an encrypted backup without a key before creating a temp directory",async()=>{
    const dir=tempDir();
    writeFileSync(path.join(dir,"keep.txt"),"sibling");
    await expect(withDecryptedBackup(dir,"a","b",true,null,async()=>undefined)).rejects.toThrow(/NOVA_BACKUP_KEY/);
    expect(readdirSync(dir).some(name=>name.startsWith(".restore-"))).toBe(false);
    expect(existsSync(path.join(dir,"keep.txt"))).toBe(true);
  });

  it("decrypts into a unique directory and removes it after success",async()=>{
    const dir=tempDir();
    const database=await encryptedPayload(dir,"database","database-bytes");
    const reports=await encryptedPayload(dir,"reports","reports-bytes");
    writeFileSync(path.join(dir,"keep.txt"),"sibling");
    let seen="";
    await withDecryptedBackup(dir,database,reports,true,key,async(dump,archive)=>{
      expect(readFileSync(dump,"utf8")).toBe("database-bytes");
      expect(readFileSync(archive,"utf8")).toBe("reports-bytes");
      seen=path.dirname(dump);
      expect(seen.startsWith(path.join(dir,".restore-"))).toBe(true);
      expect(seen).not.toBe(dir);
    });
    expect(existsSync(seen)).toBe(false);
    expect(readdirSync(dir).some(name=>name.startsWith(".restore-"))).toBe(false);
    expect(existsSync(path.join(dir,"keep.txt"))).toBe(true);
  });

  it("removes the first plaintext dump if the second archive fails to decrypt",async()=>{
    const dir=tempDir();
    const database=await encryptedPayload(dir,"database","database-bytes");
    const reports=await encryptedPayload(dir,"reports","reports-bytes",wrongKey);
    writeFileSync(path.join(dir,"keep.txt"),"sibling");
    await expect(withDecryptedBackup(dir,database,reports,true,key,async()=>undefined)).rejects.toThrow(/does not match, or the file is damaged/);
    expect(readdirSync(dir).filter(name=>name.startsWith(".restore-"))).toEqual([]);
    expect(existsSync(path.join(dir,"keep.txt"))).toBe(true);
    expect(readdirSync(dir).some(name=>name.includes("database.dump"))).toBe(false);
  });
});
