import type { ScaleDefinition, TextPair } from "../src/domain/types";
export const pair = (s: string): TextPair => ({ "zh-CN": s, "zh-HK": s });
export function scaleFixture(): ScaleDefinition {
  return {
    id: "test-only", version: "1.0.0", title: pair("测试"), description: pair("合成测评"), demo: true,
    source: "synthetic", rights: { digital: true, commercial: true, reference: "synthetic" },
    minAge: 6, maxAge: 18, regions: ["CN", "HK"], roles: ["student", "parent", "teacher"], retakeDays: 14,
    norm: { label: pair("演示"), source: "none", regions: ["CN", "HK"], minAge: 6, maxAge: 18, validated: false },
    items: ["a", "b", "c"].map(id => ({ id, label: pair(id), choices: [0,1,2,3].map(value => ({value,label:pair(String(value))})), reverse: id === "b", required: false })),
    dimensions: [{ key: "connection", label: pair("沟通"), items: ["a", "b"], aggregation: "sum", maxMissing: 0, prorate: false, higherMeans: "more_support", bands: [
      { minimum: 0, key: "low", label: pair("低"), explanation: pair("低分"), adviceIds: ["listen"] },
      { minimum: 4, key: "high", label: pair("高"), explanation: pair("高分"), adviceIds: ["listen", "routine"] }
    ] }],
    riskRules: [{ itemId: "c", values: [3], message: pair("需要即时支持") }]
  };
}
