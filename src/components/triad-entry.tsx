"use client";
import { useState } from "react";
import { ArrowLeft, ArrowRight, CircleNotch, Copy } from "@phosphor-icons/react";
import { api, type Locale } from "./api";
import { copy } from "./copy";
import { ErrorNotice, Field, useMutation } from "./ui";

const relationships = ["母亲", "父亲", "祖父母或外祖父母", "其他主要照顾者"] as const;
const grades = ["学前大班", "小学一至三年级", "小学四至六年级", "初中", "高中", "其他"] as const;

export function TriadEntry({ door, locale, onBack, onDone }: { door: "parent" | "student" | "teacher"; locale: Locale; onBack: () => void; onDone: () => Promise<void> }) {
  const t = copy(locale);
  const mutation = useMutation();
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  async function submit(form: FormData) {
    if (door === "parent") {
      const started = await api<{ joinCode: string }>("/api/triad/parent", locale, { method: "POST", body: { parentName: form.get("parentName"), username: form.get("username"), password: form.get("password"), relationship: form.get("relationship"), childName: form.get("childName"), birthDate: form.get("birthDate"), grade: form.get("grade"), accepted: true } });
      setCode(started.joinCode);
      return;
    }
    await api("/api/triad/join", locale, { method: "POST", body: { code: form.get("code"), role: door, name: form.get("name"), username: form.get("username"), password: form.get("password") } });
    await onDone();
  }
  if (code) return <div><h2>{t("joinCodeReady")}</h2><p className="join-code">{code}</p><p>{t("joinCodeNote")}</p><div className="button-group"><button type="button" className="button secondary" onClick={() => void navigator.clipboard.writeText(code).then(() => setCopied(true)).catch(() => setCopied(false))}><Copy />{t(copied ? "copied" : "copyCode")}</button><button type="button" className="button primary" onClick={() => void mutation.run(onDone)}>{mutation.busy ? <CircleNotch className="spin" /> : <ArrowRight />}{t("enterWorkspace")}</button></div></div>;
  return <form onSubmit={event => { event.preventDefault(); void mutation.run(() => submit(new FormData(event.currentTarget))); }}>
    <button type="button" className="text-link" onClick={onBack}><ArrowLeft />{t("backToLogin")}</button>
    <h2>{t(door === "parent" ? "parentDoor" : door === "student" ? "studentDoor" : "teacherDoor")}</h2>
    {door === "parent" ? <>
      <Field label={t("yourName")}><input name="parentName" required maxLength={100} autoComplete="name" /></Field>
      <Field label={t("relationship")}><select name="relationship" required defaultValue="母亲">{relationships.map(item => <option key={item} value={item}>{item}</option>)}</select></Field>
      <Field label={t("childName")}><input name="childName" required maxLength={100} /></Field>
      <Field label={t("birthDate")} hint={locale === "zh-HK" ? "適用於 8 至 17 歲" : "适用于 8 至 17 岁"}><input name="birthDate" type="date" required /></Field>
      <Field label={t("grade")}><select name="grade" required defaultValue="小学四至六年级">{grades.map(item => <option key={item} value={item}>{item}</option>)}</select></Field>
    </> : <>
      <Field label={t("joinCode")} hint={t("joinCodeHint")}><input name="code" required autoCapitalize="characters" maxLength={32} placeholder="TOPE-" /></Field>
      <Field label={t("yourName")}><input name="name" required maxLength={100} autoComplete="name" /></Field>
    </>}
    <Field label={t("username")} hint={t("usernameHint")}><input name="username" required autoComplete="username" minLength={3} maxLength={100} /></Field>
    <Field label={t("password")} hint={t("passwordHint")}><input name="password" type="password" required autoComplete="new-password" minLength={12} maxLength={256} /></Field>
    {door === "parent" && <label className="checkbox-label"><input type="checkbox" required /><span>{t("consentCheck")}</span></label>}
    {mutation.error && <ErrorNotice locale={locale} message={mutation.error} />}
    <button className="button primary full-width" disabled={mutation.busy}>{mutation.busy ? <CircleNotch className="spin" /> : <ArrowRight />}{t(door === "parent" ? "startParent" : door === "student" ? "joinStudent" : "joinTeacher")}</button>
  </form>;
}
