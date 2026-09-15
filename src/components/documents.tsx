"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AssessmentDraftSession } from "./draft-session";
import dynamic from "next/dynamic";
import { ArrowLeft, CheckCircle, CircleNotch, DownloadSimple, FileText, ShieldCheck } from "@phosphor-icons/react";
import { api, apiUrl, errorMessage, isAdult, type Locale, type Report, type Role, type SurveyRecord } from "./api";
import { copy, formatDate } from "./copy";
import { Badge, Empty, ErrorNotice, Loading } from "./ui";
const SurveyRunner = dynamic(() => import("./survey-runner"), { ssr: false, loading: () => <div className="loading-state"><CircleNotch className="spin" aria-label="Loading" /></div> });
export function AssessmentView({ id, refreshKey, locale, role, onBack, onRefresh, openPrivacy }: { id: string; refreshKey: number; locale: Locale; role: Role; onBack: () => void; onRefresh: () => Promise<void>; openPrivacy: () => void }) {
  const t = copy(locale);
  const [loaded, setLoaded] = useState<{ record: SurveyRecord; locale: Locale } | null>(null);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const draftRef = useRef<AssessmentDraftSession | null>(null);
  const localeRef = useRef(locale);
  localeRef.current = locale;

  useEffect(() => {
    const controller = new AbortController();
    setLoaded(null);
    setError("");
    setSubmitted(false);
    async function load() {
      const existing = draftRef.current?.id === id ? draftRef.current : null;
      if (existing) await existing.prepareForReload(locale);
      if (controller.signal.aborted) return;
      const record = await api<SurveyRecord>(`/api/assessments/${encodeURIComponent(id)}`, locale, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const draft = existing || new AssessmentDraftSession(record);
      if (existing) draft.observeServer(record);
      draftRef.current = draft;
      const snapshot = draft.getSnapshot();
      setLoaded({ record: { ...record, draftAnswers: snapshot.answers, draftRevision: snapshot.revision }, locale });
    }
    void load().catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); });
    return () => controller.abort();
  }, [id, locale, attempt, refreshKey]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (draftRef.current?.getSnapshot().hasUnsavedChanges) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      const draft = draftRef.current;
      if (draft?.id === id) void draft.prepareForReload(localeRef.current);
    };
  }, [id]);

  const reloadLatest = useCallback(async () => {
    const draft = draftRef.current;
    await draft?.discardAfterConflict();
    if (draftRef.current === draft) draftRef.current = null;
    setAttempt(value => value + 1);
  }, []);
  const record = loaded?.record;
  const draft = draftRef.current;
  return <>
    <button className="text-link back-link" onClick={onBack}><ArrowLeft />{t("assessments")}</button>
    {error ? <ErrorNotice locale={locale} message={error} onRetry={() => setAttempt(value => value + 1)} /> : !record || !loaded || !draft ? <Loading locale={locale} /> : <>
      <div className="page-title"><div><span className="eyebrow">{t("questionnaire")} / {record.childName}</span><h1>{record.scaleTitle}</h1><p>{record.description}</p></div>{record.demo && <Badge tone="peach">{t("demoScale")}</Badge>}</div>
      {submitted || (record.status !== "pending" && !draft.getSnapshot().conflict) ? <div className="panel submitted-panel"><Empty title={t("submitted")} text={t("submittedNote")} icon={<CheckCircle size={44} weight="duotone" />} />{isAdult(role) && <p className="muted centered">{t("automaticNote")}</p>}<div className="centered"><button className="button secondary" onClick={onBack}>{t("back")}</button></div></div> : <>
        <p className="info-strip"><ShieldCheck />{t("answerNotice")}</p>
        <SurveyRunner key={`${id}:${loaded.locale}`} record={record} draft={draft} locale={loaded.locale} onReloadLatest={reloadLatest} openPrivacy={openPrivacy} onSubmitted={async () => { setSubmitted(true); await onRefresh(); }} />
      </>}
    </>}
  </>;
}
export function ReportView({ id, refreshKey, locale, onBack }: { id: string; refreshKey: number; locale: Locale; onBack: () => void }) { const t = copy(locale); const [report, setReport] = useState<(Report & { html: string; downloadUrl: string }) | null>(null); const [error, setError] = useState(""); const [attempt, setAttempt] = useState(0); useEffect(() => { const controller = new AbortController(); setReport(null); setError(""); api<Report & { html: string; downloadUrl: string }>(`/api/reports/${encodeURIComponent(id)}`, locale, { signal: controller.signal }).then(setReport).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); }); return () => controller.abort(); }, [id, locale, attempt, refreshKey]); return <><button className="text-link back-link" onClick={onBack}><ArrowLeft />{t("reports")}</button>{error ? <ErrorNotice message={error} locale={locale} onRetry={() => setAttempt(attempt + 1)} /> : !report ? <Loading locale={locale} /> : <><div className="page-title"><div><span className="eyebrow">{report.childName} / {t("reports")}</span><h1>{report.title}</h1><p>{t("generated")} {formatDate(report.createdAt, locale, true)}</p></div><a className="button primary" href={apiUrl(`/api/reports/${encodeURIComponent(id)}/pdf`, locale)} download><DownloadSimple />{t("downloadPdf")}</a></div><div className="report-labels"><Badge tone="sage"><FileText />{t(report.generationMode === "ai" ? "aiReport" : "templateReport")}</Badge>{report.demo && <Badge tone="peach">{t("demo")}</Badge>}{report.risk && <Badge tone="danger">{t("risk")}</Badge>}<span className="muted small-text">{t("resultReference")}</span></div><iframe className="report-frame" title={t("reportDocument")} src={apiUrl(`/api/reports/${encodeURIComponent(id)}/document`, locale)} sandbox="allow-same-origin allow-downloads" /></>}</>; }
