import { describe, expect, it, vi } from "vitest";
import { demoAdvice, demoScale } from "../src/domain/demo";
import { parseAdvice, ensureAdviceReferences } from "../src/domain/validation";
import { triadAdvice } from "../src/lib/triad";
import { scoreAssessment } from "../src/domain/scoring";
import type { AdviceBlock, AdviceLibrary, ContentSnapshot, RespondentRole, TriadDomainKey } from "../src/domain/types";
import {
  buildTriadNarrativeSource, eligibleTriadAdviceIds, selectTriadNarrative, triadModelInput, triadTemplateSelection,
  type TriadNarrativeSource
} from "../src/domain/triad-narrative";

const domains = ["cognition", "connection", "guidance", "curriculum", "community", "state", "impact", "autonomy"];
const applicableBlock = {
  ...demoAdvice.blocks[0],
  dimensionKeys: [],
  triadApplicability: { domainKeys: ["connection"], roles: ["parent", "teacher"] }
};

describe("versioned triad advice content", () => {
  it("accepts explicit domain and respondent applicability without inventing score bands", () => {
    const parsed = parseAdvice({ title: demoAdvice.title, blocks: [applicableBlock] });
    expect(parsed.blocks[0]).toEqual(applicableBlock);
  });

  it("keeps older and ordinary advice libraries compatible", () => {
    expect(parseAdvice(demoAdvice)).toEqual(demoAdvice);
    expect(() => ensureAdviceReferences(demoScale, demoAdvice)).not.toThrow();
  });

  it.each([
    { domainKeys: [], roles: ["parent"] },
    { domainKeys: ["portrait"], roles: ["parent"] },
    { domainKeys: ["connection", "connection"], roles: ["parent"] },
    { domainKeys: ["connection"], roles: [] },
    { domainKeys: ["connection"], roles: ["staff"] },
    { domainKeys: ["connection"], roles: ["parent", "parent"] },
    { domainKeys: ["connection"], roles: ["parent"], minimum: 3 }
  ])("rejects invalid or ambiguous triad applicability %#", triadApplicability => {
    expect(() => parseAdvice({ title: demoAdvice.title, blocks: [{ ...applicableBlock, triadApplicability }] })).toThrow();
  });

  it("provides one bilingual generic block per report domain and retains the legacy context block", () => {
    const content = parseAdvice(triadAdvice);
    const candidates = content.blocks.filter(block => "triadApplicability" in block);
    expect(candidates).toHaveLength(8);
    expect(candidates.map(block => block.triadApplicability!.domainKeys[0])).toEqual(domains);
    for (const block of candidates) {
      expect(block.dimensionKeys).toEqual([]);
      expect(block.triadApplicability!.roles).toEqual(["student", "parent", "teacher"]);
      for (const locale of ["zh-CN", "zh-HK"] as const) {
        expect(block.title[locale].length).toBeGreaterThan(0);
        expect(block.body[locale].length).toBeGreaterThan(0);
      }
    }
    expect(content.blocks.find(block => block.id === "triad_context")).toEqual({
      id: "triad_context",
      title: { "zh-CN": "先看具体情境", "zh-HK": "先看具體情境" },
      body: {
        "zh-CN": "这份报告把孩子、家长和老师的观察放在一起，不合成一个总分，也不做诊断。",
        "zh-HK": "這份報告把孩子、家長和老師的觀察放在一起，不合成一個總分，也不做診斷。"
      },
      source: "Nova growth triad intake, 2026-10",
      dimensionKeys: ["cognition"]
    });
  });
});

const settings = { enabled: true, url: "https://synthetic.invalid/v1", key: "synthetic-key", model: "synthetic-model", scope: "CN" };
const policy = { triadEnabled: true, currentAiConsented: true };
const roleOrder: RespondentRole[] = ["student", "parent", "teacher"];
function adviceBlock(id: string, domain: TriadDomainKey, roles = roleOrder): AdviceBlock {
  return { ...demoAdvice.blocks[0], id, dimensionKeys: [], triadApplicability: { domainKeys: [domain], roles } };
}
function adviceSnapshot(): ContentSnapshot<AdviceLibrary> {
  return {
    id: "frozen-parent-advice", version: "1.0.1",
    content: {
      title: demoAdvice.title,
      blocks: [
        demoAdvice.blocks[0],
        adviceBlock("cognition_support", "cognition"),
        adviceBlock("connection_support", "connection"),
        adviceBlock("teacher_state", "state", ["teacher"])
      ]
    }
  };
}
function source(role: RespondentRole): TriadNarrativeSource {
  return {
    role, age: 12, region: "CN", status: "valid", risk: false, aiConsented: true,
    dimensions: [
      { key: `${role}_thinking`, domain: "cognition", raw: 3, higherMeans: "more_strength" },
      { key: `${role}_connection`, domain: "connection", raw: 2, higherMeans: "more_support" }
    ]
  };
}
const sources = () => roleOrder.map(source);
const reply = (selection: unknown) => vi.fn<typeof fetch>(async () =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(selection) } }] }), { status: 200 }));

describe("triad source projection and candidates", () => {
  it("projects explicit fields, excludes private data, unknown domains and single-item answers", () => {
    const score = scoreAssessment(demoScale, { q1: 1, q2: 2, q3: 1, q4: 2, q5: 1, q6: 2, q7: 1, q8: 2, q9: 0 }, { age: 12, region: "CN", role: "parent" });
    const connection = score.dimensions[0];
    score.dimensions = [
      connection,
      { ...connection, key: "single_item", answered: 1, totalItems: 1, raw: 2 },
      { ...connection, key: "one_usable", answered: 1, totalItems: 4, raw: 2 },
      { ...connection, key: "hidden", answered: 0, totalItems: 0, raw: null },
      { ...connection, key: "portrait" },
      { ...connection, key: "unknown" }
    ];
    const tainted = { ...score, childName: "PRIVATE_CHILD", answers: { q1: "PRIVATE_ANSWER" }, riskMessages: [{ "zh-CN": "PRIVATE_MESSAGE", "zh-HK": "PRIVATE_MESSAGE" }] };
    const result = buildTriadNarrativeSource("parent", [
      { key: "connection", domain: "connection" },
      { key: "single_item", domain: "state" },
      { key: "one_usable", domain: "impact" },
      { key: "hidden", domain: "autonomy" },
      { key: "portrait", domain: "portrait" },
      { key: "unknown", domain: "unregistered" }
    ], tainted, true);
    expect(Object.keys(result).sort()).toEqual(["age", "aiConsented", "dimensions", "region", "risk", "role", "status"]);
    expect(result.dimensions.map(item => [item.key, item.raw])).toEqual([
      ["connection", connection.raw], ["single_item", null], ["one_usable", null], ["hidden", null]
    ]);
    expect(result.dimensions.every(item => Object.keys(item).sort().join() === "domain,higherMeans,key,raw")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  it("matches role and existing domain with usable values, in parent-library order, once per ID", () => {
    const input = sources();
    input[0].dimensions.push({ key: "child_state", domain: "state", raw: 3, higherMeans: "more_support" });
    expect(eligibleTriadAdviceIds(input, adviceSnapshot())).toEqual(["cognition_support", "connection_support"]);
    input[2].dimensions.push({ key: "teacher_state", domain: "state", raw: null, higherMeans: "more_support" });
    expect(eligibleTriadAdviceIds(input, adviceSnapshot())).toEqual(["cognition_support", "connection_support"]);
    input[2].dimensions.at(-1)!.raw = 3;
    expect(eligibleTriadAdviceIds(input, adviceSnapshot())).toEqual(["cognition_support", "connection_support", "teacher_state"]);
    expect(eligibleTriadAdviceIds(input.map(item => ({ ...item, dimensions: item.dimensions.map(dimension => ({ ...dimension, raw: null })) })), adviceSnapshot())).toEqual([]);
  });

  it("uses only the supplied frozen advice version and supports legacy snapshots without metadata", () => {
    const frozen = adviceSnapshot();
    const before = structuredClone(frozen);
    const newer = structuredClone(frozen);
    newer.id = "newer-unrelated-library";
    newer.content.blocks[1].id = "newer_id";
    const input = sources().map(item => ({ ...item, advice: newer }));
    expect(eligibleTriadAdviceIds(input, frozen)).toEqual(["cognition_support", "connection_support"]);
    expect(frozen).toEqual(before);
    expect(eligibleTriadAdviceIds(input, { ...frozen, content: demoAdvice })).toEqual([]);
  });

  it("whitelists the actual model payload again even when source objects contain extra fields", () => {
    const input = sources().reverse().map(item => ({
      ...item, childName: "PRIVATE_NAME", grade: "PRIVATE_GRADE", answers: { q1: "PRIVATE_ANSWER" },
      submittedAt: "PRIVATE_DATE", freeText: "PRIVATE_WRITING",
      dimensions: item.dimensions.map(dimension => ({ ...dimension, label: "PRIVATE_LABEL", missing: ["PRIVATE_ITEM"] }))
    }));
    const frozen = adviceSnapshot();
    const model = triadModelInput(input, frozen) as {
      sources: { role: string; ageBand: string; dimensions: Record<string, unknown>[] }[];
      advice: Record<string, unknown>[];
      outputContract: unknown;
    };
    expect(Object.keys(model).sort()).toEqual(["advice", "outputContract", "sources"]);
    expect(model.sources.map(item => item.role)).toEqual(roleOrder);
    for (const item of model.sources) {
      expect(Object.keys(item).sort()).toEqual(["ageBand", "dimensions", "role"]);
      expect(item.ageBand).toBe("10-12");
      for (const dimension of item.dimensions) expect(Object.keys(dimension).sort()).toEqual(["domain", "higherMeans", "key", "raw"]);
    }
    expect(model.advice.map(block => block.id)).toEqual(["cognition_support", "connection_support"]);
    expect(model.advice.every(block => Object.keys(block).sort().join() === "body,id,title")).toBe(true);
    expect(JSON.stringify(model)).not.toContain("PRIVATE_");
    expect(JSON.stringify(model)).not.toContain(frozen.id);
    expect(JSON.stringify(model)).not.toContain(frozen.version);
  });
});

describe("triad ordering, gates and deterministic fallback", () => {
  it.each(roleOrder)("sends only the %s aggregate change when that source is perturbed", async role => {
    const baseline = sources(), changed = structuredClone(baseline), frozen = adviceSnapshot();
    changed.find(item => item.role === role)!.dimensions[0].raw = 4;
    const fetcher = reply({ adviceIds: ["connection_support", "cognition_support"] });
    await selectTriadNarrative(baseline, frozen, settings, policy, fetcher);
    await selectTriadNarrative(changed, frozen, settings, policy, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const captured = fetcher.mock.calls.map(([, init]) => {
      const request = JSON.parse(String(init?.body));
      return JSON.parse(request.messages.find((message: { role: string }) => message.role === "user").content) as {
        sources: { role: RespondentRole; ageBand: string; dimensions: { key: string; domain: string; raw: number; higherMeans: string }[] }[];
      };
    });
    for (const payload of captured) expect(payload.sources.map(item => item.role)).toEqual(roleOrder);
    const expected = structuredClone(captured[0]);
    expected.sources.find(item => item.role === role)!.dimensions[0].raw = 4;
    expect(captured[1]).toEqual(expected);
    expect(captured[1]).not.toEqual(captured[0]);
    for (const otherRole of roleOrder.filter(item => item !== role)) {
      expect(captured[1].sources.find(item => item.role === otherRole)).toEqual(captured[0].sources.find(item => item.role === otherRole));
    }
  });

  it.each(["CN", "HK"] as const)("orders every candidate once for the matching %s region", async region => {
    const input = sources().map(item => ({ ...item, region }));
    const frozen = adviceSnapshot();
    const before = structuredClone({ input, frozen });
    const expected = eligibleTriadAdviceIds(input, frozen).reverse();
    const fetcher = reply({ adviceIds: expected });
    const result = await selectTriadNarrative(input, frozen, { ...settings, scope: region }, policy, fetcher);
    expect(result).toEqual({ selectedAdviceIds: expected, generationMode: "ai", fallbackReason: null, aiModel: settings.model });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(JSON.parse(request.messages[1].content)).toEqual(triadModelInput(input, frozen));
    expect({ input, frozen }).toEqual(before);
  });

  it.each([
    ["triad disabled", "triad_ai_disabled", (input: TriadNarrativeSource[]) => input, { ...policy, triadEnabled: false }, settings],
    ["global AI disabled", "ai_disabled", (input: TriadNarrativeSource[]) => input, policy, { ...settings, enabled: false }],
    ["current consent absent", "no_ai_consent", (input: TriadNarrativeSource[]) => input, { ...policy, currentAiConsented: false }, settings],
    ["source consent absent", "no_ai_consent", (input: TriadNarrativeSource[]) => input.map((item, index) => index === 0 ? { ...item, aiConsented: false } : item), policy, settings],
    ["risk in teacher", "risk_template", (input: TriadNarrativeSource[]) => input.map(item => item.role === "teacher" ? { ...item, risk: true } : item), policy, settings],
    ["incomplete child", "incomplete_template", (input: TriadNarrativeSource[]) => input.map(item => item.role === "student" ? { ...item, status: "incomplete" as const } : item), policy, settings],
    ["ineligible parent", "incomplete_template", (input: TriadNarrativeSource[]) => input.map(item => item.role === "parent" ? { ...item, status: "ineligible" as const } : item), policy, settings],
    ["mixed region", "region_mismatch", (input: TriadNarrativeSource[]) => input.map((item, index) => index === 0 ? { ...item, region: "HK" as const } : item), policy, settings],
    ["wrong provider region", "region_mismatch", (input: TriadNarrativeSource[]) => input, policy, { ...settings, scope: "HK" }],
    ["missing source", "invalid_triad_sources", (input: TriadNarrativeSource[]) => input.slice(1), policy, settings],
    ["duplicate role", "invalid_triad_sources", (input: TriadNarrativeSource[]) => [input[0], input[0], input[2]], policy, settings]
  ] as const)("does not contact a provider when %s", async (_label, reason, modify, gate, config) => {
    const input = modify(sources());
    const fetcher = reply({ adviceIds: [] });
    const result = await selectTriadNarrative(input, adviceSnapshot(), config, gate, fetcher);
    expect(result).toEqual(triadTemplateSelection(input, adviceSnapshot(), reason));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([0, 1])("does not contact AI for %i eligible candidates", async count => {
    const frozen = adviceSnapshot();
    frozen.content.blocks = frozen.content.blocks.slice(0, count + 1);
    const fetcher = reply({ adviceIds: [] });
    const result = await selectTriadNarrative(sources(), frozen, settings, policy, fetcher);
    expect(result.fallbackReason).toBe(count ? "insufficient_advice_candidates" : "no_advice_candidates");
    expect(result.selectedAdviceIds).toHaveLength(count);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { adviceIds: ["cognition_support"] },
    { adviceIds: ["cognition_support", "cognition_support"] },
    { adviceIds: ["cognition_support", "unknown"] },
    { adviceIds: ["cognition_support", "connection_support"], diagnosis: "FORBIDDEN_PROSE" },
    { adviceIds: ["cognition_support", "connection_support"], score: 99 },
    { adviceIds: ["cognition_support", 3] },
    { adviceIds: [] },
    ["cognition_support", "connection_support"],
    "FORBIDDEN_PROSE"
  ])("rejects any non-permutation or additional model claim %#", async selection => {
    const result = await selectTriadNarrative(sources(), adviceSnapshot(), settings, policy, reply(selection));
    expect(result).toEqual(triadTemplateSelection(sources(), adviceSnapshot(), "invalid_output"));
    expect(JSON.stringify(result)).not.toContain("FORBIDDEN_PROSE");
  });

  it.each([
    ["non-JSON envelope", "invalid_output", async () => new Response("<html>bad gateway</html>")],
    ["oversized envelope", "invalid_output", async () => new Response("x".repeat(20_001))],
    ["HTTP error", "provider_error", async () => new Response("unavailable", { status: 503 })],
    ["network failure", "provider_unavailable", async () => { throw new Error("SYNTHETIC_TRANSPORT_FAILURE"); }],
    ["timeout", "provider_unavailable", async () => { throw new DOMException("synthetic timeout", "TimeoutError"); }],
    ["reasoning-only", "thinking_model_output", async () => new Response(JSON.stringify({ choices: [{ message: { content: "", reasoning_content: "FORBIDDEN_REASONING" } }] }))]
  ] as const)("preserves deterministic candidates after %s", async (_label, reason, fetcher) => {
    const result = await selectTriadNarrative(sources(), adviceSnapshot(), settings, policy, fetcher);
    expect(result).toEqual(triadTemplateSelection(sources(), adviceSnapshot(), reason));
  });

  it("allows consent-change fallback without a second provider request", async () => {
    const input = sources(), frozen = adviceSnapshot();
    const fetcher = reply({ adviceIds: eligibleTriadAdviceIds(input, frozen).reverse() });
    expect((await selectTriadNarrative(input, frozen, settings, policy, fetcher)).generationMode).toBe("ai");
    expect(triadTemplateSelection(input, frozen, "ai_consent_changed")).toEqual({
      selectedAdviceIds: ["cognition_support", "connection_support"], generationMode: "template",
      fallbackReason: "ai_consent_changed", aiModel: null
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
