import { text, type Locale, type ScaleDefinition } from "./types";

export interface SurveySupplement {
  itemId: string;
  parentId: string;
  label: string;
  anyOf: number[];
  maxLength: number;
}

/** The scale parser verifies the explicit relationship before this projection. */
export function surveySupplements(scale: ScaleDefinition, locale: Locale): SurveySupplement[] {
  return scale.items.filter(item => item.supplementFor).map(item => ({
    itemId: item.id,
    parentId: item.supplementFor!,
    label: text(item.label, locale),
    anyOf: [...item.showIf!.anyOf],
    maxLength: 2000
  }));
}
