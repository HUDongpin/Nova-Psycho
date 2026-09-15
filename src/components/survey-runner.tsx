"use client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Model } from "survey-core";
import { Survey } from "survey-react-ui";
import "survey-core/i18n/simplified-chinese";
import "survey-core/i18n/traditional-chinese";
import { ArrowClockwise, CheckCircle, CircleNotch, Copy, FloppyDisk, ShieldCheck, Warning } from "@phosphor-icons/react";
import { ApiError, errorMessage, type Locale, type SurveyRecord } from "./api";
import { AssessmentDraftSession } from "./draft-session";
import { copy } from "./copy";
import { ErrorNotice, Field } from "./ui";

export default function SurveyRunner({ record, draft, locale, onSubmitted, onReloadLatest, openPrivacy }: {
  record: SurveyRecord;
  draft: AssessmentDraftSession;
  locale: Locale;
  onSubmitted: () => Promise<void>;
  onReloadLatest: () => Promise<void>;
  openPrivacy: () => void;
}) {
  const t = copy(locale);
  const snapshot = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const [acknowledged, setAcknowledged] = useState(false);
  const acknowledgedRef = useRef(false);
  acknowledgedRef.current = acknowledged;
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [reloading, setReloading] = useState(false);
  const locked = record.consentRequired || !acknowledged || snapshot.conflict || snapshot.submitting;

  const model = useMemo(() => {
    const survey = new Model(record.surveyJson);
    survey.locale = locale === "zh-HK" ? "zh-tw" : "zh-cn";
    survey.data = draft.getSnapshot().answers;
    survey.showTitle = false;
    survey.showCompleteButton = false;
    survey.showCompletedPage = false;
    survey.showProgressBar = false;
    survey.mode = "display";
    survey.applyTheme({ cssVariables: { "--sjs-primary-backcolor": "#2c6058", "--sjs-primary-backcolor-dark": "#214d47", "--sjs-primary-backcolor-light": "#edf3ef", "--sjs-general-backcolor": "#ffffff", "--sjs-general-backcolor-dim": "#f7f8f4", "--sjs-general-forecolor": "#263e38", "--sjs-general-forecolor-light": "#687c74", "--sjs-font-family": "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'PingFang HK', 'Microsoft YaHei', sans-serif", "--sjs-corner-radius": "12px" } });
    return survey;
  }, [record, locale, draft]);

  useEffect(() => { model.mode = locked ? "display" : "edit"; model.showProgressBar = !locked; }, [model, locked]);
  useEffect(() => {
    draft.setAcknowledged(false, locale);
    const change = () => {
      if (!acknowledgedRef.current || record.consentRequired) return;
      draft.update({ ...model.data }, locale);
    };
    model.onValueChanged.add(change);
    // The shared controller owns queued writes and debounce state. A locale
    // remount must not issue an independent cleanup save with an old snapshot.
    return () => { model.onValueChanged.remove(change); };
  }, [model, draft, locale, record.consentRequired]);

  async function submit() {
    if (record.consentRequired) { setError(t("consentNeeded")); return; }
    if (!acknowledged) { setError(t("acknowledgeNeeded")); return; }
    if (snapshot.conflict) return;
    if (!model.validate(true, true, undefined, true)) { setError(t("checkAnswers")); return; }
    setError("");
    model.mode = "display";
    draft.update({ ...model.data }, locale);
    try {
      await draft.submit(locale);
      await onSubmitted();
    } catch (err) {
      if (!(err instanceof ApiError && err.code === "DRAFT_CONFLICT")) setError(errorMessage(err));
    }
  }

  return <div className="survey-container">
    <div className="survey-assent-panel">
      <button type="button" className="text-link" onClick={openPrivacy}><ShieldCheck />{t("privacy")}</button>
      <p className="small-text muted">{t("assentFirst")}</p>
      <label className="checkbox-label"><input type="checkbox" checked={acknowledged} onChange={event => { const value = event.target.checked; setAcknowledged(value); draft.setAcknowledged(value, locale); }} disabled={snapshot.submitting || snapshot.conflict || record.consentRequired} /><span>{t("acknowledge")}</span></label>
      {record.consentRequired && <div className="warning-note">{t("consentNeeded")}</div>}
    </div>
    {snapshot.conflict && <section className="draft-conflict" role="alert">
      <div className="draft-conflict-heading"><Warning size={22} /><h2>{t("draftConflictTitle")}</h2></div>
      <p>{t("draftConflictNote")}</p>
      <Field label={t("localDraftAnswers")}><textarea className="code-input" value={JSON.stringify(snapshot.answers, null, 2)} readOnly rows={5} onFocus={event => event.target.select()} /></Field>
      <div className="button-group">
        <button type="button" className="button secondary" onClick={async () => { try { await navigator.clipboard.writeText(JSON.stringify(snapshot.answers, null, 2)); setCopied(true); } catch { setError(t("draftCopyFailed")); } }}><Copy />{t(copied ? "copied" : "copyDraftAnswers")}</button>
        <button type="button" className="button primary" disabled={reloading} onClick={async () => { setReloading(true); try { await onReloadLatest(); } catch (err) { setError(errorMessage(err)); setReloading(false); } }}><ArrowClockwise className={reloading ? "spin" : ""} />{t("reloadLatestDraft")}</button>
      </div>
    </section>}
    <div className="survey-save-status" aria-live="polite" hidden={record.consentRequired || !acknowledged || snapshot.conflict}>
      {snapshot.status === "saved" ? <CheckCircle weight="fill" /> : snapshot.status === "saving" || snapshot.submitting ? <CircleNotch className="spin" /> : <FloppyDisk />}
      <span>{t(snapshot.status === "saved" ? "savedDraft" : snapshot.status === "saving" || snapshot.submitting ? "saving" : snapshot.status === "failed" ? "saveFailed" : "unsaved")}</span>
      {snapshot.status === "failed" && <button className="text-link" onClick={() => void draft.save(locale).catch(() => undefined)}>{t("saveDraft")}</button>}
    </div>
    <fieldset className="survey-questions" disabled={locked}><Survey model={model} /></fieldset>
    <div className="survey-submit-panel">
      {(error || (!snapshot.conflict && snapshot.status === "failed" && snapshot.error)) && <ErrorNotice locale={locale} message={error || snapshot.error!} />}
      <button className="button primary" disabled={locked || reloading} onClick={() => void submit()}>{snapshot.submitting ? <CircleNotch className="spin" /> : <CheckCircle />}{t(snapshot.submitting ? "submitting" : "submit")}</button>
    </div>
  </div>;
}
