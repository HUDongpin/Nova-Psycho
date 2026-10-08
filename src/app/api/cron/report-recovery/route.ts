import { authorizedReportRecovery,recoverReportDispatches } from "@/lib/report-dispatch-recovery";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;

export async function GET(request:Request):Promise<Response>{
  if(!authorizedReportRecovery(request))return new Response(null,{status:401,headers:{"Cache-Control":"no-store"}});
  const result=await recoverReportDispatches();
  return Response.json(result,{headers:{"Cache-Control":"no-store"}});
}
