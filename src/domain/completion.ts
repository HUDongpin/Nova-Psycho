import type { ScaleDefinition, TextPair } from "./types";

export interface CompletionRules {
  items: Array<{
    id: string;
    kind: "single" | "multi" | "text";
    required: boolean;
    showIf?: { itemId: string; anyOf: number[] };
    excludeValues?: number[];
  }>;
  dimensions: Array<{
    key: string;
    label: TextPair;
    itemIds: string[];
    maxMissing: number;
    optional?: boolean;
  }>;
}

export type CompletionIssue =
  | { kind: "required_missing"; itemId: string }
  | {
      kind: "insufficient_coverage";
      dimensionKey: string;
      itemIds: string[];
      answered: number;
      required: number;
      total: number;
      unansweredItemIds: string[];
      excludedItemIds: string[];
    };

export function completionRules(scale: ScaleDefinition): CompletionRules {
  return {
    items: scale.items.map(item => ({
      id: item.id,
      kind: item.kind ?? "single",
      required: item.required,
      ...(item.showIf ? { showIf: { itemId: item.showIf.itemId, anyOf: [...item.showIf.anyOf] } } : {}),
      ...(item.excludeValues ? { excludeValues: [...item.excludeValues] } : {})
    })),
    dimensions: scale.dimensions.map(dimension => ({
      key: dimension.key,
      label: { ...dimension.label },
      itemIds: [...dimension.items],
      maxMissing: dimension.maxMissing,
      ...(dimension.optional === undefined ? {} : { optional: dimension.optional })
    }))
  };
}

export function completionIssues(rules: CompletionRules, answers: Record<string, unknown>): CompletionIssue[] {
  const issues: CompletionIssue[] = [];
  const items = new Map(rules.items.map(item => [item.id, item]));
  for (const item of rules.items) {
    if (!item.required) continue;
    if (item.showIf) {
      const current = answers[item.showIf.itemId];
      const values = typeof current === "number" ? [current] : Array.isArray(current) ? current : [];
      if (!item.showIf.anyOf.some(value => values.includes(value))) continue;
    }
    const value = answers[item.id];
    const answered = item.kind === "text" ? typeof value === "string" && value.trim().length > 0
      : item.kind === "multi" ? Array.isArray(value) && value.length > 0
        : typeof value === "number";
    if (!answered) issues.push({ kind: "required_missing", itemId: item.id });
  }
  for (const dimension of rules.dimensions) {
    if (dimension.optional) continue;
    const unansweredItemIds: string[] = [], excludedItemIds: string[] = [];
    for (const id of dimension.itemIds) {
      const value = answers[id];
      if (typeof value !== "number") unansweredItemIds.push(id);
      else if (items.get(id)?.excludeValues?.includes(value)) excludedItemIds.push(id);
    }
    // Coverage uses the assigned dimension, including hidden rows, just like scoring.
    const total = dimension.itemIds.length;
    const answered = total - unansweredItemIds.length - excludedItemIds.length;
    const required = Math.max(1, total - dimension.maxMissing);
    if (answered < required) issues.push({
      kind: "insufficient_coverage", dimensionKey: dimension.key, itemIds: [...dimension.itemIds],
      answered, required, total, unansweredItemIds, excludedItemIds
    });
  }
  return issues;
}
