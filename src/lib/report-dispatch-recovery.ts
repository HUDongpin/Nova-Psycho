import { timingSafeEqual } from "node:crypto";
import { getConfig } from "./config";
import { query } from "./db";
import { enqueueReportJob } from "./report-dispatch";

export function authorizedReportRecovery(request:Request):boolean{
  const secret=process.env.CRON_SECRET;
  if(!secret||secret.length<32)return false;
  const actual=Buffer.from(request.headers.get("authorization")??""),expected=Buffer.from(`Bearer ${secret}`);
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}

export async function recoverReportDispatches():Promise<{selected:number;dispatched:number;pending:number}>{
  const config=getConfig();
  if(config.workerMode!=="queue")throw new Error("Report queue is disabled");
  const rows=await query<{id:string}>(`SELECT j.id FROM report_jobs j JOIN assessments a ON a.id=j.assessment_id
    WHERE a.region=$1 AND ((j.state='ready' AND j.available_at<=now()) OR (j.state='running' AND j.lease_until<now()))
    ORDER BY j.available_at,j.created_at LIMIT 25`,[config.region]);
  let dispatched=0;
  const deadline=Date.now()+40000;
  for(const row of rows){
    if(Date.now()>=deadline)break;
    try{await enqueueReportJob(row.id);dispatched++;}
    catch{console.error("nova_report_recovery_pending",{region:config.region});}
  }
  return {selected:rows.length,dispatched,pending:rows.length-dispatched};
}
