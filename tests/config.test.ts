import {describe,it,expect,afterEach,vi} from "vitest";
import {getConfig} from "../src/lib/config";
function base(){vi.stubEnv("NOVA_REGION","CN");vi.stubEnv("NOVA_MODE","demo");vi.stubEnv("DATABASE_URL","postgresql://synthetic.invalid/nova_test");vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3100");vi.stubEnv("NOVA_REPORT_DIR","work/test-private");vi.stubEnv("NOVA_REPORT_KEY","0".repeat(64));vi.stubEnv("NOVA_AI_ENABLED","false");}
afterEach(()=>vi.unstubAllEnvs());
describe("deployment configuration",()=>{
  it("keeps template reports working if AI was enabled without credentials",()=>{base();vi.stubEnv("NOVA_AI_ENABLED","true");vi.stubEnv("NOVA_AI_BASE_URL","");vi.stubEnv("NOVA_AI_API_KEY","");vi.stubEnv("NOVA_AI_MODEL","");expect(getConfig().ai.enabled).toBe(false);});
  it("does not permit public demo mode",()=>{base();vi.stubEnv("NOVA_PUBLIC_URL","https://demo.example.invalid");expect(()=>getConfig()).toThrow();});
  it("does not permit public report storage",()=>{base();vi.stubEnv("NOVA_REPORT_DIR","public/reports");expect(()=>getConfig()).toThrow();});
  it("rejects global or mismatched regional model routes",()=>{base();vi.stubEnv("NOVA_AI_ENABLED","true");vi.stubEnv("NOVA_AI_BASE_URL","https://llm-example.cn-hongkong.maas.aliyuncs.com/compatible-mode/v1");vi.stubEnv("NOVA_AI_API_KEY","synthetic-key");vi.stubEnv("NOVA_AI_MODEL","test-model");vi.stubEnv("NOVA_AI_DEPLOYMENT_SCOPE","CN");expect(()=>getConfig()).toThrow();});
});
