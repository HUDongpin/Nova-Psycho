"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, ArrowLeft, ArrowRight, BookOpenText, CaretRight, Check, CheckCircle, ClipboardText, DownloadSimple, FileText, HandHeart, Leaf, Plus, ShieldCheck, Trash, UserCircle, UserPlus, UsersThree, Warning } from "@phosphor-icons/react";
import { api, apiUrl, ApiError, errorMessage, isStaff, retryAssessmentReport, type Assessment, type Family, type Goal, type HealthStatus, type Locale, type OpsStatus, type RecoveryTarget, type Report, type Scale, type Workspace } from "./api";
import { firstContentStructure } from "./content-samples";
import { copy, formatDate, roleName, statusName, type CopyKey } from "./copy";
import { Badge, Empty, ErrorNotice, Field, Loading, SectionHeading, TextLink, useMutation } from "./ui";
export type Route = { page: string; id?: string };
export type OpenForm = (kind: "family" | "assignment" | "assessment" | "goal" | "consent" | "invite" | "delete" | "observation" | "scale" | "retire" | "recovery", target?: Family | Scale | RecoveryTarget) => void;
type ViewProps = { workspace: Workspace; locale: Locale; navigate: (route: Route) => void; openForm: OpenForm };

export function FamilyTable({ families, workspace, locale, navigate }: Pick<ViewProps, "workspace" | "locale" | "navigate"> & { families: Family[] }) {
  const t = copy(locale); return <div className="table-scroll"><table className="data-table family-table"><thead><tr><th>{t("family")}</th><th>{t("grade")} / {t("age")}</th><th>{t("consentStatus")}</th><th>{t("assessments")}</th><th><span className="sr-only">{t("actions")}</span></th></tr></thead><tbody>{families.map((family, i) => { const pending = workspace.assessments.filter(item => item.familyId === family.id && item.status === "pending").length; return <tr key={family.id}><td><button className="person-link" onClick={() => navigate({ page: "family", id: family.id })}><span className={`avatar avatar-${i % 3}`}>{family.childName.slice(-2)}</span><span><strong>{family.familyName}</strong><small>{family.childName}</small></span></button></td><td>{family.grade}<small className="cell-sub">{family.age} {t("years")}</small></td><td><span className={`consent-pill ${family.consent ? "yes" : "no"}`}><span />{t(family.consent ? "consented" : "noConsent")}</span></td><td>{pending > 0 ? <Badge tone="peach">{pending} {t("pendingCount")}</Badge> : <span className="muted">—</span>}</td><td><button className="icon-button" aria-label={`${t("details")} · ${family.familyName}`} onClick={() => navigate({ page: "family", id: family.id })}><CaretRight /></button></td></tr>; })}</tbody></table></div>;
}
export function AssessmentList({ assessments, locale, navigate, adult = true, compact = false, onRefresh }: { assessments: Assessment[]; locale: Locale; navigate: (route: Route) => void; adult?: boolean; compact?: boolean; workspace?: Workspace; onRefresh?: () => Promise<void> }) {
  const t = copy(locale); const m = useMutation(); const [retryId, setRetryId] = useState<string | null>(null); const [queuedNote, setQueuedNote] = useState("");
  if (!assessments.length) return <Empty title={t("noTasks")} text={t("noPendingText")} icon={<ClipboardText size={30} />} />;
  return <>
    {m.error && <ErrorNotice message={m.error} locale={locale} />}
    {queuedNote && <p className="success-notice" role="status">{queuedNote}</p>}
    <div className={`assessment-list ${compact ? "compact-list" : ""}`}>{assessments.map(item => <article key={item.id} className="assessment-row"><span className={`item-icon ${item.status !== "pending" ? "completed-icon" : ""}`}>{item.status === "pending" ? <ClipboardText size={23} weight="regular" /> : <CheckCircle size={23} weight="regular" />}</span><div className="assessment-row-copy"><div className="row-title"><h3>{item.scaleTitle}</h3><Badge tone={item.status === "pending" ? "peach" : item.status === "failed" ? "danger" : "sage"}>{!adult && item.status !== "pending" ? t("submitted") : item.phase === "waiting" ? t("triadWaiting") : statusName(item.status, locale)}</Badge></div><p>{item.childName} · {roleName(item.respondentRole, locale)} {item.respondentName}</p>{!compact && <small>{t("assignedDate")} {formatDate(item.createdAt, locale)}</small>}</div><div className="assessment-row-action">{item.status === "pending" && item.canRespond ? <button className="button secondary small" onClick={() => navigate({ page: "assessment", id: item.id })}>{t("start")}<ArrowRight size={15} /></button> : adult && item.reportId && item.status === "published" ? <button className="button secondary small" onClick={() => navigate({ page: "report", id: item.reportId! })}>{t("viewReport")}<ArrowRight size={15} /></button> : onRefresh && item.canRetryReport && item.status === "failed" ? <button type="button" className="button secondary small" disabled={m.busy} aria-busy={retryId === item.id && m.busy} aria-label={`${t("retryReport")} · ${item.scaleTitle} · ${item.childName}`} onClick={() => { if (m.busy || !onRefresh) return; setRetryId(item.id); setQueuedNote(""); void m.run(async () => { await retryAssessmentReport(item.id, locale); setQueuedNote(t("retryQueued")); await onRefresh(); }).finally(() => setRetryId(null)); }}>{retryId === item.id && m.busy ? t("retrying") : t("retryReport")}</button> : !compact && <span className="muted small-text">{t(item.phase === "waiting" ? "triadWaitingNote" : item.status === "pending" ? "pendingHelp" : !adult ? "submittedNote" : item.status === "failed" ? "reportFailed" : item.status === "published" ? "completed" : "reportQueued")}</span>}</div></article>)}</div>
  </>;
}
export function ReportCards({ reports, locale, navigate, compact = false }: { reports: Report[]; locale: Locale; navigate: (route: Route) => void; compact?: boolean }) {
  const t = copy(locale); if (!reports.length) return <Empty title={t("noReports")} text={t("noReportsText")} icon={<FileText size={30} />} />;
  return <div className={compact ? "report-list" : "report-grid"}>{reports.map(report => <article className={`report-card ${compact ? "report-card-compact" : ""}`} key={report.id}><div className="report-card-top"><span className="item-icon peach-icon"><FileText size={24} weight="regular" /></span><div><strong>{report.childName}</strong><small>{formatDate(report.createdAt, locale)}</small></div>{report.demo && <Badge tone="peach">{t("demo")}</Badge>}</div><h3>{report.title}</h3><p className="muted">{report.combined ? report.scaleTitle : `${report.scaleTitle} · ${roleName(report.respondentRole, locale)}`}</p><div className="report-card-meta"><Badge tone="sage">{t(report.generationMode === "ai" ? "aiReport" : "templateReport")}</Badge>{report.risk && <Badge tone="danger">{t("risk")}</Badge>}</div><button className="text-link" onClick={() => navigate({ page: "report", id: report.id })}>{t("viewReport")}<ArrowRight size={17} /></button></article>)}</div>;
}
export function GoalList({ goals, workspace, locale, onChange, showFamily = true }: { goals: Goal[]; workspace: Workspace; locale: Locale; onChange: () => Promise<void>; showFamily?: boolean }) {
  const t = copy(locale); const m = useMutation(); const [activeId, setActiveId] = useState<string | null>(null);
  if (!goals.length) return <Empty title={t("noGoals")} text={t("careNote")} icon={<Leaf size={30} />} />;
  return <>{m.error && <ErrorNotice message={m.error} locale={locale} />}<div className="goal-list">{goals.map(goal => <article className={`goal-row ${goal.status === "completed" ? "goal-completed" : ""}`} key={goal.id}><button className={`goal-check ${goal.status === "completed" ? "checked" : ""}`} title={t(goal.status === "completed" ? "reopen" : "markComplete")} aria-label={`${t(goal.status === "completed" ? "reopen" : "markComplete")}：${goal.title}`} aria-pressed={goal.status === "completed"} disabled={m.busy} onClick={() => { setActiveId(goal.id); void m.run(async () => { await api(`/api/goals/${encodeURIComponent(goal.id)}`, locale, { method: "PATCH", body: { status: goal.status === "completed" ? "active" : "completed" } }); await onChange(); }).finally(() => setActiveId(null)); }}>{goal.status === "completed" && <Check size={17} weight="bold" />}</button><div><h3>{goal.title}</h3><p>{goal.detail}</p><small>{showFamily && <>{workspace.families.find(family => family.id === goal.familyId)?.familyName} · </>}{activeId === goal.id && m.busy ? t("saving") : t(goal.status === "active" ? "active" : "completed")}</small></div></article>)}</div></>;
}
async function markSafetyViewed(ids: string[], locale: Locale) {
  for (const id of ids) await api(`/api/alerts/${encodeURIComponent(id)}/viewed`, locale, { method: "POST", body: {} });
}
export function SafetyAlertBanner({ alerts, locale, navigate, onRefresh }: { alerts: Workspace["alerts"]; locale: Locale; navigate: (route: Route) => void; onRefresh: () => Promise<void> }) {
  const t = copy(locale); const m = useMutation(); const [activeId, setActiveId] = useState<string | null>(null);
  if (!alerts.length) return null;
  return <div className="safety-alert" role="status"><Warning size={18} /><div className="safety-alert-body"><strong>{t("safetyAlert")}</strong>{m.error && <ErrorNotice message={m.error} locale={locale} />}<ul className="safety-alert-list">{alerts.map(alert => <li className="safety-alert-row" key={alert.id}><button type="button" className="text-link" onClick={() => navigate({ page: "family", id: alert.familyId })}>{alert.childName}</button><button type="button" className="button secondary small" disabled={m.busy} aria-label={`${t("safetyViewed")} · ${alert.childName}`} onClick={() => { if (m.busy) return; setActiveId(alert.id); void m.run(async () => { await markSafetyViewed([alert.id], locale); await onRefresh(); }).finally(() => setActiveId(null)); }}>{activeId === alert.id && m.busy ? t("saving") : t("safetyViewed")}</button></li>)}</ul></div></div>;
}
export function FamilySafetyNotice({ alerts, locale, onRefresh }: { alerts: Workspace["alerts"]; locale: Locale; onRefresh: () => Promise<void> }) {
  const t = copy(locale); const m = useMutation();
  if (!alerts.length) return null;
  return <div className="safety-alert" role="status"><Warning size={18} /><div className="safety-alert-body"><strong>{t("safetyAlert")}</strong><p>{t("safetyViewedNote")}</p>{m.error && <ErrorNotice message={m.error} locale={locale} />}<button type="button" className="button secondary small" disabled={m.busy} onClick={() => { if (m.busy) return; void m.run(async () => { await markSafetyViewed(alerts.map(alert => alert.id), locale); await onRefresh(); }); }}>{m.busy ? t("saving") : t("safetyViewed")}</button></div></div>;
}
export function Dashboard({ workspace, locale, navigate, openForm, onRefresh }: ViewProps & { onRefresh: () => Promise<void> }) {
  const t = copy(locale); const pending = workspace.assessments.filter(item => item.status === "pending"); const goals = workspace.goals.filter(item => item.status === "active"); const stats = [{ key: "familyCount" as const, count: workspace.families.length, icon: UsersThree, page: "families", tone: "sage" }, { key: "pendingCount" as const, count: pending.length, icon: ClipboardText, page: "assessments", tone: "peach" }, { key: "reportCount" as const, count: workspace.reports.length, icon: FileText, page: "reports", tone: "sand" }, { key: "goalCount" as const, count: goals.length, icon: HandHeart, page: "care", tone: "lilac" }];
  return <div className="dashboard-screen"><SafetyAlertBanner alerts={workspace.alerts} locale={locale} navigate={navigate} onRefresh={onRefresh} /><div className="page-title dashboard-title"><div className="dashboard-greeting"><div><h1>{t("welcome")}，{workspace.user.name}</h1><p>{t("welcomeSub")}</p></div><img className="dashboard-figure" src="/home-companion.jpg" alt={t("homeFigure")} /></div><button className="button primary" onClick={() => openForm("assessment")} disabled={!workspace.families.length}><Plus />{t("newAssessment")}</button></div><div className="stats-grid">{stats.map(stat => <button className="stat-card" key={stat.key} onClick={() => navigate({ page: stat.page })}><div><span className={`stat-icon ${stat.tone}`}><stat.icon size={18} weight="regular" /></span><span className="stat-label">{t(stat.key)}</span></div><strong>{stat.count}<ArrowRight size={16} /></strong></button>)}</div><p className="scope-note"><ShieldCheck size={14} />{t("scope")}</p><div className="dashboard-grid"><section className="panel family-panel"><SectionHeading title={t("yourFamilies")} subtitle={t("familySub")} action={<TextLink onClick={() => navigate({ page: "families" })}>{t("viewAll")}</TextLink>} />{workspace.families.length ? <FamilyTable families={workspace.families.slice(0,5)} workspace={workspace} locale={locale} navigate={navigate} /> : <Empty title={t("familyEmpty")} text={t("familyEmptyText")} icon={<UsersThree size={32}/>} action={isStaff(workspace.user.role) ? <button className="button secondary" onClick={() => openForm("family")}><Plus />{t("newFamily")}</button> : undefined} />}</section><section className="panel next-panel"><SectionHeading title={t("tasksTitle")} subtitle={t("tasksSub")} /><div className="task-count"><span>{pending.length}</span><ClipboardText size={45} weight="regular" /></div>{pending.length ? <AssessmentList assessments={pending.slice(0,3)} locale={locale} navigate={navigate} compact workspace={workspace} onRefresh={onRefresh} /> : <Empty title={t("noPending")} text={t("noPendingText")} />}<TextLink onClick={() => navigate({ page: "assessments" })}>{t("viewAll")}</TextLink></section><section className="panel reports-panel"><SectionHeading title={t("latestReports")} subtitle={t("automaticNote")} action={<TextLink onClick={() => navigate({ page: "reports" })}>{t("viewAll")}</TextLink>} /><ReportCards reports={workspace.reports.slice(0,2)} locale={locale} navigate={navigate} compact /></section><section className="panel care-panel"><div className="care-panel-heading"><span className="item-icon"><HandHeart size={25} weight="regular" /></span><h2>{t("everyday")}</h2></div><GoalList goals={workspace.goals.slice(0,3)} workspace={workspace} locale={locale} onChange={onRefresh} /><button className="text-link" onClick={() => openForm("goal")} disabled={!workspace.families.length}><Plus size={17} />{t("newGoal")}</button></section></div></div>;
}
export function FamiliesView({ workspace, locale, navigate, openForm }: ViewProps) { const t = copy(locale); const [query, setQuery] = useState(""); const filtered = workspace.families.filter(family => `${family.familyName} ${family.childName}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())); return <><div className="page-title"><div><h1>{t("families")}</h1><p>{t("familySub")}</p></div>{isStaff(workspace.user.role) && <button className="button primary" onClick={() => openForm("family")}><Plus />{t("newFamily")}</button>}</div><section className="panel"><div className="list-toolbar"><span>{t("all")} <strong>{workspace.families.length}</strong></span><label className="search-field"><span className="sr-only">{t("search")}</span><input type="search" placeholder={t("search")} value={query} onChange={event => setQuery(event.target.value)} /></label></div>{filtered.length ? <FamilyTable families={filtered} workspace={workspace} locale={locale} navigate={navigate} /> : <Empty title={t(query ? "noSearch" : "familyEmpty")} text={query ? undefined : t("familyEmptyText")} icon={<UsersThree size={32} />} />}</section></>; }
export function FamilyView({ family, workspace, locale, navigate, openForm, onRefresh, openPrivacy, authProvider = "local" }: ViewProps & { family: Family; onRefresh: () => Promise<void>; openPrivacy: () => void; authProvider?: "local" | "clerk" }) {
  const t = copy(locale); const staff = isStaff(workspace.user.role); const assessments = workspace.assessments.filter(item => item.familyId === family.id); const reports = workspace.reports.filter(item => item.familyId === family.id); const goals = workspace.goals.filter(item => item.familyId === family.id); const observations = workspace.observations.filter(item => item.familyId === family.id); const notes = workspace.staffNotes.filter(item => item.familyId === family.id);
  const familyAlerts = workspace.alerts.filter(alert => alert.familyId === family.id);
  return <><button className="text-link back-link" onClick={() => navigate({ page: "families" })}><ArrowLeft />{t("families")}</button><div className="page-title"><div className="family-title"><span className="avatar avatar-large avatar-0">{family.childName.slice(-2)}</span><div><span className="eyebrow">{family.childName} · {family.grade} · {family.age} {t("years")}</span><h1>{family.familyName}</h1></div></div><button className="button primary" onClick={() => openForm("assessment", family)}><Plus />{t("newAssessment")}</button></div>{staff && <FamilySafetyNotice alerts={familyAlerts} locale={locale} onRefresh={onRefresh} />}<div className="family-detail-grid"><div className="family-main"><section className="panel"><SectionHeading title={t("assessments")} action={<TextLink onClick={() => openForm("assessment", family)}>{t("newAssessment")}</TextLink>} /><AssessmentList assessments={assessments} locale={locale} navigate={navigate} workspace={workspace} onRefresh={onRefresh} /></section><section className="panel"><SectionHeading title={t("reports")} /><ReportCards reports={reports} locale={locale} navigate={navigate} compact /></section><section className="panel"><SectionHeading title={t("care")} action={<TextLink onClick={() => openForm("goal", family)}>{t("newGoal")}</TextLink>} /><GoalList goals={goals} workspace={workspace} locale={locale} onChange={onRefresh} showFamily={false} /></section>{staff && <section className="panel observation-panel"><SectionHeading title={t("observations")} subtitle={t("observationNote")} action={<TextLink onClick={() => openForm("observation", family)}>{t("addObservation")}</TextLink>} />{observations.length ? <div className="observation-list">{observations.map(item => <article key={item.id}><p>{item.body}</p><small>{item.authorName} · {formatDate(item.createdAt, locale, true)}</small></article>)}</div> : <Empty title={t("noObservations")} />}</section>}</div><aside className="family-side">{family.joinCode && <section className="panel join-panel"><SectionHeading title={t("joinCode")} /><p className="join-code">{family.joinCode}</p><p className="small-text muted">{t("joinCodeNote")}</p></section>}{staff && notes.length > 0 && <section className="panel"><SectionHeading title={t("staffOnlyNotes")} />{notes.map(note => <article key={note.label}><p><strong>{note.label}</strong></p><p>{note.value}</p></article>)}</section>}<section className="panel"><SectionHeading title={t("families")} /><dl className="detail-list"><div><dt>{t("child")}</dt><dd>{family.childName}</dd></div><div><dt>{t("birthDate")}</dt><dd>{formatDate(family.birthDate, locale)}</dd></div><div><dt>{t("grade")}</dt><dd>{family.grade}</dd></div><div><dt>{t("guardian")}</dt><dd>{family.guardianLabel}</dd></div>{staff && <div><dt>{t("staff")}</dt><dd>{family.assignedName || (family.assignedTo ? t("assignedUnavailable") : t("unassigned"))}</dd></div>}</dl>{workspace.user.role === "admin" && <button className="button secondary full-width" onClick={() => openForm("assignment", family)}>{t(family.assignedTo ? "changeAssignment" : "assignFamily")}</button>}</section><section className="panel consent-panel"><ShieldCheck size={30} weight="regular" /><h2>{t("consentStatus")}</h2><Badge tone={family.consent ? "sage" : "peach"}>{t(family.consent ? "consented" : "noConsent")}</Badge>{!family.consent && <button className="button secondary full-width" onClick={() => openForm("consent", family)}>{t("consentTitle")}</button>}<button className="text-link" onClick={openPrivacy}>{t("privacyShort")}<ArrowRight size={15}/></button></section><section className="panel"><SectionHeading title={t("authorizedMembers")} />{family.members.length ? <div className="member-list">{family.members.map(member => <div key={member.id}><UserCircle size={29} weight="regular" /><span><strong>{member.name}</strong><small>{roleName(member.role, locale)}</small></span>{workspace.user.role === "admin" && authProvider === "local" && <button className="text-link" onClick={() => openForm("recovery", { memberId: member.id, memberName: member.name })}>{t("recovery")}</button>}</div>)}</div> : <Empty title={t("noMembers")} />}{workspace.user.role === "admin" && authProvider === "clerk" && <p className="small-text muted">{t("clerkRecoveryNote")}</p>}{family.canInviteMembers && <button className="button secondary full-width" onClick={() => openForm("invite", family)}><UserPlus />{t("invite")}</button>}</section>{(workspace.user.role === "parent" || workspace.user.role === "admin") && <button className="text-link danger-text" onClick={() => openForm("delete", family)}><Trash size={17}/>{t("deleteData")}</button>}</aside></div></>;
}
export function ScalesView({ workspace, locale, openForm }: Pick<ViewProps, "workspace" | "locale" | "openForm">) { const t = copy(locale); return <><div className="page-title"><div><h1>{t("scales")}</h1><p>{t("scaleIntro")}</p></div><div className="button-group"><a className="button secondary" href={apiUrl("/api/scales/example", locale)} download><DownloadSimple />{t("downloadExample")}</a><button className="button primary" onClick={() => openForm("scale")}><Plus />{t("importScale")}</button></div></div><p className="info-strip"><ShieldCheck />{t("immutableNote")}</p>{workspace.scales.length ? <div className="scale-grid">{workspace.scales.map(scale => <article className="panel scale-card" key={scale.id}><div className="scale-heading"><span className="item-icon"><BookOpenText size={26} weight="regular" /></span><Badge tone={scale.status === "active" ? "sage" : "neutral"}>{t(scale.status === "active" ? "scaleActive" : "retired")}</Badge></div><h2>{scale.title}</h2><div className="scale-version"><span>{scale.scaleId} · v{scale.version}</span>{scale.demo && <Badge tone="peach">{t("demoScale")}</Badge>}</div>{scale.demo ? null : <p>{scale.description}</p>}<dl className="detail-list"><div><dt>{t("suitable")}</dt><dd>{scale.minAge}–{scale.maxAge} {t("years")}</dd></div><div><dt>{t("roles")}</dt><dd>{scale.roles.map(role => roleName(role, locale)).join(" / ")}</dd></div><div><dt>{t("interval")}</dt><dd>{scale.retakeDays} {t("days")}</dd></div><div><dt>{t("source")}</dt><dd>{scale.source}</dd></div><div><dt>{t("rights")}</dt><dd>{typeof scale.rights === "string" ? scale.rights : scale.rights.reference}</dd></div></dl>{scale.status === "active" && workspace.user.role === "admin" && <button className="button secondary" onClick={() => openForm("retire", scale)}>{t("retire")}</button>}{scale.status === "retired" && workspace.user.role === "admin" && <button className="button secondary" onClick={() => openForm("retire", scale)}>{t("reactivate")}</button>}</article>)}</div> : <div className="panel"><Empty title={t("noScales")} icon={<BookOpenText size={32} />} /></div>}</>; }
export function ContentView({ workspace, locale, refreshKey, onRefresh }: { workspace: Workspace; locale: Locale; refreshKey: number; onRefresh: () => Promise<void> }) {
  const t = copy(locale);
  const [kind, setKind] = useState<"advice" | "template">("advice");
  const [data, setData] = useState<{ id: string; version: string; content: unknown } | null>(null);
  const [firstVersion, setFirstVersion] = useState(false);
  const [loading, setLoading] = useState(true);
  const [json, setJson] = useState("");
  const [version, setVersion] = useState("");
  const [loadError, setLoadError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [saved, setSaved] = useState(false);
  const m = useMutation();
  const pendingSave = useRef<Promise<{ id: string }> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setData(null); setFirstVersion(false); setLoading(true); setLoadError(""); setRefreshError(""); setSaved(false); setVersion(""); m.setError("");
    const read = async () => {
      await pendingSave.current?.catch(() => undefined);
      if (controller.signal.aborted) return;
      const value = await api<{ id: string; version: string; content: unknown }>(`/api/content/${kind}`, locale, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setData(value); setJson(JSON.stringify(value.content, null, 2)); setLoading(false);
    };
    void read().catch(err => {
      if (controller.signal.aborted) return;
      if (err instanceof ApiError && err.status === 409 && err.code === "CONTENT_NOT_CONFIGURED") {
        setFirstVersion(true);
        setVersion("1.0.0");
        setJson(JSON.stringify(firstContentStructure(kind), null, 2));
      } else setLoadError(errorMessage(err));
      setLoading(false);
    });
    return () => controller.abort();
  }, [kind, locale, attempt, refreshKey]);
  const versions = workspace.contentVersions.filter(item => item.kind === kind);

  return <>
    <div className="page-title"><div><h1>{t("content")}</h1><p>{t("contentIntro")}</p></div></div>
    <div className="content-grid">
      <section className="panel">
        <div className="tabs" role="group" aria-label={t("content")}>{(["advice", "template"] as const).map(value => <button key={value} className={kind === value ? "active" : ""} aria-pressed={kind === value} onClick={() => setKind(value)} disabled={m.busy}>{t(value)}</button>)}</div>
        {loadError ? <ErrorNotice locale={locale} message={loadError} onRetry={() => setAttempt(value => value + 1)} /> : loading ? <Loading locale={locale} /> : <form className="content-form" onSubmit={event => {
          event.preventDefault(); setSaved(false); setRefreshError("");
          void m.run(async () => {
            let value: unknown;
            try { value = JSON.parse(json); } catch { throw new Error(t("validJSON")); }
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(t("validJSON"));
            const submittedVersion = version;
            const request = api<{ id: string }>(`/api/content/${kind}`, locale, { method: "POST", body: { version: submittedVersion, content: value } });
            pendingSave.current = request;
            const result = await request.finally(() => { if (pendingSave.current === request) pendingSave.current = null; });
            setData({ id: result.id, version: submittedVersion, content: value });
            setFirstVersion(false); setVersion(""); setSaved(true);
            try { await onRefresh(); } catch (err) { setRefreshError(errorMessage(err)); }
          });
        }}>
          {firstVersion && <div className="content-bootstrap"><h2>{t("firstVersionTitle")}</h2><p>{t("firstVersionNote")}</p><p>{t(kind === "advice" ? "adviceStructureHelp" : "templateStructureHelp")}</p></div>}
          {data && <div className="content-version-row"><Badge tone="sage">{t("currentVersion")} {data.version}</Badge></div>}
          <Field label={t("newVersion")}><input value={version} onChange={event => setVersion(event.target.value)} required maxLength={64} placeholder={firstVersion ? "1.0.0" : "1.1.0"} /></Field>
          <Field label={t("contentJson")}><textarea className="code-input" value={json} onChange={event => setJson(event.target.value)} required rows={19} spellCheck={false} /></Field>
          {m.error && <ErrorNotice locale={locale} message={m.error} />}
          {saved && <p className="success-notice" role="status">{t("contentSaved")}</p>}
          {refreshError && <ErrorNotice locale={locale} message={refreshError} onRetry={() => void onRefresh().then(() => setRefreshError("")).catch(err => setRefreshError(errorMessage(err)))} />}
          <button className="button primary" disabled={m.busy}>{t(m.busy ? "saving" : firstVersion ? "saveFirstVersion" : "saveVersion")}</button>
        </form>}
      </section>
      <aside className="panel version-panel"><SectionHeading title={t("versions")} />{versions.length ? <div className="version-list">{versions.map(item => <div key={item.id}><span className="version-dot" /><div><strong>{item.version}</strong><small>{formatDate(item.createdAt, locale, true)}</small></div></div>)}</div> : <Empty title={t("noVersions")} />}</aside>
    </div>
  </>;
}
interface AuditEvent { id: number; action: string; entity_id: string | null; created_at: string }
// The audit trail was being written but had no way to be read except through SQL, which
// makes it useless for the review it exists to support. The endpoint already existed.
export function AuditView({ locale, refreshKey }: { locale: Locale; refreshKey: number }) {
  const t = copy(locale); const [events, setEvents] = useState<AuditEvent[] | null>(null); const [error, setError] = useState(""); const [attempt, setAttempt] = useState(0);
  useEffect(() => { const controller = new AbortController(); setError(""); api<AuditEvent[]>("/api/audit", locale, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setEvents(value); }).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); }); return () => controller.abort(); }, [locale, attempt, refreshKey]);
  return <><div className="page-title"><div><h1>{t("audit")}</h1><p>{t("auditIntro")}</p></div></div><p className="info-strip"><ShieldCheck />{t("auditNote")}</p><section className="panel">{error ? <ErrorNotice message={error} locale={locale} onRetry={() => setAttempt(attempt + 1)} /> : !events ? <Loading locale={locale} /> : events.length ? <div className="version-list">{events.map(event => <div key={event.id}><span className="version-dot" /><div><strong>{event.action}</strong><small>{formatDate(event.created_at, locale, true)}{event.entity_id ? ` · ${t("auditEntity")} ${event.entity_id.slice(0, 8)}` : ""}</small></div></div>)}</div> : <Empty title={t("noAudit")} />}</section></>;
}

const OPS_WARNING_KEYS = {
  worker_never_started: "warn_worker_never_started",
  worker_stale: "warn_worker_stale",
  failed_jobs: "warn_failed_jobs",
  expired_leases: "warn_expired_leases",
  queue_backlog: "warn_queue_backlog",
} as const satisfies Record<string, CopyKey>;

function opsWarningLabel(code: string, t: (key: CopyKey) => string): string {
  const key = OPS_WARNING_KEYS[code as keyof typeof OPS_WARNING_KEYS];
  return key ? t(key) : code;
}

const OPS_QUEUE_STATE_LABELS = {
  idle: ["空闲", "閒置"],
  processing: ["正在生成报告", "正在產生報告"],
  backlog: ["等待处理", "等候處理"],
  failed: ["有报告生成失败", "有報告產生失敗"],
  unavailable: ["处理暂不可用", "處理暫時無法使用"],
} as const satisfies Record<OpsStatus["worker"]["state"], readonly [string, string]>;

// GET /api/ops/status already existed for operators; without a page the admin nav could not
// surface worker liveness or queue warnings.
export function OpsView({ locale }: { locale: Locale }) {
  const t = copy(locale);
  const language = locale === "zh-HK" ? 1 : 0;
  const [status, setStatus] = useState<OpsStatus | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [healthError, setHealthError] = useState("");
  const [healthBusy, setHealthBusy] = useState(false);
  const queueMode = status?.worker.mode === "queue";

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setRefreshing(true);
    api<OpsStatus>("/api/ops/status", locale, { signal: controller.signal })
      .then(setStatus)
      .catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); })
      .finally(() => { if (!controller.signal.aborted) setRefreshing(false); });
    return () => controller.abort();
  }, [locale, attempt]);

  async function runHealthProbe() {
    setHealthBusy(true);
    setHealthError("");
    try {
      setHealth(await api<HealthStatus>("/api/health", locale));
    } catch (err) {
      setHealth(null);
      setHealthError(errorMessage(err));
    } finally {
      setHealthBusy(false);
    }
  }

  return <>
    <div className="page-title">
      <div><h1>{t("ops")}</h1><p>{["查看本区域的报告任务与处理状态，仅管理员可见。", "查看本區域的報告任務與處理狀態，僅管理員可見。"][language]}</p></div>
      <button className="button secondary" type="button" disabled={refreshing} onClick={() => setAttempt(current => current + 1)}>
        <ArrowClockwise className={refreshing ? "spin" : ""} />{t("refresh")}
      </button>
    </div>
    <p className="info-strip"><ShieldCheck />{t("opsNote")}</p>
    {error ? <ErrorNotice message={error} locale={locale} onRetry={() => setAttempt(attempt + 1)} /> : !status ? <Loading locale={locale} /> : <>
      <p className="scope-note">{t("opsCheckedAt")} · {formatDate(status.checkedAt, locale, true)} · {status.region} · {status.mode}</p>
      <div className="stats-grid ops-stats">
        <div className="stat-card" aria-label={t("opsReady")}><span className="stat-label">{t("opsReady")}</span><strong>{status.jobs.ready}</strong></div>
        <div className="stat-card" aria-label={t("opsRunning")}><span className="stat-label">{t("opsRunning")}</span><strong>{status.jobs.running}</strong></div>
        <div className="stat-card" aria-label={t("opsDone")}><span className="stat-label">{t("opsDone")}</span><strong>{status.jobs.done}</strong></div>
        <div className="stat-card" aria-label={t("opsFailed")}><span className="stat-label">{t("opsFailed")}</span><strong>{status.jobs.failed}</strong></div>
      </div>
      <div className="dashboard-grid" style={{ marginTop: "1.25rem" }}>
        <section className="panel">
          <SectionHeading
            title={queueMode ? ["报告生成", "報告產生"][language] : t("opsWorker")}
            subtitle={queueMode ? ["按需处理，无待处理任务时保持空闲。", "按需處理，沒有待處理任務時保持閒置。"][language] : undefined}
            action={<Badge tone={(queueMode ? status.worker.state === "idle" || status.worker.state === "processing" : status.worker.alive) ? "sage" : "peach"}>{queueMode ? OPS_QUEUE_STATE_LABELS[status.worker.state][language] : t(status.worker.alive ? "opsWorkerAlive" : "opsWorkerDown")}</Badge>}
          />
          <dl className="detail-list">
            {!queueMode && <>
              <div><dt>{t("opsWorkerId")}</dt><dd>{status.worker.workerId ?? t("opsNone")}</dd></div>
              <div><dt>{t("opsHeartbeatAge")}</dt><dd>{status.worker.heartbeatAgeSeconds ?? t("opsNone")}</dd></div>
              <div><dt>{t("opsUptime")}</dt><dd>{status.worker.uptimeSeconds ?? t("opsNone")}</dd></div>
              <div><dt>{t("opsCycles")}</dt><dd>{status.worker.cycles ?? t("opsNone")}</dd></div>
            </>}
            <div><dt>{t("opsOldestReady")}</dt><dd>{status.oldestReadySeconds ?? t("opsNone")}</dd></div>
            <div><dt>{t("opsExpiredLeases")}</dt><dd>{status.expiredLeases}</dd></div>
          </dl>
        </section>
        <section className="panel">
          <SectionHeading title={t("opsWarnings")} />
          {status.warnings.length
            ? <ul className="ops-warning-list">{status.warnings.map(code => <li key={code}><Badge tone="peach">{code}</Badge> <span>{opsWarningLabel(code, t)}</span></li>)}</ul>
            : <p className="muted" style={{ padding: "0 24px 23px" }}>{t("opsNoWarnings")}</p>}
        </section>
      </div>
      <section className="panel" style={{ marginTop: "1.25rem" }}>
        <SectionHeading
          title={t("healthProbe")}
          subtitle={t("healthProbeNote")}
          action={
            <button className="button secondary" type="button" disabled={healthBusy} onClick={() => void runHealthProbe()}>
              {healthBusy ? t("healthChecking") : t("healthCheck")}
            </button>
          }
        />
        {healthError ? <div style={{ padding: "0 24px 23px" }}><ErrorNotice message={healthError} locale={locale} onRetry={() => void runHealthProbe()} /></div> : null}
        {health ? (
          <dl className="detail-list">
            <div><dt>{t("status")}</dt><dd><Badge tone={health.ok ? "sage" : "peach"}>{t(health.ok ? "healthOk" : "healthFail")}</Badge></dd></div>
            <div><dt>{t("healthRegion")}</dt><dd>{health.region}</dd></div>
            <div><dt>{t("healthMode")}</dt><dd>{health.mode}</dd></div>
          </dl>
        ) : !healthError ? (
          <p className="muted" style={{ padding: "0 24px 23px" }}>{t("healthProbeNote")}</p>
        ) : null}
      </section>
    </>}
  </>;
}
