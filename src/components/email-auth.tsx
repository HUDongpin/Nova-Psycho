"use client";
import { SignIn, SignUp } from "@clerk/nextjs";
import { ShieldCheck } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useIdentityAuth } from "./localized-clerk-provider";
import { pendingInvitation } from "./link-token";
import { api, errorMessage } from "./api";
import { ErrorNotice, PrivacyModal, useLocale } from "./ui";
import { AuthShell } from "./auth-shell";
import { authAppearance } from "./auth-appearance";
import styles from "./auth.module.css";

export function EmailAuthPage({ mode }: { mode: "sign-in" | "sign-up" }) {
  const auth = useIdentityAuth(), { locale, setLocale, t } = useLocale();
  const [privacy, setPrivacy] = useState(false);
  const [error, setError] = useState("");
  const [destination, setDestination] = useState<"/" | "/invite" | null>(null);
  const loading = <p className={styles.status} role="status">{t(mode === "sign-up" ? "emailRegisterLoading" : "emailLoading")}</p>;
  useEffect(() => {
    if (!auth.enabled) return;
    const controller = new AbortController();
    void api("/api/auth/test-logout", locale, { method: "POST", body: {}, signal: controller.signal }).then(() => {
      if (!controller.signal.aborted) setDestination(pendingInvitation() ? "/invite" : "/");
    }).catch(reason => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [auth.enabled, locale]);
  return <><AuthShell locale={locale} onLocaleChange={setLocale} variant="email" afterCard={<a className="text-link" href={destination ?? "/"}>{t(destination === "/invite" ? "returnInvite" : "returnLogin")}</a>}>
    {error && <ErrorNotice locale={locale} message={error} />}
    {auth.enabled && !destination && !error && loading}
    {!auth.enabled ? <><h2>{t(mode === "sign-up" ? "emailRegister" : "emailLogin")}</h2><p>{t("authUnavailable")}</p></> : destination && (mode === "sign-up"
      ? <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" forceRedirectUrl={destination} signInForceRedirectUrl={destination} appearance={authAppearance} fallback={loading} />
      : <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" forceRedirectUrl={destination} signUpForceRedirectUrl={destination} appearance={authAppearance} fallback={loading} />)}
    {mode === "sign-up" && <p className={styles.registrationNote}>{t("registrationPrivacyNote")}</p>}
    {auth.enabled && <div className={styles.policy}><button type="button" className="text-link" onClick={() => setPrivacy(true)}><ShieldCheck size={16} aria-hidden="true" />{t("privacy")}</button></div>}
  </AuthShell>{auth.enabled && privacy && <PrivacyModal locale={locale} onClose={() => setPrivacy(false)} />}</>;
}
