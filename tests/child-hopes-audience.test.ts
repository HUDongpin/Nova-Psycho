import { describe, expect, it } from "vitest";
import { demoTemplate } from "../src/domain/demo";
import { modelInput, selectNarrative, eligibleAdviceIds } from "../src/domain/narrative";
import { reportHtml } from "../src/domain/report-html";
import { scoreAssessment } from "../src/domain/scoring";
import { composeTriad, previewAnswers, staffOnlyText, type TriadSource } from "../src/domain/triad-report";
import { childScale, parentScale, teacherScale } from "../src/domain/triad-scales";
import type { AssessmentSnapshot, Locale, ReportPayload, ScaleBand, StoredAnswer } from "../src/domain/types";
import { childScale as child13 } from "./fixtures/triad-scales-1.3.0";

const HOPES = ["c19", "c20", "c21", "c22"] as const;
const SECRET = "CHILD_HOPE_SECRET_NOT_FOR_PARENT_OR_MODEL";
const SCENE = "CHILD_SCENE_WORDS_SENTINEL";
const ADULT = "ADULT_WORDS_SENTINEL";
const CHILD_NAME = "PRIVATE_CHILD_NAME_9f3a";
const GRADE = "PRIVATE_GRADE_9f3a";
const submittedAt = "2026-10-14T03:00:00.000Z";

function answersFor(scale: typeof childScale): Record<string, StoredAnswer> {
  const preview = structuredClone(scale);
  for (const item of preview.items) if (item.id === "c_age" || item.id === "p_age") item.choices = item.choices.filter(choice => choice.value === 12);
  return previewAnswers(preview, "calm");
}

function source(scale: typeof childScale, answers: Record<string, StoredAnswer>): TriadSource {
  const role = scale.roles[0];
  return { role, scale, answers, score: scoreAssessment(scale, answers, { age: 12, region: "CN", role }), submittedAt };
}

describe("growth-child@1.4.0 hopes writing", () => {
  it("keeps the questions and gives them a staff reader without a parent or model reader", async () => {
    expect(childScale.version).toBe("1.4.0");
    expect(parentScale.version).toBe("1.2.0");
    expect(teacherScale.version).toBe("1.2.0");
    expect(child13.version).toBe("1.3.0");
    for (const id of HOPES) {
      const current = childScale.items.find(item => item.id === id);
      const previous = child13.items.find(item => item.id === id);
      expect(current?.kind).toBe("text");
      expect(current?.pageTitle?.["zh-CN"]).toBe("我希望大人知道");
      expect(current?.report).toBe("staff");
      expect(previous?.label).toEqual(current?.label);
      expect(previous?.required).toBe(current?.required);
      expect(previous?.report).toBe("words");
    }

    const childAnswers = answersFor(childScale);
    const previousAnswers = answersFor(child13);
    for (const id of HOPES) {
      childAnswers[id] = `${SECRET}_${id}`;
      previousAnswers[id] = `${SECRET}_${id}`;
    }
    childAnswers.c17 = SCENE;
    previousAnswers.c17 = SCENE;
    const parentAnswers = answersFor(parentScale);
    parentAnswers.p_worry = ADULT;
    const teacherAnswers = answersFor(teacherScale);

    const notes = staffOnlyText(childScale, childAnswers);
    expect(notes.map(note => note.value)).toEqual(HOPES.map(id => `${SECRET}_${id}`));
    expect(notes.map(note => note.label["zh-CN"])).toEqual(HOPES.map(id => childScale.items.find(item => item.id === id)!.label["zh-CN"]));
    expect(notes.some(note => note.value === SCENE)).toBe(false);
    expect(staffOnlyText(child13, previousAnswers)).toEqual([]);

    const sources = [source(childScale, childAnswers), source(parentScale, parentAnswers), source(teacherScale, teacherAnswers)];
    expect(sources.every(item => item.score.status === "valid" && item.score.risk === false)).toBe(true);
    const report = composeTriad(sources);
    const serialized = JSON.stringify(report);
    expect(serialized).toContain(ADULT);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(SCENE);
    expect(report.words.every(item => item.role !== "student")).toBe(true);
    const payload: ReportPayload = {
      scale: parentScale,
      score: sources[1].score,
      advice: { id: "synthetic-advice", version: "1.0.0", content: { title: { "zh-CN": "合成建议", "zh-HK": "合成建議" }, blocks: [] } },
      template: { id: "synthetic-template", version: "1.0.0", content: demoTemplate },
      childName: CHILD_NAME,
      grade: GRADE,
      submittedAt,
      aiConsented: true,
      selectedAdviceIds: [],
      generationMode: "template",
      fallbackReason: "triad_combined",
      aiModel: null,
      comparison: { available: false },
      triad: report
    };
    for (const locale of ["zh-CN", "zh-HK"] as Locale[]) {
      const html = reportHtml(payload, locale);
      expect(html).toContain(ADULT);
      expect(html).not.toContain(SECRET);
      expect(html).not.toContain(SCENE);
      for (const id of HOPES) expect(html).not.toContain(childScale.items.find(item => item.id === id)!.label[locale]);
    }

    const band: ScaleBand = {
      minimum: 1,
      key: "shown",
      label: { "zh-CN": "合成分档", "zh-HK": "合成分檔" },
      explanation: { "zh-CN": "合成说明", "zh-HK": "合成說明" },
      adviceIds: ["shown_advice"]
    };
    const snapshot: AssessmentSnapshot = {
      scale: childScale,
      score: {
        ...sources[0].score,
        dimensions: sources[0].score.dimensions.map(dimension => dimension.key === "c7" ? { ...dimension, band } : dimension)
      },
      advice: {
        id: "synthetic-advice",
        version: "1.0.0",
        content: {
          title: { "zh-CN": "合成建议", "zh-HK": "合成建議" },
          blocks: [{
            id: "shown_advice",
            title: { "zh-CN": "合成建议标题", "zh-HK": "合成建議標題" },
            body: { "zh-CN": "合成建议正文", "zh-HK": "合成建議正文" },
            source: "synthetic",
            dimensionKeys: ["c7"]
          }]
        }
      },
      template: { id: "synthetic-template", version: "1.0.0", content: demoTemplate },
      childName: CHILD_NAME,
      grade: GRADE,
      submittedAt,
      aiConsented: true
    };
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
    expect(JSON.stringify(snapshot)).not.toContain(SCENE);
    const input = JSON.stringify(modelInput(snapshot));
    expect(eligibleAdviceIds(snapshot)).toEqual(["shown_advice"]);
    expect(input).not.toContain(SECRET);
    expect(input).not.toContain(SCENE);
    expect(input).not.toContain(CHILD_NAME);
    expect(input).not.toContain(GRADE);
    for (const id of HOPES) {
      expect(input).not.toContain(childScale.items.find(item => item.id === id)!.label["zh-CN"]);
      expect(input).not.toContain(childScale.items.find(item => item.id === id)!.label["zh-HK"]);
    }
    const calls: string[] = [];
    const selection = await selectNarrative(snapshot, {
      enabled: true,
      url: "https://example.invalid/compatible-mode/v1",
      key: "synthetic-test-key",
      model: "test-model",
      scope: "CN"
    }, (async (_input, init) => {
      calls.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ adviceIds: ["shown_advice"] }) } }] }), { status: 200 });
    }) as typeof fetch);
    expect(selection.generationMode).toBe("ai");
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain(SECRET);
    expect(calls[0]).not.toContain(SCENE);
    expect(calls[0]).not.toContain(CHILD_NAME);
    expect(calls[0]).not.toContain(GRADE);
    for (const id of HOPES) {
      expect(calls[0]).not.toContain(childScale.items.find(item => item.id === id)!.label["zh-CN"]);
      expect(calls[0]).not.toContain(childScale.items.find(item => item.id === id)!.label["zh-HK"]);
    }
  });
});
