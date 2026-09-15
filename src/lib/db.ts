import pg, { type PoolClient, type QueryResultRow } from "pg";
import { getConfig } from "./config";
pg.types.setTypeParser(1082,value=>value);
const globalDb=globalThis as unknown as {novaPool?:pg.Pool; novaDatabaseUrl?:string; novaRegionCheck?:Promise<void>;novaIdentity?:string};
export function pool():pg.Pool{
  const config=getConfig();
  if(globalDb.novaDatabaseUrl&&globalDb.novaDatabaseUrl!==config.databaseUrl)throw new Error("A process cannot switch database regions");
  if(!globalDb.novaPool){globalDb.novaDatabaseUrl=config.databaseUrl;globalDb.novaPool=new pg.Pool({connectionString:config.databaseUrl,max:10,connectionTimeoutMillis:5000,idleTimeoutMillis:20000,statement_timeout:15000,application_name:`nova-${config.region.toLowerCase()}`});}
  return globalDb.novaPool;
}
export async function assertDatabaseRegion():Promise<void>{
  const identity=`${getConfig().region}:${getConfig().mode}`;
  if(globalDb.novaIdentity&&globalDb.novaIdentity!==identity)throw new Error("A process cannot change its region or service mode");
  if(!globalDb.novaRegionCheck)globalDb.novaRegionCheck=(async()=>{
    const r=await pool().query("SELECT region,mode FROM deployment_settings WHERE singleton=true");
    if(r.rows[0]?.region!==getConfig().region)throw new Error("Database region does not match process region");
    if(r.rows[0]?.mode!==getConfig().mode)throw new Error("Database data classification does not match process mode");
    globalDb.novaIdentity=identity;
  })().catch(e=>{globalDb.novaRegionCheck=undefined;throw e;});
  await globalDb.novaRegionCheck;
}
export async function query<T extends QueryResultRow=QueryResultRow>(sql:string,values:unknown[]=[]):Promise<T[]>{
  await assertDatabaseRegion();const r=await pool().query<T>(sql,values);return r.rows;
}
export async function transaction<T>(fn:(client:PoolClient)=>Promise<T>):Promise<T>{
  await assertDatabaseRegion();const client=await pool().connect();
  try{await client.query("BEGIN");const r=await fn(client);await client.query("COMMIT");return r;}catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
}
export async function closeDatabase(){await globalDb.novaPool?.end();globalDb.novaPool=undefined;globalDb.novaDatabaseUrl=undefined;globalDb.novaRegionCheck=undefined;globalDb.novaIdentity=undefined;}
