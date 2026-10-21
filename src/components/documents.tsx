"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AssessmentDraftSession, type DraftSnapshot } from "./draft-session";
import { AccountDraftStore, type DraftOwner } from "./account-drafts";
import dynamic from "next/dynamic";
import { ArrowClockwise, ArrowLeft, CircleNotch, DownloadSimple, FileText } from "@phosphor-icons/react";
import { api, ApiError, apiUrl, errorMessage, isAdult, retryAssessmentReport, type Assessment, type AssessmentStatus, type Locale, type Region, type Report, type Role, type SubmissionPhase, type SurveyRecord } from "./api";
import { copy, formatDate, safetyGuidanceText } from "./copy";
import { Badge, ErrorNotice, Loading, LocaleSwitch, useMutation } from "./ui";
import { GardenIcon, GardenIllustration } from "./garden";
import { submissionDisplayState, type SubmissionDisplayState } from "./submission-presentation";
import type { GardenIconKey, GardenScene } from "../domain/garden-visuals";
import questionnaireStyles from "./questionnaire.module.css";
const emptySubscribe = () => () => undefined;
const emptySnapshot = () => null;
const SurveyRunner = dynamic(() => import("./survey-runner"), { ssr: false, loading: () => <div className="loading-state"><CircleNotch className="spin" aria-label="Loading" /></div> });
const submissionPresentation: Record<SubmissionDisplayState, { icon: GardenIconKey; scene: GardenScene; title: "submitted" | "triadWaiting" | "reportNeedsParentConsent" | "gardenReportGenerating" | "gardenReportFailed" | "gardenReportReady" | "reportPrivacyHeld"; note: "submittedNote" | "triadWaitingNote" | "reportNeedsParentConsentNote" | "reportQueued" | "reportFailed" | "gardenReportReadyNote" | "reportPrivacyRefresh" }> = {
  privacy: { icon: "shield", scene: "waiting", title: "reportPrivacyHeld", note: "reportPrivacyRefresh" },
  submitted: { icon: "check", scene: "ready", title: "submitted", note: "submittedNote" },
  waiting: { icon: "clock", scene: "waiting", title: "triadWaiting", note: "triadWaitingNote" },
  consent: { icon: "shield", scene: "waiting", title: "reportNeedsParentConsent", note: "reportNeedsParentConsentNote" },
  reporting: { icon: "book", scene: "waiting", title: "gardenReportGenerating", note: "reportQueued" },
  failed: { icon: "book", scene: "waiting", title: "gardenReportFailed", note: "reportFailed" },
  ready: { icon: "book", scene: "report", title: "gardenReportReady", note: "gardenReportReadyNote" },
};

export function SubmissionPanel({ locale, region, role, phase, status, safetyGuidance = false, reportId, reportHeld = false, privacyRefreshRequired = false, retryBusy = false, onRetry, onViewReport, onBack }: { locale: Locale; region: Region; role: Role; phase: SubmissionPhase; status?: AssessmentStatus; safetyGuidance?: boolean; reportId: string | null; reportHeld?: boolean; privacyRefreshRequired?: boolean; retryBusy?: boolean; onRetry?: () => void; onViewReport: (id: string) => void; onBack: () => void }) {
  const t = copy(locale);
  const state = submissionDisplayState({ role, phase, status, reportId, reportHeld, privacyRefreshRequired });
  const presentation = submissionPresentation[state];
  return <section className="panel submitted-panel garden-submission" data-testid="submission-state" data-state={state}>
    {safetyGuidance && <div className="safety-guidance" role="status"><strong>{t("safetyGuidanceTitle")}</strong><p>{safetyGuidanceText(region, locale)}</p></div>}
    <div className="garden-submission-content">
      <GardenIllustration scene={presentation.scene} />
      <div className="garden-submission-copy" role="status">
        {state !== "submitted" && <span className="garden-kicker"><GardenIcon kind="check" />{t("submitted")}</span>}
        <h2><GardenIcon kind={presentation.icon} />{t(presentation.title)}</h2>
        <p>{t(presentation.note)}</p>
      </div>
    </div>
    {isAdult(role) && ["submitted", "waiting", "reporting"].includes(state) && <p className="garden-submission-footnote">{t("automaticNote")}</p>}
    <div className="garden-submission-actions">
      {state === "ready" && reportId && <button className="button primary" onClick={() => onViewReport(reportId)}><FileText />{t("viewReport")}</button>}
      {state === "failed" && onRetry && <button className="button primary" disabled={retryBusy} aria-busy={retryBusy} onClick={onRetry}><ArrowClockwise className={retryBusy ? "spin" : ""} />{t(retryBusy ? "retrying" : "retryReport")}</button>}
      <button className="button secondary" onClick={onBack}>{t("back")}</button>
    </div>
  </section>;
}
export function AssessmentView({ owner, id, refreshKey, locale, region, role, draftSessions, reportId, privacyRefreshRequired = false, progress, canRetryReport = false, onViewReport, onBack, onRefresh, openPrivacy, privacyOpen = false, onLocaleChange }: { owner: DraftOwner; id: string; refreshKey: number; locale: Locale; region: Region; role: Role; draftSessions: AccountDraftStore; reportId: string | null; privacyRefreshRequired?: boolean; progress?: Pick<Assessment, "id" | "status" | "phase">; canRetryReport?: boolean; onViewReport: (id: string) => void; onBack: () => void; onRefresh: () => Promise<void>; openPrivacy: () => void; privacyOpen?: boolean; onLocaleChange?: (locale: Locale) => void }) {
  const t = copy(locale);
  const [loaded, setLoaded] = useState<{ record: SurveyRecord; locale: Locale; token: number; epoch: number } | null>(null);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [outcome, setOutcome] = useState<{ phase: SubmissionPhase; safetyGuidance: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState("");
  const leavePending = useRef(false);
  const activeView = useRef(true);
  const activeId = useRef(id);
  activeId.current = id;
  useEffect(() => { activeView.current = true; return () => { activeView.current = false; }; }, []);
  const draftRef = useRef<AssessmentDraftSession | null>(null);
  const retry = useMutation();
  const localeRef = useRef(locale);
  const loadToken = useRef(0);
  localeRef.current = locale;

  useEffect(() => {
    const controller = new AbortController();
    setLoaded(null);
    setError("");
    setUnavailable(false);
    setSubmitted(false);
    setOutcome(null);
    async function load() {
      draftRef.current = draftSessions.get(owner, id) ?? null;
      const { record, draft } = await draftSessions.load(owner, id, locale, controller.signal);
      if (controller.signal.aborted) return;
      draftRef.current = draft;
      const snapshot = draft.getSnapshot();
      setLoaded({ record: { ...record, draftAnswers: snapshot.answers, draftRevision: snapshot.revision }, locale, token: ++loadToken.current, epoch: draftSessions.epoch });
    }
    void load().catch(err => { if (!controller.signal.aborted) { setError(errorMessage(err)); setUnavailable(err instanceof ApiError && (err.status === 403 || err.status === 404)); } });
    return () => controller.abort();
  }, [id, locale, attempt, refreshKey, draftSessions, owner]);

  useEffect(() => {
    return () => {
      const draft = draftRef.current;
      if (draft?.id === id) void draft.prepareForReload(localeRef.current);
    };
  }, [id]);

  const reloadLatest = useCallback(async () => {
    const draft = draftRef.current;
    const epoch = draftSessions.epoch;
    await draft?.discardAfterConflict();
    if (!draftSessions.isCurrent(owner, epoch)) return;
    if (draft && draftSessions.get(owner, draft.id) === draft) draftSessions.discard(owner, draft.id);
    if (draftRef.current === draft) draftRef.current = null;
    setAttempt(value => value + 1);
  }, [draftSessions, owner, setAttempt]);
  const record = loaded?.record;
  const draft = draftRef.current;
  const draftSnapshot = useSyncExternalStore<DraftSnapshot | null>(draft?.subscribe ?? emptySubscribe, draft?.getSnapshot ?? emptySnapshot, draft?.getSnapshot ?? emptySnapshot);
  async function leave() {
    if (leavePending.current || draft?.getSnapshot().submitting || draft?.getSnapshot().loggingOut) return;
    leavePending.current = true; setLeaving(true); setLeaveError("");
    const epoch = draftSessions.epoch;
    const current = () => activeView.current && activeId.current === id && draftSessions.isCurrent(owner, epoch);
    try {
      if (draft?.getSnapshot().hasUnsavedChanges) {
        await draft.save(locale);
        if (draft.getSnapshot().hasUnsavedChanges) throw new Error(t("acknowledgeNeeded"));
      }
      if (current()) onBack();
    } catch (err) { if (current()) setLeaveError(errorMessage(err)); }
    finally { leavePending.current = false; if (current()) setLeaving(false); }
  }
  // Workspace refreshes advance report state without reloading a respondent's draft.
  const pipeline = progress?.id === id && progress.status !== "pending" ? progress : null;
  const instrumentBlocked = record?.status === "pending" ? record.responseBlockedReason : undefined;
  const blocked = unavailable || record?.consentRequired || instrumentBlocked;
  const discardBlocked = () => {
    if (!window.confirm(t("discardDraftConfirm"))) return;
    if (draft) draftSessions.discard(owner, draft.id);
    draftRef.current = null; setLoaded(null); onBack();
  };
  return <section className={questionnaireStyles.screen} data-testid="questionnaire-screen">
    <header className={questionnaireStyles.header}><div className={questionnaireStyles.headerInner}>
      <div className={questionnaireStyles.headerGroup}><span className={questionnaireStyles.wordmark} aria-label="TopE 心理助手">TopE</span>
        <button type="button" className={questionnaireStyles.backButton} data-testid="survey-back" disabled={leaving || draftSnapshot?.submitting || draftSnapshot?.loggingOut} onClick={() => void leave()}><ArrowLeft />{leaving ? t("saving") : t("back")}</button>
      </div>
      <div className={questionnaireStyles.headerTools}>
        {onLocaleChange && <div inert={leaving || draftSnapshot?.submitting || draftSnapshot?.loggingOut}><LocaleSwitch locale={locale} onChange={onLocaleChange} /></div>}
        <button type="button" className={questionnaireStyles.textButton} onClick={event => { event.currentTarget.focus({ preventScroll: true }); openPrivacy(); }} aria-haspopup="dialog">{locale === "zh-HK" ? "填寫須知" : "填写须知"}</button>
      </div>
    </div></header>
    <div className={questionnaireStyles.content}>
    {leaveError && <div className={questionnaireStyles.exitError}><ErrorNotice locale={locale} message={leaveError} onRetry={() => void leave()} /></div>}
    {blocked ? <section className="panel draft-access-blocked" role="alert">{instrumentBlocked && <h2>{t("instrumentUnavailable")}</h2>}<p>{t(instrumentBlocked ? instrumentBlocked === "UNVALIDATED_INSTRUMENT" ? "instrumentUnvalidated" : "instrumentDemoOnly" : record?.consentRequired ? "consentDraftPaused" : "draftUnavailable")}</p><div className="button-group"><button className="button secondary" onClick={() => setAttempt(value => value + 1)}>{t("retry")}</button>{draft?.getSnapshot().hasUnsavedChanges && <button className="button ghost" onClick={discardBlocked}>{t("discardThisDraft")}</button>}</div></section> : error ? <ErrorNotice locale={locale} message={error} onRetry={() => setAttempt(value => value + 1)} /> : !record || !loaded || !draft ? <Loading locale={locale} /> : <>
      <div className={questionnaireStyles.identityHeader}><div><h1>{record.scaleTitle}</h1><p>{t("questionnaire")} · {record.childName}</p></div>{(record.demo || record.syntheticTest) && <Badge tone="sage">{t(record.syntheticTest ? "syntheticTest" : "nonclinicalTrial")}</Badge>}</div>
      {!record.demo && record.description && <p className={questionnaireStyles.introNote}>{record.description}</p>}
      {record.demo && <p className={`warning-note ${questionnaireStyles.introNote}`} role="note">{t("trialNotice")}</p>}
      {record.syntheticTest && <p className={`warning-note ${questionnaireStyles.introNote}`} role="status">{t("syntheticTestNotice")}</p>}
      {retry.error && <ErrorNotice message={retry.error} locale={locale} />}
      {submitted || (record.status !== "pending" && !draft.getSnapshot().conflict) ? <SubmissionPanel locale={locale} region={region} role={role} phase={pipeline ? pipeline.phase ?? null : outcome?.phase ?? record.phase ?? null} status={pipeline?.status ?? record.status} safetyGuidance={outcome?.safetyGuidance ?? record.safetyGuidance === true} reportId={reportId} reportHeld={(pipeline?.status ?? record.status) === "published"} privacyRefreshRequired={privacyRefreshRequired} onViewReport={onViewReport} onBack={onBack} retryBusy={retry.busy} onRetry={canRetryReport && isAdult(role) ? () => { if (!retry.busy) void retry.run(async () => { await retryAssessmentReport(id, locale); await onRefresh(); }); } : undefined} /> : <>
        <SurveyRunner key={`${id}:${loaded.locale}:${loaded.token}`} record={record} draft={draft} locale={loaded.locale} onReloadLatest={reloadLatest} openPrivacy={openPrivacy} privacyOpen={privacyOpen} leaving={leaving} onSubmitted={async result => { if (!draftSessions.isCurrent(owner, loaded.epoch)) return; setOutcome(result); setSubmitted(true); await onRefresh(); }} />
      </>}
    </>}
    </div>
  </section>;
}
export function ReportView({ id, refreshKey, locale, onBack }: { id: string; refreshKey: number; locale: Locale; onBack: () => void }) {
  const t = copy(locale);
  const [report, setReport] = useState<(Report & { html: string; downloadUrl: string }) | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setReport(null); setError("");
    api<Report & { html: string; downloadUrl: string }>(`/api/reports/${encodeURIComponent(id)}`, locale, { signal: controller.signal }).then(setReport).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); });
    return () => controller.abort();
  }, [id, locale, attempt, refreshKey]);
  return <>
    <button className="text-link back-link garden-report-back" onClick={onBack}><ArrowLeft />{t("reports")}</button>
    {error ? <ErrorNotice message={error} locale={locale} onRetry={() => setAttempt(attempt + 1)} /> : !report ? <Loading locale={locale} /> : <>
      <div className="page-title garden-report-heading">
        <div className="garden-report-heading-copy"><GardenIcon kind="book" /><div><span className="eyebrow">{report.childName} / {t("reports")}</span><h1>{report.title}</h1><p>{t("generated")} {formatDate(report.createdAt, locale, true)}</p></div></div>
        <a className="button primary" href={apiUrl(`/api/reports/${encodeURIComponent(id)}/pdf`, locale)} download><DownloadSimple />{t("downloadPdf")}</a>
      </div>
      <div className="report-labels garden-report-labels"><Badge tone="sage"><FileText />{t(report.generationMode === "ai" ? "aiReport" : "templateReport")}</Badge>{report.demo && <Badge tone="peach">{t("nonclinicalTrial")}</Badge>}{report.risk && <Badge tone="danger">{t("risk")}</Badge>}<span className="muted small-text">{t("resultReference")}</span></div>
      <iframe className="report-frame garden-report-frame" title={t("reportDocument")} src={apiUrl(`/api/reports/${encodeURIComponent(id)}/document`, locale)} sandbox="allow-same-origin allow-downloads" />
    </>}
  </>;
}
