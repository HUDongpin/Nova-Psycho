import { describe,it,expect,afterEach } from "vitest";
import { existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectReferencedPdfKeys,countedTableSql,createExclusiveBackupTarget,isCountedTable,missingRestoredReportKeys,stageReferencedReports } from "../scripts/backup-lib";

const created:string[]=[];
function tempDir():string{
  const dir=mkdtempSync(path.join(tmpdir(),"nova-snapshot-"));
  created.push(dir);
  return dir;
}
afterEach(()=>{for(const dir of created.splice(0))rmSync(dir,{recursive:true,force:true});});

const KEY_CN="11111111-2222-4333-8444-555555555555.99999999-8888-4777-8666-555555555555.zh-CN.pdf.enc";
const KEY_HK="11111111-2222-4333-8444-555555555555.99999999-8888-4777-8666-555555555555.zh-HK.pdf.enc";
const KEY_OTHER="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.zh-CN.pdf.enc";

describe("manifest table names",()=>{
  it("accepts the known backup tables",()=>{
    expect(isCountedTable("reports")).toBe(true);
    expect(countedTableSql("reports")).toBe("SELECT count(*)::int AS n FROM reports");
  });
  it("refuses an unknown or injected table name",()=>{
    expect(isCountedTable("reports; DROP TABLE users")).toBe(false);
    expect(isCountedTable("pg_shadow")).toBe(false);
    expect(()=>countedTableSql("reports; DROP TABLE users")).toThrow(/Unsupported table name/);
  });
});

describe("referenced report keys",()=>{
  it("collects unique filenames from pdf_keys objects",()=>{
    expect(collectReferencedPdfKeys([
      {pdf_keys:{"zh-CN":KEY_CN,"zh-HK":KEY_HK}},
      {pdf_keys:{"zh-CN":KEY_CN}}
    ])).toEqual([KEY_CN,KEY_HK]);
  });
  it("rejects a path that is not a private report key",()=>{
    expect(()=>collectReferencedPdfKeys([{pdf_keys:{"zh-CN":"../secret"}}])).toThrow(/Invalid private report key/);
  });
});

describe("staging referenced reports",()=>{
  it("copies only the snapshot's files and ignores live extras",async()=>{
    const reports=tempDir();
    const staging=path.join(tempDir(),"stage");
    writeFileSync(path.join(reports,KEY_CN),"one");
    writeFileSync(path.join(reports,KEY_HK),"two");
    writeFileSync(path.join(reports,KEY_OTHER),"live-extra");
    writeFileSync(path.join(reports,"stray.txt"),"ignore");
    const count=await stageReferencedReports(reports,staging,[KEY_CN,KEY_HK]);
    expect(count).toBe(2);
    expect(readdirSync(staging).sort()).toEqual([KEY_CN,KEY_HK]);
    expect(existsSync(path.join(staging,KEY_OTHER))).toBe(false);
    expect(existsSync(path.join(staging,"stray.txt"))).toBe(false);
  });
  it("fails rather than recording a backup when a referenced file is missing",async()=>{
    const reports=tempDir();
    const staging=path.join(tempDir(),"stage");
    writeFileSync(path.join(reports,KEY_CN),"one");
    await expect(stageReferencedReports(reports,staging,[KEY_CN,KEY_HK])).rejects.toThrow(/Referenced report file is missing/);
  });
  it("refuses to stage a key that would escape the report directory",async()=>{
    const reports=tempDir();
    const staging=path.join(tempDir(),"stage");
    await expect(stageReferencedReports(reports,staging,["../escaped.pdf.enc"])).rejects.toThrow(/Invalid private report key/);
  });
});

describe("exclusive backup directory ownership",()=>{
  it("refuses an existing timestamp directory and leaves its bytes untouched",async()=>{
    const target=path.join(tempDir(),"CN","2026-09-19T14-00-00-000Z");
    mkdirSync(target,{recursive:true});
    const dump=path.join(target,"database.dump");
    writeFileSync(dump,"OLD-DUMP-BYTES");
    await expect(createExclusiveBackupTarget(target)).rejects.toThrow(/already exists/);
    expect(readFileSync(dump,"utf8")).toBe("OLD-DUMP-BYTES");
    expect(readdirSync(target)).toEqual(["database.dump"]);
  });
  it("creates only a newly owned target and leaves a sibling backup in place",async()=>{
    const regionDir=path.join(tempDir(),"CN");
    const previous=path.join(regionDir,"2026-09-19T13-00-00-000Z");
    mkdirSync(previous,{recursive:true});
    writeFileSync(path.join(previous,"database.dump"),"KEEP-PREVIOUS");
    const next=path.join(regionDir,"2026-09-19T14-00-00-000Z");
    await createExclusiveBackupTarget(next);
    expect(existsSync(next)).toBe(true);
    expect(readFileSync(path.join(previous,"database.dump"),"utf8")).toBe("KEEP-PREVIOUS");
    rmSync(next,{recursive:true,force:true});
    expect(readFileSync(path.join(previous,"database.dump"),"utf8")).toBe("KEEP-PREVIOUS");
    expect(existsSync(next)).toBe(false);
  });
});

describe("restored reference verification",()=>{
  it("accepts a directory that contains every referenced file",async()=>{
    const dir=tempDir();
    writeFileSync(path.join(dir,KEY_CN),"one");
    writeFileSync(path.join(dir,KEY_HK),"two");
    await expect(missingRestoredReportKeys(dir,[{pdf_keys:{"zh-CN":KEY_CN,"zh-HK":KEY_HK}}])).resolves.toEqual([]);
  });
  it("rejects when a referenced file is absent even if the total count matches",async()=>{
    const dir=tempDir();
    writeFileSync(path.join(dir,KEY_OTHER),"decoy");
    writeFileSync(path.join(dir,"stray.txt"),"also");
    const missing=await missingRestoredReportKeys(dir,[{pdf_keys:{"zh-CN":KEY_CN,"zh-HK":KEY_HK}}]);
    expect(missing).toEqual([KEY_CN,KEY_HK]);
  });
});
