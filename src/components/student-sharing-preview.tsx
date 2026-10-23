"use client";
import { STUDENT_SUPPORT_OPTIONS } from "../domain/student-sharing";
import type { Locale } from "./api";

export function selectedStudentSupport(value: unknown) {
  const noShare = value === undefined || (Array.isArray(value) && (!value.length || (value.length === 1 && value[0] === 0)));
  if (noShare) return { valid: true, options: [], signature: "" };
  if (!Array.isArray(value) || value.length > 3 || new Set(value).size !== value.length) return { valid: false, options: [], signature: "" };
  const options = value.map(selected => STUDENT_SUPPORT_OPTIONS.find(option => option.value === selected));
  if (options.some(option => !option)) return { valid: false, options: [], signature: "" };
  const selected = options.filter(option => option !== undefined);
  return { valid: true, options: selected, signature: selected.map(option => option.id).join("|") };
}

/** The preview receives sharing choices only, never the private answer object. */
export function StudentSharingPreview({ value, locale, confirmed = false, disabled = false, onConfirm }: { value: unknown; locale: Locale; confirmed?: boolean; disabled?: boolean; onConfirm?: (confirmed: boolean) => void }) {
  const hk = locale === "zh-HK", selected = selectedStudentSupport(value);
  return <section className="student-sharing-preview" data-testid="student-sharing-preview" aria-label={hk ? "給家長的分享預覽" : "给家长的分享预览"}>
    <h3>{hk ? "給家長的分享預覽" : "给家长的分享预览"}</h3>
    <p>{hk ? "家長報告只會加入下列由你選擇並確認的句子。普通答案和自由文字不會放入家長報告；服務團隊可按授權查看。安全問題仍按保護流程處理。" : "家长报告只会加入下列由你选择并确认的句子。普通答案和自由文字不会放入家长报告；服务团队可按授权查看。安全问题仍按保护流程处理。"}</p>
    {!selected.valid ? <p role="alert">{hk ? "請返回選擇最多三句支持需要，或選擇這次不分享。" : "请返回选择最多三句支持需要，或选择这次不分享。"}</p> : selected.options.length ? <>
      <ul>{selected.options.map(option => <li key={option.id}>{option.label[locale]}</li>)}</ul>
      {onConfirm && <label className="checkbox-label"><input type="checkbox" checked={confirmed} disabled={disabled} onChange={event => onConfirm(event.target.checked)} /><span>{hk ? "我已看過以上完整句子，同意將這些句子放進家長報告。" : "我已看过以上完整句子，同意将这些句子放进家长报告。"}</span></label>}
    </> : <p>{hk ? "這次不向家長分享任何支持句子。你的問卷仍可正常提交。" : "这次不向家长分享任何支持句子。你的问卷仍可正常提交。"}</p>}
  </section>;
}
