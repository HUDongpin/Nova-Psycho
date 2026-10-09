"use client";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, CircleNotch, IconContext, UserPlus } from "@phosphor-icons/react";
import { api, errorMessage, type Region, type Role, type Session } from "@/components/api";
import { AccountAccessForm } from "@/components/account-access";
import { useIdentityAuth } from "@/components/localized-clerk-provider";
import { formatDate, roleName } from "@/components/copy";
import { clearPendingInvitation, useLinkToken } from "@/components/link-token";
import { CredentialFields } from "@/components/registration-fields";
import { Brand, ErrorNotice, Field, Loading, LocaleSwitch, PrivacyModal, useLocale, useMutation } from "@/components/ui";
export default function InvitePage() {
  const { locale, setLocale, t } = useLocale(), identity = useIdentityAuth();
  const { token, generation, isCurrent } = useLinkToken({ persistForAuthentication: true });
  const [invite, setInvite] = useState<{ familyName: string; role: Role; region: Region; expiresAt: string } | null>(null);
  const [session, setSession] = useState<Session | null>(null), [error, setError] = useState(""), [privacy, setPrivacy] = useState(false), [attempt, setAttempt] = useState(0), [localLogin, setLocalLogin] = useState(false);
  const m = useMutation();
  const readSession = useCallback(async () => {
    const value = await api<Session>("/api/session", locale);
    setSession(value);
    if (value.region === "HK" && !localStorage.getItem("nova-locale")) setLocale("zh-HK");
  }, [locale]);
  useEffect(() => { setInvite(null); m.setError(""); }, [token, generation, m.setError]);
  useEffect(() => {
    if (token === null) return;
    if (!token) { setError(t("noToken")); return; }
    const controller = new AbortController(); setError("");
    Promise.all([api<{ familyName: string; role: Role; region: Region; expiresAt: string }>("/api/invite", locale, { signal: controller.signal, headers: { "X-Invitation-Token": token } }), api<Session>("/api/session", locale, { signal: controller.signal })]).then(([nextInvite, nextSession]) => {
      if (controller.signal.aborted) return;
      setInvite(nextInvite); setSession(nextSession);
      if (nextSession.region === "HK" && !localStorage.getItem("nova-locale")) setLocale("zh-HK");
    }).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); });
    return () => controller.abort();
  }, [token, generation, locale, attempt]);
  useEffect(() => { const change = () => { void readSession().catch(() => undefined); }; window.addEventListener("nova-identity-change", change); return () => window.removeEventListener("nova-identity-change", change); }, [readSession]);
  async function accept(form: FormData) {
    try {
      await api("/api/invite", locale, { method: "POST", body: session?.user ? { token } : session?.authProvider === "clerk" ? { token, name: form.get("name") } : { token, name: form.get("name"), username: form.get("username"), password: form.get("password") } });
      if (isCurrent()) { clearPendingInvitation(); window.location.replace("/"); }
    } catch (error) { if (isCurrent()) throw error; }
  }
  const clerk = session?.authProvider === "clerk", profileRequired = clerk && session?.identityState === "profile_required";
  const canAccept = Boolean(session?.user) || profileRequired || (!clerk && !localLogin);
  return <IconContext.Provider value={{ size: 20, weight: "regular" }}><main className="invite-page"><header className="login-header"><Brand /><div className="login-header-tools"><LocaleSwitch locale={locale} onChange={setLocale} /></div></header><section className="invite-card"><div className="login-card-icon"><UserPlus size={28} weight="regular" /></div><span className="eyebrow">{t("invitation")}</span><h1>{t("inviteTitle")}</h1>{error ? <ErrorNotice message={error} locale={locale} onRetry={token ? () => setAttempt(attempt + 1) : undefined} /> : !invite || !session ? <Loading locale={locale} /> : <><p>{t("invitationLoginNote")}</p><div className="invite-summary"><strong>{invite.familyName}</strong><span>{roleName(invite.role, locale)} · {t(invite.region === "HK" ? "regionHK" : "regionCN")}</span><small>{t("expires")} {formatDate(invite.expiresAt, locale, true)}</small></div>
    {clerk && session.identityState === "signed_out" && <div className="button-group"><a className="button primary" href="/sign-up">{t("emailRegister")}</a><a className="button secondary" href="/sign-in">{t("emailLogin")}</a></div>}
    {clerk && session.identityState === "email_unverified" && <><p role="alert">{t("emailVerifyNeeded")}</p><button type="button" className="button primary" onClick={identity.manageAccount}>{t("verifyEmail")}</button><button className="button secondary" disabled={m.busy} onClick={() => void m.run(readSession)}>{t("verifyAgain")}</button><button className="text-link" disabled={m.busy} onClick={() => void m.run(async () => { await api("/api/auth/logout", locale, { method: "POST", body: {} }); await identity.signOut(); await readSession(); })}>{t("switchAccount")}</button></>}
    {canAccept && <form onSubmit={event => { event.preventDefault(); if (!m.busy) void m.run(() => accept(new FormData(event.currentTarget))); }}><fieldset disabled={m.busy} style={{ border: 0, margin: 0, padding: 0 }}>{session.user ? <p>{session.user.name} · {roleName(session.user.role, locale)}</p> : <><Field label={t("yourName")}><input name="name" autoComplete="name" required maxLength={80} /></Field>{!clerk && <CredentialFields locale={locale} field={m.field} error={m.error} />}</>}{m.error && (Boolean(session.user) || clerk || !["username", "password"].includes(m.field ?? "")) && <ErrorNotice message={m.error} locale={locale} />}<button className="button primary full-width" disabled={m.busy}>{m.busy ? <CircleNotch className="spin" /> : <ArrowRight />}{t("acceptFamilyInvite")}</button></fieldset></form>}
    {session.user && <button type="button" className="text-link" disabled={m.busy} onClick={() => void m.run(async () => { await api("/api/auth/logout", locale, { method: "POST", body: {} }); if (clerk && session.sessionMethod !== "test") await identity.signOut(); await readSession(); })}>{t("switchAccount")}</button>}
    {!clerk && !session.user && <><button type="button" className="text-link" disabled={m.busy} onClick={() => setLocalLogin(!localLogin)}>{t(localLogin ? "registerAccount" : "localSignIn")}</button>{localLogin && <AccountAccessForm locale={locale} onDone={readSession} disabled={m.busy} />}</>}
    {profileRequired && <details><summary>{t("linkLegacy")}</summary><p>{t("linkLegacyNote")}</p><AccountAccessForm locale={locale} onDone={readSession} linkLegacy disabled={m.busy} /></details>}
  </>}<button className="text-link login-privacy" onClick={() => setPrivacy(true)}>{t("privacy")}</button><a href="/" className="text-link" onClick={clearPendingInvitation}>{t("returnLogin")}</a></section>{privacy && <PrivacyModal locale={locale} onClose={() => setPrivacy(false)} />}</main></IconContext.Provider>;
}
