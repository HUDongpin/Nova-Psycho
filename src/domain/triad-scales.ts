import type { RespondentRole, ScaleDefinition, ScaleDimension, ScaleItem } from "./types";
import { pair } from "./zh-pair";

type Opt = [number, string][];
const RESOURCE: Opt = [[1, "完全不符合"], [2, "较不符合"], [3, "有时符合"], [4, "比较符合"], [5, "非常符合"], [-1, "不确定或不适用"]];
const OBSERVE: Opt = [[1, "从不或几乎从不"], [2, "很少"], [3, "有时"], [4, "经常"], [5, "几乎总是"], [-1, "不了解或不适用"]];
const DISTRESS_CHILD: Opt = [[0, "没有"], [1, "偶尔"], [2, "有时"], [3, "经常"], [4, "几乎每天"], [-1, "不愿回答"]];
const DISTRESS: Opt = [[0, "没有"], [1, "偶尔"], [2, "有时"], [3, "经常"], [4, "几乎每天"], [-1, "不了解或不适用"]];
const IMPACT: Opt = [[0, "没有影响"], [1, "轻微"], [2, "中等"], [3, "较大"], [4, "非常大"], [-1, "不了解或不适用"]];

export function maxMissingForCoverage(count: number): number {
  return count - Math.ceil(count * 0.75);
}

interface Bag { items: ScaleItem[]; dimensions: ScaleDimension[]; risks: ScaleDefinition["riskRules"] }
function bag(): Bag { return { items: [], dimensions: [], risks: [] }; }
function choices(options: Opt): ScaleItem["choices"] { return options.map(([value, label]) => ({ value, label: pair(label) })); }
function numbered(labels: string[]): Opt { return labels.map((label, index) => [index + 1, label]); }

function add(target: Bag, item: ScaleItem): void { target.items.push(item); }

function choose(target: Bag, id: string, page: string, pageTitle: string, label: string, options: Opt, extra: Partial<ScaleItem> = {}): void {
  add(target, { id, page, pageTitle: pair(pageTitle), label: pair(label), kind: extra.kind ?? "single", choices: extra.kind === "text" ? [] : choices(options), reverse: false, required: extra.required ?? true, excludeValues: extra.excludeValues, maxChoices: extra.maxChoices, showIf: extra.showIf, shuffle: extra.shuffle, gate: extra.gate, report: extra.report });
}

function writing(target: Bag, id: string, page: string, pageTitle: string, label: string, report: "words" | "staff", required = true, showIf?: ScaleItem["showIf"]): void {
  choose(target, id, page, pageTitle, label, [], { kind: "text", report, required, showIf });
}

function checks(target: Bag, id: string, page: string, pageTitle: string, label: string, labels: string[], report: "priorities" | "omit" = "omit", maxChoices?: number, showIf?: ScaleItem["showIf"], required = true): void {
  choose(target, id, page, pageTitle, label, numbered(labels), { kind: "multi", report, maxChoices, showIf, required });
}

function scene(target: Bag, id: string, page: string, pageTitle: string, label: string, labels: string[]): void {
  choose(target, id, page, pageTitle, label, numbered(labels), { shuffle: true, report: "situation" });
}

function matrix(target: Bag, spec: { id: string; page: string; pageTitle: string; panel: string; rows: string[]; options: Opt; domain: string; higher: "more_strength" | "more_support"; optional?: boolean; showIf?: ScaleItem["showIf"] }): void {
  const ids = spec.rows.map((row, index) => {
    const id = `${spec.id}_${index + 1}`;
    add(target, { id, page: spec.page, pageTitle: pair(spec.pageTitle), panel: pair(spec.panel), label: pair(row), kind: "single", choices: choices(spec.options), reverse: false, required: true, excludeValues: spec.options.some(([value]) => value === -1) ? [-1] : undefined, showIf: spec.showIf });
    return id;
  });
  target.dimensions.push({ key: spec.id, label: pair(spec.panel), items: ids, aggregation: "mean", maxMissing: maxMissingForCoverage(ids.length), prorate: false, higherMeans: spec.higher, bands: [], optional: spec.optional, domain: spec.domain });
}

function risk(target: Bag, itemId: string, values: number[], message: string): void {
  target.risks.push({ itemId, values, message: pair(message) });
}

function markExclusive(target: Bag, id: string, labels: readonly string[]): void {
  const item = target.items.find(entry => entry.id === id);
  if (!item) throw new Error(`Missing ${id}`);
  for (const label of labels) {
    const choice = item.choices.find(entry => entry.label["zh-CN"] === label);
    if (!choice) throw new Error(`Missing ${id} choice ${label}`);
    choice.exclusive = true;
  }
}

function holdAdvance(target: Bag, ids: readonly string[]): void {
  for (const id of ids) {
    const item = target.items.find(entry => entry.id === id);
    if (!item) throw new Error(`Missing ${id}`);
    item.noAutoAdvance = true;
  }
}

const NONE = "以上均没有";
const UNSURE = "不确定";
const DECLINE = "不愿回答";

function define(role: RespondentRole, id: string, title: string, description: string, built: Bag): ScaleDefinition {
  return {
    id, version: "1.0.0", title: pair(title), description: pair(description), demo: false,
    source: "2026-10 家庭、孩子与教师三方了解问卷。没有临床常模，不用于诊断。",
    rights: { digital: true, commercial: true, reference: "Operator intake, October 2026. zh-HK text is an OpenCC Hong Kong script conversion for reading, not a separately validated translation." },
    minAge: 8, maxAge: 17, regions: ["CN", "HK"], roles: [role], retakeDays: 90,
    norm: { label: pair("服务了解规则，没有临床常模"), source: "No clinical norm. Each matrix is averaged only when at least 75 percent of its answers are usable. There is no total score.", regions: ["CN", "HK"], minAge: 8, maxAge: 17, validated: false },
    items: built.items, dimensions: built.dimensions, riskRules: built.risks, bundle: "growth-triad"
  };
}

const AGES: Opt = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map(age => [age, `${age}岁`]);
const GRADES = ["小学一至三年级", "小学四至六年级", "初中", "高中", "其他"];
const YOUTH = { itemId: "c_age", anyOf: [12, 13, 14, 15, 16, 17] };

function child(): ScaleDefinition {
  const built = bag();
  choose(built, "c_assent", "begin", "开始之前", "我知道这份问卷的用途，也知道遇到安全问题时工作人员会寻求帮助", [[1, "我明白并愿意继续"], [2, "我还想先问清楚"], [0, "我不愿意填写"]], { gate: 1 });
  choose(built, "c_age", "background", "关于你", "年龄", AGES);
  choose(built, "c_grade", "background", "关于你", "目前年级", numbered(GRADES));
  choose(built, "c_company", "background", "关于你", "今天是谁在你旁边", numbered(["我独立填写，身边没有人", "工作人员只帮助解释题目", "家长在附近但没有看答案", "家长在旁边看答案或帮助选择", "其他"]));
  checks(built, "c_help", "background", "关于你", "你现在最想得到哪些帮助", ["学习更有动力", "找到适合自己的学习方法", "更能专心和完成任务", "减少压力、焦虑或难过", "睡得更好或更有精神", "和家人更好沟通", "处理同伴或学校问题", "安排课程或未来方向", "发展兴趣或能力", "我暂时不需要帮助", "其他"], "priorities", 3);
  checks(built, "c14", "safety", "先确认安全", "过去两周，你是否出现过以下情况", ["想到伤害自己", "觉得不想活了或活着没有意义", "担心自己会伤害别人或无法控制行为", "有人伤害、威胁、欺负或逼迫我做不愿意的事", "我现在没有安全的地方可以去", NONE, UNSURE, DECLINE]);
  risk(built, "c14", [1, 2, 3, 4, 5], "孩子提到了伤害自己、不想活、可能伤害别人、被人伤害，或没有安全的地方。请先联系能保护孩子的大人。如有眼前危险，请联系当地紧急服务。");
  risk(built, "c14", [7], "孩子对安全情况选择了“不确定”。请工作人员先查看，并确认孩子是否安全。如有眼前危险，请联系当地紧急服务。");
  risk(built, "c14", [8], "孩子没有回答安全情况。请工作人员先查看，不要把未回答当成没有危险。如有眼前危险，请联系当地紧急服务。");
  const safety = { itemId: "c14", anyOf: [1, 2, 3, 4, 5, 7, 8] };
  choose(built, "c15", "safety", "先确认安全", "你现在是否处于立即危险中", numbered(["是", "可能是", "不是", UNSURE, DECLINE]), { showIf: safety });
  risk(built, "c15", [1, 2], "孩子表示自己可能正处在危险中。请立即联系能提供保护的大人或当地紧急服务。");
  checks(built, "c16", "safety", "先确认安全", "你希望工作人员怎样联系或帮助你", ["现在联系我", "先联系我信任的大人", "和我一起决定下一步", "我暂时不想说，但希望有人稍后再问", "其他"], "priorities", undefined, safety, false);
  markExclusive(built, "c14", [NONE, UNSURE, DECLINE]);
  holdAdvance(built, ["c14", "c15", "c16"]);
  matrix(built, { id: "c7", page: "learning", pageTitle: "我的感受与思考", panel: "我怎样理解和调节自己的学习", domain: "cognition", higher: "more_strength", options: RESOURCE, rows: ["我知道自己已经学会了什么，还有什么没弄懂。", "遇到困难时，我会先试一种方法，而不是马上放弃。", "我会用总结、画图、复述或自我测试帮助自己学习。", "做错后，我能找一找错误是怎样发生的。", "题目变了一点，我能试着用以前学过的方法。", "我相信通过合适的方法、练习和帮助，我可以进步。"] });
  matrix(built, { id: "c8", page: "learning", pageTitle: "我的感受与思考", panel: "我的目标和执行", domain: "cognition", higher: "more_strength", options: RESOURCE, rows: ["我知道自己最近最想改善的一件学习事情。", "我能把较大的任务分成几个小步骤。", "我通常能在需要时开始做任务。", "我能大概估计完成任务需要多长时间。", "做事分心以后，我通常能重新回到任务。", "我会检查自己是否完成了计划。"] });
  matrix(built, { id: "c9", page: "relationship", pageTitle: "家里和学校的关系", panel: "我的安全感和沟通体验", domain: "connection", higher: "more_strength", options: RESOURCE, rows: ["家里至少有一个人愿意认真听我说。", "我难过、紧张或遇到困难时，知道可以找谁。", "我和家人争吵以后，通常还有机会重新沟通。", "家人会尝试了解我的想法，而不只是告诉我该怎么做。", "在学校里，我至少有一个可以信任的成人。", "我和同伴在一起时，大多数时候觉得自己是被接纳的。"] });
  matrix(built, { id: "c10", page: "relationship", pageTitle: "家里和学校的关系", panel: "我在家中得到的指导和空间", domain: "guidance", higher: "more_strength", options: RESOURCE, rows: ["家里的主要规则对我来说比较清楚。", "大人制定规则时通常会说明原因。", "与我有关的安排，我有机会表达自己的意见。", "我犯错时，大人通常会先了解发生了什么。", "我能承担一些适合我年龄的责任。", "家人会帮助我学习自己解决问题，而不是全部替我处理。"] });
  matrix(built, { id: "c11", page: "fit", pageTitle: "课程和支持", panel: "课程和活动是否适合我", domain: "curriculum", higher: "more_strength", options: RESOURCE, rows: ["现在的学习难度大体适合我的基础。", "我的时间里有学习、休息、运动和自己喜欢的活动。", "我有机会发展一项真正感兴趣的事情。", "我知道自己哪些学科或能力比较有优势。", "我参加课程或补习前，大人会听我的感受和想法。", "我对下一阶段想做什么有一个大概方向。"] });
  matrix(built, { id: "c12", page: "fit", pageTitle: "课程和支持", panel: "我在学校和周围获得的支持", domain: "community", higher: "more_strength", options: RESOURCE, rows: ["我知道遇到学习问题时可以向谁求助。", "我知道遇到同伴或安全问题时可以向谁求助。", "老师大体了解我的学习情况和需要。", "我有参加团队、运动、艺术、实践或集体活动的机会。", "我能接触到不同的人、观点和成长可能。", "当我需要帮助时，家长和学校通常能够一起想办法。"] });
  matrix(built, { id: "c13", page: "state", pageTitle: "过去两周", panel: "过去两周我的感受和状态", domain: "state", higher: "more_support", options: DISTRESS_CHILD, rows: ["我常常觉得紧张或担心，很难放松。", "我常常觉得难过、没希望或对事情没有兴趣。", "我容易生气或情绪一下子变得很强。", "我很累、没有精神，或睡眠明显不好。", "注意或冲动问题影响了学习或生活。", "我因为害怕、压力或身体不舒服而不想上学。", "我在学校被排挤、欺负或感到不安全。", "这些困难影响了我和家人或朋友的关系。"] });
  scene(built, "cs1", "scenes", "遇到这些事情时，我通常会怎样做", "一道题做了几次仍然不会时，我通常会", ["继续用同一种方法反复做", "直接放弃或去做别的事", "看看自己卡在哪里，再换一种方法或求助", "等大人发现以后帮我", "先抄下答案，以后再说", "每次情况差别很大"]);
  scene(built, "cs2", "scenes", "遇到这些事情时，我通常会怎样做", "我和家长因为学习发生争吵后，我通常会", ["继续争到底", "不再说话，也不想再谈", "先离开一下，平静后再试着说明自己的想法", "答应大人的要求，但并不打算执行", "找另一个信任的人帮助沟通", "每次情况差别很大"]);
  scene(built, "cs3", "scenes", "遇到这些事情时，我通常会怎样做", "当很多任务同时要完成时，我通常会", ["先做最容易或最喜欢的", "一直担心，但不知道从哪里开始", "列出任务并选一个最重要的小步骤开始", "等到最后再集中完成", "请大人替我安排所有步骤", "每次情况差别很大"]);
  scene(built, "cs4", "scenes", "遇到这些事情时，我通常会怎样做", "同学的评论让我很难受时，我通常会", ["马上反击", "假装没事，不告诉任何人", "先确认发生了什么，再找合适的人商量", "认为一定是自己不好", "把事情发到网上", "每次情况差别很大"]);
  scene(built, "cs5", "scenes", "遇到这些事情时，我通常会怎样做", "我不想继续一项已经参加很久的课程或活动时，我通常会", ["直接拒绝再去", "继续参加，但不告诉任何人自己的感受", "说明原因，并和大人商量试一段时间或调整方案", "故意表现不好让大人放弃", "完全听大人决定", "每次情况差别很大"]);
  writing(built, "c17", "scenes", "遇到这些事情时，我通常会怎样做", "上面哪一个情境最像你最近遇到的问题，为什么", "words", false);
  matrix(built, { id: "c18", page: "youth", pageTitle: "12 岁及以上才会看到", panel: "我的自主性和未来方向", domain: "autonomy", higher: "more_strength", options: RESOURCE, optional: true, showIf: YOUTH, rows: ["我能区分自己真正想要的目标和别人替我决定的目标。", "做重要决定时，我会考虑自己的兴趣、能力和现实条件。", "我能表达不同意见，同时听取他人的理由。", "我知道压力过大时有哪些对自己相对安全有效的应对方式。", "网络和社交媒体很少控制我的睡眠或重要任务。", "我对未来虽不完全确定，但知道下一步可以探索什么。"] });
  writing(built, "c19", "hopes", "我希望大人知道", "我觉得自己做得比较好的三件事", "words");
  writing(built, "c20", "hopes", "我希望大人知道", "我最希望家长理解的一件事", "words", false);
  writing(built, "c21", "hopes", "我希望大人知道", "我最希望老师理解的一件事", "words", false);
  writing(built, "c22", "hopes", "我希望大人知道", "如果未来一个月能有一个小变化，我希望是", "words");
  choose(built, "c23", "hopes", "我希望大人知道", "填完这份问卷后，我现在的感受", numbered(["平静或还好", "有一点不舒服，但可以继续", "很难受，希望有人和我谈谈", "不确定", "不愿回答"]));
  risk(built, "c23", [3], "孩子填完后表示很难受，希望有人谈谈。请工作人员及时查看，并让孩子知道可以找到可信的大人。");
  return define("student", "growth-child", "儿童和青少年成长体验自查", "这份问卷想了解你在学习、家里、学校和同伴中的真实体验。没有标准答案，也不会因为一次回答给你贴标签。建议 8 至 17 岁自己填写；12 岁及以上会多几题。香港繁体是便于阅读的字形转换，不是另行验证的译本。", built);
}

function parent(): ScaleDefinition {
  const built = bag();
  choose(built, "p_assent", "begin", "开始之前", "我已了解问卷用途、保密边界和非诊断性质，并同意提交", [[1, "同意并继续"], [0, "不同意"]], { gate: 1 });
  choose(built, "p_relation", "background", "家庭和这次最想解决的事", "填表人与孩子的关系", numbered(["母亲", "父亲", "祖父母或外祖父母", "其他主要照顾者"]));
  choose(built, "p_together", "background", "家庭和这次最想解决的事", "您与孩子共同生活的时间", numbered(["几乎每天", "每周4至6天", "每周1至3天", "少于每周1天", "其他"]));
  choose(built, "p_age", "background", "家庭和这次最想解决的事", "孩子年龄", AGES);
  choose(built, "p_grade", "background", "家庭和这次最想解决的事", "孩子目前年级", numbered(["学前大班", ...GRADES]));
  choose(built, "p_curriculum", "background", "家庭和这次最想解决的事", "目前课程体系", numbered(["内地课程", "DSE", "IB", "AP", "A-Level", "其他", "不适用或不确定"]));
  checks(built, "p_care", "background", "家庭和这次最想解决的事", "家庭主要照顾安排", ["父母共同照顾", "母亲为主", "父亲为主", "祖辈为主", "住校", "保姆或其他照顾者参与", "其他"]);
  checks(built, "p_changes", "background", "家庭和这次最想解决的事", "过去六个月是否发生重要变化", ["转学或升学", "搬家", "照顾者或家庭结构变化", "家庭成员患病", "亲人离世", "父母工作明显变化", "同伴或校园事件", "其他", "没有明显变化", "不愿回答"]);
  checks(built, "p_history", "background", "家庭和这次最想解决的事", "孩子曾接受哪些评估或支持", ["儿科或发育评估", "精神心理评估", "心理咨询", "学习或学业评估", "注意或执行功能评估", "语言评估", "学校支持", "家庭教育服务", "没有", "不确定"]);
  checks(built, "p_focus", "background", "家庭和这次最想解决的事", "本次最希望优先改善的方面", ["学习动力与目标", "学习方法与效率", "专注与执行功能", "情绪或心理状态", "亲子沟通", "家长自身成长", "家庭规则与协作", "课程或升学规划", "同伴与学校适应", "综合素质与独立性", "其他"], "priorities", 3);
  writing(built, "p_worry", "background", "家庭和这次最想解决的事", "请用一两句话描述当前最困扰家庭的现象", "words");
  choose(built, "p_duration", "background", "家庭和这次最想解决的事", "现象大约持续了多久", numbered(["少于1个月", "1至3个月", "4至6个月", "7至12个月", "1年以上", "不确定"]));
  checks(built, "p_support", "background", "家庭和这次最想解决的事", "希望获得哪些支持", ["综合评估与反馈", "家长一对一指导", "家长课程或团体", "儿童或青少年心理支持", "学习能力与习惯支持", "亲子共同工作", "课程或升学规划", "学校沟通", "专业医疗或心理转介", "暂时只需初访建议"]);
  const month = "请按过去三个月大多数情况下的实际表现作答";
  matrix(built, { id: "q14", page: "child", pageTitle: month, panel: "孩子的学习动力和目标调节", domain: "cognition", higher: "more_strength", options: OBSERVE, rows: ["孩子开始学习任务时通常不需要反复催促。", "孩子能说出近期学习目标或自己想改善的方面。", "孩子遇到较难任务时愿意先尝试一种方法。", "孩子相信能力可以通过练习、策略和求助逐步提高。", "孩子能分辨自己已经理解和尚未理解的内容。", "完成任务后，孩子会检查过程或结果。"] });
  matrix(built, { id: "q15", page: "child", pageTitle: month, panel: "孩子的学习策略和效率", domain: "cognition", higher: "more_strength", options: OBSERVE, rows: ["孩子会根据任务选择复述、归纳、画图或自我测试等方法。", "孩子能从错误中分析原因，而不只是改正答案。", "题目或情境变化后，孩子能尝试迁移已学方法。", "孩子能安排任务先后并估计所需时间。", "孩子遇到不懂的问题时能够适当求助。", "孩子能用笔记、错题或复习计划支持后续学习。"] });
  matrix(built, { id: "q16", page: "child", pageTitle: month, panel: "孩子的情绪和关系表现", domain: "connection", higher: "more_strength", options: OBSERVE, rows: ["孩子愿意向至少一位家人表达重要感受或困难。", "孩子与家人发生冲突后通常能够重新沟通。", "孩子能逐渐识别并说出自己的情绪。", "孩子在学校有至少一位可以信任的成人。", "孩子有相对稳定的同伴关系或归属感。", "孩子受到批评或挫折后能够在支持下恢复。"] });
  matrix(built, { id: "q17", page: "child", pageTitle: month, panel: "孩子在家庭指导下的自我管理", domain: "guidance", higher: "more_strength", options: OBSERVE, rows: ["孩子了解家中主要规则及规则背后的原因。", "孩子能参与讨论与自己有关的安排。", "孩子在提醒下能逐步完成多步骤任务。", "孩子承担与年龄相称的家务或家庭责任。", "孩子使用电子产品时有相对清晰且可执行的约定。", "家长与孩子能共同回顾计划是否有效并作调整。"] });
  matrix(built, { id: "q18", page: "child", pageTitle: month, panel: "课程与发展路径的匹配", domain: "curriculum", higher: "more_strength", options: OBSERVE, rows: ["当前学习难度与孩子的基础和状态大体匹配。", "孩子的时间安排在学业、休息、运动和兴趣之间相对平衡。", "孩子有机会发展至少一项真正感兴趣的活动。", "家庭了解孩子各学科或领域的优势和困难。", "阶段目标与孩子当前能力及长期方向基本衔接。", "报班或课程选择会参考孩子的体验、证据和实际效果。"] });
  matrix(built, { id: "q19", page: "child", pageTitle: month, panel: "学校和成长资源", domain: "community", higher: "more_strength", options: OBSERVE, rows: ["家庭与学校有稳定、双向而非只在出问题时才发生的沟通。", "家庭大体了解孩子在学校的学习、情绪和同伴表现。", "孩子知道遇到学习、同伴或安全问题时可以向谁求助。", "孩子有参与团队、运动、艺术、实践或社区活动的机会。", "家庭能够找到相对可靠的教育或心理支持渠道。", "家庭获取教育信息后能够筛选，而不是越看越混乱。"] });
  matrix(built, { id: "q20", page: "state", pageTitle: "过去四周", panel: "过去四周出现以下情况的频率", domain: "state", higher: "more_support", options: DISTRESS, rows: ["明显难以开始或完成日常学习任务。", "注意力或冲动问题明显影响家庭或学校生活。", "持续情绪低落、易怒、紧张或缺乏活力。", "睡眠、饮食或身体不适影响白天功能。", "拒绝上学、经常请假或出勤受到影响。", "同伴冲突、被孤立或遭受欺凌。", "反复咬指甲、拔头发或其他明显紧张行为。", "家庭冲突明显影响孩子的日常状态。"] });
  matrix(built, { id: "q21", page: "state", pageTitle: "过去四周", panel: "当前问题的实际影响", domain: "impact", higher: "more_support", options: IMPACT, rows: ["学习完成或成绩", "情绪和自信", "睡眠、饮食或身体状态", "亲子关系", "家庭日常生活", "上学出勤", "同伴关系"] });
  checks(built, "q22", "state", "过去四周", "过去四周是否出现以下需要及时关注的情况", ["提到伤害自己、不想活或明显绝望", "伤害他人或无法控制的激烈行为", "疑似遭受欺凌、暴力、虐待或其他安全威胁", "长时间无法正常睡眠或进食", "持续拒绝上学并明显影响出勤", "出现幻听、妄想、意识混乱或与现实明显脱节", NONE, UNSURE, DECLINE]);
  risk(built, "q22", [1, 2, 3, 4, 5, 6], "家长报告了自伤、他伤、受伤害、长时间无法睡眠或进食、持续拒绝上学，或现实感明显异常。请先确认孩子是否安全。如有眼前危险，请联系当地紧急服务。");
  risk(built, "q22", [8], "家长对需要及时关注的情况选择了“不确定”。请工作人员先确认孩子是否安全。如有眼前危险，请联系当地紧急服务。");
  risk(built, "q22", [9], "家长没有回答需要及时关注的情况。请工作人员先查看，不要把未回答当成没有危险。如有眼前危险，请联系当地紧急服务。");
  markExclusive(built, "q22", [NONE, UNSURE, DECLINE]);
  const parentSafety = { itemId: "q22", anyOf: [1, 2, 3, 4, 5, 6] };
  writing(built, "q23", "state", "过去四周", "请说明发生时间、频率、最近一次及目前是否仍在发生", "staff", true, parentSafety);
  matrix(built, { id: "q24", page: "portrait", pageTitle: "您自己通常怎样处理和了解这些事", panel: "反思和观点转换", domain: "portrait", higher: "more_strength", options: OBSERVE, rows: ["面对孩子的问题，我会先区分事实、我的解释和我的情绪。", "我能意识到同一行为可能有不止一种原因。", "孩子的说法与我不同的时候，我愿意先弄清他的视角。", "我会回顾自己的反应是否加剧了问题。", "即使已有经验，我也愿意根据新情况调整判断。", "我能容许一段时间的不确定，而不是立即下结论。", "我会把一次事件与长期模式区分开。", "我能同时看到孩子的困难和已有资源。"] });
  matrix(built, { id: "q25", page: "portrait", pageTitle: "您自己通常怎样处理和了解这些事", panel: "信息判断和认知灵活性", domain: "portrait", higher: "more_strength", options: OBSERVE, rows: ["看到教育信息时，我会关注来源、证据和适用对象。", "不同专家意见冲突时，我会比较依据，而不是只选更符合我想法的观点。", "我会区分相关关系与因果关系，避免把成绩变化归因于单一因素。", "我愿意寻找可能推翻自己原有判断的信息。", "一种方法对别人有效时，我仍会评估是否适合自己的孩子。", "我能在短期成绩与长期发展之间权衡。", "计划效果不好时，我会修正假设，而不是只增加强度。", "我能识别自己在焦虑时更容易相信绝对化建议。"] });
  matrix(built, { id: "q26", page: "portrait", pageTitle: "您自己通常怎样处理和了解这些事", panel: "家长的学习习惯和信息使用", domain: "portrait", higher: "more_strength", options: OBSERVE, rows: ["我会围绕一个明确问题有计划地学习，而不是漫无目的地刷信息。", "我能把学到的原则转化为一两个可执行的小步骤。", "我会记录尝试了什么以及发生了什么变化。", "我会在一段时间后复盘方法是否有效。", "我能从孩子、教师和专业人员等不同来源收集信息。", "遇到不理解的概念时，我会进一步核实而不是凭印象使用。", "我能持续实践一种方法，而不是频繁更换方案。", "我会根据反馈更新自己的家庭教育知识。"] });
  matrix(built, { id: "q27", page: "portrait", pageTitle: "您自己通常怎样处理和了解这些事", panel: "情绪觉察和调节", domain: "portrait", higher: "more_strength", options: OBSERVE, rows: ["冲突发生时，我能觉察自己的身体反应和情绪变化。", "我能在情绪很强时暂停，避免立即说出伤人的话。", "我能用较具体的词描述自己的情绪和需要。", "我能区分孩子的情绪与我自己的情绪。", "情绪平复后，我愿意回到问题并修复关系。", "当压力超过承受范围时，我会主动寻求支持。", "我能允许孩子表达负面情绪，而不急于让情绪消失。", "我很少把工作或生活中的负面情绪转移给孩子。"] });
  matrix(built, { id: "q28", page: "portrait", pageTitle: "您自己通常怎样处理和了解这些事", panel: "问题解决和家庭执行", domain: "portrait", higher: "more_strength", options: OBSERVE, rows: ["出现问题时，我会先把问题描述得具体、可观察。", "我会和孩子一起确定一个优先目标，而不是同时解决所有问题。", "我会分析诱因、维持因素和已有例外。", "我会提出不止一个可行方案并比较利弊。", "我会把方案拆成明确的小步骤、时间和责任人。", "我会提前讨论遇到阻力时怎么办。", "我会根据实际数据评估效果，而不只凭当下感受。", "当问题超出家庭能力范围时，我会及时寻求专业帮助。"] });
  matrix(built, { id: "q29", page: "portrait", pageTitle: "您自己通常怎样处理和了解这些事", panel: "自主支持与边界", domain: "portrait", higher: "more_strength", options: OBSERVE, rows: ["我会在必要边界内给孩子与年龄相称的选择。", "制定规则时，我会说明理由并听取孩子的意见。", "我更常反馈具体过程和策略，而不只评价分数或人格。", "孩子犯错时，我会先了解情况，再决定后果。", "我能保持稳定边界，而不是在严厉和放任之间来回变化。", "我会让孩子承担与年龄相称的自然或约定后果。", "我会尊重孩子与我不同的兴趣、节奏和发展方向。", "我能把支持孩子与替孩子承担区分开。"] });
  writing(built, "q30", "portrait", "您自己通常怎样处理和了解这些事", "过去两周，您感到教育孩子非常吃力或无力的情境有哪些？请简洁描述事件本身以及您的想法、情绪感受和事后的反思", "words");
  checks(built, "q31", "portrait", "您自己通常怎样处理和了解这些事", "目前您自己最需要哪类支持", ["理解孩子的发展特点", "管理焦虑或愤怒", "改善亲子沟通", "建立稳定规则和边界", "学习科学的学习支持方法", "改善夫妻或照顾者协作", "筛选教育信息", "制定可执行计划", "恢复个人时间和支持网络", "其他"], "priorities", 3);
  const scenes: [string, string, string[]][] = [
    ["s1", "孩子这次考试明显退步，回家后说“我已经很努力了”，您最可能先怎么做", ["要求孩子立即把错题全部重做", "先安慰并暂时不再谈这件事", "先听孩子描述准备过程和感受，再一起找一个可验证的原因", "马上联系老师或机构，请对方给出解决方案", "指出他对“努力”的理解不够，要求提高学习时长", "我通常会因当时情绪不同而采取不同做法"]],
    ["s2", "孩子写作业拖延，已经连续一周影响睡眠，您最可能采取哪一步", ["取消娱乐并全程监督，直到恢复正常", "先观察任务、时间、情绪和环境，和孩子确定一个最小调整方案", "替孩子重新安排全部任务并提醒每一步", "认为这是态度问题，强调必须自律", "暂时不管，等孩子自己承担后果", "立即报名专注力或学习方法课程"]],
    ["s3", "孩子说不想去学校，您通常首先会怎么处理", ["强调上学是必须履行的责任，要求孩子按时到校，再观察后续表现", "先同意请假休息，等孩子愿意时再谈原因", "先接纳孩子的情绪，并询问是否涉及欺凌、威胁、自伤想法、严重身体不适等安全问题", "与孩子具体梳理不想上学发生在何时、涉及哪些课程、人物或情境，并共同确定次日最小可行步骤", "先联系班主任或学校，核实出勤、学习和同伴情况，再与孩子讨论", "立即寻找心理、医疗或教育专业人员评估，并主要按照专业人员建议处理", "视当时的工作安排、情绪或孩子反应而定，处理方式不固定"]],
    ["s4", "您看到两个教育专家对手机管理给出相反建议，您通常会怎么处理", ["选择粉丝更多或表达更有说服力的一方", "选择更符合自己原有观点的一方", "比较证据、适用年龄和家庭条件，再小范围试行", "把两种建议同时使用", "继续搜索更多信息，暂时不行动", "交给另一位家长决定"]],
    ["s5", "孩子情绪激动地说“你根本不懂我”，您当时也很生气", ["立即解释自己为孩子付出了多少", "要求孩子先改变态度再谈", "先暂停并说明稍后会回来沟通，平复后再听他的具体意思", "马上道歉并答应他的要求", "不再回应，等孩子自己冷静", "请另一位家长或老师处理"]],
    ["s6", "家长双方对是否报补习班意见相反", ["由更了解学习的一方决定", "避免争论，先维持现状", "分别列出目标、证据、孩子意见和可承受成本，再共同决定", "让孩子独自决定", "先报名试试，效果不好再说", "各自按自己的方式推进"]],
    ["s7", "已经执行两周的学习计划没有明显效果", ["延长学习时间并加强监督", "认为孩子不配合，暂停计划", "核对执行情况和结果指标，修改一个关键假设后再试", "立即更换另一套完整方案", "继续原计划，至少坚持一个学期", "把问题交给机构解决"]],
    ["s8", "老师说孩子课堂注意力差，但孩子说课程太简单、自己都会", ["相信老师并要求孩子改正", "相信孩子，认为老师误解了他", "分别收集课堂任务、作业表现和不同情境的信息，再判断原因", "立即做注意力测评", "要求孩子即使会也必须表现得专注", "先不处理，观察成绩是否下降"]],
    ["s9", "孩子向您透露自己被同学排挤，并要求您不要告诉任何人", ["答应绝对保密", "立即联系对方家长质问", "先了解安全程度和孩子希望，说明涉及安全时需要寻求帮助，并共同决定下一步", "告诉孩子不要太敏感", "要求孩子自己学会处理人际关系", "直接要求学校给孩子换班"]],
    ["s10", "您最近压力很大，发现自己连续几天容易冲孩子发火", ["提醒自己控制情绪，但不做其他改变", "认为主要是孩子行为导致的", "向孩子说明并修复，同时减少一个压力源或寻求支持", "暂时减少与孩子交流", "用补偿或礼物弥补", "制定更严格规则以减少冲突"]]
  ];
  for (const [id, label, labels] of scenes) {
    scene(built, id, "scenes", "遇到这些情况时，您通常实际会怎么做", label, labels);
    writing(built, `${id}a`, "scenes", "遇到这些情况时，您通常实际会怎么做", "您这样处理时最主要的考虑是什么", "words", false);
  }
  writing(built, "q32", "close", "还想让服务团队知道的事", "您认为孩子目前最重要的三个优势是什么", "words");
  writing(built, "q33", "close", "还想让服务团队知道的事", "您认为孩子目前最需要改善的状况是什么", "words");
  writing(built, "q34", "close", "还想让服务团队知道的事", "您认为自己作为家长对孩子的影响主要体现在哪些方面", "words");
  writing(built, "q35", "close", "还想让服务团队知道的事", "您认为整个家庭系统对孩子的重要影响有哪些", "words");
  writing(built, "q36", "close", "还想让服务团队知道的事", "您认为自己作为家长目前最稳定的三个资源是什么", "words");
  writing(built, "q37", "close", "还想让服务团队知道的事", "如果未来四至六周只能出现一个小变化，您最希望是什么", "words");
  writing(built, "q38", "close", "还想让服务团队知道的事", "还有哪些重要信息希望服务团队提前知道", "words", false);
  checks(built, "q39", "close", "还想让服务团队知道的事", "您方便参加初访的方式", ["线上视频", "电话", "线下面谈", "尚未确定"]);
  writing(built, "q40", "close", "还想让服务团队知道的事", "联系方式（手机号或微信，只给工作人员，不写入给家长的报告）", "staff");
  return define("parent", "growth-parent", "家庭系统发展需求评估", "这份问卷同时看两件事：孩子在家里、学习和学校里可以观察到的表现，以及您面对信息、学习和情绪时通常怎么处理。结果用来准备沟通和支持，不给孩子做诊断，也不给家长划分等级。三方一起完成时适用于 8 至 17 岁。香港繁体是便于阅读的字形转换，不是另行验证的译本。", built);
}

function teacher(): ScaleDefinition {
  const built = bag();
  choose(built, "t_assent", "begin", "开始之前", "我已了解用途，并确认可以根据学校规定提供这些观察信息", [[1, "同意并继续"], [0, "暂不能填写"]], { gate: 1 });
  choose(built, "t_role", "background", "您的观察范围", "您的角色", numbered(["班主任", "学科教师", "年级或行政教师", "学校心理或辅导人员", "特殊教育或学习支持教师", "其他"]));
  choose(built, "t_known", "background", "您的观察范围", "接触该学生的时间", numbered(["少于1个月", "1至3个月", "4至12个月", "1年以上"]));
  choose(built, "t_hours", "background", "您的观察范围", "平均每周可直接观察学生多长时间", numbered(["少于1小时", "1至3小时", "4至8小时", "9至15小时", "15小时以上"]));
  checks(built, "t_setting", "background", "您的观察范围", "主要观察情境", ["常规课堂", "小组或项目活动", "课间或校园活动", "一对一交流", "考试", "社团或体育活动", "其他"]);
  choose(built, "t_confidence", "background", "您的观察范围", "您对本次评价的把握程度", numbered(["较低：观察有限", "中等：有一定了解", "较高：在多种情境中持续观察"]));
  checks(built, "t_focus", "background", "您的观察范围", "学校目前最关注的方面", ["学习动力", "学习方法", "注意与执行", "情绪状态", "行为规范", "同伴关系", "出勤", "课程匹配", "家校沟通", "暂无明显担忧", "其他"], "priorities", 3);
  const observed = "请只根据过去三个月您直接观察到的情况作答";
  matrix(built, { id: "t8", page: "school", pageTitle: observed, panel: "学习理解和调节", domain: "cognition", higher: "more_strength", options: OBSERVE, rows: ["学生能判断自己是否理解，并在需要时提出具体问题。", "学生会尝试不止一种策略解决学习任务。", "学生能从反馈或错误中调整方法。", "任务变化后，学生能尝试迁移已经学过的知识或方法。", "学生遇到困难时能保持适度坚持。", "学生能够检查任务过程或结果。"] });
  matrix(built, { id: "t9", page: "school", pageTitle: observed, panel: "学校关系和归属", domain: "connection", higher: "more_strength", options: OBSERVE, rows: ["学生与至少一位教师保持基本信任和沟通。", "学生在需要时能够向成人求助。", "学生能参与同伴互动并获得基本接纳。", "出现同伴矛盾后，学生能在支持下修复或继续合作。", "学生能够表达感受或需要，而不只通过退缩或激烈行为表现。", "学生在班级或学校活动中表现出一定归属感。"] });
  matrix(built, { id: "t10", page: "school", pageTitle: observed, panel: "规则理解和执行功能", domain: "guidance", higher: "more_strength", options: OBSERVE, rows: ["学生理解主要课堂规则及任务要求。", "学生能在提示下启动任务。", "学生能按顺序完成包含多个步骤的任务。", "学生能管理所需材料和作业。", "分心后，学生能在提醒下回到任务。", "学生能逐渐减少成人提醒并承担相应责任。"] });
  matrix(built, { id: "t11", page: "school", pageTitle: observed, panel: "课程和任务匹配", domain: "curriculum", higher: "more_strength", options: OBSERVE, rows: ["当前课程难度与学生的基础大体匹配。", "学生能在常规时间内完成大部分适龄任务。", "教学呈现方式能让学生理解并参与。", "学生有机会在任务中发挥自己的优势。", "反馈和支持能够帮助学生形成下一步行动。", "学生的学习负荷未明显挤压必要的休息和校园参与。"] });
  matrix(built, { id: "t12", page: "school", pageTitle: observed, panel: "学校参与和支持资源", domain: "community", higher: "more_strength", options: OBSERVE, rows: ["学生有参与小组、班级或校园活动的机会。", "学生能接触到适合其需要的学习或心理支持资源。", "相关教师之间能够共享必要且合规的信息。", "学校与家庭之间有可使用的沟通渠道。", "遇到困难时，学生知道可以联系哪些校内人员。", "现有支持能够在一段时间内持续，而不是只在危机时出现。"] });
  matrix(built, { id: "t13", page: "state", pageTitle: "过去四周在学校的困难", panel: "过去四周在学校出现以下情况的频率", domain: "state", higher: "more_support", options: DISTRESS, rows: ["明显难以开始或完成课堂任务。", "注意力、冲动或活动水平明显影响学习。", "经常逃避较难、较长或需要耐心的任务。", "情绪低落、易怒、焦虑或明显缺乏活力。", "与同伴反复冲突、被孤立或遭受欺凌。", "因身体不适、睡眠不足或疲劳影响课堂状态。", "迟到、请假、拒绝到校或提前离校。", "激烈行为、退缩或情绪反应使日常支持难以进行。"] });
  matrix(built, { id: "t14", page: "state", pageTitle: "过去四周在学校的困难", panel: "这些困难对学校功能的影响", domain: "impact", higher: "more_support", options: IMPACT, rows: ["课程参与", "任务完成和成绩", "师生沟通", "同伴关系", "出勤和校园生活"] });
  checks(built, "t15", "state", "过去四周在学校的困难", "您是否观察或获知以下需要及时处理的情况", ["学生表达自伤、自杀或明显绝望", "对他人存在明确伤害风险", "疑似遭受欺凌、暴力、虐待或其他安全威胁", "意识、言行或现实判断出现明显异常", "持续拒绝上学或出勤严重受损", NONE, UNSURE, "不便在本问卷中说明"]);
  risk(built, "t15", [1, 2, 3, 4, 5], "教师观察到自伤或绝望、伤害他人的风险、受伤害、现实判断异常，或出勤严重受损。请先按学校现有的保护流程处理，不要只等这份报告。");
  risk(built, "t15", [7], "教师对需要及时处理的情况选择了“不确定”。请先按学校现有的保护流程核实，不要只等这份报告。");
  risk(built, "t15", [8], "教师没有在问卷中说明需要及时处理的情况。请先按学校现有的保护流程核实，不要把未说明当成没有危险。");
  markExclusive(built, "t15", [NONE, UNSURE, "不便在本问卷中说明"]);
  writing(built, "t16", "state", "过去四周在学校的困难", "请记录客观事实、发生时间、频率、最近一次和已采取措施", "staff", true, { itemId: "t15", anyOf: [1, 2, 3, 4, 5] });
  scene(built, "ts1", "scenes", "学校里通常会怎样处理", "学生多次未交作业，并说“太多了，我不知道从哪开始”", ["按班规直接处理，要求补齐", "减少全部任务，避免继续增加压力", "和学生确认卡点，选择一个最小步骤并约定检查时间", "立即联系家长，交由家庭处理", "安排同伴替他说明或完成部分任务", "暂时观察，不作处理"]);
  scene(built, "ts2", "scenes", "学校里通常会怎样处理", "学生考试成绩不错，但课堂经常走神并影响同伴", ["成绩没有问题，因此不特别处理", "反复提醒遵守纪律", "收集不同任务和时段的表现，与学生讨论走神的功能并调整支持", "立即建议家长做注意力诊断", "把学生调到单独座位并长期保持", "交给班主任处理"]);
  scene(built, "ts3", "scenes", "学校里通常会怎样处理", "学生说被同学排挤，但要求教师不要告诉任何人", ["答应绝对保密", "立即当众询问相关同学", "了解安全程度，解释保密边界，并与学生共同决定合适的报告步骤", "让学生先自己解决", "立即通知全班家长", "等出现更严重事件再处理"]);
  scene(built, "ts4", "scenes", "学校里通常会怎样处理", "家长认为孩子只是“不够努力”，教师观察到明显疲劳和焦虑", ["避免分歧，只报告成绩", "直接告诉家长其判断错误", "用具体观察和功能影响沟通，同时了解家庭看到的情况并商议下一步", "立即建议停学休息", "把问题转交学校心理人员后不再参与", "提高要求以检验学生是否真的努力"]);
  scene(built, "ts5", "scenes", "学校里通常会怎样处理", "已实施两周支持方案，但学生改善不明显", ["增加原方案强度", "认为学生缺乏配合并终止支持", "核对执行、情境和结果指标，调整一个关键环节后继续观察", "立即更换全套方案", "维持不变直到学期结束", "直接要求家庭寻求校外服务"]);
  checks(built, "t17", "close", "已经做过的支持和您的建议", "学校已经尝试过哪些支持", ["调整座位或环境", "拆分任务或提供清单", "延长时间或减少任务量", "个别反馈或定期检查", "同伴支持", "情绪或心理支持", "家校沟通", "学习支持或特殊教育服务", "出勤支持", "尚未尝试", "其他"]);
  writing(built, "t18", "close", "已经做过的支持和您的建议", "哪项支持最有效，具体表现是什么", "words", false);
  writing(built, "t19", "close", "已经做过的支持和您的建议", "哪项支持效果有限，可能原因是什么", "words", false);
  writing(built, "t20", "close", "已经做过的支持和您的建议", "请描述学生最稳定的三个优势", "words");
  writing(built, "t21", "close", "已经做过的支持和您的建议", "如果未来四至六周只设一个学校目标，您建议是什么", "words");
  checks(built, "t22", "close", "已经做过的支持和您的建议", "您认为下一步需要哪些协作", ["课堂内继续观察和支持", "与学生单独沟通", "家校共同制定计划", "学习能力或执行功能评估", "学校心理支持", "校外心理或医疗评估", "课程或任务调整", "同伴或校园安全支持", "暂不需要额外支持", "其他"], "priorities");
  writing(built, "t23", "close", "已经做过的支持和您的建议", "其他需要服务团队了解的信息", "words", false);
  return define("teacher", "growth-teacher", "学生学习与身心发展观察", "请只报告您直接观察到的行为和频率，不推断家庭原因，也不做临床诊断。无法观察时请选择“不了解或不适用”。这份观察和家长、孩子的回答放在一起，给家长看一份报告。香港繁体是便于阅读的字形转换，不是另行验证的译本。", built);
}

export const childScale = child();
export const parentScale = parent();
export const teacherScale = teacher();
export const triadScales = [childScale, parentScale, teacherScale];
