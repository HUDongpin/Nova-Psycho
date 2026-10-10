import type { MessageMetadata,RetryDirective } from "@vercel/queue";
import { z } from "zod";
import { getConfig } from "./config";
import { closePdfBrowser } from "./pdf";
import { processReportJob } from "./worker";

const reportMessage=z.object({jobId:z.string().uuid(),region:z.enum(["CN","HK"])}).strict();
export class ReportRetryAt extends Error{
  constructor(readonly retryAt:string){super("Report job is not ready to acknowledge");}
}

export async function consumeReportMessage(message:unknown):Promise<void>{
  const parsed=reportMessage.safeParse(message),config=getConfig();
  if(config.workerMode!=="queue")throw new Error("Report queue is disabled");
  if(!parsed.success||parsed.data.region!==config.region)return;
  try{
    const result=await processReportJob(parsed.data.jobId);
    if(result.status==="retry_at")throw new ReportRetryAt(result.retryAt);
  }catch(error){
    if(error instanceof ReportRetryAt)throw error;
    throw new Error("Report processing temporarily unavailable");
  }finally{
    await closePdfBrowser().catch(()=>{console.error("nova_report_browser_cleanup_failed",{region:config.region});});
  }
}

export function reportQueueRetry(error:unknown,metadata:MessageMetadata):RetryDirective{
  if(error instanceof ReportRetryAt)return {afterSeconds:Math.min(3600,Math.max(1,Math.ceil((Date.parse(error.retryAt)-Date.now())/1000)))};
  if(metadata.deliveryCount>=8){
    console.error("nova_report_delivery_deferred",{region:getConfig().region});
    return {acknowledge:true};
  }
  return {afterSeconds:Math.min(300,30*2**Math.max(0,metadata.deliveryCount-1))};
}
