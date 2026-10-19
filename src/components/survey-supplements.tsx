import { useId, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { Locale } from "./api";
import type { SurveySupplement } from "../domain/survey-supplements";
import type { SurveySupplementController } from "./survey-supplement-controller";

export function SupplementInput({ supplement, value, locale, disabled, readOnly, onChange }: {
  supplement: SurveySupplement;
  value: string;
  locale: Locale;
  disabled: boolean;
  readOnly: boolean;
  onChange: (value: string) => void;
}) {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  return <div className="survey-supplement" data-testid="survey-supplement" data-supplement-id={supplement.itemId}>
    <label htmlFor={inputId}>{supplement.label}</label>
    <p id={hintId}>{locale === "zh-HK" ? "選填，不計分，僅供獲授權的工作人員查看。" : "选填，不计分，仅供获授权的工作人员查看。"}</p>
    <textarea id={inputId} name={supplement.itemId} aria-required="false" aria-describedby={hintId} maxLength={supplement.maxLength} rows={3} value={value} disabled={disabled} readOnly={readOnly} onChange={event => onChange(event.target.value)} />
  </div>;
}

export function SurveySupplements({ controller, locale, locked }: { controller: SurveySupplementController; locale: Locale; locked: boolean }) {
  useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const supplement = controller.currentSupplement();
  if (!supplement) return null;
  const host = controller.hostFor(supplement.parentId);
  if (!host) return null;
  const value = controller.model.getValue(supplement.itemId);
  return createPortal(<SupplementInput key={supplement.itemId} supplement={supplement} value={typeof value === "string" ? value : ""} locale={locale} disabled={locked} readOnly={controller.model.mode !== "edit"} onChange={value => controller.write(supplement.itemId, value)} />, host);
}
