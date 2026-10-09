"use client";
import { ArrowRight, CircleNotch } from "@phosphor-icons/react";
import { api, type Locale } from "./api";
import { copy } from "./copy";
import { ErrorNotice, Field, useMutation } from "./ui";
export function AccountAccessForm({ locale, onDone, linkLegacy = false, disabled = false }: { locale: Locale; onDone: () => Promise<void>; linkLegacy?: boolean; disabled?: boolean }) {
  const t = copy(locale), mutation = useMutation();
  return <form onSubmit={event => { event.preventDefault(); if (disabled || mutation.busy) return; const form = new FormData(event.currentTarget); void mutation.run(async () => { await api(linkLegacy ? "/api/auth/link-legacy" : "/api/auth/login", locale, { method: "POST", body: { username: form.get("username"), password: form.get("password") } }); await onDone(); }); }}><Field label={t(linkLegacy ? "oldUsername" : "username")}><input name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" required maxLength={100} disabled={disabled || mutation.busy} /></Field><Field label={t(linkLegacy ? "oldPassword" : "password")}><input name="password" type="password" autoComplete="current-password" required maxLength={256} disabled={disabled || mutation.busy} /></Field>{mutation.error && <ErrorNotice locale={locale} message={mutation.error} />}<button className="button primary full-width" disabled={disabled || mutation.busy}>{mutation.busy ? <CircleNotch className="spin" /> : <ArrowRight />}{t(linkLegacy ? "linkLegacy" : mutation.busy ? "loggingIn" : "loginButton")}</button></form>;
}
