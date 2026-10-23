import type { DimensionScore, Locale, RespondentRole, ResultMode, ScaleDefinition, ScaleDimension, ScaleItem, StoredAnswer, StudentSharingSnapshot, SupportIntakeObservation, TextPair, TriadReport } from "./types";
import { answerVisible, scoreAssessment } from "./scoring";
import { pair } from "./zh-pair";
import { PARENT_REPORT_AUDIENCE_VERSION, parentReportWordAllowed } from "./report-privacy";
import { approvedStudentSharing } from "./student-sharing";

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
  studentSharing?: StudentSharingSnapshot;
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

export function triadResultMode(scales: readonly Pick<ScaleDefinition, "resultMode">[]): ResultMode {
  const modes = new Set(scales.map(scale => scale.resultMode ?? "scored"));
  if (modes.size > 1) throw new Error("Mixed triad result modes");
  return modes.values().next().value ?? "scored";
}

// Parent-report permission is explicit for this intake version. Item report tags
// are not permission to expose additional answers, particularly child responses.
const SUPPORT_REPORT_ITEMS = {
  concerns: {
    parent: ["p_focus", "q20_1", "q20_2", "q20_3", "q20_4", "q20_5", "q20_6", "q20_8", "q21_1", "q21_3", "q21_4"],
    teacher: ["t_focus", "t13_1", "t13_2", "t13_4", "t13_5", "t13_7", "t14_1"]
  },
  supports: {
    parent: ["q16_1", "q18_1", "q18_2", "q19_1", "q19_5"],
    teacher: ["t11_1", "t12_2"]
  },
  actions: { parent: ["q31"], teacher: ["t22", "t21"] }
} as const;

const TOPE_REPORT_ITEMS = {
  concerns: ["o_task", "o_communication"],
  supports: ["o_support_needs", "o_tried_supports"],
  actions: ["o_next_step"]
} as const;
const TOPE_INFORMATION_SOURCE: Record<string, string> = {
  o_task: "o_task_source", o_communication: "o_communication_source", o_support_needs: "o_support_source"
};

function isTopeObservation(scale: ScaleDefinition): boolean {
  return scale.id === "growth-tope-observation" && scale.version === "1.0.0" && scale.resultMode === "support-intake";
}

function stagedSource(source: TriadSource): TriadReport["sources"][number] {
  const tope = isTopeObservation(source.scale);
  const date = source.answers.o_visit_date;
  // Never copy staff writing into report metadata. Only a real ISO calendar date is allowed here.
  const validDate = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)) && new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date;
  return {
    role: source.role, submittedAt: source.submittedAt,
    label: pair(source.role === "parent" ? "家长资料" : source.role === "student" ? "学生资料" : tope ? "TOPE 现场观察" : "学校教师观察"),
    ...(tope && validDate ? { visitDate: date } : {})
  };
}

function stagedTitle(sources: readonly TriadSource[]): TextPair {
  const student = sources.some(source => source.role === "student");
  const teacher = sources.find(source => source.role === "teacher");
  if (student && teacher) return pair("综合跟进报告");
  if (student) return pair("跟进报告：新增学生资料");
  if (teacher) return pair(isTopeObservation(teacher.scale) ? "跟进报告：新增现场观察" : "跟进报告：新增教师资料");
  return pair("首次家长报告");
}

function supportObservationPeriod(role: "parent" | "teacher", itemId: string): TextPair {
  if (/^(q20_|q21_)/.test(itemId)) return pair("过去四周");
  if (/^(t13_|t14_)/.test(itemId)) return pair("过去四周在学校");
  if (/^(q16_|q18_|q19_)/.test(itemId)) return pair("过去三个月");
  if (/^(t11_|t12_)/.test(itemId)) return pair("过去三个月在学校的直接观察");
  if (role === "teacher" && itemId === "t21") return pair("未来四至六周");
  return pair("本次填写");
}

function supportObservations(sources: readonly TriadSource[], section: keyof typeof SUPPORT_REPORT_ITEMS): SupportIntakeObservation[] {
  return sources.flatMap(source => {
    if (source.role !== "parent" && source.role !== "teacher") return [];
    const role = source.role;
    const tope = isTopeObservation(source.scale);
    const itemIds: readonly string[] = tope ? TOPE_REPORT_ITEMS[section] : SUPPORT_REPORT_ITEMS[section][role];
    return itemIds.flatMap(itemId => {
      const item = source.scale.items.find(candidate => candidate.id === itemId);
      if (!item || item.report === "staff" || !answerVisible(source.answers, item, source.score.age)) return [];
      if (tope && item.kind === "text") return [];
      const value = source.answers[item.id];
      const selected = typeof value === "number" ? [value] : Array.isArray(value) ? value : [];
      // Preserve submitted writing verbatim in either script; no AI translation.
      const responses = item.kind === "text" && typeof value === "string" && value.trim()
        ? [{ "zh-CN": value.trim(), "zh-HK": value.trim() }]
        : selected.flatMap(entry => { const label = choiceLabel(item, entry); return label ? [label] : []; });
      const informationItem = source.scale.items.find(candidate => candidate.id === TOPE_INFORMATION_SOURCE[itemId]);
      const informationValue = informationItem && source.answers[informationItem.id];
      const informationSource = informationItem && typeof informationValue === "number" ? choiceLabel(informationItem, informationValue) : null;
      return responses.length ? [{ role, itemId, prompt: item.label, responses, period: tope ? pair("本次 TOPE 到访") : supportObservationPeriod(role, itemId), ...(informationSource ? { informationSource } : {}) }] : [];
    });
  });
}

export function composeTriad(sources: TriadSource[], options: { staged?: boolean } = {}): TriadReport {
  const resultMode = triadResultMode(sources.map(source => source.scale));
  if (options.staged && (resultMode !== "support-intake" || !sources.some(source => source.role === "parent"))) throw new Error("Staged reports require a parent support intake");
  const order: RespondentRole[] = options.staged ? ["parent", "student", "teacher"] : ROLE_ORDER;
  const ordered = [...sources].sort((left, right) => order.indexOf(left.role) - order.indexOf(right.role));
  const safety: TextPair[] = [];
  const seen = new Set<string>();
  for (const source of ordered) for (const message of source.score.riskMessages) {
    if (seen.has(message["zh-CN"])) continue;
    seen.add(message["zh-CN"]);
    safety.push(message);
  }
  const student = ordered.find(source => source.role === "student");
  const studentShared = options.staged && student && student.studentSharing?.confirmedAt === student.submittedAt ? approvedStudentSharing(student.scale, student.studentSharing) : undefined;
  if (resultMode === "support-intake") return {
    parentAudienceVersion: PARENT_REPORT_AUDIENCE_VERSION,
    resultMode,
    ...(options.staged ? { staged: true } : {}),
    title: options.staged ? stagedTitle(ordered) : pair("当前困难与支持建议"),
    sources: ordered.map(source => options.staged ? stagedSource(source) : ({ role: source.role, submittedAt: source.submittedAt })),
    safety, domains: [], portrait: [], situations: [], priorities: [], words: [], comparisons: [],
    supportIntake: {
      concerns: supportObservations(ordered, "concerns"),
      supports: supportObservations(ordered, "supports"),
      actions: supportObservations(ordered, "actions"),
      ...(studentShared ? { studentShared } : {}),
      nextStep: pair("从上述关注中共同选一项，商定一项具体支持，明确由谁参与，并在四至六周后回顾。")
    }
  };
  const domains = DOMAINS.flatMap(([key, label]) => {
    const views = ordered.flatMap(source => source.scale.dimensions.filter(dimension => dimension.domain === key).flatMap(dimension => {
      const dimensionItems = dimension.items.map(id => source.scale.items.find(item => item.id === id)).filter(item => item !== undefined);
      if (dimensionItems.length > 0 && dimensionItems.every(item => !answerVisible(source.answers, item, source.score.age))) return [];
      const scored = source.score.dimensions.find(item => item.key === dimension.key);
      const raw = scored?.raw ?? null;
      return [{
        role: source.role,
        label: joinLabel(ROLE_LABEL[source.role], dimension.label),
        body: dimensionBody(source.scale, dimension, scored),
        raw,
        submittedAt: source.submittedAt
      }];
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
  const words = adultSources.flatMap(source => source.scale.items.filter(item => parentReportWordAllowed(source.scale, item)).flatMap(item => {
    const value = source.answers[item.id];
    return typeof value === "string" && value.trim() ? [{ role: source.role, prompt: item.label, value: value.trim() }] : [];
  }));
  return {
    parentAudienceVersion: PARENT_REPORT_AUDIENCE_VERSION,
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
      const exclusive = new Set(item.choices.filter(choice => choice.exclusive).map(choice => choice.value));
      const pool = item.choices.map(choice => choice.value).filter(value => mode === "risk" ? risks.includes(value) : !risks.includes(value));
      const source = pool.length ? pool : item.choices.map(choice => choice.value);
      const open = source.filter(value => !exclusive.has(value));
      const limit = item.maxChoices ?? (open.length || 1);
      answers[item.id] = (open.length ? open : source).slice(0, limit);
      continue;
    }
    const usable = item.choices.map(choice => choice.value).filter(value => !item.excludeValues?.includes(value) && (mode === "risk" || !risks.includes(value)));
    const preferred = mode === "risk" && risks.length ? risks[0] : usable.includes(4) ? 4 : usable[0];
    answers[item.id] = preferred;
  }
  return answers;
}

export function staffOnlyText(scale: ScaleDefinition, answers: Record<string, StoredAnswer>): { itemId: string; label: TextPair; value: string }[] {
  return scale.items.filter(item => item.report === "staff").flatMap(item => {
    const value = answers[item.id];
    return typeof value === "string" && value.trim() ? [{ itemId: item.id, label: item.label, value: value.trim() }] : [];
  });
}
