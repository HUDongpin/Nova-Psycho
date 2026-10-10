import {describe,it,expect,afterEach,vi} from "vitest";
import {getConfig} from "../src/lib/config";
function base(){vi.stubEnv("NOVA_REGION","CN");vi.stubEnv("NOVA_MODE","demo");vi.stubEnv("DATABASE_URL","postgresql://synthetic.invalid/nova_test");vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3100");vi.stubEnv("NOVA_REPORT_DIR","work/test-private");vi.stubEnv("NOVA_REPORT_KEY","0".repeat(64));vi.stubEnv("NOVA_AI_ENABLED","false");}
afterEach(()=>vi.unstubAllEnvs());
describe("deployment configuration",()=>{
  it("keeps data residency separate from the product region",()=>{base();vi.stubEnv("NOVA_DATA_REGION","SG");expect(getConfig()).toMatchObject({region:"CN",dataRegion:"SG"});});
  it("rejects an unknown data region",()=>{base();vi.stubEnv("NOVA_DATA_REGION","unknown");expect(()=>getConfig()).toThrow(/NOVA_DATA_REGION/);});
  it("preserves the local filesystem and continuous worker defaults",()=>{base();expect(getConfig()).toMatchObject({reportStorage:"filesystem",workerMode:"continuous",queueRegion:null});});
  it("does not resolve or require a filesystem directory for database storage",()=>{base();vi.stubEnv("NOVA_REPORT_STORAGE","database");vi.stubEnv("NOVA_REPORT_DIR",undefined);expect(getConfig()).toMatchObject({reportStorage:"database",reportDir:""});});
  it.each(["NOVA_REPORT_STORAGE","NOVA_WORKER_MODE"])("rejects unknown %s modes",name=>{base();vi.stubEnv(name,"unknown");expect(()=>getConfig()).toThrow();});
  it("rejects ephemeral queue filesystem storage",()=>{base();vi.stubEnv("NOVA_WORKER_MODE","queue");vi.stubEnv("NOVA_QUEUE_REGION","sin1");expect(()=>getConfig()).toThrow(/database report storage/);});
  it("requires an explicit queue region",()=>{base();vi.stubEnv("NOVA_REPORT_STORAGE","database");vi.stubEnv("NOVA_WORKER_MODE","queue");expect(()=>getConfig()).toThrow(/queue region/);});
  it("accepts explicitly configured durable queue mode",()=>{base();vi.stubEnv("NOVA_REPORT_STORAGE","database");vi.stubEnv("NOVA_WORKER_MODE","queue");vi.stubEnv("NOVA_QUEUE_REGION","sin1");expect(getConfig()).toMatchObject({reportStorage:"database",workerMode:"queue",queueRegion:"sin1"});});
  it("refuses an unconfigured continuous worker on Vercel",()=>{base();vi.stubEnv("VERCEL","1");expect(()=>getConfig()).toThrow(/Vercel requires/);});
  it("keeps template reports working if AI was enabled without credentials",()=>{base();vi.stubEnv("NOVA_AI_ENABLED","true");vi.stubEnv("NOVA_AI_BASE_URL","");vi.stubEnv("NOVA_AI_API_KEY","");vi.stubEnv("NOVA_AI_MODEL","");expect(getConfig().ai.enabled).toBe(false);});
  it("does not permit public demo mode",()=>{base();vi.stubEnv("NOVA_PUBLIC_URL","https://demo.example.invalid");expect(()=>getConfig()).toThrow();});
  it("does not permit public report storage",()=>{base();vi.stubEnv("NOVA_REPORT_DIR","public/reports");expect(()=>getConfig()).toThrow();});
  it("rejects global or mismatched regional model routes",()=>{base();vi.stubEnv("NOVA_AI_ENABLED","true");vi.stubEnv("NOVA_AI_BASE_URL","https://llm-example.cn-hongkong.maas.aliyuncs.com/compatible-mode/v1");vi.stubEnv("NOVA_AI_API_KEY","synthetic-key");vi.stubEnv("NOVA_AI_MODEL","test-model");vi.stubEnv("NOVA_AI_DEPLOYMENT_SCOPE","CN");expect(()=>getConfig()).toThrow();});
});
// A Beijing (cn-beijing) business-space endpoint is the supported mainland route.
// These pin both the accepted form and the near-misses that must not slip through.
describe("Beijing workspace endpoint allowlist",()=>{
  const BEIJING="https://llm-abc123def.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
  const ai=(url:string,scope="CN")=>{vi.stubEnv("NOVA_AI_ENABLED","true");vi.stubEnv("NOVA_AI_BASE_URL",url);vi.stubEnv("NOVA_AI_API_KEY","synthetic-key");vi.stubEnv("NOVA_AI_MODEL","qwen-flash");vi.stubEnv("NOVA_AI_DEPLOYMENT_SCOPE",scope);};

  it("accepts a business-space endpoint in the deployment region",()=>{base();ai(BEIJING);const config=getConfig();expect(config.ai.enabled).toBe(true);expect(config.ai.scope).toBe("CN");});
  it("accepts a workspace id containing hyphens and digits",()=>{base();ai("https://llm-ws-01a.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");expect(getConfig().ai.enabled).toBe(true);});
  it("rejects the shared DashScope domain, which is not workspace-scoped",()=>{base();ai("https://dashscope.aliyuncs.com/compatible-mode/v1");expect(()=>getConfig()).toThrow();});
  it("rejects the trial domain",()=>{base();ai("https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");expect(()=>getConfig()).toThrow();});
  it("rejects a Beijing endpoint when the region is Hong Kong",()=>{base();vi.stubEnv("NOVA_REGION","HK");vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3101");ai(BEIJING,"HK");expect(()=>getConfig()).toThrow();});
  it("rejects a Beijing endpoint while the scope says Hong Kong",()=>{base();ai(BEIJING,"HK");expect(()=>getConfig()).toThrow();});
  it("rejects plain http",()=>{base();ai("http://llm-abc123def.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");expect(()=>getConfig()).toThrow();});
  it("rejects a different path",()=>{base();ai("https://llm-abc123def.cn-beijing.maas.aliyuncs.com/v1");expect(()=>getConfig()).toThrow();});
  it("rejects a trailing query or fragment",()=>{base();ai(`${BEIJING}?x=1`);expect(()=>getConfig()).toThrow();});
  it("rejects an embedded username or password",()=>{base();ai("https://user:pw@llm-abc123def.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");expect(()=>getConfig()).toThrow();});
  it("rejects another region's workspace host",()=>{base();ai("https://llm-abc123def.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1");expect(()=>getConfig()).toThrow();});
  it("stays disabled rather than throwing when the key is missing",()=>{base();ai(BEIJING);vi.stubEnv("NOVA_AI_API_KEY","");expect(getConfig().ai.enabled).toBe(false);});
});
describe("DeepSeek flash endpoint",()=>{
  const flash=()=>{base();vi.stubEnv("NOVA_AI_ENABLED","true");vi.stubEnv("NOVA_AI_BASE_URL","https://api.deepseek.com");vi.stubEnv("NOVA_AI_API_KEY","synthetic-key");vi.stubEnv("NOVA_AI_MODEL","deepseek-flash");vi.stubEnv("NOVA_AI_DEPLOYMENT_SCOPE","CN");};
  it("accepts the official flash endpoint",()=>{flash();const config=getConfig();expect(config.ai.enabled).toBe(true);expect(config.ai.model).toBe("deepseek-flash");});
  it("rejects a DeepSeek path other than the API origin",()=>{flash();vi.stubEnv("NOVA_AI_BASE_URL","https://api.deepseek.com/anthropic");expect(()=>getConfig()).toThrow();});
  it("rejects a non-flash DeepSeek model",()=>{flash();vi.stubEnv("NOVA_AI_MODEL","deepseek-v4-pro");expect(()=>getConfig()).toThrow();});
});
