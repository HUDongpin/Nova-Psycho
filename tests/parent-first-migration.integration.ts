/** Rehearse the bounded migration on a throwaway copy of the pre-feature schema. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { getConfig } from "../src/lib/config";
import { assertThrowawayTarget } from "../scripts/test-database-guard";
import { migrateParentFirst } from "../scripts/migrations/20261023-parent-first";
import { triadScales, stagedTriadScaleIds } from "../src/domain/triad-scales";
import { parseStoredScale } from "../src/domain/validation";
const config=getConfig();assertThrowawayTarget({mode:config.mode,databaseUrl:config.databaseUrl,aiEnabled:config.ai.enabled});
const databaseName=`nova_parent_first_migration_${randomBytes(5).toString("hex")}`;
const owner=new pg.Client(config.databaseUrl);await owner.connect();
const url=new URL(config.databaseUrl);url.pathname=`/${databaseName}`;
const client=new pg.Client(url.href);let passed=false;
try{
  await owner.query(`CREATE DATABASE ${databaseName}`);await client.connect();
  const schema=await fs.readFile("src/lib/schema.sql","utf8");
  await client.query(schema.split("-- BEGIN PARENT-FIRST V1 MIGRATION")[0]+"COMMIT;");
  await client.query("INSERT INTO deployment_settings(singleton,region,mode) VALUES(true,$1,'demo')",[config.region]);
  const newIds=new Set<string>(Object.values(stagedTriadScaleIds));
  for(const definition of triadScales){
    const scale=parseStoredScale(definition),id=`${scale.id}@${scale.version}`;if(newIds.has(id))continue;
    await client.query("INSERT INTO scales(id,scale_id,version,definition) VALUES($1,$2,$3,$4)",[id,scale.id,scale.version,JSON.stringify(scale)]);
  }
  const parent=randomUUID(),family=randomUUID(),round=randomUUID(),assessment=randomUUID(),job=randomUUID();
  await client.query("INSERT INTO users(id,region,name,role,demo) VALUES($1,$2,'Synthetic migration parent','parent',true)",[parent,config.region]);
  await client.query("INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label) VALUES($1,$2,'Synthetic migration','Synthetic child','2014-01-01','S2','Synthetic')",[family,config.region]);
  await client.query("INSERT INTO triad_rounds(id,family_id,region) VALUES($1,$2,$3)",[round,family,config.region]);
  await client.query("INSERT INTO assessments(id,family_id,region,respondent_id,respondent_role,scale_version_id,locale,triad_round_id,status,answers,snapshot,submitted_at) VALUES($1,$2,$3,$4,'parent','growth-parent@2.0.0','zh-CN',$5,'published','{}','{}',now())",[assessment,family,config.region,parent,round]);
  await client.query("INSERT INTO report_jobs(id,assessment_id,state) VALUES($1,$2,'done')",[job,assessment]);
  await client.query("INSERT INTO reports(id,assessment_id,family_id,region,payload,pdf_keys,html_documents) VALUES($1,$1,$2,$3,'{}','{}',$4)",[assessment,family,config.region,JSON.stringify({"zh-CN":"synthetic frozen report","zh-HK":"synthetic frozen report"})]);
  const before=(await client.query("SELECT id,answers,snapshot,submitted_at FROM assessments")).rows;
  const reports=(await client.query("SELECT id,assessment_id,payload,pdf_keys,html_documents,created_at FROM reports")).rows;
  const dry=await migrateParentFirst(client,false,config.region);assert.equal(dry.missingIds.length,3);
  assert.equal((await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='triad_rounds' AND column_name='report_workflow'")).rowCount,0);
  const applied=await migrateParentFirst(client,true,config.region);assert.equal(applied.insertedIds.length,3);
  assert.deepEqual((await client.query("SELECT id,answers,snapshot,submitted_at FROM assessments")).rows,before);
  assert.deepEqual((await client.query("SELECT id,assessment_id,payload,pdf_keys,html_documents,created_at FROM reports")).rows,reports);
  assert.equal((await client.query("SELECT report_workflow FROM triad_rounds WHERE id=$1",[round])).rows[0].report_workflow,"legacy_triad");
  assert.deepEqual((await migrateParentFirst(client,true,config.region)).insertedIds,[]);
  await assert.rejects(client.query("UPDATE triad_rounds SET report_workflow='parent_first_v1' WHERE id=$1",[round]),/immutable/);
  await assert.rejects(client.query("UPDATE reports SET payload='{}' WHERE id=$1",[assessment]),/immutable/);
  assert.equal((await client.query("SELECT count(*)::int AS count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proname='nova_parent_first_immutable' AND n.nspname='pg_catalog'")).rows[0].count,0);
  await assert.rejects(migrateParentFirst(client,false,config.region==="CN"?"HK":"CN"),/Unexpected/);
  passed=true;console.log("PASS parent-first migration dry-run, apply, repeat, immutable legacy sources and region rejection");
}finally{
  await client.end();await owner.query(`DROP DATABASE IF EXISTS ${databaseName}`);await owner.end();
  await fs.writeFile("work/parent-first-20261023/migration-results.json",JSON.stringify({passed,syntheticOnly:true,throwawayDatabase:true,legacyReportsUnchanged:passed,repeatedMigrationSafe:passed},null,2),{mode:0o600});
}
