import {describe,it,expect} from "vitest";
import {demoScale,demoAdvice,demoTemplate} from "../src/domain/demo";
import {reportHtml} from "../src/domain/report-html";
import {scoreAssessment} from "../src/domain/scoring";
import {eligibleAdviceIds} from "../src/domain/narrative";
import {pair} from "./fixtures";
import type {Comparison,ReportPayload} from "../src/domain/types";
function payload():ReportPayload{
  const p:ReportPayload={scale:demoScale,score:scoreAssessment(demoScale,{q1:1,q2:2,q3:1,q4:2,q5:1,q6:2,q7:1,q8:2,q9:1},{age:12,region:"CN",role:"student"}),advice:{id:"a",version:"1.0.0",content:demoAdvice},template:{id:"t",version:"1.0.0",content:demoTemplate},childName:'<script>alert("XSS")</script>',grade:"六年级",submittedAt:"2026-09-10T00:00:00Z",aiConsented:false,selectedAdviceIds:[],generationMode:"template",fallbackReason:"risk_template",aiModel:null,comparison:{available:false,reason:"first_assessment"}};p.selectedAdviceIds=eligibleAdviceIds(p);return p;
}
function withComparison(comparison:Comparison):ReportPayload{return {...payload(),comparison};}
function frozenDate(iso:string,locale:"zh-CN"|"zh-HK"){return new Intl.DateTimeFormat(locale,{timeZone:"Asia/Hong_Kong",year:"numeric",month:"long",day:"numeric"}).format(new Date(iso));}
describe("parent-facing report contract",()=>{
  it("escapes user content and includes no raw response field",()=>{const html=reportHtml(payload(),"zh-CN");expect(html).not.toContain("<script>");expect(html).toContain("&lt;script&gt;");expect(html).not.toContain('"q1"');expect(html).not.toContain("draft_answers");});
  it("prioritizes safety signal over routine suggestions",()=>{const html=reportHtml(payload(),"zh-CN");expect(html.indexOf("请先关注安全")).toBeLessThan(html.indexOf("家长可以尝试的下一步"));});
  it("renders real traditional text and historical version stamps",()=>{const html=reportHtml(payload(),"zh-HK");expect(html.includes("家庭支持測評報告")).toBe(true);expect(html.includes("示範報告")).toBe(true);expect(html.includes("專業規則模板")).toBe(true);expect(html.includes("1.0.0")).toBe(true);});
  it("renders frozen previousDate in both locales",()=>{
    const previousDate="2026-08-01T00:00:00Z";
    const p=withComparison({available:true,previousDate,changes:[{key:"connection",label:pair("沟通"),delta:1,higherMeans:"more_support"}]});
    expect(reportHtml(p,"zh-CN")).toContain(frozenDate(previousDate,"zh-CN"));
    expect(reportHtml(p,"zh-HK")).toContain(frozenDate(previousDate,"zh-HK"));
  });
  it("explains more_support meaning and increased raw values in both locales",()=>{
    const p=withComparison({available:true,previousDate:"2026-08-01T00:00:00Z",changes:[{key:"connection",label:pair("沟通"),delta:2,higherMeans:"more_support"}]});
    const cn=reportHtml(p,"zh-CN"),hk=reportHtml(p,"zh-HK");
    expect(cn).toContain("分数越高表示需要更多支持");expect(hk).toContain("分數越高表示需要更多支持");
    expect(cn).toContain("原始分较上次升高");expect(hk).toContain("原始分較上次升高");
    expect(cn).toContain("+2");expect(cn).toContain("变化本身不证明辅导疗效");expect(hk).toContain("變化本身不證明輔導療效");
    expect(cn).not.toContain("诊断");expect(hk).not.toContain("診斷");
  });
  it("explains more_strength meaning and decreased raw values in both locales",()=>{
    const p=withComparison({available:true,previousDate:"2026-08-01T00:00:00Z",changes:[{key:"connection",label:pair("沟通"),delta:-3,higherMeans:"more_strength"}]});
    const cn=reportHtml(p,"zh-CN"),hk=reportHtml(p,"zh-HK");
    expect(cn).toContain("分数越高表示该方面的优势更明显");expect(hk).toContain("分數越高表示該方面的優勢更明顯");
    expect(cn).toContain("原始分较上次降低");expect(hk).toContain("原始分較上次降低");
    expect(cn).toContain("-3");
  });
  it("explains unchanged raw values",()=>{
    const p=withComparison({available:true,previousDate:"2026-08-01T00:00:00Z",changes:[{key:"connection",label:pair("沟通"),delta:0,higherMeans:"more_support"}]});
    const cn=reportHtml(p,"zh-CN"),hk=reportHtml(p,"zh-HK");
    expect(cn).toContain("原始分较上次没有变化");expect(hk).toContain("原始分較上次沒有變化");
    expect(cn).not.toContain("+0");
  });
  it("keeps unavailable different-observer text and frozen history",()=>{
    const p=withComparison({available:false,reason:"different_respondent"});
    const cn=reportHtml(p,"zh-CN"),hk=reportHtml(p,"zh-HK");
    expect(cn).toContain("目前没有适合直接比较的同版本、同填答者记录。不同填答者的观察分别保留，不计算合并总分。");
    expect(hk).toContain("目前沒有適合直接比較的同版本、同填答者紀錄。不同填答者的觀察分別保留，不計算合併總分。");
    expect(cn).not.toContain("较上次原始分变化");expect(hk).not.toContain("較上次原始分變化");
    expect(cn).not.toContain("对比的上次测评日期");
    expect(hk).toContain("家庭支持測評報告");expect(hk).toContain("1.0.0");
  });
});
