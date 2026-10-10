"use client";
import { useEffect, useRef, useState } from "react";
import { TriadEntry } from "./triad-entry";
import { AccountAccessForm } from "./account-access";
import { useIdentityAuth } from "./localized-clerk-provider";
import { ArrowRight, LockKey, ShieldCheck, UserCircle } from "@phosphor-icons/react";
import { api, type Locale, type Session } from "./api";
import { copy, roleName } from "./copy";
import { Brand, ErrorNotice, LocaleSwitch, PrivacyModal, useMutation } from "./ui";
function demoLoginAccounts(accounts: Session["demoAccounts"]) {
  const pick = (role: Session["demoAccounts"][number]["role"], hint?: string) => accounts.find(account => account.role === role && (hint === undefined || account.name.includes(hint))) ?? accounts.find(account => account.role === role);
  return [pick("parent", "林"), pick("student", "林"), pick("teacher")].filter(account => account !== undefined);
}
const doors = ["parent", "student", "teacher"] as const;
type Door = typeof doors[number];
function readDoor(): Door | null {
  return doors.find(value => window.location.hash === `#onboarding/${value}`) ?? null;
}

export function Login({ session, locale, setLocale, onLogin, recovery, disabled = false }: { session: Session; locale: Locale; setLocale: (locale: Locale) => void; onLogin: () => Promise<void>; recovery?: { mismatch: boolean; onReturn: () => void; onDiscard: () => Promise<void> }; disabled?: boolean }) {
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
  const emailLinks = <div className="button-group"><a className="button primary" href="/sign-up" target={recovery ? "_blank" : undefined} rel={recovery ? "noopener noreferrer" : undefined}>{t("emailRegister")}</a><a className="button secondary" href="/sign-in" target={recovery ? "_blank" : undefined} rel={recovery ? "noopener noreferrer" : undefined}>{t("emailLogin")}</a></div>;
  async function switchIdentity() { await api("/api/auth/logout", locale, { method: "POST", body: {} }); if (session.sessionMethod !== "test") await identity.signOut(); await onLogin(); }
  return <main className="login-page"><header className="login-header"><Brand /><div className="login-header-tools"><LocaleSwitch locale={locale} onChange={setLocale} /></div></header><div className="login-layout"><section className="login-story"><h1>{t("loginIntro")}</h1><p>{t("tagline")}。{t("automaticNote")}</p><figure className="login-story-figure"><img src="/home-companion.jpg" alt={t("homeFigure")} /></figure></section><section className="login-card"><div className="login-card-icon"><LockKey size={27} weight="regular" /></div>{recoveryNotice}
    {canChooseRole && doors.filter(value => visitedDoors.current.has(value)).map(value => <div key={value} hidden={door !== value} inert={door !== value}><TriadEntry door={value} active={door === value} locale={locale} onBack={backToLogin} onDone={finishEntry} openPrivacy={() => setPrivacy(true)} authProvider={clerk ? "clerk" : "local"} /></div>)}
    {(!door || !canChooseRole) && <>
      {canChooseRole ? <><h2>{t(profileRequired ? "completeProfile" : "entryTitle")}</h2>{profileRequired && <p>{t("profileRoleNote")}</p>}<div ref={chooserRef} className="entry-doors"><button type="button" className="entry-door entry-door-parent" onClick={() => enterDoor("parent")}><strong>{t("parentDoor")}</strong><small>{t("parentDoorNote")}</small></button><button type="button" className="entry-door entry-door-student" onClick={() => enterDoor("student")}><strong>{t("studentDoor")}</strong><small>{t("studentDoorNote")}</small></button><button type="button" className="entry-door entry-door-teacher" onClick={() => enterDoor("teacher")}><strong>{t("teacherDoor")}</strong><small>{t("teacherDoorNote")}</small></button></div></> : <><h2>{t("emailLogin")}</h2><p>{t("emailAuthIntro")}</p>{session.identityState === "email_unverified" ? <><p role="alert">{t("emailVerifyNeeded")}</p><button type="button" className="button primary" onClick={identity.manageAccount}>{t("verifyEmail")}</button></> : emailLinks}</>}
      {clerk && session.testAccountLoginEnabled && session.identityState === "signed_out" && <section className="test-account-login"><div className="divider-label">{t("testAccountLogin")}</div><p className="small-text muted">{t("testAccountLoginNote")}</p><AccountAccessForm locale={locale} onDone={onLogin} testAccount disabled={busy} /></section>}
      {profileRequired && <details><summary>{t("linkLegacy")}</summary><p>{t("linkLegacyNote")}</p><AccountAccessForm locale={locale} onDone={finishEntry} linkLegacy disabled={busy} /></details>}
      {clerk && session.identityState !== "signed_out" && <button type="button" className="text-link" disabled={busy} onClick={() => void mutation.run(switchIdentity)}>{t("switchAccount")}</button>}
      {clerk && (recovery || session.identityState === "email_unverified") && <button type="button" className="button secondary full-width" disabled={busy} onClick={() => void mutation.run(onLogin)}>{t("verifyAgain")}</button>}
      {!clerk && <><div className="divider-label">{t("haveAccount")}</div><h2>{t("login")}</h2><AccountAccessForm locale={locale} onDone={onLogin} disabled={busy} /><p className="muted small-text login-recovery-note">{t("forgotPassword")}</p></>}
      {mutation.error && <ErrorNotice locale={locale} message={mutation.error} />}
      {!clerk && session.mode === "demo" && demoLoginAccounts(session.demoAccounts).length > 0 && <div className="demo-login"><div className="divider-label">{t("demoAccounts")}</div><div className="demo-account-grid">{demoLoginAccounts(session.demoAccounts).map(account => <button key={account.id} className="demo-account" disabled={busy} onClick={() => void mutation.run(async () => { await api("/api/auth/demo", locale, { method: "POST", body: { accountId: account.id } }); await onLogin(); })}><UserCircle size={26} weight="regular" /><span><strong>{account.name}</strong><small>{roleName(account.role, locale)}</small></span><ArrowRight size={16} /></button>)}</div></div>}
      <button className="text-link login-privacy" onClick={() => setPrivacy(true)}><ShieldCheck size={17} />{t("privacy")}</button>
    </>}
  </section></div><footer className="login-footer"><span>TopE · {t("tagline")}</span></footer>{privacy && <PrivacyModal locale={locale} onClose={() => setPrivacy(false)} />}</main>;
}
