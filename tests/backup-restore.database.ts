import assert from "node:assert/strict";
import { randomBytes,randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { createRegionalBackup,run,sha256File } from "../scripts/backup-lib";
import { closeDatabase } from "../src/lib/db";
import { writePrivatePdf } from "../src/lib/storage";

const databaseUrl=process.env.NOVA_BACKUP_REVIEW_DATABASE_URL;
assert.ok(databaseUrl,"Set NOVA_BACKUP_REVIEW_DATABASE_URL to a fresh synthetic database");
const address=new URL(databaseUrl);
assert.ok(["127.0.0.1","localhost"].includes(address.hostname));
assert.equal(address.pathname,"/nova_recovery_backup_cn");
assert.equal(address.password,"");
const selected=process.argv.find(arg=>arg.startsWith("--case="))?.slice(7)??"all";
assert.ok(["all","target-path","target-permissions","restored-permissions","post-restore-failures","interruption","database-failure","roundtrip","corruption","classification","encryption"].includes(selected));
const restoreScript=path.resolve(process.argv.find(arg=>arg.startsWith("--restore-script="))?.slice(17)??"scripts/restore.ts");
assert.ok(restoreScript===path.resolve("scripts/restore.ts")||restoreScript.startsWith(path.resolve("work/qa/restore-boundaries")+path.sep));
const root=await fs.mkdtemp(path.resolve("work/qa/recovery-review/backup/fixture-"));
const sourceName=`nova_backup_review_${randomBytes(8).toString("hex")}`;
const ownedDatabases:string[]=[];
const control=new pg.Client({connectionString:databaseUrl});
const sourceUrl=new URL(databaseUrl);sourceUrl.pathname=`/${sourceName}`;
const syntheticEnv={...process.env,DATABASE_URL:sourceUrl.toString(),NOVA_REGION:"CN",NOVA_MODE:"demo",NOVA_PUBLIC_URL:"http://127.0.0.1:3205",NOVA_REPORT_STORAGE:"filesystem",NOVA_WORKER_MODE:"continuous",NOVA_REPORT_DIR:path.join(root,"reports"),NOVA_BACKUP_DIR:path.join(root,"backups"),NOVA_REPORT_KEY:"0".repeat(64),NOVA_AI_ENABLED:"false",NOVA_AUTH_PROVIDER:"local",NOVA_BACKUP_KEY:"",VERCEL:"0"};
Object.assign(process.env,syntheticEnv);
const outcomes:{name:string;passed:boolean}[]=[];
let source:pg.Client|undefined;

async function createDatabase(){
  const name=`nova_backup_review_${randomBytes(8).toString("hex")}`;
  await control.query(`CREATE DATABASE "${name}"`);ownedDatabases.push(name);
  const url=new URL(databaseUrl!);url.pathname=`/${name}`;return url.toString();
}
async function tableCount(url:string){
  const client=new pg.Client({connectionString:url});await client.connect();
  try{return (await client.query<{n:number}>("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n;}finally{await client.end();}
}
async function restore(backup:string,targetUrl:string,reportDir:string,extra:Partial<NodeJS.ProcessEnv>={},umask?:number){
  let script=restoreScript;
  if(umask!==undefined){
    script=path.join(root,`restore-mask-${randomUUID()}.mjs`);
    await fs.writeFile(script,`process.umask(${umask});await import(${JSON.stringify(pathToFileURL(restoreScript).href)});\n`);
  }
  try{
    const result=await run(process.execPath,["--import","tsx",script,backup],{env:{...syntheticEnv,NOVA_RESTORE_DATABASE_URL:targetUrl,NOVA_RESTORE_REPORT_DIR:reportDir,NOVA_RESTORE_REGION:"CN",...extra},maxBuffer:4*1024*1024});
    return {ok:true,output:String(result.stdout)+String(result.stderr)};
  }catch(error){const result=error as {stdout?:string;stderr?:string};return {ok:false,output:String(result.stdout??"")+String(result.stderr??"")};}
}
async function check(name:string,fn:()=>Promise<void>){await fn();outcomes.push({name,passed:true});console.log(`PASS: ${name}`);}

try{
  await control.connect();
  assert.deepEqual((await control.query("SELECT region,mode FROM deployment_settings WHERE singleton=true")).rows,[{region:"CN",mode:"demo"}]);
  await control.query(`CREATE DATABASE "${sourceName}"`);ownedDatabases.push(sourceName);
  source=new pg.Client({connectionString:sourceUrl.toString()});await source.connect();
  await source.query(await fs.readFile(new URL("../src/lib/schema.sql",import.meta.url),"utf8"));
  await source.query("INSERT INTO deployment_settings(singleton,region,mode) VALUES(true,'CN','demo')");
  const userId=randomUUID(),familyId=randomUUID(),assessmentId=randomUUID();
  const key=`${assessmentId}.${randomUUID()}.zh-CN.pdf.enc`;
  await source.query("INSERT INTO users(id,region,name,role,demo) VALUES($1,'CN','Synthetic backup parent','parent',true)",[userId]);
  await source.query("INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label) VALUES($1,'CN','Synthetic backup','Synthetic child','2013-04-12','S2','Parent')",[familyId]);
  await source.query("INSERT INTO scales(id,scale_id,version,definition) VALUES('synthetic-backup','synthetic-backup','1.0.0','{}')");
  await source.query("INSERT INTO assessments(id,family_id,region,respondent_id,respondent_role,scale_version_id,locale,status) VALUES($1,$2,'CN',$3,'parent','synthetic-backup','zh-CN','published')",[assessmentId,familyId,userId]);
  await source.query("INSERT INTO reports(id,assessment_id,family_id,region,payload,pdf_keys) VALUES($1,$1,$2,'CN','{}',$3)",[assessmentId,familyId,JSON.stringify({"zh-CN":key})]);
  await writePrivatePdf(key,Buffer.from("%PDF-1.4 synthetic backup fixture\n%%EOF"));
  const backup=await createRegionalBackup();

  if(selected==="all"||selected==="classification")await check("backup rejects a database whose region or mode differs from the process",async()=>{
    try{
      process.env.NOVA_REGION="HK";
      await assert.rejects(createRegionalBackup,/Database region does not match/);
      process.env.NOVA_REGION="CN";process.env.NOVA_MODE="service";process.env.NOVA_PUBLIC_URL="https://synthetic.invalid";
      await assert.rejects(createRegionalBackup,/Database data classification does not match/);
    }finally{Object.assign(process.env,syntheticEnv);}
  });
  if(selected==="all"||selected==="target-path")await check("invalid report destination does not modify the restore database",async()=>{
    const target=await createDatabase(),reportDir=path.join(root,"report-file-sentinel");
    await fs.writeFile(reportDir,"KEEP-SYNTHETIC-SENTINEL");
    const result=await restore(backup.target,target,reportDir);
    assert.equal(result.ok,false);assert.equal(await fs.readFile(reportDir,"utf8"),"KEEP-SYNTHETIC-SENTINEL");
    const tables=await tableCount(target);console.log(JSON.stringify({case:"target-path",restoreSucceeded:result.ok,publicTablesAfterFailure:tables}));
    assert.equal(tables,0,"A report target rejected by the filesystem must be rejected before database restoration");
  });
  if(selected==="all"||selected==="target-permissions")await check("unwritable report destinations fail before database restoration",async()=>{
    const counts:number[]=[];
    for(const exists of [false,true]){
      const target=await createDatabase(),parent=path.join(root,exists?"existing-readonly":"missing-readonly");
      await fs.mkdir(parent,{mode:0o700});
      const reportDir=exists?parent:path.join(parent,"reports");
      await fs.chmod(parent,0o555);
      try{
        const result=await restore(backup.target,target,reportDir);
        assert.equal(result.ok,false);assert.match(result.output,/EACCES|Permission denied/);
        const tables=await tableCount(target);counts.push(tables);
        console.log(JSON.stringify({case:"target-permissions",targetExists:exists,restoreSucceeded:result.ok,publicTablesAfterFailure:tables}));
      }finally{await fs.chmod(parent,0o700);}
    }
    assert.deepEqual(counts,[0,0],"Both existing and missing unwritable report directories must be rejected before restoring the database");
  });
  if(selected==="all"||selected==="roundtrip")await check("valid backup restores regional data and the exact encrypted report",async()=>{
    const target=await createDatabase(),reportDir=path.join(root,"roundtrip-reports");
    const result=await restore(backup.target,target,reportDir);
    assert.equal(result.ok,true,result.output);assert.match(result.output,/Restore verified/);
    const reconcileIndex=result.output.indexOf("Keep workers and traffic stopped"),workerIndex=result.output.indexOf("Start the report worker");
    assert.ok(reconcileIndex>=0&&workerIndex>=0);assert.ok(reconcileIndex<workerIndex);
    assert.match(result.output,/passwords, account access, sessions, recovery\/invitation link use and revocation, Clerk revocations, family access, consents and deletions/);
    assert.match(result.output,/Use a newer authoritative source; otherwise keep this target isolated/);
    assert.deepEqual(await fs.readFile(path.join(reportDir,key)),await fs.readFile(path.join(syntheticEnv.NOVA_REPORT_DIR,key)));
    const client=new pg.Client({connectionString:target});await client.connect();
    try{assert.deepEqual((await client.query("SELECT id,pdf_keys FROM reports")).rows,[{id:assessmentId,pdf_keys:{"zh-CN":key}}]);}finally{await client.end();}
  });
  if(selected==="all"||selected==="restored-permissions")await check("restored reports retain private readable permissions independently of caller umask",async()=>{
    const modes:number[]=[];
    for(const [umask,exists] of [[0o077,true],[0o400,true],[0o400,false]] as const){
      const target=await createDatabase(),reportDir=path.join(root,`restored-mask-${umask}-${exists}`);
      if(exists)await fs.mkdir(reportDir,{mode:0o700});
      try{
        const result=await restore(backup.target,target,reportDir,{},umask);
        assert.equal(result.ok,true,result.output);assert.match(result.output,/Restore verified/);
        const file=path.join(reportDir,key),mode=(await fs.stat(file)).mode&0o777;
        const readable=await fs.readFile(file).then(()=>true,()=>false);modes.push(mode);
        console.log(JSON.stringify({case:"restored-permissions",umask:umask.toString(8),targetExisted:exists,restoreSucceeded:result.ok,reportMode:mode.toString(8),readable}));
        assert.equal((await fs.stat(reportDir)).mode&0o777,0o700);
        assert.equal(readable,true);
      }finally{await fs.chmod(reportDir,0o700);}
    }
    assert.deepEqual(modes,[0o600,0o600,0o600],"A verified restore must retain the private report's owner-read permission");
    const deniedTarget=await createDatabase(),deniedDir=path.join(root,"restore-mask-700");
    try{
      const denied=await restore(backup.target,deniedTarget,deniedDir,{},0o700);
      assert.equal(denied.ok,false);assert.equal(await tableCount(deniedTarget),0);
    }finally{await fs.chmod(deniedDir,0o700);}
  });
  if(selected==="all"||selected==="post-restore-failures")await check("extraction and post-restore verification failures never report success and keep outputs private",async()=>{
    const backupKey="ab".repeat(32),realTar=String((await run("which",["tar"])).stdout).trim();
    process.env.NOVA_BACKUP_KEY=backupKey;
    let encrypted:Awaited<ReturnType<typeof createRegionalBackup>>;
    try{encrypted=await createRegionalBackup();}finally{process.env.NOVA_BACKUP_KEY="";}
    for(const failure of ["extraction","missing-reference","row-count"]){
      const target=await createDatabase(),reportDir=path.join(root,`late-failure-${failure}`);
      await fs.mkdir(reportDir,{mode:0o755});await fs.chmod(reportDir,0o755);
      const bin=path.join(root,`tar-${failure}`),observation=path.join(root,`permissions-${failure}.json`),decoy=`${randomUUID()}.${randomUUID()}.zh-CN.pdf.enc`;
      await fs.mkdir(bin,{mode:0o700});
      await fs.writeFile(path.join(bin,"tar"),`#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import cp from 'node:child_process';
const args=process.argv.slice(2),dir=args[args.indexOf('-C')+1];
const before=fs.statSync(dir).mode&0o777;
const result=cp.spawnSync(${JSON.stringify(realTar)},args,{stdio:'inherit'});
if(result.status!==0)process.exit(result.status??1);
const file=path.join(dir,${JSON.stringify(key)});
fs.writeFileSync(${JSON.stringify(observation)},JSON.stringify({before,after:fs.statSync(dir).mode&0o777,fileMode:fs.statSync(file).mode&0o777}));
if(${JSON.stringify(failure)}==='extraction'){fs.truncateSync(file,20);process.stderr.write('SYNTHETIC_EXTRACTION_FAILURE\\n');process.exit(73);}
if(${JSON.stringify(failure)}==='missing-reference')fs.renameSync(file,path.join(dir,${JSON.stringify(decoy)}));
`,{mode:0o700});
      const manifestPath=path.join(encrypted.target,"manifest.json"),manifestBytes=await fs.readFile(manifestPath);
      try{
        if(failure==="row-count"){
          const manifest=JSON.parse(manifestBytes.toString());manifest.database.tables.users++;
          await fs.writeFile(manifestPath,JSON.stringify(manifest));
        }
        const result=await restore(encrypted.target,target,reportDir,{NOVA_BACKUP_KEY:backupKey,PATH:`${bin}${path.delimiter}${process.env.PATH}`});
        assert.equal(result.ok,false);assert.doesNotMatch(result.output,/^Restore verified/m);assert.match(result.output,/database restored/);
        assert.match(result.output,failure==="extraction"?/SYNTHETIC_EXTRACTION_FAILURE/:failure==="missing-reference"?/FAIL missing report file/:/FAIL users 1 expected 2/);
        const tables=await tableCount(target),modes=JSON.parse(await fs.readFile(observation,"utf8"));
        assert.ok(tables>0);assert.deepEqual(modes,{before:0o700,after:0o700,fileMode:0o600});
        assert.equal((await fs.readdir(encrypted.target)).some(name=>name.startsWith(".restore-")),false);
        console.log(JSON.stringify({case:"post-restore-failure",failure,restoreSucceeded:result.ok,publicTablesAfterFailure:tables,privateDirectoryBeforeExtraction:modes.before.toString(8),reportMode:modes.fileMode.toString(8),plaintextStagingRemoved:true}));
      }finally{await fs.writeFile(manifestPath,manifestBytes);}
    }
  });
  if(selected==="all"||selected==="corruption")await check("checksum and regional mismatch fail before database mutation",async()=>{
    const target=await createDatabase(),reportDir=path.join(root,"corruption-reports");
    const wrongRegion=await restore(backup.target,target,reportDir,{NOVA_RESTORE_REGION:"HK"});
    assert.equal(wrongRegion.ok,false);assert.match(wrongRegion.output,/Region mismatch/);assert.equal(await tableCount(target),0);
    const archive=path.join(backup.target,backup.manifest.reports.file),bytes=await fs.readFile(archive);
    await fs.appendFile(archive,Buffer.from("synthetic-corruption"));
    try{const result=await restore(backup.target,target,reportDir);assert.equal(result.ok,false);assert.match(result.output,/Checksum mismatch/);assert.equal(await tableCount(target),0);}finally{await fs.writeFile(archive,bytes);}
  });
  if(selected==="all"||selected==="encryption")await check("encrypted restore checks the backup key and report-key fingerprint and removes plaintext staging",async()=>{
    const backupKey="ab".repeat(32),target=await createDatabase(),reportDir=path.join(root,"encrypted-reports");
    process.env.NOVA_BACKUP_KEY=backupKey;
    let encrypted:Awaited<ReturnType<typeof createRegionalBackup>>;
    try{encrypted=await createRegionalBackup();}finally{process.env.NOVA_BACKUP_KEY="";}
    for(const extra of [{NOVA_BACKUP_KEY:"cd".repeat(32)},{NOVA_BACKUP_KEY:backupKey,NOVA_REPORT_KEY:"01".repeat(32)}]){
      const denied=await restore(encrypted.target,target,reportDir,extra);
      assert.equal(denied.ok,false);assert.equal(await tableCount(target),0);
      assert.equal((await fs.readdir(encrypted.target)).some(name=>name.startsWith(".restore-")),false);
    }
    const result=await restore(encrypted.target,target,reportDir,{NOVA_BACKUP_KEY:backupKey});
    assert.equal(result.ok,true,result.output);
    assert.deepEqual(await fs.readFile(path.join(reportDir,key)),await fs.readFile(path.join(syntheticEnv.NOVA_REPORT_DIR,key)));
    assert.equal((await fs.readdir(encrypted.target)).some(name=>name.startsWith(".restore-")),false);
    const maskedTarget=await createDatabase(),maskedDir=path.join(root,"encrypted-mask-400");
    const masked=await restore(encrypted.target,maskedTarget,maskedDir,{NOVA_BACKUP_KEY:backupKey},0o400);
    assert.equal(masked.ok,true,masked.output);
    assert.deepEqual(await fs.readFile(path.join(maskedDir,key)),await fs.readFile(path.join(syntheticEnv.NOVA_REPORT_DIR,key)));
    assert.equal((await fs.stat(path.join(maskedDir,key))).mode&0o777,0o600);
    assert.equal((await fs.readdir(encrypted.target)).some(name=>name.startsWith(".restore-")),false);
  });
  if(selected==="all"||selected==="interruption")await check("SIGTERM stops the actual database restore before cleanup and rolls back its transaction",async()=>{
    const lockKey=randomBytes(2).readUInt16BE(),backupKey="ab".repeat(32);
    await source!.query("CREATE FUNCTION synthetic_restore_wait(integer) RETURNS boolean LANGUAGE SQL AS 'SELECT true'");
    await source!.query("CREATE TABLE synthetic_restore_waiting(value integer CHECK (synthetic_restore_wait(value)))");
    await source!.query("INSERT INTO synthetic_restore_waiting VALUES(1)");
    await source!.query(`CREATE OR REPLACE FUNCTION synthetic_restore_wait(integer) RETURNS boolean LANGUAGE plpgsql AS 'BEGIN PERFORM pg_advisory_xact_lock(807099,${lockKey}); RETURN true; END'`);
    process.env.NOVA_BACKUP_KEY=backupKey;
    let encrypted:Awaited<ReturnType<typeof createRegionalBackup>>;
    try{encrypted=await createRegionalBackup();}finally{process.env.NOVA_BACKUP_KEY="";}
    const target=await createDatabase(),reportDir=path.join(root,"interrupted-reports"),barrier=new pg.Client({connectionString:target});
    await barrier.connect();
    const barrierPid=(await barrier.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await barrier.query("SELECT pg_advisory_lock(807099,$1)",[lockKey]);
    const child=spawn(process.execPath,["--import","tsx",restoreScript,encrypted.target],{env:{...syntheticEnv,NOVA_BACKUP_KEY:backupKey,NOVA_RESTORE_DATABASE_URL:target,NOVA_RESTORE_REPORT_DIR:reportDir,NOVA_RESTORE_REGION:"CN"},stdio:["ignore","pipe","pipe"]});
    let output="",restorePid:number|undefined;
    child.stdout.on("data",chunk=>{output+=String(chunk);});child.stderr.on("data",chunk=>{output+=String(chunk);});
    const exited=once(child,"exit");
    try{
      for(let attempt=0;attempt<500;attempt++){
        const rows=await barrier.query<{pid:number}>("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='pg_restore' AND $1::int=ANY(pg_blocking_pids(pid))",[barrierPid]);
        restorePid=rows.rows[0]?.pid;if(restorePid)break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.ok(restorePid,"The real pg_restore must be blocked in the synthetic COPY constraint before SIGTERM");
      const restoreClientPid=Number(String((await run("pgrep",["-P",String(child.pid),"-x","pg_restore"])).stdout).trim());
      assert.ok(Number.isSafeInteger(restoreClientPid)&&restoreClientPid>0);
      child.kill("SIGTERM");
      let timeout:ReturnType<typeof setTimeout>|undefined;
      const [code,signal]=await Promise.race([exited,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error("Restore CLI did not exit after SIGTERM")),12000);})]).finally(()=>{if(timeout)clearTimeout(timeout);});
      assert.throws(()=>process.kill(restoreClientPid,0),{code:"ESRCH"},"The owned pg_restore client must be gone when the CLI exits");
      assert.throws(()=>process.kill(-restoreClientPid,0),{code:"ESRCH"},"The owned pg_restore process group must be gone when the CLI exits");
      let active=1;
      const backendDrainStarted=Date.now();
      for(let attempt=0;attempt<200;attempt++){
        active=(await barrier.query<{n:number}>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1",[restorePid])).rows[0].n;
        if(!active)break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      const tables=await tableCount(target),staging=(await fs.readdir(encrypted.target)).filter(name=>name.startsWith(".restore-"));
      console.log(JSON.stringify({case:"interruption",code,signal,restoreClientAndGroupStopped:true,backendDrainMs:Date.now()-backendDrainStarted,activeRestoreBackends:active,publicTablesAfterSignal:tables,plaintextStageCount:staging.length}));
      assert.equal(code,143);assert.equal(signal,null);assert.doesNotMatch(output,/^Restore verified/m);
      assert.equal(active,0,"The database backend must drain without releasing the barrier or terminating it manually");
      assert.equal(tables,0);assert.deepEqual(staging,[]);
    }finally{
      if(restorePid)await barrier.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid=$1 AND datname=current_database() AND application_name='pg_restore'",[restorePid]);
      await barrier.query("SELECT pg_advisory_unlock(807099,$1)",[lockKey]);await barrier.end();
      if(child.exitCode===null&&child.signalCode===null){child.kill("SIGKILL");await exited;}
    }
  });
  if(selected==="all"||selected==="database-failure")await check("a database restore error rolls back earlier restored tables",async()=>{
    await source!.query("CREATE FUNCTION synthetic_restore_check(integer) RETURNS boolean LANGUAGE SQL AS 'SELECT true'");
    await source!.query("CREATE TABLE synthetic_restore_fault(value integer CHECK (synthetic_restore_check(value)))");
    await source!.query("INSERT INTO synthetic_restore_fault VALUES(1)");
    await source!.query("CREATE OR REPLACE FUNCTION synthetic_restore_check(integer) RETURNS boolean LANGUAGE SQL AS 'SELECT false'");
    const broken=await createRegionalBackup(),target=await createDatabase(),reportDir=path.join(root,"failed-reports");
    assert.equal(await sha256File(path.join(broken.target,broken.manifest.database.file)),broken.manifest.database.sha256);
    const result=await restore(broken.target,target,reportDir);
    assert.equal(result.ok,false);assert.match(result.output,/violates check constraint/);
    const tables=await tableCount(target);console.log(JSON.stringify({case:"database-failure",restoreSucceeded:result.ok,publicTablesAfterFailure:tables}));
    assert.equal(tables,0,"A failed pg_restore must not leave a partial database that blocks a retry");
    const retry=await restore(backup.target,target,reportDir);
    assert.equal(retry.ok,true,retry.output);
    assert.match(retry.output,/Restore verified/);
  });
}finally{
  await closeDatabase();await source?.end();
  for(const name of ownedDatabases.reverse())await control.query(`DROP DATABASE "${name}"`);
  await control.end();
  await fs.rm(root,{recursive:true,force:true});await fs.mkdir(root,{mode:0o700});
  await fs.writeFile(path.join(root,"results.json"),JSON.stringify({syntheticOnly:true,ownedDatabasesRemoved:true,ownedFixtureFilesRemoved:true,outcomes},null,2));
  console.log(`Synthetic fixture evidence: ${root}`);
}
