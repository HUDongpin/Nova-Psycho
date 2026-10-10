"use client";
import { useEffect, useId, useRef, useState } from "react";
import { parseJoinCode } from "../domain/registration";
import type { Locale } from "./api";
import { copy } from "./copy";
import { ErrorNotice, Field } from "./ui";

export function JoinCodeField({ locale, error, disabled = false }: { locale: Locale; error?: string; disabled?: boolean }) {
  const t = copy(locale), id = useId(), input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);
  useEffect(() => { input.current?.setCustomValidity((value || touched) && !parseJoinCode(value) ? copy(locale)("invalidCodeFormat") : ""); }, [locale, value, touched]);
  const invalid = touched && !parseJoinCode(value);
  const message = invalid ? t("invalidCodeFormat") : error;
  return <div><Field label={t("joinCode")} hint={t("joinCodeHint")}><input ref={input} id={id} name="code" value={value} required disabled={disabled} autoCapitalize="characters" autoComplete="off" maxLength={32} placeholder="TOPE-A2B3C4D5" aria-invalid={Boolean(message)} aria-errormessage={message ? `${id}-error` : undefined} onChange={event => { const next = event.currentTarget.value; setValue(next); event.currentTarget.setCustomValidity(parseJoinCode(next) ? "" : t("invalidCodeFormat")); }} onBlur={event => { setTouched(true); const parsed = parseJoinCode(value); if (parsed) { setValue(parsed); event.currentTarget.setCustomValidity(""); } }} onInvalid={() => setTouched(true)} /></Field>{message && <div id={`${id}-error`}><ErrorNotice locale={locale} message={message} /></div>}</div>;
}

export function CredentialFields({ locale, field, error, disabled = false }: { locale: Locale; field?: string; error?: string; disabled?: boolean }) {
  const t = copy(locale);
  return <><Field label={t("username")} hint={t("usernameHint")}><input name="username" required disabled={disabled} autoComplete="username" autoCapitalize="none" autoCorrect="off" minLength={3} maxLength={100} pattern="[a-zA-Z0-9_.@\-]{3,100}" aria-invalid={field === "username"} /></Field>{field === "username" && error && <ErrorNotice message={error} locale={locale} />}<Field label={t("password")} hint={t("passwordHint")}><input name="password" type="password" required disabled={disabled} autoComplete="new-password" minLength={12} maxLength={256} aria-invalid={field === "password"} /></Field>{field === "password" && error && <ErrorNotice message={error} locale={locale} />}</>;
}
