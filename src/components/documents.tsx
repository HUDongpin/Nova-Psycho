"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AssessmentDraftSession } from "./draft-session";
import { AccountDraftStore, type DraftOwner } from "./account-drafts";
import dynamic from "next/dynamic";
import { ArrowLeft, CheckCircle, CircleNotch, DownloadSimple, FileText } from "@phosphor-icons/react";
import { api, ApiError, apiUrl, errorMessage, isAdult, type Locale, type Report, type Role, type SurveyRecord } from "./api";
import { copy, formatDate } from "./copy";
import { Badge, Empty, ErrorNotice, Loading } from "./ui";
const SurveyRunner = dynamic(() => import("./survey-runner"), { ssr: false, loading: () => <div className="loading-state"><CircleNotch className="spin" aria-label="Loading" /></div> });
export function AssessmentView({ owner, id, refreshKey, locale, role, draftSessions, reportId, onViewReport, onBack, onRefresh, openPrivacy }: { owner: DraftOwner; id: string; refreshKey: number; locale: Locale; role: Role; draftSessions: AccountDraftStore; reportId: string | null; onViewReport: (id: string) => void; onBack: () => void; onRefresh: () => Promise<void>; openPrivacy: () => void }) {
  const t = copy(locale);
  const [loaded, setLoaded] = useState<{ record: SurveyRecord; locale: Locale; token: number; epoch: number } | null>(null);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const draftRef = useRef<AssessmentDraftSession | null>(null);
  const localeRef = useRef(locale);
  const loadToken = useRef(0);
  localeRef.current = locale;

  useEffect(() => {
    const controller = new AbortController();
    setLoaded(null);
    setError("");
    setUnavailable(false);
    setSubmitted(false);
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
  }, [draftSessions, owner]);
  const record = loaded?.record;
  const draft = draftRef.current;
  const blocked = unavailable || record?.consentRequired;
  const discardBlocked = () => {
    if (!window.confirm(t("discardDraftConfirm"))) return;
    if (draft) draftSessions.discard(owner, draft.id);
    draftRef.current = null; setLoaded(null); onBack();
  };
  return <>
    <button className="text-link back-link" onClick={onBack}><ArrowLeft />{t("assessments")}</button>
    {blocked ? <section className="panel draft-access-blocked" role="alert"><p>{t(record?.consentRequired ? "consentDraftPaused" : "draftUnavailable")}</p><div className="button-group"><button className="button secondary" onClick={() => setAttempt(value => value + 1)}>{t("retry")}</button>{draft?.getSnapshot().hasUnsavedChanges && <button className="button ghost" onClick={discardBlocked}>{t("discardThisDraft")}</button>}</div></section> : error ? <ErrorNotice locale={locale} message={error} onRetry={() => setAttempt(value => value + 1)} /> : !record || !loaded || !draft ? <Loading locale={locale} /> : <>
      <div className="page-title"><div><span className="eyebrow">{t("questionnaire")} / {record.childName}</span><h1>{record.scaleTitle}</h1>{!record.demo && record.description ? <p>{record.description}</p> : null}</div>{record.demo && <Badge tone="peach">{t("demoScale")}</Badge>}</div>
      {submitted || (record.status !== "pending" && !draft.getSnapshot().conflict) ? <div className="panel submitted-panel"><Empty title={t("submitted")} text={t("submittedNote")} icon={<CheckCircle size={44} weight="regular" />} />{isAdult(role) && <p className="muted centered">{t("automaticNote")}</p>}{isAdult(role) && reportId && <p className="centered" role="status"><button className="button primary" onClick={() => onViewReport(reportId)}><FileText />{t("viewReport")}</button></p>}<div className="centered"><button className="button secondary" onClick={onBack}>{t("back")}</button></div></div> : <>
        <SurveyRunner key={`${id}:${loaded.locale}:${loaded.token}`} record={record} draft={draft} locale={loaded.locale} onReloadLatest={reloadLatest} openPrivacy={openPrivacy} onSubmitted={async () => { if (!draftSessions.isCurrent(owner, loaded.epoch)) return; setSubmitted(true); await onRefresh(); }} />
      </>}
    </>}
  </>;
}
export function ReportView({ id, refreshKey, locale, onBack }: { id: string; refreshKey: number; locale: Locale; onBack: () => void }) { const t = copy(locale); const [report, setReport] = useState<(Report & { html: string; downloadUrl: string }) | null>(null); const [error, setError] = useState(""); const [attempt, setAttempt] = useState(0); useEffect(() => { const controller = new AbortController(); setReport(null); setError(""); api<Report & { html: string; downloadUrl: string }>(`/api/reports/${encodeURIComponent(id)}`, locale, { signal: controller.signal }).then(setReport).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); }); return () => controller.abort(); }, [id, locale, attempt, refreshKey]); return <><button className="text-link back-link" onClick={onBack}><ArrowLeft />{t("reports")}</button>{error ? <ErrorNotice message={error} locale={locale} onRetry={() => setAttempt(attempt + 1)} /> : !report ? <Loading locale={locale} /> : <><div className="page-title"><div><span className="eyebrow">{report.childName} / {t("reports")}</span><h1>{report.title}</h1><p>{t("generated")} {formatDate(report.createdAt, locale, true)}</p></div><a className="button primary" href={apiUrl(`/api/reports/${encodeURIComponent(id)}/pdf`, locale)} download><DownloadSimple />{t("downloadPdf")}</a></div><div className="report-labels"><Badge tone="sage"><FileText />{t(report.generationMode === "ai" ? "aiReport" : "templateReport")}</Badge>{report.demo && <Badge tone="peach">{t("demo")}</Badge>}{report.risk && <Badge tone="danger">{t("risk")}</Badge>}<span className="muted small-text">{t("resultReference")}</span></div><iframe className="report-frame" title={t("reportDocument")} src={apiUrl(`/api/reports/${encodeURIComponent(id)}/document`, locale)} sandbox="allow-same-origin allow-downloads" /></>}</>; }
