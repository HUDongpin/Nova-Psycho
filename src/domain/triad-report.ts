import type { RespondentRole, ScaleDefinition, ScaleItem, StoredAnswer, TextPair, TriadReport } from "./types";
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

function frequency(raw: number | null, difficulty: boolean): TextPair {
  if (raw === null) return pair("有效回答还不到四分之三，这里先不概括。");
  if (difficulty) {
    if (raw >= 3) return pair("这类情况比较经常出现，值得进一步了解。");
    if (raw >= 2) return pair("这类情况有时出现。");
    if (raw >= 1) return pair("这类情况偶尔出现。");
    return pair("这段时间几乎没有报告这类情况。");
  }
  if (raw >= 4) return pair("过去这段时间，这一方面的做法比较经常出现。");
  if (raw >= 3) return pair("过去这段时间，这一方面有时出现。");
  if (raw >= 2) return pair("过去这段时间，这一方面较少出现。");
  return pair("过去这段时间，这一方面很少出现。");
}

function withScore(body: TextPair, raw: number, low: number, high: number, difficulty: boolean): TextPair {
  const shown = Number.isInteger(raw) ? String(raw) : raw.toFixed(1);
  const extra = difficulty
    ? pair(`原始平均分 ${shown}（${low} 到 ${high}，分数越高表示这类情况越多。这不是诊断，也不是名次）。`)
    : pair(`原始平均分 ${shown}（${low} 到 ${high}。这不是诊断，也不是和其他孩子比较的名次）。`);
  return { "zh-CN": `${body["zh-CN"]}${extra["zh-CN"]}`, "zh-HK": `${body["zh-HK"]}${extra["zh-HK"]}` };
}

function portraitSentence(label: TextPair, raw: number | null): TextPair {
  const template = raw === null
    ? pair("「{name}」的有效回答还不够，这里先不概括。")
    : raw >= 4
      ? pair("在「{name}」里，您描述自己比较经常会这样做。")
      : raw >= 3
        ? pair("在「{name}」里，您描述自己有时会这样做。")
        : pair("在「{name}」里，您描述自己较少这样做。");
  return {
    "zh-CN": template["zh-CN"].replaceAll("{name}", label["zh-CN"]),
    "zh-HK": template["zh-HK"].replaceAll("{name}", label["zh-HK"])
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
      const difficulty = dimension.higherMeans === "more_support";
      const body = frequency(raw, difficulty);
      return {
        role: source.role,
        label: joinLabel(ROLE_LABEL[source.role], dimension.label),
        body: raw === null ? body : withScore(body, raw, scored?.min ?? 0, scored?.max ?? 0, difficulty),
        raw,
        submittedAt: source.submittedAt
      };
    }));
    if (!views.length) return [];
    const numbers = views.flatMap(view => view.raw === null ? [] : [view.raw]);
    const note = numbers.length >= 2 && Math.max(...numbers) - Math.min(...numbers) >= 1.5
      ? pair("这几方看到的情况相差比较明显。这不代表谁在撒谎。家里、学校和孩子自己的感受可以不一样，适合一起核对具体情境。")
      : null;
    return [{ key, label: pair(label), note, views }];
  });
  const portrait = ordered.filter(source => source.role === "parent").flatMap(source => source.scale.dimensions.filter(dimension => dimension.domain === "portrait").map(dimension => {
    const raw = source.score.dimensions.find(item => item.key === dimension.key)?.raw ?? null;
    return { heading: dimension.label, body: portraitSentence(dimension.label, raw) };
  }));
  const situations = ordered.flatMap(source => source.scale.items.filter(item => item.report === "situation").flatMap(item => {
    const value = source.answers[item.id];
    const choice = typeof value === "number" ? choiceLabel(item, value) : null;
    return choice ? [{ role: source.role, prompt: item.label, choice }] : [];
  }));
  const priorities = ordered.flatMap(source => source.scale.items.filter(item => item.report === "priorities").flatMap(item => {
    const value = source.answers[item.id];
    if (!Array.isArray(value)) return [];
    const choices = value.flatMap(entry => { const label = choiceLabel(item, entry); return label ? [label] : []; });
    return choices.length ? [{ role: source.role, prompt: item.label, choices }] : [];
  }));
  const words = ordered.flatMap(source => source.scale.items.filter(item => item.report === "words").flatMap(item => {
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

