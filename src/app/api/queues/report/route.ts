import { reportQueueClient } from "@/lib/report-dispatch";
import { consumeReportMessage,reportQueueRetry } from "@/lib/report-queue";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=240;

export async function POST(request:Request):Promise<Response>{
  // queue/v2beta removes this route's public URL on Vercel.
  if(process.env.VERCEL!=="1")return new Response(null,{status:404});
  return reportQueueClient().handleCallback(consumeReportMessage,{visibilityTimeoutSeconds:300,retry:reportQueueRetry})(request);
}
