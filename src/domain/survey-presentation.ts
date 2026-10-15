import { parentScale, parentScaleV1 } from "./triad-scales";
import { text, type Locale, type RespondentRole, type ScaleDefinition, type ScaleItem, type TextPair } from "./types";

export interface TitleEmphasis {
  itemId: string;
  expectedTitle: string;
  phrase: string;
}

const sameText = (left?: TextPair, right?: TextPair) => left === undefined || right === undefined
  ? left === right
  : left["zh-CN"] === right["zh-CN"] && left["zh-HK"] === right["zh-HK"];

function isCanonicalParentItem(scale: ScaleDefinition, role: RespondentRole, item: ScaleItem): boolean {
  if (role !== "parent" || scale.roles.length !== 1 || scale.roles[0] !== "parent") return false;
  const canonical = [parentScaleV1, parentScale].find(candidate => candidate.id === scale.id && candidate.version === scale.version);
  const original = canonical?.items.find(candidate => candidate.id === item.id);
  return !!original && item.page === original.page && (item.kind ?? "single") === (original.kind ?? "single")
    && sameText(item.label, original.label) && sameText(item.observerLabel, original.observerLabel) && sameText(item.pageTitle, original.pageTitle);
}

/** Display-only instructions, derived from the assigned version without modifying it. */
export function questionDescription(scale: ScaleDefinition, role: RespondentRole, item: ScaleItem, locale: Locale): string | undefined {
  const hk = locale === "zh-HK";
  const parts: string[] = [];
  if (isCanonicalParentItem(scale, role, item)) {
    if (item.page === "state") parts.push(hk ? "以下請回答孩子過去四周的情況。" : "以下请回答孩子过去四周的情况。");
    if (item.page === "portrait") parts.push(hk ? "以下請回答您自己的情況。" : "以下请回答您自己的情况。");
  }
  if (item.kind === "multi") parts.push(item.maxChoices
    ? hk ? `可多選，最多選 ${item.maxChoices} 項。` : `可多选，最多选 ${item.maxChoices} 项。`
    : hk ? "可多選。" : "可多选。");
  return parts.length ? parts.join(" ") : undefined;
}

/** No HTML is sent; the client can emphasize only this exact assigned title. */
export function titleEmphasis(scale: ScaleDefinition, role: RespondentRole, locale: Locale): TitleEmphasis[] {
  const item = scale.items.find(candidate => candidate.id === "q14_1");
  if (!item || !isCanonicalParentItem(scale, role, item)) return [];
  const phrase = locale === "zh-HK" ? "不需要反覆催促" : "不需要反复催促";
  const expectedTitle = text(item.label, locale);
  return expectedTitle.includes(phrase) ? [{ itemId: item.id, expectedTitle, phrase }] : [];
}
