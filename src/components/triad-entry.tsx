"use client";
import { useEffect, useRef } from "react";
import { ArrowLeft, ArrowRight, CircleNotch, ShieldCheck } from "@phosphor-icons/react";
import { api, type Locale } from "./api";
import { copy } from "./copy";
import { CredentialFields, JoinCodeField } from "./registration-fields";
import { ErrorNotice, Field, useMutation } from "./ui";

export function TriadEntry({ door, active = true, locale, onBack, onDone, openPrivacy, authProvider = "local" }: { door: "parent" | "student" | "teacher"; active?: boolean; locale: Locale; openPrivacy: () => void; onBack: () => void; onDone: () => Promise<void>; authProvider?: "local" | "clerk" }) {
  const t = copy(locale), mutation = useMutation(), formRef = useRef<HTMLFormElement>(null);
  useEffect(() => { if (!active) { const password = formRef.current?.elements.namedItem("password"); if (password instanceof HTMLInputElement) password.value = ""; } }, [active]);
  async function submit(form: FormData) {
    const body = { name: form.get("name"), role: door, ...(authProvider === "local" ? { username: form.get("username"), password: form.get("password") } : {}) };
    await api(door === "student" ? "/api/triad/join" : authProvider === "clerk" ? "/api/auth/profile" : "/api/auth/register", locale, { method: "POST", body: door === "student" ? { ...body, code: form.get("code") } : body });
    await onDone();
  }
  return <form ref={formRef} onSubmit={event => { event.preventDefault(); if (!active || mutation.busy) return; void mutation.run(() => submit(new FormData(event.currentTarget))); }}>
    <button type="button" className="text-link" onClick={onBack} disabled={mutation.busy}><ArrowLeft />{t("back")}</button>
    <h2>{t(door === "parent" ? "parentDoor" : door === "student" ? "studentDoor" : "teacherDoor")}</h2>
    <p>{t(door === "student" ? "studentDoorNote" : "accountReadyLater")}</p>
    {door === "student" && <JoinCodeField locale={locale} error={mutation.field === "code" ? mutation.error : undefined} disabled={mutation.busy} />}
    <Field label={t("yourName")}><input name="name" required maxLength={100} autoComplete="name" disabled={mutation.busy} /></Field>
    {authProvider === "local" && <CredentialFields locale={locale} field={mutation.field} error={mutation.error} disabled={mutation.busy} />}
    <button type="button" className="text-link" onClick={openPrivacy}><ShieldCheck size={17} />{t("privacy")}</button>
    {mutation.error && !["code", "username", "password"].includes(mutation.field ?? "") && <ErrorNotice locale={locale} message={mutation.error} />}
    {authProvider === "local" && <p><button type="button" className="text-link" onClick={onBack} disabled={mutation.busy}>{t("existingAccountHint")}</button></p>}
    <button className="button primary full-width" disabled={mutation.busy}>{mutation.busy ? <CircleNotch className="spin" /> : <ArrowRight />}{t(door === "student" ? "joinStudent" : "registerAccount")}</button>
  </form>;
}
