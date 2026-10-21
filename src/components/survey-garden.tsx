import { useMemo, useSyncExternalStore } from "react";
import type { Model } from "survey-core";
import type { Locale } from "./api";
import { gardenIconForSection, type GardenIconKey } from "../domain/garden-visuals";
import { GardenIcon, GardenIllustration } from "./garden";
import { createSurveyProgressStore, type SurveyChapter } from "./survey-progress";

export function SurveyGardenIntro({ locale }: { locale: Locale }) {
  const hk = locale === "zh-HK";
  return <div className="survey-garden-intro" data-testid="garden-survey-intro">
    <div>
      <p className="survey-garden-eyebrow">{hk ? "留一點時間，慢慢了解" : "留一点时间，慢慢了解"}</p>
      <h2>{hk ? "從最近的日常說起" : "从最近的日常说起"}</h2>
      <p>{hk ? "按照自己的步調，分享你看到和感受到的事。先閱讀下方說明，再開始作答。" : "按照自己的步调，分享你看到和感受到的事。先阅读下方说明，再开始作答。"}</p>
    </div>
    <GardenIllustration scene="welcome" />
  </div>;
}

export function SurveyGardenJourney({ locale, acknowledged, submitting }: { locale: Locale; acknowledged: boolean; submitting: boolean }) {
  const hk = locale === "zh-HK";
  const current = submitting ? 2 : acknowledged ? 1 : 0;
  const steps: { label: string; icon: GardenIconKey }[] = [
    { label: hk ? "了解說明" : "了解说明", icon: "leaf" },
    { label: hk ? "填寫問卷" : "填写问卷", icon: "book" },
    { label: "提交回答", icon: "send" },
  ];
  return <ol className="survey-garden-journey" data-testid="garden-journey" aria-label={hk ? "填寫步驟" : "填写步骤"}>
    {steps.map((step, index) => <li key={step.icon} className={index === current ? "is-current" : index < current ? "is-done" : ""} aria-current={index === current ? "step" : undefined}>
      <GardenIcon kind={index < current ? "check" : step.icon} />
      <span>{step.label}{index < current && <span className="sr-only">{hk ? "，已完成" : "，已完成"}</span>}</span>
    </li>)}
  </ol>;
}

export function SurveyGardenProgress({ model, chapters, locale }: { model: Model; chapters: ReadonlyMap<string, SurveyChapter>; locale: Locale }) {
  const hk = locale === "zh-HK";
  const store = useMemo(() => createSurveyProgressStore(model, chapters), [model, chapters]);
  const progress = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const answeredLabel = hk ? `已回答 ${progress.answered}/${progress.total} 題` : `已回答 ${progress.answered}/${progress.total} 题`;
  const positionLabel = hk ? `第 ${progress.position}/${progress.total} 題` : `第 ${progress.position}/${progress.total} 题`;
  return <section className="survey-garden-progress" data-testid="garden-survey-progress" data-position={progress.position} data-total={progress.total} data-answered={progress.answered} aria-label={hk ? "作答進度" : "作答进度"}>
    <div className="survey-garden-chapter">
      <GardenIcon kind={gardenIconForSection(progress.chapter.id)} />
      <div><span className="survey-garden-eyebrow">{hk ? "目前章節" : "当前章节"}</span><h2>{progress.chapter.title || (hk ? "這份問卷" : "这份问卷")}</h2></div>
      <span className="survey-garden-position" data-testid="garden-question-position">{progress.total ? positionLabel : hk ? "暫無可填寫題目" : "暂无可填写题目"}</span>
    </div>
    <div className="survey-garden-count"><strong data-testid="garden-answered-count">{answeredLabel}</strong><span>{hk ? "選答題可留空" : "选答题可留空"}</span></div>
    <progress value={progress.answered} max={Math.max(1, progress.total)} aria-label={answeredLabel} />
  </section>;
}
