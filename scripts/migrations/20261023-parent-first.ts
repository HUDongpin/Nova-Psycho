import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import { stagedParentScale, stagedChildScale, topeStaffScale, currentTriadScaleIds, legacyTriadScaleIds } from "../../src/domain/triad-scales";
import { parseStoredScale } from "../../src/domain/validation";

export interface ParentFirstMigrationClient { query(sql:string,values?:unknown[]):Promise<{rows:Record<string,unknown>[]}> }
const definitions=[stagedParentScale,stagedChildScale,topeStaffScale].map(parseStoredScale);

/** Additive workflow migration: no report/answer backfill and no existing scale retirement. */
export async function migrateParentFirst(client:ParentFirstMigrationClient,apply=false,expectedRegion:"CN"|"HK") {
  const source=await fs.readFile(new URL("../../src/lib/schema.sql",import.meta.url),"utf8");
  const block=source.split("-- BEGIN PARENT-FIRST V1 MIGRATION\n")[1]?.split("-- END PARENT-FIRST V1 MIGRATION")[0];
  if(!block)throw new Error("Missing bounded migration");
  await client.query(apply?"BEGIN":"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try{
    await client.query("SET LOCAL search_path = pg_catalog, public");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const marker=await client.query("SELECT region,mode FROM public.deployment_settings WHERE singleton=true");
    if(marker.rows.length!==1||marker.rows[0].region!==expectedRegion||!["demo","service"].includes(String(marker.rows[0].mode)))throw new Error("Unexpected database region or classification");
    if(apply){
      const lock=await client.query("SELECT pg_try_advisory_xact_lock(742681,1) AS acquired");
      if(lock.rows[0]?.acquired!==true)throw new Error("Another content operation is active");
      await client.query("LOCK TABLE public.scales IN SHARE ROW EXCLUSIVE MODE");
    }
    const existing=await client.query("SELECT id,scale_id,version,definition,status FROM public.scales ORDER BY id");
    for(const id of [...Object.values(currentTriadScaleIds),...Object.values(legacyTriadScaleIds)]){
      if(existing.rows.find(row=>row.id===id)?.status!=="active")throw new Error(`Required legacy scale ${id} is not active`);
    }
    const missing=definitions.filter(scale=>{
      const id=`${scale.id}@${scale.version}`,row=existing.rows.find(row=>row.id===id);
      if(row&&(row.scale_id!==scale.id||row.version!==scale.version||row.status!=="active"||!isDeepStrictEqual(row.definition,JSON.parse(JSON.stringify(scale)))))throw new Error(`Conflicting target scale ${id}`);
      return !row;
    });
    if(apply){
      await client.query(block);
      for(const scale of missing)await client.query("INSERT INTO public.scales(id,scale_id,version,definition,status) VALUES($1,$2,$3,$4,'active')",[`${scale.id}@${scale.version}`,scale.id,scale.version,JSON.stringify(scale)]);
      const after=await client.query("SELECT id,scale_id,version,definition,status FROM public.scales ORDER BY id");
      const ids=new Set(existing.rows.map(row=>row.id));
      if(!isDeepStrictEqual(after.rows.filter(row=>ids.has(row.id)),existing.rows))throw new Error("Existing questionnaire versions changed");
    }
    await client.query("COMMIT");
    return {region:expectedRegion,mode:apply?"apply":"dry-run",insertedIds:apply?missing.map(scale=>`${scale.id}@${scale.version}`):[],missingIds:missing.map(scale=>`${scale.id}@${scale.version}`),existingVersionsPreserved:true,existingRoundsUnchanged:true};
  }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const args=process.argv.slice(2),region=process.env.NOVA_REGION;
  if(args.length>1||(args.length===1&&args[0]!=="--apply"))throw new Error("Usage: 20261023-parent-first.ts [--apply]");
  if(!process.env.DATABASE_URL||(region!=="CN"&&region!=="HK"))throw new Error("Explicit DATABASE_URL and NOVA_REGION are required");
  const client=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000});client.on("error",()=>{});
  try{await client.connect();console.log(JSON.stringify(await migrateParentFirst(client,args[0]==="--apply",region)));}
  catch{console.error("Parent-first migration failed. No success is claimed; check the target, migration prerequisites and existing questionnaire versions.");process.exitCode=1;}
  finally{await client.end().catch(()=>{});}
}
