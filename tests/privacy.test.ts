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
    expect(noticeVersion).toBe("nova-privacy-2026-09-v1");
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
