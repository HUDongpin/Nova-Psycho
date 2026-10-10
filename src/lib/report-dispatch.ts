import { QueueClient } from "@vercel/queue";
import { getConfig } from "./config";
import { query } from "./db";
import { validateId } from "./http";

export const REPORT_TOPIC="nova-report";
export type DeferredReportWork=(work:()=>Promise<void>)=>void;

export function reportQueueClient():QueueClient{
  const config=getConfig();
  if(config.workerMode!=="queue"||!config.queueRegion)throw new Error("Report queue is not configured");
  return new QueueClient({region:config.queueRegion,telemetry:{isEnabled:false}});
}

export async function enqueueReportJob(jobId:string):Promise<void>{
  validateId(jobId);
  const config=getConfig();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    await Promise.race([
      reportQueueClient().send(REPORT_TOPIC,{jobId,region:config.region},{retentionSeconds:604800}),
      new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error("Report dispatch timed out")),8000);})
    ]);
  }finally{if(timer)clearTimeout(timer);}
}

export async function dispatchAssessmentReport(assessmentId:string,defer?:DeferredReportWork):Promise<void>{
  if(getConfig().workerMode!=="queue")return;
  validateId(assessmentId);
  const attempt=async()=>{
    const jobs=await query<{id:string}>(`SELECT j.id FROM report_jobs j JOIN assessments a ON a.id=j.assessment_id
      WHERE a.region=$2 AND (j.assessment_id=$1 OR $1=ANY(j.source_assessment_ids))
        AND j.state IN ('ready','running') LIMIT 1`,[assessmentId,getConfig().region]);
    if(jobs[0])await enqueueReportJob(jobs[0].id);
  };
  try{await attempt();}
  catch{
    // The assessment is already committed. Its SQL job is the recovery source.
    console.error("nova_report_dispatch_pending",{region:getConfig().region});
    if(defer)defer(async()=>{
      try{await attempt();}
      catch{console.error("nova_report_dispatch_retry_pending",{region:getConfig().region});}
    });
  }
}
