import { childScale } from "../../src/domain/triad-scales";
import type { ScaleDefinition } from "../../src/domain/types";

const SAFETY = ["c14", "c15", "c16"] as const;

// ed66f27 child instrument: c15 and c16 stay hidden unless c14 includes 1–5.
// Derived from that definition's safety contract, not from a live database.
export function childScaleAt1_0_0(): ScaleDefinition {
  const scale = structuredClone(childScale);
  scale.version = "1.0.0";
  const safetyItems = SAFETY.map(id => {
    const item = scale.items.find(entry => entry.id === id);
    if (!item) throw new Error(`Missing ${id}`);
    return item;
  });
  const rest = scale.items.filter(item => !SAFETY.includes(item.id as typeof SAFETY[number]));
  const after = rest.findIndex(item => item.id === "c13_8");
  const pageTitle = rest.find(item => item.id === "c13_1")?.pageTitle;
  if (after < 0 || !pageTitle) throw new Error("Missing the ed66f27 state page");
  const followUp = { itemId: "c14", anyOf: [1, 2, 3, 4, 5] };
  for (const item of safetyItems) {
    item.page = "state";
    item.pageTitle = pageTitle;
    delete item.noAutoAdvance;
    for (const choice of item.choices) delete choice.exclusive;
    if (item.id === "c15" || item.id === "c16") item.showIf = { ...followUp };
  }
  scale.items = [...rest.slice(0, after + 1), ...safetyItems, ...rest.slice(after + 1)];
  scale.riskRules = scale.riskRules.filter(rule => rule.itemId !== "c14" || rule.values.some(value => value >= 1 && value <= 5));
  return scale;
}
