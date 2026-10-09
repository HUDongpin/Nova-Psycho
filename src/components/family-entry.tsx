"use client";
import { useRef, useState } from "react";
import { ArrowRight, CircleNotch, Copy, Plus, ShieldCheck } from "@phosphor-icons/react";
import { api, type Locale, type User } from "./api";
import { copy } from "./copy";
import { JoinCodeField } from "./registration-fields";
import { ErrorNotice, Field, useMutation } from "./ui";
const relationships = [["母亲", "母親"], ["父亲", "父親"], ["祖父母或外祖父母", "祖父母或外祖父母"], ["其他主要照顾者", "其他主要照顧者"]] as const;
const grades = [["学前大班", "學前大班"], ["小学一至三年级", "小學一至三年級"], ["小学四至六年级", "小學四至六年級"], ["初中", "初中"], ["高中", "高中"], ["其他", "其他"]] as const;
export function ParentFamilyFields({ locale, openPrivacy }: { locale: Locale; openPrivacy: () => void }) {
  const t = copy(locale);
  return <><Field label={t("relationship")}><select name="relationship" required defaultValue="母亲">{relationships.map(([value, traditional]) => <option key={value} value={value}>{locale === "zh-HK" ? traditional : value}</option>)}</select></Field><Field label={t("childName")}><input name="childName" required maxLength={100} /></Field><Field label={t("birthDate")} hint={locale === "zh-HK" ? "適用於 8 至 17 歲" : "适用于 8 至 17 岁"}><input name="birthDate" type="date" required /></Field><Field label={t("grade")}><select name="grade" required defaultValue="小学四至六年级">{grades.map(([value, traditional]) => <option key={value} value={value}>{locale === "zh-HK" ? traditional : value}</option>)}</select></Field><button type="button" className="text-link" onClick={openPrivacy}><ShieldCheck size={17} />{t("privacy")}</button><label className="checkbox-label"><input name="accepted" type="checkbox" required /><span>{t("consentCheck")}</span></label></>;
}
export function FamilyEntry({ user, hasFamilies, locale, onDone, openPrivacy }: { user: User; hasFamilies: boolean; locale: Locale; onDone: () => Promise<void>; openPrivacy: () => void }) {
  const t = copy(locale), mutation = useMutation();
  const [open, setOpen] = useState(!hasFamilies), [code, setCode] = useState(""), [copied, setCopied] = useState(false), [status, setStatus] = useState("");
  const requestId = useRef<string | null>(null);
  if (user.role !== "parent" && user.role !== "teacher" && user.role !== "student") return null;
  const parent = user.role === "parent";
  async function submit(form: FormData) {
    setStatus("");
    if (parent) {
      requestId.current ??= crypto.randomUUID();
      const result = await api<{ joinCode: string }>("/api/triad/family", locale, { method: "POST", body: { requestId: requestId.current, relationship: form.get("relationship"), childName: form.get("childName"), birthDate: form.get("birthDate"), grade: form.get("grade"), accepted: form.get("accepted") === "on" } });
      setCode(result.joinCode);
      await onDone();
    } else {
      const result = await api<{ alreadyMember: boolean }>("/api/triad/join", locale, { method: "POST", body: { code: form.get("code") } });
      setStatus(t(result.alreadyMember ? "alreadyJoined" : "familyJoined"));
      await onDone(); setOpen(false);
    }
  }
  return <section className="panel family-entry" style={{ marginBottom: "1.25rem", padding: "1.5rem" }}><div className="section-heading"><div><h2>{t(parent ? "createFirstFamily" : hasFamilies ? "joinAnotherFamily" : "noFamilyYet")}</h2>{!hasFamilies && <p>{t(parent ? "parentFamilyNote" : user.role === "teacher" ? "teacherFamilyNote" : "studentDoorNote")}</p>}</div>{!open && <button type="button" className="button secondary" onClick={() => { setCode(""); requestId.current = null; setStatus(""); setOpen(true); }}><Plus />{t(parent ? "newFamily" : "joinFamily")}</button>}</div>{status && <p className="success-notice" role="status">{status}</p>}{code ? <div><h3>{t("joinCodeReady")}</h3><p className="join-code">{code}</p><p>{t("joinCodeNote")}</p><div className="button-group"><button type="button" className="button secondary" onClick={() => void navigator.clipboard.writeText(code).then(() => setCopied(true)).catch(() => setCopied(false))}><Copy />{t(copied ? "copied" : "copyCode")}</button><button type="button" className="button primary" onClick={() => { setOpen(false); setCode(""); }}>{t("close")}</button></div></div> : open && <form onSubmit={event => { event.preventDefault(); if (!mutation.busy) void mutation.run(() => submit(new FormData(event.currentTarget))); }}><fieldset disabled={mutation.busy} style={{ border: 0, padding: 0, margin: 0 }}>{parent ? <ParentFamilyFields locale={locale} openPrivacy={openPrivacy} /> : <JoinCodeField locale={locale} error={mutation.field === "code" ? mutation.error : undefined} />}{mutation.error && mutation.field !== "code" && <ErrorNotice message={mutation.error} locale={locale} />}<div className="button-group"><button className="button primary" disabled={mutation.busy}>{mutation.busy ? <CircleNotch className="spin" /> : <ArrowRight />}{t(parent ? "createFirstFamily" : "joinFamily")}</button>{hasFamilies && <button type="button" className="button ghost" disabled={mutation.busy} onClick={() => setOpen(false)}>{t("cancel")}</button>}</div></fieldset></form>}</section>;
}
