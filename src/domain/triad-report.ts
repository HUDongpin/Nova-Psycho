import type { DimensionScore, Locale, RespondentRole, ScaleDefinition, ScaleDimension, ScaleItem, StoredAnswer, TextPair, TriadReport } from "./types";
import { scoreAssessment } from "./scoring";
import { pair } from "./zh-pair";

export const TRIAD_BUNDLE = "growth-triad";
const ROLE_ORDER: RespondentRole[] = ["student", "parent", "teacher"];
const DOMAINS: [string, string][] = [
  ["cognition", "学习和思考"],
  ["connection", "关系和安全感"],
  ["guidance", "指导和自我管理"],
  ["curriculum", "课程和日常安排"],
  ["community", "学校与周围的支持"],
  ["state", "最近的身心状态"],
  ["impact", "这些困难带来的影响"],
  ["autonomy", "自主和接下来的方向"]
];
const ROLE_LABEL: Record<RespondentRole, TextPair> = {
  student: pair("孩子自己"),
  parent: pair("家长看到的"),
  teacher: pair("老师看到的")
};

export interface TriadSource {
  role: RespondentRole;
  scale: ScaleDefinition;
  answers: Record<string, StoredAnswer>;
  score: ReturnType<typeof scoreAssessment>;
  submittedAt: string;
}

export function triadRolesReady(roles: Iterable<string>): boolean {
  const present = new Set(roles);
  return ROLE_ORDER.every(role => present.has(role));
}

function joinLabel(role: TextPair, label: TextPair): TextPair {
  return { "zh-CN": `${role["zh-CN"]} · ${label["zh-CN"]}`, "zh-HK": `${role["zh-HK"]} · ${label["zh-HK"]}` };
}

function commonAnchors(scale: ScaleDefinition, dimension: ScaleDimension): ScaleItem["choices"] | null {
  if (dimension.aggregation !== "mean" || dimension.prorate) return null;
  const choices: ScaleItem["choices"][] = [];
  for (const id of dimension.items) {
    const item = scale.items.find(candidate => candidate.id === id);
    if (!item || (item.kind ?? "single") !== "single" || item.reverse) return null;
    choices.push(item.choices.filter(choice => !item.excludeValues?.includes(choice.value)).sort((left, right) => left.value - right.value));
  }
  const anchors = choices[0];
  if (!anchors || anchors.length < 2) return null;
  return choices.every(list => list.length === anchors.length && list.every((choice, index) => {
    const anchor = anchors[index];
    return choice.value === anchor.value && choice.label["zh-CN"] === anchor.label["zh-CN"] && choice.label["zh-HK"] === anchor.label["zh-HK"];
  })) ? anchors : null;
}

function anchorReference(scale: ScaleDefinition, dimension: ScaleDimension, raw: number, showValues: boolean): TextPair | null {
  const anchors = commonAnchors(scale, dimension);
  if (!anchors) return null;
  const exact = anchors.find(choice => choice.value === raw);
  const lower = exact ?? anchors.filter(choice => choice.value < raw).at(-1);
  const upper = exact ?? anchors.find(choice => choice.value > raw);
  if (!lower || !upper) return null;
  // These are the frozen questionnaire's answer anchors, not new score bands.
  const template = exact
    ? pair(showValues ? "对应问卷选项 {lower}。" : "对应问卷选项{lower}。")
    : pair(showValues ? "位于问卷选项 {lower}与 {upper}之间。" : "位于问卷选项{lower}与{upper}之间。");
  const at = (choice: ScaleItem["choices"][number], locale: Locale) => `${showValues ? choice.value : ""}「${choice.label[locale]}」`;
  return {
    "zh-CN": template["zh-CN"].replace("{lower}", at(lower, "zh-CN")).replace("{upper}", at(upper, "zh-CN")),
    "zh-HK": template["zh-HK"].replace("{lower}", at(lower, "zh-HK")).replace("{upper}", at(upper, "zh-HK"))
  };
}

function dimensionBody(scale: ScaleDefinition, dimension: ScaleDimension, scored: DimensionScore | undefined): TextPair {
  if (scored?.raw === null || scored?.raw === undefined) return pair("有效回答还不到四分之三，这里先不概括。");
  const reference = anchorReference(scale, dimension, scored.raw, true);
  const scoreLabel = dimension.aggregation === "mean" ? "原始平均分" : "原始分";
  const template = pair(`${scoreLabel} ${scored.raw}（${scored.min} 到 ${scored.max}）${reference ? "，{reference}" : "。请结合本维度各题的回答理解。"}这不是诊断，也不是名次。`);
  return {
    "zh-CN": template["zh-CN"].replace("{reference}", reference?.["zh-CN"] ?? ""),
    "zh-HK": template["zh-HK"].replace("{reference}", reference?.["zh-HK"] ?? "")
  };
}

function portraitSentence(scale: ScaleDefinition, dimension: ScaleDimension, raw: number | null): TextPair {
  const reference = raw === null ? null : anchorReference(scale, dimension, raw, false);
  const template = raw === null ? pair("「{name}」的有效回答还不够，这里先不概括。")
    : reference ? pair("在「{name}」里，本组回答的平均位置{reference}")
      : pair("在「{name}」里，请结合本组各题的回答理解，这里不作统一概括。");
  return {
    "zh-CN": template["zh-CN"].replace("{name}", dimension.label["zh-CN"]).replace("{reference}", reference?.["zh-CN"] ?? ""),
    "zh-HK": template["zh-HK"].replace("{name}", dimension.label["zh-HK"]).replace("{reference}", reference?.["zh-HK"] ?? "")
  };
}

function choiceLabel(item: ScaleItem, value: number): TextPair | null {
  return item.choices.find(choice => choice.value === value)?.label ?? null;
}

export function composeTriad(sources: TriadSource[]): TriadReport {
  const ordered = [...sources].sort((left, right) => ROLE_ORDER.indexOf(left.role) - ROLE_ORDER.indexOf(right.role));
  const safety: TextPair[] = [];
  const seen = new Set<string>();
  for (const source of ordered) for (const message of source.score.riskMessages) {
    if (seen.has(message["zh-CN"])) continue;
    seen.add(message["zh-CN"]);
    safety.push(message);
  }
  const domains = DOMAINS.flatMap(([key, label]) => {
    const views = ordered.flatMap(source => source.scale.dimensions.filter(dimension => dimension.domain === key).map(dimension => {
      const scored = source.score.dimensions.find(item => item.key === dimension.key);
      const raw = scored?.raw ?? null;
      return {
        role: source.role,
        label: joinLabel(ROLE_LABEL[source.role], dimension.label),
        body: dimensionBody(source.scale, dimension, scored),
        raw,
        submittedAt: source.submittedAt
      };
    }));
    if (!views.length) return [];
    // A domain can contain different subdimensions and observation windows.
    // Keep each view without inferring cross-respondent disagreement from a spread.
    return [{ key, label: pair(label), note: null, views }];
  });
  const portrait = ordered.filter(source => source.role === "parent").flatMap(source => source.scale.dimensions.filter(dimension => dimension.domain === "portrait").map(dimension => {
    const raw = source.score.dimensions.find(item => item.key === dimension.key)?.raw ?? null;
    return { heading: dimension.label, body: portraitSentence(source.scale, dimension, raw) };
  }));
  const adultSources = ordered.filter(source => source.role === "parent" || source.role === "teacher");
  const situations = adultSources.flatMap(source => source.scale.items.filter(item => item.report === "situation").flatMap(item => {
    const value = source.answers[item.id];
    const choice = typeof value === "number" ? choiceLabel(item, value) : null;
    return choice ? [{ role: source.role, prompt: item.label, choice }] : [];
  }));
  const priorities = adultSources.flatMap(source => source.scale.items.filter(item => item.report === "priorities").flatMap(item => {
    const value = source.answers[item.id];
    if (!Array.isArray(value)) return [];
    const choices = value.flatMap(entry => { const label = choiceLabel(item, entry); return label ? [label] : []; });
    return choices.length ? [{ role: source.role, prompt: item.label, choices }] : [];
  }));
  const words = adultSources.flatMap(source => source.scale.items.filter(item => item.report === "words").flatMap(item => {
    const value = source.answers[item.id];
    return typeof value === "string" && value.trim() ? [{ role: source.role, prompt: item.label, value: value.trim() }] : [];
  }));
  return {
    title: pair("孩子的成长了解"),
    sources: ordered.map(source => ({ role: source.role, submittedAt: source.submittedAt })),
    safety, domains, portrait, situations, priorities, words
  };
}

export function previewAnswers(scale: ScaleDefinition, mode: "calm" | "risk" = "calm"): Record<string, StoredAnswer> {
  const answers: Record<string, StoredAnswer> = {};
  const visible = (item: ScaleItem) => {
    if (!item.showIf) return true;
    const current = answers[item.showIf.itemId];
    const values = typeof current === "number" ? [current] : Array.isArray(current) ? current : [];
    return item.showIf.anyOf.some(value => values.includes(value));
  };
  for (const item of scale.items) {
    if (!visible(item)) continue;
    if (item.gate !== undefined) { answers[item.id] = item.gate; continue; }
    const kind = item.kind ?? "single";
    const risks = scale.riskRules.filter(rule => rule.itemId === item.id).flatMap(rule => rule.values);
    if (kind === "text") { answers[item.id] = item.report === "staff" ? "13800001111" : "想被理解"; continue; }
    if (kind === "multi") {
      const pool = item.choices.map(choice => choice.value).filter(value => mode === "risk" ? risks.includes(value) : !risks.includes(value));
      const picked = (pool.length ? pool : item.choices.map(choice => choice.value)).slice(0, item.maxChoices ?? 1);
      answers[item.id] = picked;
      continue;
    }
    const usable = item.choices.map(choice => choice.value).filter(value => !item.excludeValues?.includes(value) && (mode === "risk" || !risks.includes(value)));
    const preferred = mode === "risk" && risks.length ? risks[0] : usable.includes(4) ? 4 : usable[0];
    answers[item.id] = preferred;
  }
  return answers;
}

export function staffOnlyText(scale: ScaleDefinition, answers: Record<string, StoredAnswer>): { label: TextPair; value: string }[] {
  return scale.items.filter(item => item.report === "staff").flatMap(item => {
    const value = answers[item.id];
    return typeof value === "string" && value.trim() ? [{ label: item.label, value: value.trim() }] : [];
  });
}
