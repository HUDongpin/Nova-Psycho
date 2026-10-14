import type { Locale, RespondentRole, ScaleDefinition, ScaleItem } from "./types";
import { text } from "./types";

function visibleIf(item: ScaleItem): string | undefined {
  if (!item.showIf) return undefined;
  return `{${item.showIf.itemId}} anyof [${item.showIf.anyOf.join(",")}]`;
}

function element(item: ScaleItem, role: RespondentRole, locale: Locale): Record<string, unknown> {
  const title = text(role === "student" || !item.observerLabel ? item.label : item.observerLabel, locale);
  const kind = item.kind ?? "single";
  const base: Record<string, unknown> = { name: item.id, title, isRequired: item.required };
  if (item.noAutoAdvance) base.noAutoAdvance = true;
  const rule = visibleIf(item);
  if (rule) base.visibleIf = rule;
  if (kind === "text") return { ...base, type: "comment", maxLength: 2000, rows: 4 };
  const choices = item.choices.map(choice => ({ value: choice.value, text: text(choice.label, locale), ...(choice.exclusive ? { isExclusive: true } : {}) }));
  if (kind === "multi") return { ...base, type: "checkbox", choices, ...(item.maxChoices ? { maxSelectedChoices: item.maxChoices } : {}), choicesOrder: item.shuffle ? "random" : "none" };
  return { ...base, type: "radiogroup", choices, colCount: 1, choicesOrder: item.shuffle ? "random" : "none" };
}

function panels(items: ScaleItem[], role: RespondentRole, locale: Locale): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = [];
  let index = 0;
  while (index < items.length) {
    const item = items[index];
    if (!item.panel) {
      elements.push(element(item, role, locale));
      index += 1;
      continue;
    }
    const title = text(item.panel, locale);
    const grouped: Record<string, unknown>[] = [];
    while (index < items.length) {
      const next = items[index].panel;
      if (!next || text(next, locale) !== title) break;
      grouped.push(element(items[index], role, locale));
      index += 1;
    }
    elements.push({ type: "panel", title, elements: grouped });
  }
  return elements;
}

export function surveyDefinition(scale: ScaleDefinition, role: RespondentRole, locale: Locale) {
  const traditional = locale === "zh-HK";
  const pages: { name: string; title?: string; elements: Record<string, unknown>[] }[] = [];
  for (const item of scale.items) {
    const name = item.page ?? "assessment";
    const current = pages.find(page => page.name === name);
    if (current) continue;
    const grouped = scale.items.filter(candidate => (candidate.page ?? "assessment") === name);
    pages.push({ name, title: item.pageTitle ? text(item.pageTitle, locale) : undefined, elements: panels(grouped, role, locale) });
  }
  return {
    title: text(scale.title, locale),
    description: text(scale.description, locale),
    locale: traditional ? "zh-tw" : "zh-cn",
    showQuestionNumbers: "on",
    showProgressBar: "top",
    progressBarType: "questions",
    showCompletedPage: false,
    clearInvisibleValues: "onHidden",
    completeText: traditional ? "提交並生成報告" : "提交并生成报告",
    pageNextText: traditional ? "下一頁" : "下一页",
    pagePrevText: traditional ? "上一頁" : "上一页",
    pages
  };
}
