import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import pg from "pg";
import fs from "node:fs/promises";
import path from "node:path";

vi.mock("../src/lib/db",()=>({closeDatabase:vi.fn(async()=>undefined),pool:vi.fn(),query:vi.fn()}));

const calls:string[]=[];
const stopAtCreate=new Error("Synthetic stop before database creation");

beforeEach(()=>{
  vi.resetModules();calls.length=0;
  vi.stubEnv("NOVA_REGION","CN");vi.stubEnv("NOVA_MODE","demo");
  vi.stubEnv("DATABASE_URL","postgresql://127.0.0.1:55432/nova_backup_guard");
  vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3199");
  vi.stubEnv("NOVA_REPORT_DIR","work/verification/backup-guard-reports");
  vi.stubEnv("NOVA_REPORT_KEY","0".repeat(64));
  vi.stubEnv("NOVA_AI_ENABLED","false");
  vi.stubEnv("NOVA_BACKUP_DIR","work/verification/backup-guard-backups");
  vi.spyOn(pg.Client.prototype,"connect").mockImplementation((async()=>{calls.push("connect");}) as never);
  vi.spyOn(pg.Client.prototype,"query").mockImplementation((async(sql:string)=>{
    calls.push(sql);
    if(sql.startsWith("CREATE DATABASE"))throw stopAtCreate;
    return {rows:[]};
  }) as never);
  vi.spyOn(pg.Client.prototype,"end").mockImplementation(async()=>{calls.push("end");});
  vi.spyOn(fs,"mkdir").mockResolvedValue(undefined);
  vi.spyOn(fs,"writeFile").mockResolvedValue(undefined);
});

describe("backup acceptance script encrypted archive",()=>{
  it.each([false,true])("reads manifest-selected archives through the restore helper and rejects extras=%s",async extra=>{
    vi.stubEnv("NOVA_BACKUP_KEY","1".repeat(64));
    const lib=await import("../scripts/backup-lib");
    const restore=await import("../scripts/restore-lib");
    const storage=await import("../src/lib/storage");
    const worker=await import("../src/lib/worker");
    const retention=await import("../src/lib/report-retention");
    const db=await import("../src/lib/db");
    const files=new Set<string>();
    const written:string[]=[];
    let locked=false;
    let queued:string|null=null;
    const target=path.resolve("work/verification/backup-guard-backups/owned");
    const decodedArchive=path.join(target,".restore-owned/reports.tar.gz");
    vi.spyOn(console,"log").mockImplementation(()=>{});
    vi.mocked(pg.Client.prototype.query).mockImplementation((async(sql:string)=>({rows:sql.includes("count(*)")?[{n:2}]:[]})) as never);
    vi.mocked(db.pool).mockReturnValue({query:vi.fn(async()=>({rows:[]}))} as never);
    vi.mocked(db.query).mockImplementation((async(sql:string,values:unknown[]=[])=>{
      if(sql.startsWith("INSERT INTO file_deletion_jobs"))queued=String(values[0]);
      return sql.startsWith("SELECT file_key FROM file_deletion_jobs")&&queued?[{file_key:queued}]:[];
    }) as never);
    vi.spyOn(storage,"writePrivatePdf").mockImplementation(async key=>{files.add(key);written.push(key);});
    vi.spyOn(storage,"removePrivatePdf").mockImplementation(async key=>{
      if(locked)return "busy";
      files.delete(key);return "done";
    });
    vi.spyOn(worker,"processDeletionJobs").mockImplementation(async()=>{
      if(locked)return "busy";
      if(queued)files.delete(queued);
      queued=null;return "done";
    });
    vi.spyOn(retention,"acquireExclusiveReportRetentionLock").mockImplementation(async()=>{locked=true;});
    vi.spyOn(retention,"releaseExclusiveReportRetentionLock").mockImplementation(async()=>{locked=false;});
    vi.spyOn(fs,"readdir").mockImplementation((async(dir:string)=>String(dir).includes("restored")?written.slice(0,2):[...files]) as never);
    vi.spyOn(lib,"withConsistentBackupSnapshot").mockImplementation((async(fn:(ctx:unknown)=>Promise<unknown>)=>fn({counts:{users:1}})) as never);
    const backup=vi.spyOn(lib,"createRegionalBackup").mockImplementation(async()=>{
      if(!files.has(written[1]))throw new Error("Referenced report file is missing");
      return {target,manifest:{formatVersion:1,region:"CN",mode:"demo",createdAt:"synthetic",encrypted:true,reportKeyFingerprint:"synthetic",
        database:{file:"selected-database.dump.enc",bytes:1,sha256:"synthetic",tables:{users:1}},
        reports:{file:"selected-reports.tar.gz.enc",bytes:1,sha256:"synthetic",fileCount:2},tools:{node:"synthetic",pgDump:"synthetic"}}};
    });
    const reader=vi.spyOn(restore,"withDecryptedBackup").mockImplementation(async(_dir,_database,_reports,_encrypted,_key,fn)=>fn(path.join(target,".restore-owned/database.dump"),decodedArchive));
    const tar=vi.spyOn(lib,"run").mockImplementation((async(command:string,args:string[])=>{
      expect(command).toBe("tar");
      expect(args[1]).toBe(decodedArchive);
      return {stdout:args[0]==="-tzf"?`./\n${written.slice(0,2).map(key=>`./${key}\n`).join("")}${extra?"./unexpected.txt\n":""}`:"",stderr:""};
    }) as never);
    vi.spyOn(lib,"missingRestoredReportKeys").mockImplementation(async(_dir,rows)=>lib.collectReferencedPdfKeys(rows).filter(key=>!written.slice(0,2).includes(key)));
    const runScript=import("../scripts/backup-checks");
    if(extra)await expect(runScript).rejects.toThrow();
    else await expect(runScript).resolves.toBeDefined();
    expect(reader).toHaveBeenCalledWith(target,path.join(target,"selected-database.dump.enc"),path.join(target,"selected-reports.tar.gz.enc"),true,Buffer.from("1".repeat(64),"hex"),expect.any(Function));
    expect(tar).toHaveBeenCalledTimes(extra?1:2);
    expect(backup).toHaveBeenCalledTimes(extra?1:2);
  });
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});

describe("backup acceptance script database gate",()=>{
  it.each([
    "postgresql://remote.example.invalid/nova_backup_guard",
    "postgresql://127.0.0.1:55432/nova_backup_guard?host=remote.example.invalid"
  ])("refuses %s before opening a connection",async databaseUrl=>{
    vi.stubEnv("DATABASE_URL",databaseUrl);
    await expect(import("../scripts/backup-checks")).rejects.toThrow(/loopback|retarget/);
    expect(calls).toEqual([]);
  });

  it.each([
    {region:"CN",mode:"service",reason:/not classified demo/},
    {region:"HK",mode:"demo",reason:/different region/}
  ])("refuses $region/$mode classification and closes without DDL",async({region,mode,reason})=>{
    vi.mocked(pg.Client.prototype.query).mockImplementation((async(sql:string)=>{
      calls.push(sql);
      return {rows:sql.includes("pg_tables")?[{tablename:"deployment_settings"}]:[{region,mode}]};
    }) as never);
    await expect(import("../scripts/backup-checks")).rejects.toThrow(reason);
    expect(calls[0]).toBe("connect");
    expect(calls.at(-1)).toBe("end");
    expect(calls.slice(1,-1)).toHaveLength(2);
    expect(calls.slice(1,-1).every(sql=>sql.startsWith("SELECT"))).toBe(true);
  });

  it.each(["empty","demo"])("checks %s database classification before attempting CREATE",async classification=>{
    vi.mocked(pg.Client.prototype.query).mockImplementation((async(sql:string)=>{
      calls.push(sql);
      if(sql.startsWith("CREATE DATABASE"))throw stopAtCreate;
      if(classification==="empty")return {rows:[]};
      return {rows:sql.includes("pg_tables")?[{tablename:"deployment_settings"}]:[{region:"CN",mode:"demo"}]};
    }) as never);
    await expect(import("../scripts/backup-checks")).rejects.toBe(stopAtCreate);
    expect(calls[0]).toBe("connect");
    const createAt=calls.findIndex(sql=>sql.startsWith("CREATE DATABASE"));
    expect(createAt).toBe(classification==="empty"?2:3);
    expect(calls.slice(1,createAt).every(sql=>sql.startsWith("SELECT"))).toBe(true);
    expect(calls.at(-1)).toBe("end");
    expect(calls.some(sql=>sql.startsWith("DROP DATABASE"))).toBe(false);
  });

  it("closes the control client when connection fails",async()=>{
    const failure=new Error("Synthetic connection failure");
    vi.mocked(pg.Client.prototype.connect).mockImplementation((async()=>{calls.push("connect");throw failure;}) as never);
    await expect(import("../scripts/backup-checks")).rejects.toBe(failure);
    expect(calls).toEqual(["connect","end"]);
  });
});
