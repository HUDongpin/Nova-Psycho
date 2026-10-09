import { describe,it,expect } from "vitest";
import { noticeVersion,privacyNotice } from "../src/lib/privacy";
import type { Locale,Region } from "../src/domain/types";

const combinations:[Region,Locale][]=[
  ["CN","zh-CN"],
  ["CN","zh-HK"],
  ["HK","zh-CN"],
  ["HK","zh-HK"]
];

const flatten=(region:Region,locale:Locale)=>{
  const notice=privacyNotice(region,locale);
  return [notice.title,...notice.sections.flatMap(section=>[section.title,section.body])].join("\n");
};

describe("privacy notice",()=>{
  it("pins the notice version",()=>{
    expect(noticeVersion).toBe("nova-privacy-2026-10-v3");
  });

  it.each(combinations)("returns a complete bilingual notice for %s + %s",(region,locale)=>{
    const notice=privacyNotice(region,locale);
    expect(notice.version).toBe(noticeVersion);
    expect(notice.title).toMatch(/测评与资料使用说明|測評與資料使用說明/);
    expect(notice.sections.length).toBeGreaterThanOrEqual(5);
    for(const section of notice.sections){
      expect(section.title.trim().length).toBeGreaterThan(0);
      expect(section.body.trim().length).toBeGreaterThan(0);
    }
    const text=flatten(region,locale);
    expect(text).not.toMatch(/TODO|FIXME|\bundefined\b|\bnull\b/);
  });

  it("uses region-specific residency wording",()=>{
    const cn=privacyNotice("CN","zh-CN").sections.find(section=>section.title.includes("资料所在"))!.body;
    const hk=privacyNotice("HK","zh-CN").sections.find(section=>section.title.includes("资料所在"))!.body;
    expect(cn).toContain("内地");
    expect(hk).toContain("香港");
    expect(cn).not.toBe(hk);
    const cnHk=privacyNotice("CN","zh-HK").sections.find(section=>section.title.includes("資料所在"))!.body;
    const hkHk=privacyNotice("HK","zh-HK").sections.find(section=>section.title.includes("資料所在"))!.body;
    expect(cnHk).toMatch(/內地|内地/);
    expect(hkHk).toContain("香港");
    expect(cnHk).not.toBe(hkHk);
  });

  it.each(["zh-CN","zh-HK"] as const)("uses actual Singapore storage location for the Hong Kong service in %s",locale=>{
    const notice=privacyNotice("HK",locale,"SG");
    const location=notice.sections.find(section=>/资料所在|資料所在/.test(section.title))!.body;
    expect(location).toContain("新加坡");
    expect(location).toContain("Vercel");
    expect(location).not.toMatch(/存放[于於]香港/);
    expect(notice.version).toBe(noticeVersion);
  });

  it.each(["zh-CN","zh-HK"] as const)("discloses Clerk US identity hosting while retaining actual family storage in %s",locale=>{
    const notice=privacyNotice("HK",locale,"SG","clerk");
    const identity=notice.sections.find(section=>section.body.includes("Clerk"));
    expect(identity).toBeDefined();
    expect(identity!.body).toMatch(/美国托管|美國託管/);
    expect(identity!.body).toMatch(/登录邮箱、认证凭证和会话信息|登入電郵、認證憑證及登入工作階段資料/);
    const location=notice.sections.find(section=>/资料所在|資料所在/.test(section.title))!.body;
    expect(location).toContain("新加坡");
    expect(location).not.toMatch(/美国|美國/);
  });
  it.each(["zh-CN","zh-HK"] as const)("does not claim Clerk handles identities in local mode (%s)",locale=>{
    const implicit=privacyNotice("HK",locale,"SG");
    const explicit=privacyNotice("HK",locale,"SG","local");
    expect(implicit).toEqual(explicit);
    expect(JSON.stringify(implicit)).not.toContain("Clerk");
    expect(privacyNotice("HK",locale,"SG","clerk").sections.length).toBe(implicit.sections.length+1);
  });

  it("states that the model does not receive names, contact, or raw answers",()=>{
    for(const [region,locale] of combinations){
      const ai=privacyNotice(region,locale).sections.find(section=>/AI/.test(section.title))!.body;
      expect(ai).toMatch(/不接收姓名/);
      expect(ai).toMatch(/联络资料|聯絡資料|联系资料/);
      expect(ai).toMatch(/逐题答案|逐題答案/);
    }
  });

  it("states that the service does not provide a medical diagnosis",()=>{
    expect(flatten("CN","zh-CN")).toContain("医学确诊");
    expect(flatten("HK","zh-HK")).toContain("醫學確診");
    for(const [region,locale] of combinations){
      expect(flatten(region,locale)).toMatch(/医学确诊|醫學確診/);
    }
  });

  it("does not invent English when switching locale",()=>{
    const withoutBrand=(text:string)=>text.replaceAll("Nova","").replaceAll("AI","");
    for(const region of ["CN","HK"] as const){
      expect(withoutBrand(flatten(region,"zh-CN"))).not.toMatch(/[A-Za-z]{3,}/);
      expect(withoutBrand(flatten(region,"zh-HK"))).not.toMatch(/[A-Za-z]{3,}/);
    }
  });
});
