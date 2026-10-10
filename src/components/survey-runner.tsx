"use client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Model } from "survey-core";
import { Survey } from "survey-react-ui";
import "survey-core/i18n/simplified-chinese";
import "survey-core/i18n/traditional-chinese";
import { ArrowClockwise, CheckCircle, CircleNotch, Copy, FloppyDisk, Warning } from "@phosphor-icons/react";
import { ApiError, errorMessage, type Locale, type SurveyRecord } from "./api";
import { AssessmentDraftSession } from "./draft-session";
import { copy } from "./copy";
import { bindChoiceAutoAdvance, CHOICE_AUTO_ADVANCE_MS, focusFirstUnanswered, questionProgressLabel, questionSkipsAutoAdvance } from "./survey-navigation";
import { ErrorNotice, Field } from "./ui";

export default function SurveyRunner({ record, draft, locale, onSubmitted, onReloadLatest, openPrivacy }: {
  record: SurveyRecord;
  draft: AssessmentDraftSession;
  locale: Locale;
  onSubmitted: (result: { phase: "waiting" | "reporting" | null; safetyGuidance: boolean }) => Promise<void>;
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
  const [advancePending, setAdvancePending] = useState(false);
  const [advanceHeld, setAdvanceHeld] = useState(false);
  const [advanceToken, setAdvanceToken] = useState(0);
  const advanceSeconds = String(CHOICE_AUTO_ADVANCE_MS / 1000);
  const submitRef = useRef<() => void>(() => undefined);
  const sessionLocked = snapshot.loggingOut || snapshot.authenticationPaused;
  const locked = record.consentRequired || !acknowledged || snapshot.conflict || snapshot.submitting || sessionLocked;

  const model = useMemo(() => {
    const survey = new Model(record.surveyJson);
    survey.textUpdateMode = "onTyping";
    survey.locale = locale === "zh-HK" ? "zh-tw" : "zh-cn";
    survey.showTitle = false;
    survey.showCompleteButton = false;
    survey.showCompletedPage = false;
    survey.showProgressBar = false;
    survey.showPrevButton = true;
    survey.showNavigationButtons = true;
    survey.questionsOnPageMode = "inputPerPage";
    survey.progressBarType = "questions";
    survey.pagePrevText = t("previousQuestion");
    survey.pageNextText = t("nextQuestion");
    survey.addNavigationItem({
      id: "nova-submit",
      title: t("submit"),
      visibleIndex: 35,
      disableShrink: true,
      disableHide: true,
      css: "nova-submit-item",
      innerCss: "nova-nav-submit",
      iconName: "icon-check-24x24",
      iconSize: 18,
      // A real tooltip would be read twice with the visible label. This keeps the check icon and drops the extra name.
      tooltip: "\u200b",
      action: () => { submitRef.current(); }
    });
    survey.data = draft.getSnapshot().answers;
    focusFirstUnanswered(survey);
    survey.onGetProgressText.add((_sender, options) => {
      options.text = questionProgressLabel(survey, locale === "zh-HK");
    });
    survey.mode = "display";
    survey.applyTheme({ cssVariables: { "--sjs-primary-backcolor": "#2c6058", "--sjs-primary-backcolor-dark": "#1e4c45", "--sjs-primary-backcolor-light": "#e6f0ea", "--sjs-general-backcolor": "#ffffff", "--sjs-general-backcolor-dim": "#f4f7f4", "--sjs-general-forecolor": "#243833", "--sjs-general-forecolor-light": "#526860", "--sjs-font-family": "'PingFang SC', 'PingFang HK', 'Hiragino Sans GB', 'Noto Sans SC', 'Microsoft YaHei', sans-serif", "--sjs-corner-radius": "10px", "--sjs-border-default": "#dde6e0", "--sjs-font-questiontitle-size": "16px" } });
    return survey;
  }, [record, locale, draft]);

  useEffect(() => { model.mode = locked ? "display" : "edit"; model.showProgressBar = !locked; }, [model, locked]);
  useEffect(() => {
    const action = model.navigationBar.getActionById("nova-submit");
    if (!action) return;
    action.title = t(snapshot.submitting ? "submitting" : "submit");
    action.enabled = !locked && !reloading;
  }, [model, locked, reloading, snapshot.submitting, t]);
  useEffect(() => {
    if (locked) {
      setAdvancePending(false);
      return;
    }
    const syncHold = () => setAdvanceHeld(questionSkipsAutoAdvance(model.currentSingleQuestion ?? undefined));
    syncHold();
    model.onCurrentPageChanged.add(syncHold);
    const stop = bindChoiceAutoAdvance(model, {
      onPending: () => {
        setAdvancePending(true);
        setAdvanceToken(value => value + 1);
      },
      onClear: () => setAdvancePending(false)
    });
    return () => {
      model.onCurrentPageChanged.remove(syncHold);
      stop();
    };
  }, [model, locked]);
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
    const current = draft.getSnapshot();
    if (current.loggingOut || current.authenticationPaused) return;
    if (record.consentRequired) { setError(t("consentNeeded")); return; }
    if (!acknowledged) { setError(t("acknowledgeNeeded")); return; }
    if (snapshot.conflict) return;
    if (!model.validate(true, true, undefined, true)) { setError(t("checkAnswers")); return; }
    setError("");
    model.mode = "display";
    draft.update({ ...model.data }, locale);
    try {
      const result = await draft.submit(locale);
      if (draft.getSnapshot().authenticationPaused) return;
      await onSubmitted({ phase: result.phase ?? null, safetyGuidance: result.safetyGuidance === true });
    } catch (err) {
      if (!(err instanceof ApiError && err.code === "DRAFT_CONFLICT")) setError(errorMessage(err));
    }
  }
  submitRef.current = () => { void submit(); };
  const submitError = error || (!snapshot.conflict && snapshot.status === "failed" ? snapshot.error : "") || "";

  return <div className="survey-container">
    <div className="survey-assent-panel">
      <label className="checkbox-label">
        <input type="checkbox" checked={acknowledged} onChange={event => { const value = event.target.checked; setAcknowledged(value); draft.setAcknowledged(value, locale); }} disabled={snapshot.submitting || snapshot.conflict || sessionLocked || record.consentRequired} />
        <span>{t("acknowledgeLead")}<button type="button" className="assent-link" onClick={event => { event.preventDefault(); openPrivacy(); }}>{t("privacy")}</button>{t("acknowledgeTail")}{t("answerNotice")}</span>
      </label>
      {record.consentRequired && <div className="warning-note">{t("consentNeeded")}</div>}
    </div>
    {snapshot.conflict && <section className="draft-conflict" role="alert">
      <div className="draft-conflict-heading"><Warning size={22} /><h2>{t("draftConflictTitle")}</h2></div>
      <p>{t("draftConflictNote")}</p>
      <Field label={t("localDraftAnswers")}><textarea className="code-input" value={JSON.stringify(snapshot.answers, null, 2)} readOnly rows={5} onFocus={event => event.target.select()} /></Field>
      <div className="button-group">
        <button type="button" className="button secondary" disabled={sessionLocked} onClick={async () => { const current = draft.getSnapshot(); if (current.authenticationPaused || current.loggingOut) return; try { await navigator.clipboard.writeText(JSON.stringify(current.answers, null, 2)); setCopied(true); } catch { setError(t("draftCopyFailed")); } }}><Copy />{t(copied ? "copied" : "copyDraftAnswers")}</button>
        <button type="button" className="button primary" disabled={reloading || sessionLocked} onClick={async () => { setReloading(true); try { await onReloadLatest(); } catch (err) { setError(errorMessage(err)); setReloading(false); } }}><ArrowClockwise className={reloading ? "spin" : ""} />{t("reloadLatestDraft")}</button>
      </div>
    </section>}
    <div className="survey-save-status" aria-live="polite" hidden={record.consentRequired || !acknowledged || snapshot.conflict}>
      {snapshot.status === "saved" ? <CheckCircle weight="fill" /> : snapshot.status === "saving" || snapshot.submitting ? <CircleNotch className="spin" /> : <FloppyDisk />}
      <span>{t(snapshot.status === "saved" ? "savedDraft" : snapshot.status === "saving" || snapshot.submitting ? "saving" : snapshot.status === "failed" ? "saveFailed" : "unsaved")}</span>
      {snapshot.status === "failed" && <button className="text-link" disabled={sessionLocked} onClick={() => void draft.save(locale).catch(() => undefined)}>{t("saveDraft")}</button>}
    </div>
    <p className="survey-nav-hint" aria-live="polite">{(advancePending ? t("autoAdvanceSoon") : advanceHeld ? t("safetyNoAutoAdvance") : t("autoAdvanceHint")).replaceAll("{seconds}", advanceSeconds)}</p>
    {advancePending && <div key={advanceToken} className="survey-advance-track" aria-hidden="true"><span style={{ animationDuration: `${CHOICE_AUTO_ADVANCE_MS}ms` }} /></div>}
    <fieldset className="survey-questions" disabled={locked}><Survey model={model} /></fieldset>
    {submitError && <div className="survey-submit-panel"><ErrorNotice locale={locale} message={submitError} /></div>}
  </div>;
}
