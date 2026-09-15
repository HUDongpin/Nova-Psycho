import path from "node:path";
import type { Region } from "../domain/types";
export interface Config {
  region:Region;mode:"demo"|"service";databaseUrl:string;publicUrl:string;reportDir:string;reportKey:Buffer;siblingUrl:string|null;
  ai:{enabled:boolean;url:string;key:string;model:string;scope:string};
}
export function getConfig():Config{
  const region=process.env.NOVA_REGION;
  if(region!=="CN"&&region!=="HK")throw new Error("NOVA_REGION must be CN or HK");
  const mode=process.env.NOVA_MODE==="demo"?"demo":"service";
  const databaseUrl=process.env.DATABASE_URL;
  const publicUrl=process.env.NOVA_PUBLIC_URL;
  const key=process.env.NOVA_REPORT_KEY??"";
  const reportDir=process.env.NOVA_REPORT_DIR;
  if(!databaseUrl||!publicUrl||!reportDir||!/^[a-f0-9]{64}$/i.test(key))throw new Error("Database, public URL and private report storage must be configured");
  const url=new URL(publicUrl);
  if(url.pathname!=="/"||url.search||url.hash||url.username||url.password)throw new Error("NOVA_PUBLIC_URL must be an origin");
  if(mode==="demo" && !["localhost","127.0.0.1","[::1]"].includes(url.hostname))throw new Error("Demo mode may only run on loopback origins");
  if(mode==="service"&&url.protocol!=="https:")throw new Error("Service mode requires HTTPS");
  const resolved=path.resolve(reportDir);
  if(resolved===path.resolve("public")||resolved.startsWith(path.resolve("public")+path.sep))throw new Error("Reports cannot be stored in public assets");
  const ai={enabled:process.env.NOVA_AI_ENABLED==="true",url:process.env.NOVA_AI_BASE_URL??"",key:process.env.NOVA_AI_API_KEY??"",model:process.env.NOVA_AI_MODEL??"",scope:process.env.NOVA_AI_DEPLOYMENT_SCOPE??""};
  if(ai.enabled){
    if(!ai.url||!ai.key||!ai.model)ai.enabled=false;
    else{
      if(ai.scope!==region)throw new Error("AI requires explicit same-region scope");
      const u=new URL(ai.url);
      const cn=/^llm-[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$/;
      const hk=/^llm-[a-z0-9-]+\.cn-hongkong\.maas\.aliyuncs\.com$/;
      if(u.protocol!=="https:"||!(region==="CN"?cn:hk).test(u.hostname)||u.pathname!=="/compatible-mode/v1"||u.search||u.hash||u.username||u.password)throw new Error("Only an approved regional workspace inference endpoint is allowed");
    }
  }
  const sibling=process.env.NOVA_DEMO_SIBLING_URL;
  const siblingUrl=mode==="demo"&&sibling&&["localhost","127.0.0.1"].includes(new URL(sibling).hostname)?sibling:null;
  return {region,mode,databaseUrl,publicUrl:url.origin,reportDir:resolved,reportKey:Buffer.from(key,"hex"),siblingUrl,ai};
}
