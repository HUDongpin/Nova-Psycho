// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { demoAdvice, demoScale, demoTemplate } from "../src/domain/demo";
import { reportHtml } from "../src/domain/report-html";
import { gardenIconForSection } from "../src/domain/garden-visuals";
import { scoreAssessment } from "../src/domain/scoring";
import { pair } from "./fixtures";
import type { Locale, ReportPayload, TriadReport } from "../src/domain/types";

function payload(triad?: TriadReport): ReportPayload {
  return {
    scale: demoScale,
    score: scoreAssessment(demoScale, { q1: 1, q2: 2, q3: 1, q4: 2, q5: 1, q6: 2, q7: 1, q8: 2, q9: 0 }, { age: 12, region: "CN", role: "student" }),
    advice: { id: "a", version: "1.0.0", content: demoAdvice },
    template: { id: "t", version: "1.0.0", content: demoTemplate },
    childName: "合成孩子", grade: "初中", submittedAt: "2026-10-21T00:00:00.000Z", aiConsented: false,
    selectedAdviceIds: [demoAdvice.blocks[0].id], generationMode: "template", fallbackReason: null, aiModel: null,
    comparison: { available: false, reason: "first_assessment" }, ...(triad ? { triad } : {}),
  };
}

function triad(): TriadReport {
  return {
    title: pair("孩子的成长了解"), sources: [{ role: "parent", submittedAt: "2026-10-21T00:00:00.000Z" }],
    safety: [pair("先查看这一条安全提示。")],
    domains: [{ key: "cognition", label: pair("学习和思考"), note: null, views: [
      { role: "student", label: pair("孩子自己 · 学习"), body: pair("原始平均分 2.5（1 到 5），请结合原有回答理解。"), raw: 2.5 },
      { role: "student", label: pair("孩子自己 · 思考"), body: pair("有效回答还不够，这里先不概括。"), raw: null },
      { role: "parent", label: pair("家长看到的 · 学习"), body: pair("家长的原有解释。"), raw: 3 },
      { role: "teacher", label: pair("老师看到的 · 学习"), body: pair("老师的原有解释。"), raw: 4 },
    ] }],
    portrait: [{ heading: pair("倾听"), body: pair("家长处理方式的原有描述。") }],
    situations: [{ role: "parent", prompt: pair("发生困难时"), choice: pair("一起讨论") }],
    priorities: [{ role: "teacher", prompt: pair("希望得到的帮助"), choices: [pair("沟通"), pair("日常安排")] }],
    words: [{ role: "parent", prompt: pair("想说的话"), value: '合成原话\n<img src="https://example.invalid/private" onerror="alert(1)">' }],
  };
}

const documentFor = (value: ReportPayload, locale: Locale) => new DOMParser().parseFromString(reportHtml(value, locale), "text/html");

describe("garden report navigation and offline presentation", () => {
  it("maps known questionnaire sections and keeps arbitrary imported names on the book fallback", () => {
    expect(gardenIconForSection("relationship")).toBe("connection");
    expect(gardenIconForSection("scenes")).toBe("words");
    for (const name of ["custom", "constructor", "toString", "__proto__"]) expect(gardenIconForSection(name)).toBe("book");
  });
  it.each(["zh-CN", "zh-HK"] as const)("links only to unique rendered headings in both report forms (%s)", locale => {
    for (const value of [payload(), payload(triad())]) {
      const doc = documentFor(value, locale);
      const links = [...doc.querySelectorAll<HTMLAnchorElement>(".report-directory a")];
      expect(links.length).toBeGreaterThan(3);
      const ids = [...doc.querySelectorAll("[id]")].map(element => element.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const link of links) {
        const target = doc.getElementById(link.getAttribute("href")!.slice(1));
        expect(target).not.toBeNull();
        expect(target!.textContent).toBe(link.textContent);
      }
      expect(doc.querySelector(".brand")?.outerHTML).toBe('<div class="brand">TopE 心理助手</div>');
    }
  });

  it("embeds decorative artwork without script or remote-resource dependencies", () => {
    const doc = documentFor(payload(triad()), "zh-CN");
    expect(doc.querySelector(".garden-report-art")).not.toBeNull();
    expect(doc.querySelectorAll("script,link,iframe,object,embed").length).toBe(0);
    for (const image of doc.querySelectorAll<HTMLImageElement>("img")) {
      expect(image.getAttribute("src")).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
      expect(image.alt).toBe("");
      expect(image.getAttribute("aria-hidden")).toBe("true");
      const svg = new DOMParser().parseFromString(decodeURIComponent(image.getAttribute("src")!.split(",")[1]), "image/svg+xml");
      expect(svg.querySelectorAll("script,image,use,foreignObject").length).toBe(0);
    }
    expect(doc.body.textContent).toContain('合成原话\n<img src="https://example.invalid/private" onerror="alert(1)">');
    expect(doc.querySelector("[onerror]")).toBeNull();
  });

  it.each(["zh-CN", "zh-HK"] as const)("keeps each observation with its role and exact frozen explanation (%s)", locale => {
    const report = triad();
    const value = payload(report);
    const before = JSON.stringify(value);
    const doc = documentFor(value, locale);
    for (const role of ["student", "parent", "teacher"] as const) {
      const blocks = doc.querySelectorAll(`.observation-view[data-role="${role}"]`);
      expect(blocks.length).toBe(1);
      expect([...blocks[0].querySelectorAll("p")].map(node => node.textContent)).toEqual(
        report.domains[0].views.filter(view => view.role === role).map(view => `${view.label[locale]} ${view.body[locale]}`),
      );
    }
    expect(JSON.stringify(value)).toBe(before);
    const safety = doc.querySelector(".risk")!;
    expect(safety.compareDocumentPosition(doc.querySelector(".report-directory")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(safety.compareDocumentPosition(doc.querySelector(".dimension")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("omits absent optional chapters from the directory and retains insufficient-data explanations", () => {
    const report = triad();
    report.domains = [];
    report.portrait = []; report.situations = []; report.priorities = []; report.words = []; report.safety = [];
    const doc = documentFor(payload(report), "zh-CN");
    const links = [...doc.querySelectorAll(".report-directory a")].map(link => link.getAttribute("href"));
    expect(links).toEqual(["#report-observations", "#report-comparison"]);
    expect(doc.body.textContent).toContain("这几个方面的有效回答还不够，这里先不概括。");
    expect(doc.querySelector(".risk")).toBeNull();
  });

  it("keeps the directory valid when legacy writing is withheld for privacy", () => {
    const report = triad();
    report.legacyWritingOmitted = true;
    for (const locale of ["zh-CN", "zh-HK"] as const) {
      const doc = documentFor(payload(report), locale);
      expect(doc.querySelector('.report-directory a[href="#report-words"]')).not.toBeNull();
      expect(doc.getElementById("report-words")).not.toBeNull();
      expect(doc.querySelector(".words")?.textContent).toContain(locale === "zh-CN" ? "文字回答已隐藏" : "文字回答已隱藏");
      expect(doc.querySelector(".words")?.textContent).not.toContain(report.words[0].value);
    }
  });
});
