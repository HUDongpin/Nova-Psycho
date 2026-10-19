import { describe,it,expect,afterEach } from "vitest";
import { chmodSync,existsSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,readlinkSync,rmSync,symlinkSync,writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
const run=promisify(execFile);

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

  it.each([0o077,0o400,0o700])("keeps owned staging usable and private under umask %i",async(mask)=>{
    const dir=tempDir();
    const database=await encryptedPayload(dir,"database","database-bytes");
    const reports=await encryptedPayload(dir,"reports","reports-bytes");
    const program=`
      import assert from "node:assert/strict";
      import fs from "node:fs/promises";
      import path from "node:path";
      import { withDecryptedBackup } from ${JSON.stringify(new URL("../scripts/restore-lib.ts",import.meta.url).href)};
      process.umask(${mask});
      await withDecryptedBackup(${JSON.stringify(dir)},${JSON.stringify(database)},${JSON.stringify(reports)},true,Buffer.from(${JSON.stringify(key.toString("hex"))},"hex"),async(dump,reports)=>{
        assert.equal((await fs.stat(path.dirname(dump))).mode&0o777,0o700);
        assert.equal((await fs.stat(dump)).mode&0o777,0o600);
        assert.equal((await fs.stat(reports)).mode&0o777,0o600);
        assert.equal(await fs.readFile(dump,"utf8"),"database-bytes");
        assert.equal(await fs.readFile(reports,"utf8"),"reports-bytes");
      });
      assert.deepEqual((await fs.readdir(${JSON.stringify(dir)})).filter(name=>name.startsWith(".restore-")),[]);
    `;
    try{
      await run(process.execPath,["--import","tsx","--input-type=module","-e",program]);
    }finally{
      for(const name of readdirSync(dir).filter(name=>name.startsWith(".restore-")))chmodSync(path.join(dir,name),0o700);
    }
  });

  it("cleans callback failure without changing prior staging or sibling symlinks",async()=>{
    const dir=tempDir();
    const database=await encryptedPayload(dir,"database","database-bytes");
    const reports=await encryptedPayload(dir,"reports","reports-bytes");
    const previous=path.join(dir,".restore-previous-run"),sentinel=path.join(dir,"keep.txt");
    mkdirSync(previous);writeFileSync(path.join(previous,"database.dump"),"older owned-by-another-run");
    writeFileSync(sentinel,"sibling");
    const link=path.join(dir,".restore-sibling-link"),dangling=path.join(dir,".restore-dangling-link");
    symlinkSync(sentinel,link);symlinkSync(path.join(dir,"absent"),dangling);
    const before=readdirSync(dir).sort(),failure=new Error("Synthetic restore callback failure");
    let staging="";
    await expect(withDecryptedBackup(dir,database,reports,true,key,async(dump,archive)=>{
      staging=path.dirname(dump);
      expect(readFileSync(dump,"utf8")).toBe("database-bytes");
      expect(readFileSync(archive,"utf8")).toBe("reports-bytes");
      throw failure;
    })).rejects.toBe(failure);
    expect(existsSync(staging)).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(before);
    expect(readFileSync(path.join(previous,"database.dump"),"utf8")).toBe("older owned-by-another-run");
    expect(readFileSync(sentinel,"utf8")).toBe("sibling");
    expect(readlinkSync(link)).toBe(sentinel);expect(readlinkSync(dangling)).toBe(path.join(dir,"absent"));
  });

  it("removes its staging directory if the first archive cannot be read",async()=>{
    const dir=tempDir();let called=false;
    writeFileSync(path.join(dir,"keep.txt"),"sibling");
    await expect(withDecryptedBackup(dir,path.join(dir,"missing.enc"),path.join(dir,"reports.enc"),true,key,async()=>{called=true;})).rejects.toMatchObject({code:"ENOENT"});
    expect(called).toBe(false);expect(readdirSync(dir)).toEqual(["keep.txt"]);
  });
});
