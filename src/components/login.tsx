"use client";
import { useEffect, useRef, useState } from "react";
import { TriadEntry } from "./triad-entry";
import { AccountAccessForm } from "./account-access";
import { useIdentityAuth } from "./localized-clerk-provider";
import { ArrowRight, CaretDown, ShieldCheck, UserCircle } from "@phosphor-icons/react";
import { api, type Locale, type Session } from "./api";
import { copy, roleName } from "./copy";
import { ErrorNotice, PrivacyModal, useMutation } from "./ui";
import { AuthShell } from "./auth-shell";
import styles from "./auth.module.css";
function demoLoginAccounts(accounts: Session["demoAccounts"]) {
  // One door per role. 林 is the showcase family. 陈/陳 is that family's seeded case worker; the other seeded staff account stays off this screen.
  const named = (role: Session["demoAccounts"][number]["role"], hints: readonly string[]) => {
    const matches = accounts.filter(account => account.role === role);
    return matches.find(account => hints.some(hint => account.name.includes(hint))) ?? matches[0];
  };
  return [named("admin", []), named("staff", ["陈", "陳"]), named("parent", ["林"]), named("student", ["林"]), named("teacher", [])].filter(account => account !== undefined);
}
const doors = ["parent", "student", "teacher"] as const;
type Door = typeof doors[number];
function readDoor(): Door | null {
  return doors.find(value => window.location.hash === `#onboarding/${value}`) ?? null;
}

export function Login({ session, locale, setLocale, onLogin, sessionError = "", recovery, disabled = false }: { session: Session; locale: Locale; setLocale: (locale: Locale) => void; onLogin: () => Promise<void>; sessionError?: string; recovery?: { mismatch: boolean; onReturn: () => void; onDiscard: () => Promise<void> }; disabled?: boolean }) {
  const identity = useIdentityAuth();
  const t = copy(locale); const mutation = useMutation(); const [privacy, setPrivacy] = useState(false); const [door, setDoor] = useState<Door | null>(null);
  const visitedDoors = useRef(new Set<Door>());
  const chooserRef = useRef<HTMLDivElement>(null);
  const previousDoor = useRef<Door | null>(null);
  useEffect(() => {
    const previous = previousDoor.current;
    previousDoor.current = door;
    // The policy opener may now be hidden/inert after a browser Back action.
    if (!door && previous) chooserRef.current?.querySelector<HTMLButtonElement>(`.entry-door-${previous}`)?.focus();
  }, [door]);
  useEffect(() => {
    const change = () => {
      const next = readDoor();
      if (next) visitedDoors.current.add(next);
      setDoor(next); setPrivacy(false);
    };
    change();
    window.addEventListener("popstate", change);
    window.addEventListener("hashchange", change);
    return () => { window.removeEventListener("popstate", change); window.removeEventListener("hashchange", change); };
  }, []);
  function enterDoor(next: Door) {
    visitedDoors.current.add(next);
    window.history.pushState({ ...window.history.state, novaOnboarding: true }, "", `#onboarding/${next}`);
    setDoor(next);
  }
  function backToLogin() {
    if (window.history.state?.novaOnboarding) window.history.back();
    else {
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
      setDoor(null);
    }
  }
  async function finishEntry() {
    await onLogin();
    if (readDoor()) {
      window.history.replaceState({ ...window.history.state, novaOnboarding: false }, "", window.location.pathname + window.location.search);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
  }
  const busy = mutation.busy || disabled;
  const recoveryNotice = recovery && <section className={`draft-recovery-notice${recovery.mismatch ? " draft-account-mismatch" : ""}`} role="alert"><p>{t(recovery.mismatch ? "draftAccountMismatch" : "sessionDraftRetained")}</p><div className="button-group">{recovery.mismatch && <button type="button" className="button secondary" disabled={busy} onClick={recovery.onReturn}>{t("returnToDraftOwner")}</button>}<button type="button" className="button ghost" disabled={busy} onClick={() => { if (window.confirm(t("discardDraftConfirm"))) void mutation.run(recovery.onDiscard); }}>{t(recovery.mismatch ? "discardForCurrentAccount" : "discardPageDrafts")}</button></div></section>;
  const clerk = session.authProvider === "clerk";
  const profileRequired = clerk && session.identityState === "profile_required";
  const canChooseRole = !clerk || profileRequired;
  const emailLinks = <div className={styles.emailEntry}><a className="button primary" href="/sign-in" target={recovery ? "_blank" : undefined} rel={recovery ? "noopener noreferrer" : undefined}>{t("emailLogin")}<ArrowRight size={18} /></a><p className={styles.registration}>{t("authNoAccount")}<a className="text-link" href="/sign-up" target={recovery ? "_blank" : undefined} rel={recovery ? "noopener noreferrer" : undefined}>{t("emailRegister")}</a></p></div>;
  async function switchIdentity() { await api("/api/auth/logout", locale, { method: "POST", body: {} }); if (session.sessionMethod !== "test") await identity.signOut(); await onLogin(); }
  return <><AuthShell locale={locale} onLocaleChange={setLocale}>{recoveryNotice}
    {sessionError && <ErrorNotice locale={locale} message={sessionError} onRetry={() => void onLogin()} />}
    {canChooseRole && doors.filter(value => visitedDoors.current.has(value)).map(value => <div key={value} hidden={door !== value} inert={door !== value}><TriadEntry door={value} active={door === value} locale={locale} onBack={backToLogin} onDone={finishEntry} openPrivacy={() => setPrivacy(true)} authProvider={clerk ? "clerk" : "local"} /></div>)}
    {(!door || !canChooseRole) && <>
      {canChooseRole ? <><h2>{t(profileRequired ? "completeProfile" : "entryTitle")}</h2>{profileRequired && <p>{t("profileRoleNote")}</p>}<div ref={chooserRef} className="entry-doors"><button type="button" className="entry-door entry-door-parent" onClick={() => enterDoor("parent")}><strong>{t("parentDoor")}</strong><small>{t("parentDoorNote")}</small></button><button type="button" className="entry-door entry-door-student" onClick={() => enterDoor("student")}><strong>{t("studentDoor")}</strong><small>{t("studentDoorNote")}</small></button><button type="button" className="entry-door entry-door-teacher" onClick={() => enterDoor("teacher")}><strong>{t("teacherDoor")}</strong><small>{t("teacherDoorNote")}</small></button></div></> : <><h2>{t("authWelcome")}</h2><p>{t("authIntro")}</p>{session.identityState === "email_unverified" ? <><p role="alert">{t("emailVerifyNeeded")}</p><button type="button" className="button primary" onClick={identity.manageAccount}>{t("verifyEmail")}</button></> : emailLinks}<p className={styles.studentNote}>{t("authStudentNote")}</p></>}
      {clerk && session.testAccountLoginEnabled && session.identityState === "signed_out" && <details className={`test-account-login ${styles.testLogin}`}><summary><span>{t("testAccountLogin")}</span><CaretDown size={16} aria-hidden="true" /></summary><div className={styles.testForm}><p>{t("testAccountLoginNote")}</p><AccountAccessForm locale={locale} onDone={onLogin} testAccount disabled={busy} /></div></details>}
      {profileRequired && <details><summary>{t("linkLegacy")}</summary><p>{t("linkLegacyNote")}</p><AccountAccessForm locale={locale} onDone={finishEntry} linkLegacy disabled={busy} /></details>}
      {clerk && session.identityState !== "signed_out" && <button type="button" className="text-link" disabled={busy} onClick={() => void mutation.run(switchIdentity)}>{t("switchAccount")}</button>}
      {clerk && (recovery || session.identityState === "email_unverified") && <button type="button" className="button secondary full-width" disabled={busy} onClick={() => void mutation.run(onLogin)}>{t("verifyAgain")}</button>}
      {!clerk && <><div className="divider-label">{t("haveAccount")}</div><h2>{t("login")}</h2><AccountAccessForm locale={locale} onDone={onLogin} disabled={busy} /><p className="muted small-text login-recovery-note">{t("forgotPassword")}</p></>}
      {mutation.error && <ErrorNotice locale={locale} message={mutation.error} />}
      {!clerk && session.mode === "demo" && demoLoginAccounts(session.demoAccounts).length > 0 && <div className="demo-login"><div className="divider-label">{t("demoAccounts")}</div><div className="demo-account-grid">{demoLoginAccounts(session.demoAccounts).map(account => <button key={account.id} className="demo-account" disabled={busy} onClick={() => void mutation.run(async () => { await api("/api/auth/demo", locale, { method: "POST", body: { accountId: account.id } }); await onLogin(); })}><UserCircle size={26} weight="regular" /><span><strong>{account.name}</strong><small>{roleName(account.role, locale)}</small></span><ArrowRight size={16} /></button>)}</div></div>}
      <div className={styles.policy}><button type="button" className="text-link login-privacy" onClick={() => setPrivacy(true)}><ShieldCheck size={16} />{t("privacy")}</button></div>
    </>}
  </AuthShell>{privacy && <PrivacyModal locale={locale} onClose={() => setPrivacy(false)} />}</>;
}
