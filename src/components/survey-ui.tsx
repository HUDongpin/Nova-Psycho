import { CheckCircle, CircleNotch, FloppyDisk, Warning } from "@phosphor-icons/react";
import type { Model } from "survey-core";
import type { SurveySupplement } from "../domain/survey-supplements";
import type { Locale } from "./api";
import { copy } from "./copy";
import type { DraftSnapshot } from "./draft-session";
import { answerableQuestions } from "./survey-navigation";
import type { SurveySectionProgress } from "./survey-progress";
import styles from "./questionnaire.module.css";

/** Short navigation labels for the existing canonical page headings; the full
 * assigned heading remains next to the question. Imported headings pass through. */
export function surveySectionLabel(title: string, locale: Locale): string {
  const hk = locale === "zh-HK";
  const labels: [string[], string, string][] = [
    [["家庭和这次最想解决的事", "家庭和這次最想解決的事"], "家庭与当前关注", "家庭與目前關注"],
    [["请按过去三个月大多数情况下的实际表现作答", "請按過去三個月大多數情況下的實際表現作答"], "孩子的学习表现", "孩子的學習表現"],
    [["您自己通常怎样处理和了解这些事", "您自己通常怎樣處理和了解這些事"], "家长的自我观察", "家長的自我觀察"],
    [["遇到这些情况时，您通常实际会怎么做", "遇到這些情況時，您通常實際會怎麼做"], "情境与选择", "情境與選擇"],
    [["还想让服务团队知道的事", "還想讓服務團隊知道的事"], "其他补充", "其他補充"],
  ];
  const match = labels.find(([headings]) => headings.includes(title));
  return match ? match[hk ? 2 : 1] : title || (hk ? "這份問卷" : "这份问卷");
}

export function SurveySaveStatus({ snapshot, locale, disabled, onRetry }: {
  snapshot: DraftSnapshot; locale: Locale; disabled: boolean; onRetry: () => void;
}) {
  const t = copy(locale);
  return <div className={`${styles.saveStatus} survey-save-status`} data-status={snapshot.status} aria-live="polite" aria-atomic="true">
    {snapshot.status === "saved" ? <CheckCircle weight="fill" /> : snapshot.status === "saving" || snapshot.submitting ? <CircleNotch className="spin" /> : snapshot.status === "failed" ? <Warning /> : <FloppyDisk />}
    <span>{t(snapshot.status === "saved" ? "savedDraft" : snapshot.status === "saving" || snapshot.submitting ? "saving" : snapshot.status === "failed" ? "saveFailed" : "unsaved")}</span>
    {snapshot.status === "failed" && <button type="button" className="text-link" disabled={disabled} onClick={onRetry}>{t("retry")}</button>}
  </div>;
}

export function SurveySectionNavigation({ sections, currentId, locale, disabled, onJump }: {
  sections: readonly SurveySectionProgress[]; currentId: string; locale: Locale; disabled: boolean; onJump: (id: string) => void;
}) {
  const hk = locale === "zh-HK";
  return <nav className={styles.sectionNav} aria-label={hk ? "問卷章節" : "问卷章节"}>
    {sections.map(section => <button type="button" key={section.id} data-section-id={section.id} className={styles.sectionLink}
      disabled={disabled} aria-current={section.id === currentId ? "step" : undefined} onClick={() => onJump(section.targetId)}>
      <span>{surveySectionLabel(section.title, locale)}</span>
      <small>已答 {section.answered} / {section.total}</small>
    </button>)}
  </nav>;
}

export function SurveyReviewSections({ model, sections, supplements, locale, disabled, onJump }: {
  model: Model; sections: readonly SurveySectionProgress[]; supplements: SurveySupplement[]; locale: Locale; disabled: boolean; onJump: (id: string) => void;
}) {
  const hk = locale === "zh-HK";
  const questions = answerableQuestions(model);
  return <div className={styles.reviewSections}>
    {sections.map(section => <details key={section.id} className={styles.reviewSection}>
      <summary><span>{section.title || (hk ? "這份問卷" : "这份问卷")}</span><small>已答 {section.answered} / {section.total}</small></summary>
      <ol>
        {section.questionIds.map(id => {
          const question = model.getQuestionByName(id);
          if (!question) return null;
          const empty = question.isEmpty() || (typeof question.value === "string" && !question.value.trim());
          const displayed = question.displayValue;
          const answer = empty ? (hk ? "尚未填寫" : "尚未填写") : Array.isArray(displayed) ? displayed.join("、") : String(displayed ?? "");
          const selected = typeof question.value === "number" ? [question.value] : Array.isArray(question.value) ? question.value : [];
          const details = supplements.filter(item => item.parentId === id && item.anyOf.some(value => selected.includes(value)) && typeof model.getValue(item.itemId) === "string" && model.getValue(item.itemId).trim());
          return <li key={id}><button type="button" data-review-question-id={id} disabled={disabled} onClick={() => onJump(id)}>
            <span>{questions.indexOf(question) + 1}. {question.title}</span><small>{answer}</small>
            {details.map(item => <span key={item.itemId} className={styles.reviewSupplement} data-review-supplement={item.itemId}>
              <small>{item.label} · {hk ? "僅供獲授權的工作人員查看" : "仅供获授权的工作人员查看"}</small>
              <span>{model.getValue(item.itemId)}</span>
            </span>)}
          </button></li>;
        })}
      </ol>
    </details>)}
  </div>;
}
