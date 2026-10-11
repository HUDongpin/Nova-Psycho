import pg from "pg";
import {randomBytes,randomUUID} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import {getConfig} from "../src/lib/config";
import {closeDatabase,pool,query} from "../src/lib/db";
import {acquireExclusiveReportRetentionLock,releaseExclusiveReportRetentionLock} from "../src/lib/report-retention";
import {removePrivatePdf,writePrivatePdf} from "../src/lib/storage";
import {processDeletionJobs} from "../src/lib/worker";
import {backupKeyFromEnv,createRegionalBackup,missingRestoredReportKeys,run,withConsistentBackupSnapshot} from "./backup-lib";
import {withDecryptedBackup} from "./restore-lib";
import {assertThrowawayDatabase,assertThrowawayTarget} from "./test-database-guard";

// Isolated acceptance for backup snapshot/count/file consistency. Codex runs this
// against a local PostgreSQL 16 cluster. The script creates a throwaway database
// and synthetic report files only.

const original=getConfig();
assertThrowawayTarget({mode:original.mode,databaseUrl:original.databaseUrl,aiEnabled:original.ai.enabled});
const control=new pg.Client({connectionString:original.databaseUrl});
const database=`nova_backup_${randomBytes(6).toString("hex")}`;let created=false;
const stamp=randomBytes(4).toString("hex");
const reportDir=path.resolve("work/qa",`backup-checks-reports-${stamp}`);
const backupRoot=path.resolve("work/qa",`backup-checks-backups-${stamp}`);
const results:{name:string;passed:boolean}[]=[];
async function check(name:string,fn:()=>Promise<void>){await fn();results.push({name,passed:true});console.log(`PASS ${name}`);}

const KEY_CN=`${randomUUID()}.${randomUUID()}.zh-CN.pdf.enc`;
const KEY_HK=`${randomUUID()}.${randomUUID()}.zh-HK.pdf.enc`;
const KEY_LIVE=`${randomUUID()}.${randomUUID()}.zh-CN.pdf.enc`;
const KEY_DELETE=`${randomUUID()}.${randomUUID()}.zh-CN.pdf.enc`;
const KEY_MISSING=`${randomUUID()}.${randomUUID()}.zh-CN.pdf.enc`;

try{
  await control.connect();
  await assertThrowawayDatabase(control);
  await control.query(`CREATE DATABASE "${database}"`);created=true;
  const url=new URL(original.databaseUrl);url.pathname=`/${database}`;process.env.DATABASE_URL=url.toString();
  process.env.NOVA_REPORT_DIR=reportDir;process.env.NOVA_BACKUP_DIR=backupRoot;
  await fs.mkdir(reportDir,{recursive:true,mode:0o700});
  await pool().query(await fs.readFile(new URL("../src/lib/schema.sql",import.meta.url),"utf8"));
  await pool().query("INSERT INTO deployment_settings(singleton,region,mode) VALUES(true,$1,'demo')",[original.region]);
  const adminId=randomUUID();const parentId=randomUUID();const familyId=randomUUID();const assessmentId=randomUUID();
  await query("INSERT INTO users(id,region,username,name,role,demo) VALUES($1,$2,$3,$4,'admin',true)",[adminId,original.region,`admin-${adminId.slice(0,8)}`,"isolated admin"]);
  await query("INSERT INTO users(id,region,username,name,role,demo) VALUES($1,$2,$3,$4,'parent',true)",[parentId,original.region,`parent-${parentId.slice(0,8)}`,"isolated parent"]);
  await query("INSERT INTO scales(id,scale_id,version,definition) VALUES('backup-scale','backup-scale','1.0.0','{}')",[]);
  await query("INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label) VALUES($1,$2,'Synthetic','Child','2013-04-12','S2','Mother')",[familyId,original.region]);
  await query("INSERT INTO assessments(id,family_id,region,respondent_id,respondent_role,scale_version_id,locale,status) VALUES($1,$2,$3,$4,'parent','backup-scale','zh-CN','published')",[assessmentId,familyId,original.region,parentId]);
  await query("INSERT INTO reports(id,assessment_id,family_id,region,payload,pdf_keys) VALUES($1,$1,$2,$3,'{}',$4)",[assessmentId,familyId,original.region,JSON.stringify({"zh-CN":KEY_CN,"zh-HK":KEY_HK})]);
  await writePrivatePdf(KEY_CN,Buffer.from("%PDF-1.4 cn\n%%EOF"));
  await writePrivatePdf(KEY_HK,Buffer.from("%PDF-1.4 hk\n%%EOF"));
  await writePrivatePdf(KEY_LIVE,Buffer.from("%PDF-1.4 live extra\n%%EOF"));
  await writePrivatePdf(KEY_DELETE,Buffer.from("%PDF-1.4 delete me\n%%EOF"));

  await check("counts come from the exported snapshot, not from later inserts",async()=>{
    const extra=new pg.Client({connectionString:url.toString()});
    await extra.connect();
    try{
      await withConsistentBackupSnapshot(async ctx=>{
        const before=ctx.counts.users;
        await extra.query("INSERT INTO users(id,region,username,name,role,demo) VALUES($1,$2,$3,$4,'parent',true)",[randomUUID(),original.region,`late-${randomBytes(3).toString("hex")}`,"late insert"]);
        const live=await extra.query("SELECT count(*)::int AS n FROM users");
        assert.equal(ctx.counts.users,before);
        assert.equal(live.rows[0].n,before+1);
      });
    }finally{await extra.end();}
  });

  await check("deletion returns busy during backup, retains its task, and succeeds on the next cycle",async()=>{
    const lockClient=new pg.Client({connectionString:url.toString()});
    await lockClient.connect();
    let lockHeld=false;
    try{
      await query("INSERT INTO file_deletion_jobs(file_key) VALUES($1)",[KEY_DELETE]);
      await acquireExclusiveReportRetentionLock(lockClient);
      lockHeld=true;
      const started=Date.now();
      assert.equal(await removePrivatePdf(KEY_DELETE),"busy");
      assert.equal(await processDeletionJobs(),"busy");
      assert.ok(Date.now()-started<2000,"Cleanup must not wait for the exclusive backup lock");
      assert.equal((await fs.readdir(reportDir)).includes(KEY_DELETE),true);
      assert.equal((await query("SELECT file_key FROM file_deletion_jobs WHERE file_key=$1",[KEY_DELETE])).length,1);
      await releaseExclusiveReportRetentionLock(lockClient);
      lockHeld=false;
      assert.equal(await processDeletionJobs(),"done");
      assert.equal((await fs.readdir(reportDir)).includes(KEY_DELETE),false);
      assert.equal((await query("SELECT file_key FROM file_deletion_jobs WHERE file_key=$1",[KEY_DELETE])).length,0);
    }finally{
      if(lockHeld){try{await releaseExclusiveReportRetentionLock(lockClient);}catch{/* still close */}}
      await lockClient.end();
    }
  });

  await check("backup archives referenced files and refuses a missing reference",async()=>{
    const {target,manifest}=await createRegionalBackup();
    await withDecryptedBackup(target,path.join(target,manifest.database.file),path.join(target,manifest.reports.file),manifest.encrypted,backupKeyFromEnv(),async(_dump,archive)=>{
      const listing=await run("tar",["-tzf",archive]);
      const names=String(listing.stdout).split(/\r?\n/).map(name=>name.replace(/^\.\//,"")).filter(name=>name&&name!==".");
      assert.deepEqual(names.sort(),[KEY_CN,KEY_HK].sort());
      assert.equal(manifest.reports.fileCount,2);
      const restored=path.resolve("work/qa",`backup-checks-restored-${stamp}`);
      await fs.mkdir(restored,{recursive:true,mode:0o700});
      await run("tar",["-xzf",archive,"-C",restored]);
      assert.deepEqual((await fs.readdir(restored)).sort(),[KEY_CN,KEY_HK].sort());
      const present=await missingRestoredReportKeys(restored,[{pdf_keys:{"zh-CN":KEY_CN,"zh-HK":KEY_HK}}]);
      assert.deepEqual(present,[]);
      const rejected=await missingRestoredReportKeys(restored,[{pdf_keys:{"zh-CN":KEY_CN,"zh-HK":KEY_MISSING}}]);
      assert.deepEqual(rejected,[KEY_MISSING]);
    });

    assert.equal(await removePrivatePdf(KEY_HK),"done");
    await assert.rejects(()=>createRegionalBackup(),/Referenced report file is missing/);
  });
}finally{
  try{
    await closeDatabase();
    if(created)await control.query(`DROP DATABASE "${database}"`);
  }finally{
    process.env.DATABASE_URL=original.databaseUrl;process.env.NOVA_REPORT_DIR=original.reportDir;
    await control.end();
  }
  await fs.mkdir("work/qa",{recursive:true});
  await fs.writeFile("work/qa/backup-checks.json",JSON.stringify({timestamp:new Date().toISOString(),isolatedDatabase:true,syntheticDataOnly:true,results},null,2));
}
console.log(`Backup snapshot acceptance passed: ${results.length} checks.`);
