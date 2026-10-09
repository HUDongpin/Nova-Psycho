"use client";
import { SignIn, SignUp } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { useIdentityAuth } from "./localized-clerk-provider";
import { pendingInvitation } from "./link-token";
import { Brand, LocaleSwitch, PrivacyModal, useLocale } from "./ui";

export function EmailAuthPage({ mode }: { mode: "sign-in" | "sign-up" }) {
  const auth = useIdentityAuth(), { locale, setLocale, t } = useLocale();
  const [privacy, setPrivacy] = useState(false);
  const [destination, setDestination] = useState<"/" | "/invite" | null>(null);
  useEffect(() => { setDestination(pendingInvitation() ? "/invite" : "/"); }, []);
  return <main className="invite-page"><header className="login-header"><Brand /><LocaleSwitch locale={locale} onChange={setLocale} /></header><section className="invite-card"><h1>{t(mode === "sign-up" ? "emailRegister" : "emailLogin")}</h1><p>{t("registrationPrivacyNote")}</p>{auth.enabled && <><p className="small-text muted">{t("clerkIdentityDisclosure")}</p><button type="button" className="text-link" onClick={() => setPrivacy(true)}>{t("privacy")}</button></>}{!auth.enabled ? <p>{t("authUnavailable")}</p> : destination && (mode === "sign-up" ? <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" forceRedirectUrl={destination} signInForceRedirectUrl={destination} fallback={<p role="status">{t("emailLoading")}</p>} /> : <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" forceRedirectUrl={destination} signUpForceRedirectUrl={destination} fallback={<p role="status">{t("emailLoading")}</p>} />)}<a className="text-link" href={destination ?? "/"}>{t(destination === "/invite" ? "returnInvite" : "returnLogin")}</a></section>{auth.enabled && privacy && <PrivacyModal locale={locale} onClose={() => setPrivacy(false)} />}</main>;
}
