"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise, BookOpenText, ClipboardText, ClockCounterClockwise, FileText, FlowerLotus, HandHeart, House, IconContext, List, Plus, Pulse, ShieldCheck, SignOut, SlidersHorizontal, UsersThree, X } from "@phosphor-icons/react";
import { api, ApiError, errorMessage, isAdult, isStaff, type Family, type RecoveryTarget, type Scale, type Session, type Workspace } from "./api";
import { roleName, type CopyKey } from "./copy";
import { Brand, Empty, ErrorNotice, Loading, LocaleSwitch, PrivacyModal, useLocale, useMutation } from "./ui";
import { Login } from "./login";
import { FamilyEntry } from "./family-entry";
import { useIdentityAuth } from "./localized-clerk-provider";
import { AssessmentView, ReportView } from "./documents";
import { AccountDraftStore, type DraftOwner } from "./account-drafts";
import { hasGeneratingReports, nextReportRefreshDelay } from "./report-refresh";
import { AssessmentForm, ConsentForm, DeleteFamilyForm, FamilyAssignmentForm, FamilyForm, GoalForm, InvitationForm, ObservationForm, RecoveryForm, RetireScaleForm, ScaleImportForm } from "./forms";
import { AssessmentList, AuditView, ContentView, Dashboard, FamiliesView, FamilyView, GoalList, OpsView, ReportCards, ScalesView, type OpenForm, type Route } from "./workspace-views";
function readRoute(): Route { const parts = window.location.hash.replace(/^#\/?/, "").split("/"); return { page: parts[0] || "dashboard", id: parts[1] ? decodeURIComponent(parts[1]) : undefined }; }
type FormState = { kind: Parameters<OpenForm>[0]; target?: Family | Scale | RecoveryTarget } | null;
// An `in` check narrows a union of object types to an intersection rather than to a
// single member, so each target shape is discriminated with an explicit predicate.
const isRecoveryTarget = (target: Family | Scale | RecoveryTarget | undefined): target is RecoveryTarget => target !== undefined && "memberId" in target && "memberName" in target;
const isFamilyTarget = (target: Family | Scale | RecoveryTarget | undefined): target is Family => target !== undefined && "familyName" in target;
export default function NovaApp() {
  const identity = useIdentityAuth();
  const { locale, setLocale, t } = useLocale(); const [session, setSession] = useState<Session | null>(null); const [workspace, setWorkspace] = useState<Workspace | null>(null); const [error, setError] = useState(""); const [refreshing, setRefreshing] = useState(false); const [refreshKey, setRefreshKey] = useState(0); const [route, setRoute] = useState<Route>({ page: "dashboard" }); const [mobileMenu, setMobileMenu] = useState(false); const [privacy, setPrivacy] = useState(false); const [form, setForm] = useState<FormState>(null); const [status, setStatus] = useState(""); const mutation = useMutation();
  const [loggingOut, setLoggingOut] = useState(false);
  const authenticationLost = useRef<() => void>(() => undefined);
  const [draftSessions] = useState(() => new AccountDraftStore(() => authenticationLost.current()));
  const [, updateDraftNotice] = useState(0);
  const owner = useMemo<DraftOwner | null>(() => session?.user && session.user.region === session.region ? { id: session.user.id, region: session.region } : null, [session?.user?.id, session?.user?.region, session?.region]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (draftSessions.hasUnsavedChanges()) {
        event.preventDefault(); event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      draftSessions.discardAll();
    };
  }, [draftSessions]);
  const mounted = useRef(false);
  const logoutPending = useRef(false);
  const currentLocale = useRef(locale);
  currentLocale.current = locale;
  const workspaceRequest = useRef<{ controller: AbortController; promise: Promise<void> } | null>(null);
  const sessionRequest = useRef<AbortController | null>(null);
  const cancelWorkspace = useCallback(() => { workspaceRequest.current?.controller.abort(); workspaceRequest.current = null; }, []);
  const cancelRequests = useCallback(() => { cancelWorkspace(); sessionRequest.current?.abort(); sessionRequest.current = null; }, [cancelWorkspace]);
  authenticationLost.current = () => {
    draftSessions.suspend(); cancelRequests();
    if (!mounted.current) return;
    setWorkspace(null); setForm(null); setStatus(""); setRefreshing(false);
    setSession(value => value ? { ...value, user: null } : null);
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancelRequests(); }; }, [cancelRequests]);
  const navigate = useCallback((value: Route) => { window.location.hash = `${value.page}${value.id ? `/${encodeURIComponent(value.id)}` : ""}`; setRoute(value); setMobileMenu(false); setStatus(""); document.getElementById("main-content")?.focus(); window.scrollTo({ top: 0, behavior: "instant" }); }, []);
  useEffect(() => { const change = () => { try { setRoute(readRoute()); } catch { setRoute({ page: "dashboard" }); } setMobileMenu(false); }; change(); window.addEventListener("hashchange", change); return () => window.removeEventListener("hashchange", change); }, []);
  const loadWorkspace = useCallback((): Promise<void> => {
    if (!mounted.current || logoutPending.current || currentLocale.current !== locale) return Promise.resolve();
    const requestOwner = draftSessions.activeOwner;
    if (!requestOwner) return Promise.resolve();
    const epoch = draftSessions.epoch;
    if (workspaceRequest.current) return workspaceRequest.current.promise;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && currentLocale.current === locale && workspaceRequest.current?.controller === controller && draftSessions.isCurrent(requestOwner, epoch);
    const promise = api<Workspace>("/api/workspace", locale, { signal: controller.signal }).then(data => {
      if (!current()) return;
      if (data.user.id !== requestOwner.id || data.user.region !== requestOwner.region || data.region !== requestOwner.region) {
        authenticationLost.current();
        return;
      }
      setWorkspace(data); setError("");
    }).catch(err => {
      if (!current()) return;
      if (err instanceof ApiError && err.status === 401) {
        authenticationLost.current();
      }
      throw err;
    }).finally(() => { if (workspaceRequest.current?.controller === controller) workspaceRequest.current = null; });
    workspaceRequest.current = { controller, promise };
    return promise;
  }, [locale, draftSessions]);
  const loadWorkspaceAfterMutation = useCallback(async () => {
    const previous = workspaceRequest.current;
    if (previous) {
      // Even a failed pre-mutation read cannot replace the required fresh read.
      await previous.promise.catch(() => undefined);
      if (previous.controller.signal.aborted) return;
    }
    await loadWorkspace();
  }, [loadWorkspace]);
  const loadSession = useCallback(async (afterMutation = false) => {
    if (!mounted.current || logoutPending.current || currentLocale.current !== locale) return;
    sessionRequest.current?.abort();
    const controller = new AbortController();
    sessionRequest.current = controller;
    let epoch = draftSessions.epoch;
    const current = () => !controller.signal.aborted && !logoutPending.current && currentLocale.current === locale && sessionRequest.current === controller && draftSessions.epoch === epoch;
    setRefreshing(true); setError("");
    try {
      const data = await api<Session>("/api/session", locale, { signal: controller.signal });
      if (!current()) return;
      let accepted = false;
      if (data.user && data.user.region === data.region) accepted = draftSessions.activate({ id: data.user.id, region: data.region });
      else draftSessions.suspend();
      if (epoch !== draftSessions.epoch || !accepted) { cancelWorkspace(); setWorkspace(null); setForm(null); setStatus(""); }
      epoch = draftSessions.epoch;
      setSession(data);
      if (data.region === "HK" && !localStorage.getItem("nova-locale")) { setLocale("zh-HK"); return; }
      if (data.user && accepted) await (afterMutation ? loadWorkspaceAfterMutation : loadWorkspace)();
      else { cancelWorkspace(); setWorkspace(null); setForm(null); setStatus(""); }
    } catch (err) { if (current()) setError(errorMessage(err)); }
    finally { if (current()) { sessionRequest.current = null; setRefreshing(false); } }
  }, [locale, loadWorkspace, loadWorkspaceAfterMutation, cancelWorkspace, draftSessions]);
  useEffect(() => { void loadSession(); return cancelRequests; }, [loadSession, cancelRequests]);
  useEffect(() => { const refreshIdentity = () => { if (!logoutPending.current) void loadSession(); }; window.addEventListener("nova-identity-change", refreshIdentity); return () => window.removeEventListener("nova-identity-change", refreshIdentity); }, [loadSession]);
  useEffect(() => { if (session?.user && draftSessions.state !== "mismatch" && !isAdult(session.user.role) && route.page !== "assessments" && route.page !== "assessment") navigate({ page: "assessments" }); }, [session, route.page, navigate, draftSessions]);
  useEffect(() => { const target = form?.target; if (workspace && isFamilyTarget(target) && !workspace.families.some(family => family.id === target.id)) setForm(null); }, [workspace, form]);
  const generatingReport = hasGeneratingReports(workspace?.assessments ?? []);
  const refreshOwner = owner ? `${owner.region}:${owner.id}` : null;
  const reportRefreshWindow = useRef<{ owner: string; startedAt: number; attempts: number } | null>(null);
  const lastForegroundRefresh = useRef<{ owner: string; at: number } | null>(null);
  useEffect(() => {
    if (!refreshOwner) { reportRefreshWindow.current = null; lastForegroundRefresh.current = null; return; }
    if (loggingOut) return;
    const currentOwner = refreshOwner;
    if (!generatingReport) reportRefreshWindow.current = null;
    else if (reportRefreshWindow.current?.owner !== refreshOwner) reportRefreshWindow.current = { owner: refreshOwner, startedAt: Date.now(), attempts: 0 };
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visible = () => document.visibilityState === "visible";
    const clearTimer = () => { clearTimeout(timer); timer = undefined; };
    async function readWorkspace() {
      try { await loadWorkspace(); }
      catch (err) { if (!stopped) setError(errorMessage(err)); }
    }
    function schedule() {
      clearTimer();
      const budget = reportRefreshWindow.current;
      if (stopped || !visible() || !generatingReport || !budget || budget.owner !== refreshOwner) return;
      const delay = nextReportRefreshDelay(budget.startedAt, budget.attempts, Date.now());
      if (delay === null) return;
      timer = setTimeout(async () => {
        timer = undefined;
        if (stopped || !visible() || reportRefreshWindow.current !== budget) return;
        budget.attempts++;
        await readWorkspace();
        schedule();
      }, delay);
    }
    function refreshOnReturn() {
      if (stopped || !visible()) return;
      const now = Date.now(), previous = lastForegroundRefresh.current;
      if (previous?.owner === refreshOwner && now - previous.at < 1000) return;
      lastForegroundRefresh.current = { owner: currentOwner, at: now };
      clearTimer();
      void readWorkspace().then(schedule);
    }
    const visibilityChanged = () => { if (visible()) refreshOnReturn(); else clearTimer(); };
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("focus", refreshOnReturn);
    schedule();
    return () => { stopped = true; clearTimer(); document.removeEventListener("visibilitychange", visibilityChanged); window.removeEventListener("focus", refreshOnReturn); };
  }, [refreshOwner, generatingReport, loggingOut, loadWorkspace]);
  useEffect(() => { if (!mobileMenu) return; const previousFocus = document.activeElement as HTMLElement | null; const sidebar = document.querySelector<HTMLElement>(".sidebar"); const focusable = () => Array.from(sidebar?.querySelectorAll<HTMLElement>("a[href],button:not([disabled])") || []).filter(element => element.offsetParent !== null); (sidebar?.querySelector<HTMLElement>("nav a[aria-current=page]") || focusable()[0])?.focus({ preventScroll: true }); const close = (event: KeyboardEvent) => { if (event.key === "Escape") setMobileMenu(false); if (event.key === "Tab") { const items = focusable(); const first = items[0]; const last = items.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } } }; window.addEventListener("keydown", close); return () => { window.removeEventListener("keydown", close); if (sidebar?.contains(document.activeElement)) previousFocus?.focus({ preventScroll: true }); }; }, [mobileMenu]);
  async function refresh() {
    const pending = loadWorkspace();
    const request = workspaceRequest.current;
    if (!request) return;
    const current = () => mounted.current && !request.controller.signal.aborted;
    setRefreshing(true);
    try { await pending; if (current()) setRefreshKey(value => value + 1); }
    catch (err) { if (current()) setError(errorMessage(err)); }
    finally { if (current()) setRefreshing(false); }
  }
  async function finish(message?: string) { setForm(null); if (message) setStatus(message); try { await loadWorkspaceAfterMutation(); } catch (err) { setError(errorMessage(err)); } }
  async function logout() {
    if (logoutPending.current) return;
    const logoutOwner = draftSessions.activeOwner;
    if (!logoutOwner) return;
    const epoch = draftSessions.epoch;
    logoutPending.current = true; setLoggingOut(true); setError(""); cancelRequests();
    const drafts = draftSessions.values(logoutOwner);
    try {
      const saved = await Promise.allSettled(drafts.map(async draft => {
        if (draft.getSnapshot().authenticationPaused && !draft.getSnapshot().hasUnsavedChanges) return;
        if (draft.getSnapshot().authenticationPaused) await draftSessions.load(logoutOwner, draft.id, locale);
        await draft.prepareForLogout(locale);
      }));
      const failed = saved.findIndex(result => result.status === "rejected");
      if (failed !== -1) {
        const result = saved[failed];
        navigate({ page: "assessment", id: drafts[failed].id });
        throw new Error(`${t("logoutDraftFailed")} ${result.status === "rejected" ? errorMessage(result.reason) : ""}`);
      }
      await api("/api/auth/logout", locale, { method: "POST", body: {} });
      if (session?.authProvider === "clerk" && session.sessionMethod !== "test") await identity.signOut();
      if (!mounted.current || !draftSessions.isCurrent(logoutOwner, epoch)) return;
      draftSessions.clearAfterLogout(logoutOwner);
      setForm(null); setWorkspace(null); setStatus("");
      setSession(value => value ? { ...value, user: null, identityState: "signed_out", sessionMethod: undefined } : null);
      navigate({ page: "dashboard" });
    } catch (err) {
      for (const draft of drafts) draft.cancelLogout();
      throw err;
    } finally { logoutPending.current = false; if (mounted.current) { setLoggingOut(false); setRefreshing(false); } }
  }
  function returnToOwnerLogin() {
    draftSessions.suspend(); cancelRequests(); setWorkspace(null); setForm(null); setStatus("");
    setSession(value => value ? { ...value, user: null } : null);
  }
  async function discardRetainedDrafts() {
    cancelRequests(); draftSessions.discardAll(); setWorkspace(null); setForm(null); setStatus(""); updateDraftNotice(value => value + 1);
    if (owner && session?.user) {
      draftSessions.activate(owner);
      navigate({ page: isAdult(session.user.role) ? "dashboard" : "assessments" });
      await loadWorkspace();
    }
  }
  const openForm: OpenForm = (kind, target) => { setForm({ kind, target }); setStatus(""); };
  if (!session) return <IconContext.Provider value={{ size: 20, weight: "regular" }}><main className="startup-page"><Brand />{error ? <ErrorNotice message={error} locale={locale} onRetry={() => void loadSession()} /> : <Loading locale={locale} />}</main></IconContext.Provider>;
  if (!session.user || !owner || draftSessions.state === "mismatch") return <IconContext.Provider value={{ size: 20, weight: "regular" }}><Login session={session} locale={locale} setLocale={setLocale} onLogin={loadSession} recovery={draftSessions.hasUnsavedChanges() ? { mismatch: draftSessions.state === "mismatch", onReturn: returnToOwnerLogin, onDiscard: discardRetainedDrafts } : undefined} disabled={loggingOut} /></IconContext.Provider>;
  const user = session.user; const authProvider = session.authProvider; const adult = isAdult(user.role); const admin = user.role === "admin";
  const activeOwner = owner;
  const nav: { key: CopyKey; icon: typeof House; group: "main" | "admin" }[] = adult ? [{ key: "dashboard", icon: House, group: "main" }, { key: "families", icon: UsersThree, group: "main" }, { key: "assessments", icon: ClipboardText, group: "main" }, { key: "reports", icon: FileText, group: "main" }, { key: "care", icon: HandHeart, group: "main" }, ...(admin ? [{ key: "scales" as const, icon: BookOpenText, group: "admin" as const }, { key: "content" as const, icon: SlidersHorizontal, group: "admin" as const }, { key: "ops" as const, icon: Pulse, group: "admin" as const }, { key: "audit" as const, icon: ClockCounterClockwise, group: "admin" as const }] : [])] : [{ key: "assessments", icon: ClipboardText, group: "main" }];
  const activeNav = route.page === "family" ? "families" : route.page === "assessment" ? "assessments" : route.page === "report" ? "reports" : route.page;
  const family = form?.target && "familyName" in form.target ? form.target : undefined; const selectedScale = form?.target && "scaleId" in form.target ? form.target : undefined; const recoveryTarget = isRecoveryTarget(form?.target) ? form.target : undefined;
  const viewProps = workspace ? { workspace, locale, navigate, openForm } : null;
  function currentView() {
    if (!workspace || !viewProps) return error ? null : <Loading locale={locale} />;
    if ((route.page === "scales" || route.page === "content" || route.page === "audit" || route.page === "ops") && !admin) return <Empty title={t("unauthorized")} />;
    if (!adult && route.page !== "assessment" && route.page !== "assessments") return <Loading locale={locale} />;
    switch (route.page) {
      case "dashboard": return <Dashboard {...viewProps} onRefresh={loadWorkspaceAfterMutation} />;
      case "families": return <FamiliesView {...viewProps} />;
      case "family": { const record = workspace.families.find(item => item.id === route.id); return record ? <FamilyView {...viewProps} family={record} authProvider={authProvider} onRefresh={loadWorkspaceAfterMutation} openPrivacy={() => setPrivacy(true)} /> : <Empty title={t("missing")} />; }
      case "assessments": return <><div className="page-title"><div><h1>{t("assessments")}</h1><p>{t(adult ? "taskIntro" : "respondentIntro")}</p></div>{adult && <button className="button primary" disabled={!workspace.families.length} onClick={() => openForm("assessment")}><Plus />{t("newAssessment")}</button>}</div><section className="panel"><AssessmentList assessments={workspace.assessments} locale={locale} navigate={navigate} adult={adult} workspace={workspace} onRefresh={loadWorkspaceAfterMutation} /></section></>;
      case "assessment": return route.id ? <AssessmentView key={`${activeOwner.region}:${activeOwner.id}`} owner={activeOwner} id={route.id} refreshKey={refreshKey} locale={locale} role={user.role} draftSessions={draftSessions} reportId={adult ? workspace.assessments.find(item => item.id === route.id && item.status === "published")?.reportId ?? null : null} onViewReport={id => navigate({ page: "report", id })} onBack={() => navigate({ page: "assessments" })} onRefresh={loadWorkspaceAfterMutation} openPrivacy={() => setPrivacy(true)} /> : <Empty title={t("missing")} />;
      case "reports": return <><div className="page-title"><div><h1>{t("reports")}</h1><p>{t("reportIntro")}</p></div><span className="automation-label"><FlowerLotus weight="regular" />{t("automatic")}</span></div><p className="info-strip"><ShieldCheck />{t("automaticNote")}</p><ReportCards reports={workspace.reports} locale={locale} navigate={navigate} /></>;
      case "report": return route.id ? <ReportView id={route.id} refreshKey={refreshKey} locale={locale} onBack={() => navigate({ page: "reports" })} /> : <Empty title={t("missing")} />;
      case "care": return <><div className="page-title"><div><h1>{t("care")}</h1><p>{t("careNote")}</p></div><button className="button primary" onClick={() => openForm("goal")} disabled={!workspace.families.length}><Plus />{t("newGoal")}</button></div><section className="panel care-list-panel"><GoalList goals={workspace.goals} workspace={workspace} locale={locale} onChange={loadWorkspaceAfterMutation} /></section></>;
      case "scales": return <ScalesView {...viewProps} />;
      case "content": return <ContentView workspace={workspace} locale={locale} refreshKey={refreshKey} onRefresh={loadWorkspaceAfterMutation} />;
      case "ops": return <OpsView locale={locale} />;
      case "audit": return <AuditView locale={locale} refreshKey={refreshKey} />;
      default: return <Empty title={t("missing")} action={<button className="button secondary" onClick={() => navigate({ page: adult ? "dashboard" : "assessments" })}>{t("back")}</button>} />;
    }
  }
  return <IconContext.Provider value={{ size: 20, weight: "regular" }}><a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>{t("skip")}</a><div className="app-shell">{mobileMenu && <button className="mobile-backdrop" aria-label={t("closeMenu")} onClick={() => setMobileMenu(false)} />}<aside className={`sidebar ${mobileMenu ? "sidebar-open" : ""}`}><div className="sidebar-brand"><Brand /><button className="icon-button mobile-close" aria-label={t("closeMenu")} onClick={() => setMobileMenu(false)}><X /></button></div><div className="workspace-label"><span className="workspace-icon"><UsersThree size={18} weight="regular"/></span><span>{t("workspace")}</span></div><nav id="primary-navigation" aria-label={t("workspace")} inert={loggingOut}>{nav.map((item, index) => <div key={item.key}>{item.group === "admin" && nav[index - 1]?.group !== "admin" && <div className="nav-divider" />}<a href={`#${item.key}`} className={`nav-item ${activeNav === item.key ? "active" : ""}`} aria-current={activeNav === item.key ? "page" : undefined} onClick={event => { event.preventDefault(); navigate({ page: item.key }); }}><item.icon weight={activeNav === item.key ? "fill" : "regular"} /><span>{t(item.key)}</span>{item.key === "assessments" && !!workspace?.assessments.filter(item => item.status === "pending").length && <span className="nav-count">{workspace.assessments.filter(item => item.status === "pending").length}</span>}</a></div>)}</nav><div className="sidebar-bottom"><div className="sidebar-user"><span className="user-avatar">{user.name.slice(-2)}</span><div><strong>{user.name}</strong><small>{roleName(user.role, locale)}</small></div><button className="icon-button" title={t(loggingOut ? "loggingOut" : "logout")} aria-label={t(loggingOut ? "loggingOut" : "logout")} disabled={mutation.busy || loggingOut} onClick={() => void mutation.run(logout)}><SignOut /></button></div></div></aside><div className="workspace-body"><header className="topbar"><div><button className="icon-button mobile-menu" aria-label={t("openMenu")} aria-expanded={mobileMenu} aria-controls="primary-navigation" onClick={() => setMobileMenu(!mobileMenu)}><List size={24} /></button><span className="topbar-section">{nav.find(item => item.key === activeNav) ? t(activeNav as CopyKey) : t("workspace")}</span></div><div className="topbar-tools"><div inert={loggingOut}><LocaleSwitch locale={locale} onChange={setLocale} /></div><button className="icon-button refresh-button" aria-label={t("refresh")} title={t("refresh")} disabled={refreshing || loggingOut} onClick={() => void refresh()}><ArrowClockwise className={refreshing ? "spin" : ""} /></button><span className="topbar-avatar" title={user.name}>{user.name.slice(-1)}</span></div></header><main className="main-content" id="main-content" tabIndex={-1} inert={loggingOut} aria-busy={loggingOut}>{mutation.error ? <div className="error-notice" role="alert"><span>{mutation.error}</span><button className="button ghost small" disabled={mutation.busy || loggingOut} onClick={() => void mutation.run(logout)}><SignOut />{t("logout")}</button></div> : error && <ErrorNotice message={error} locale={locale} onRetry={() => void refresh()} />}{status && <p className="success-notice" role="status">{status}</p>}{workspace && ((user.role === "parent" && ["dashboard", "families"].includes(route.page)) || ((user.role === "teacher" || user.role === "student") && route.page === "assessments")) && <FamilyEntry user={user} hasFamilies={workspace.families.length > 0} locale={locale} onDone={loadWorkspaceAfterMutation} openPrivacy={() => setPrivacy(true)} />}{currentView()}<footer className="workspace-footer"><span>TopE · {t("tagline")}</span><button className="text-link" onClick={() => setPrivacy(true)}><ShieldCheck size={15} />{t("privacyShort")}</button></footer></main></div></div>{workspace && form?.kind === "family" && <FamilyForm workspace={workspace} locale={locale} onClose={() => setForm(null)} onDone={() => finish()} />}{workspace && family && admin && form?.kind === "assignment" && <FamilyAssignmentForm workspace={workspace} family={family} locale={locale} onClose={() => setForm(null)} onDone={() => finish(t("assignmentSaved"))} />}{workspace && form?.kind === "assessment" && <AssessmentForm workspace={workspace} familyId={family?.id} locale={locale} onClose={() => setForm(null)} onDone={() => finish(t("taskAssigned"))} />}{workspace && form?.kind === "goal" && <GoalForm workspace={workspace} familyId={family?.id} locale={locale} onClose={() => setForm(null)} onDone={() => finish()} />}{family && form?.kind === "consent" && <ConsentForm family={family} staff={isStaff(user.role)} locale={locale} onClose={() => setForm(null)} onDone={() => finish(t("consentSaved"))} openPrivacy={() => setPrivacy(true)} />}{family && form?.kind === "invite" && <InvitationForm family={family} locale={locale} onClose={() => setForm(null)} onDone={loadWorkspaceAfterMutation} />}{recoveryTarget && form?.kind === "recovery" && <RecoveryForm member={recoveryTarget} locale={locale} onClose={() => setForm(null)} />}{family && form?.kind === "delete" && <DeleteFamilyForm family={family} locale={locale} onClose={() => setForm(null)} onDone={async () => { setForm(null); await loadSession(true); navigate({ page: "families" }); }} />}{family && form?.kind === "observation" && <ObservationForm family={family} locale={locale} onClose={() => setForm(null)} onDone={() => finish()} />}{form?.kind === "scale" && <ScaleImportForm locale={locale} onClose={() => setForm(null)} onDone={() => finish()} />}{selectedScale && form?.kind === "retire" && <RetireScaleForm scale={selectedScale} locale={locale} onClose={() => setForm(null)} onDone={() => finish()} />}{privacy && <PrivacyModal locale={locale} onClose={() => setPrivacy(false)} />}</IconContext.Provider>;
}
