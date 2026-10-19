import { useId, type Ref } from "react";
import type { Model } from "survey-core";
import { completionIssues, type CompletionIssue, type CompletionRules } from "../domain/completion";
import type { Locale } from "./api";
import { answerableQuestions } from "./survey-navigation";

/** Complete local review; ordinary questionnaires retain only their required-item checks. */
export function surveyCompletionIssues(model: Model, rules?: CompletionRules, serverIssues: CompletionIssue[] = []): CompletionIssue[] {
  const local: CompletionIssue[] = rules ? completionIssues(rules, model.data) : answerableQuestions(model)
    .filter(question => question.isRequired && (question.isEmpty() || (typeof question.value === "string" && question.value.trim().length === 0)))
    .map(question => ({ kind: "required_missing", itemId: question.name }));
  const key = (issue: CompletionIssue) => issue.kind === "required_missing" ? `item:${issue.itemId}` : `dimension:${issue.dimensionKey}`;
  return [...new Map([...local, ...serverIssues].map(issue => [key(issue), issue])).values()];
}

export function completionQuestion(model: Model, itemId: string) {
  const questions = answerableQuestions(model);
  const index = questions.findIndex(question => question.name === itemId);
  if (index < 0) return null;
  const question = questions[index];
  const titleOf = (element: unknown) => element && typeof element === "object" && "title" in element && typeof element.title === "string" ? element.title : "";
  const chapter = [titleOf(question.page), titleOf(question.parent)].filter((title, position, all) => title && all.indexOf(title) === position).join(" · ");
  return { id: itemId, ordinal: index + 1, title: question.title, chapter };
}

export function CompletionSummary({ model, rules, issues, locale, disabled, headingRef, onJump }: {
  model: Model;
  rules?: CompletionRules;
  issues: CompletionIssue[];
  locale: Locale;
  disabled: boolean;
  headingRef?: Ref<HTMLHeadingElement>;
  onJump: (itemId: string) => void;
}) {
  const headingId = useId();
  const traditional = locale === "zh-HK";
  const t = (simplified: string, hk: string) => traditional ? hk : simplified;
  if (!issues.length) return null;
  const missing = issues.filter(issue => issue.kind === "required_missing").length;
  const coverage = issues.length - missing;
  const questionLink = (itemId: string) => {
    const target = completionQuestion(model, itemId);
    if (!target) return null;
    return <button type="button" className="completion-question-link" data-question-id={itemId} disabled={disabled} onClick={() => onJump(itemId)}>
      <span>{t(`第 ${target.ordinal} 题`, `第 ${target.ordinal} 題`)} · {target.title}</span>
      {target.chapter && <small>{target.chapter}</small>}
    </button>;
  };
  return <section className="survey-completion" data-testid="completion-summary" role="region" aria-labelledby={headingId}>
    <h2 id={headingId} ref={headingRef} tabIndex={-1}>{t("请检查以下部分", "請檢查以下部分")}</h2>
    <p role="status" aria-live="polite" aria-atomic="true">{t(`有 ${missing} 道必答题尚未填写，${coverage} 个部分的有效信息不足。`, `有 ${missing} 道必答題尚未填寫，${coverage} 個部分的有效資料不足。`)}</p>
    <ul className="completion-issues">
      {issues.map(issue => issue.kind === "required_missing" ? <li key={`item:${issue.itemId}`} data-completion-kind={issue.kind}>
        <strong>{t("必答题尚未填写", "必答題尚未填寫")}</strong>
        {questionLink(issue.itemId) ?? <p>{t("请重新载入问卷，核对尚未填写的必答项目。", "請重新載入問卷，核對尚未填寫的必答項目。")}</p>}
      </li> : <li key={`dimension:${issue.dimensionKey}`} data-completion-kind={issue.kind}>
        <strong>{rules?.dimensions.find(dimension => dimension.key === issue.dimensionKey)?.label[locale] || completionQuestion(model, issue.itemIds[0])?.chapter || t("需要补充信息的部分", "需要補充資料的部分")}</strong>
        <p className="completion-count">{t(`有效回答 ${issue.answered}/${issue.total}，至少需要 ${issue.required} 道。`, `有效回答 ${issue.answered}/${issue.total}，至少需要 ${issue.required} 道。`)}</p>
        <p>{issue.unansweredItemIds.length
          ? t("该部分仍有题目未填写，现有信息不足以计算结果。请按实际情况作答；‘不了解或不适用’可以保留，不会计入有效回答。", "該部分仍有題目未填寫，現有資料不足以計算結果。請按實際情況作答；「不了解或不適用」可以保留，不會計入有效回答。")
          : t("该部分已填写，但现有信息不足以计算结果。请保持真实回答，可保存后继续。", "該部分已填寫，但現有資料不足以計算結果。請保持真實回答，可儲存後繼續。")}</p>
        <ul className="completion-question-list">
          {[...issue.unansweredItemIds, ...issue.excludedItemIds].filter((id, index, all) => all.indexOf(id) === index && completionQuestion(model, id)).map(id => <li key={id}>
            <span className="completion-answer-state">{issue.unansweredItemIds.includes(id) ? t("尚未填写", "尚未填寫") : t("已回答，未计入有效数", "已回答，未計入有效數")}</span>
            {questionLink(id)}
          </li>)}
        </ul>
      </li>)}
    </ul>
  </section>;
}
