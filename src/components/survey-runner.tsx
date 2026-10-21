"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Model } from "survey-core";
import { Survey } from "survey-react-ui";
import "survey-core/i18n/simplified-chinese";
import "survey-core/i18n/traditional-chinese";
import { ArrowClockwise, ArrowLeft, ArrowRight, CaretDown, Check, Copy, ListChecks, Warning } from "@phosphor-icons/react";
import { ApiError, errorMessage, type Locale, type SubmissionPhase, type SurveyRecord } from "./api";
import { AssessmentDraftSession } from "./draft-session";
import { copy } from "./copy";
import { answerableQuestions, bindCompletionNavigation, focusFirstUnanswered } from "./survey-navigation";
import { CompletionSummary, surveyCompletionIssues } from "./survey-completion";
import { configureTitleEmphasis } from "./survey-presentation";
import { SurveyNotice } from "./survey-notice";
import { SurveySupplementController } from "./survey-supplement-controller";
import { SurveySupplements } from "./survey-supplements";
import { createQuestionChapters, createSurveyProgressStore, createSurveySectionsStore } from "./survey-progress";
import { surveySectionLabel, SurveyReviewSections, SurveySaveStatus, SurveySectionNavigation } from "./survey-ui";
import { ErrorNotice, Field, Modal } from "./ui";
import styles from "./questionnaire.module.css";

export default function SurveyRunner({ record, draft, locale, onSubmitted, onReloadLatest, openPrivacy, privacyOpen = false, leaving = false }: {
  record: SurveyRecord;
  draft: AssessmentDraftSession;
  locale: Locale;
  onSubmitted: (result: { phase: SubmissionPhase; safetyGuidance: boolean }) => Promise<void>;
  onReloadLatest: () => Promise<void>;
  openPrivacy: () => void;
  privacyOpen?: boolean;
  leaving?: boolean;
}) {
  const t = copy(locale), hk = locale === "zh-HK";
  const snapshot = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const [stage, setStage] = useState<"intro" | "answering" | "review">("intro");
  const [noticeChecked, setNoticeChecked] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [jumpRequest, setJumpRequest] = useState<{ id: string } | null>(null);
  const completedJump = useRef<{ id: string } | null>(null);
  const [reviewFocus, setReviewFocus] = useState(0);
  const questionsRef = useRef<HTMLFieldSetElement>(null);
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const completionHeadingRef = useRef<HTMLHeadingElement>(null);
  const acknowledgedRef = useRef(false);
  acknowledgedRef.current = acknowledged;
  const sessionLocked = snapshot.loggingOut || snapshot.authenticationPaused;
  const locked = record.consentRequired || !acknowledged || snapshot.conflict || snapshot.submitting || sessionLocked || leaving;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const privacyOpenRef = useRef(privacyOpen);
  privacyOpenRef.current = privacyOpen;
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const chapters = useMemo(() => createQuestionChapters(record.surveyJson), [record.surveyJson]);

  const { model, completionNavigation, supplementController } = useMemo(() => {
    const survey = new Model(record.surveyJson);
    configureTitleEmphasis(survey, record.titleEmphasis);
    survey.textUpdateMode = "onTyping";
    survey.locale = locale === "zh-HK" ? "zh-tw" : "zh-cn";
    survey.showTitle = false;
    survey.showCompleteButton = false;
    survey.showCompletedPage = false;
    survey.showProgressBar = false;
    survey.showNavigationButtons = false;
    survey.showQuestionNumbers = "off";
    survey.questionsOnPageMode = "inputPerPage";
    // Navigation belongs to the application, including explicit final review.
    survey.autoAdvanceEnabled = false;
    survey.autoAdvanceAllowComplete = false;
    survey.enterKeyAction = "default";
    survey.data = draft.getSnapshot().answers;
    focusFirstUnanswered(survey);
    survey.mode = "display";
    survey.applyTheme({ isPanelless: true, cssVariables: {
      "--sjs-primary-backcolor": "#2c6058", "--sjs-primary-backcolor-dark": "#204d46",
      "--sjs-primary-backcolor-light": "#edf4f0", "--sjs-general-backcolor": "#ffffff",
      "--sjs-general-backcolor-dim": "#ffffff", "--sjs-general-forecolor": "#202724",
      "--sjs-general-forecolor-light": "#65716c", "--sjs-font-family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'PingFang HK', 'Microsoft YaHei', sans-serif",
      "--sjs-corner-radius": "16px", "--sjs-border-default": "#e1e7e3", "--sjs-font-questiontitle-size": "28px",
    } });
    return {
      model: survey,
      completionNavigation: bindCompletionNavigation(survey, () => undefined, () => !lockedRef.current && !privacyOpenRef.current && stageRef.current === "answering"),
      supplementController: new SurveySupplementController(survey, record.supplements ?? [], () => !lockedRef.current && !privacyOpenRef.current && stageRef.current === "answering"),
    };
  }, [record, locale, draft]);
  const progressStore = useMemo(() => createSurveyProgressStore(model, chapters), [model, chapters]);
  const sectionStore = useMemo(() => createSurveySectionsStore(model, chapters), [model, chapters]);
  const progress = useSyncExternalStore(progressStore.subscribe, progressStore.getSnapshot, progressStore.getSnapshot);
  const sections = useSyncExternalStore(sectionStore.subscribe, sectionStore.getSnapshot, sectionStore.getSnapshot);

  // Clear hidden detail before draft listeners observe a parent answer change.
  useLayoutEffect(() => { supplementController.connect(questionsRef.current); return () => supplementController.dispose(); }, [supplementController]);
  useEffect(() => { model.mode = locked ? "display" : "edit"; }, [model, locked]);
  useEffect(() => { completionNavigation.connect(); return () => completionNavigation.dispose(); }, [completionNavigation]);
  useLayoutEffect(() => { if (locked || privacyOpen) completionNavigation.cancel(); }, [locked, privacyOpen, completionNavigation]);
  useEffect(() => {
    // Run after a chapter dialog has restored its opener, then hand focus to the
    // actual input. Consume the request so closing privacy cannot replay a jump.
    if (jumpRequest && completedJump.current !== jumpRequest && stage === "answering" && !locked && !privacyOpen) {
      completionNavigation.jump(jumpRequest.id);
      completedJump.current = jumpRequest;
    }
  }, [jumpRequest, stage, locked, privacyOpen, completionNavigation]);
  useEffect(() => {
    if (stage === "review" && reviewFocus) reviewHeadingRef.current?.focus();
  }, [stage, reviewFocus]);
  useEffect(() => {
    draft.setAcknowledged(false, locale);
    const change = () => {
      if (!acknowledgedRef.current || record.consentRequired) return;
      draft.update(supplementController.readAnswers(), locale);
      setError("");
    };
    model.onValueChanged.add(change);
    return () => { model.onValueChanged.remove(change); };
  }, [model, draft, locale, record.consentRequired, supplementController]);

  function start() {
    if (!noticeChecked || record.consentRequired || snapshot.conflict || sessionLocked || leaving) return;
    acknowledgedRef.current = true;
    setAcknowledged(true); draft.setAcknowledged(true, locale); setStage("answering");
    const current = model.currentSingleQuestion;
    if (current) setJumpRequest({ id: current.name });
  }
  function jumpTo(id: string) {
    if (locked || privacyOpen) return;
    setDrawerOpen(false); setStage("answering"); setJumpRequest({ id });
  }
  function review() {
    if (locked || privacyOpen) return;
    completionNavigation.cancel();
    draft.update(supplementController.readAnswers(), locale); draft.markCompletionAttempted();
    setDrawerOpen(false); setError(""); setStage("review"); setReviewFocus(value => value + 1);
  }
  function move(previous: boolean) {
    if (locked || privacyOpen) return;
    if (!previous && model.isLastElement) { review(); return; }
    const moved = previous ? model.prevPage() : model.nextPage();
    if (moved && model.currentSingleQuestion) setJumpRequest({ id: model.currentSingleQuestion.name });
  }
  async function submit() {
    completionNavigation.cancel();
    const current = draft.getSnapshot();
    if (stage !== "review" || current.loggingOut || current.authenticationPaused || current.submitting || leaving) return;
    if (record.consentRequired) { setError(t("consentNeeded")); return; }
    if (!acknowledged) { setError(t("acknowledgeNeeded")); return; }
    if (current.conflict) return;
    draft.update(supplementController.readAnswers(), locale); draft.markCompletionAttempted();
    const issues = surveyCompletionIssues(model, record.completionRules, draft.getSnapshot().completionIssues);
    if (issues.length) { completionHeadingRef.current?.focus(); return; }
    if (!model.validate(true, false, undefined, false)) {
      const invalid = answerableQuestions(model).find(question => question.errors.length);
      if (invalid) jumpTo(invalid.name);
      setError(t("checkAnswers")); return;
    }
    setError(""); model.mode = "display";
    try {
      const result = await draft.submit(locale);
      if (draft.getSnapshot().authenticationPaused) return;
      await onSubmitted({ phase: result.phase ?? null, safetyGuidance: result.safetyGuidance === true });
    } catch (err) {
      if (err instanceof ApiError && err.code === "INCOMPLETE_TRIAD" && err.completionIssues?.length) setReviewFocus(value => value + 1);
      else if (!(err instanceof ApiError && err.code === "DRAFT_CONFLICT")) setError(errorMessage(err));
    }
  }
  const issues = stage === "review" ? surveyCompletionIssues(model, record.completionRules, snapshot.completionIssues) : [];
  const submitError = error || (!snapshot.conflict && snapshot.status === "failed" ? snapshot.error : "") || "";
  const answeredLabel = hk ? `已回答 ${progress.answered} / ${progress.total} 題` : `已回答 ${progress.answered} / ${progress.total} 题`;
  const positionLabel = hk ? `第 ${progress.position} / ${progress.total} 題` : `第 ${progress.position} / ${progress.total} 题`;
  const sectionNavigation = <SurveySectionNavigation sections={sections} currentId={stage === "answering" ? progress.chapter.id : ""} locale={locale} disabled={locked} onJump={jumpTo} />;

  return <div className={`${styles.runner} survey-container`} data-stage={stage}>
    {stage !== "intro" && <aside className={styles.chapterSidebar}>
      <p className={styles.sidebarLabel}>{hk ? "問卷章節" : "问卷章节"}</p>{sectionNavigation}
      <button type="button" className={styles.reviewLink} disabled={locked} onClick={review}><ListChecks />{hk ? "核對作答" : "核对作答"}</button>
    </aside>}
    <div className={styles.main}>
      {stage === "intro" && <section className={styles.intro}>
        <SurveyNotice locale={locale} acknowledged={noticeChecked} disabled={snapshot.submitting || snapshot.conflict || sessionLocked || record.consentRequired || leaving} consentRequired={record.consentRequired} onAcknowledged={setNoticeChecked} onOpen={openPrivacy} />
        <div className={styles.introActions}><p>{hk ? "按自己的步調，可以隨時暫停。" : "按自己的步调，可以随时暂停。"}</p>
          <button type="button" className={styles.primaryButton} data-testid="survey-start" disabled={!noticeChecked || record.consentRequired || snapshot.conflict || sessionLocked || leaving} onClick={start}>{hk ? "開始填寫" : "开始填写"}<ArrowRight /></button>
        </div>
      </section>}
      {snapshot.conflict && <section className="draft-conflict" role="alert">
        <div className="draft-conflict-heading"><Warning size={22} /><h2>{t("draftConflictTitle")}</h2></div><p>{t("draftConflictNote")}</p>
        <Field label={t("localDraftAnswers")}><textarea className="code-input" value={JSON.stringify(snapshot.answers, null, 2)} readOnly rows={5} onFocus={event => event.target.select()} /></Field>
        <div className="button-group">
          <button type="button" className="button secondary" disabled={sessionLocked} onClick={async () => { const current = draft.getSnapshot(); if (current.authenticationPaused || current.loggingOut) return; try { await navigator.clipboard.writeText(JSON.stringify(current.answers, null, 2)); setCopied(true); } catch { setError(t("draftCopyFailed")); } }}><Copy />{t(copied ? "copied" : "copyDraftAnswers")}</button>
          <button type="button" className="button primary" disabled={reloading || sessionLocked} onClick={async () => { setReloading(true); try { await onReloadLatest(); } catch (err) { setError(errorMessage(err)); setReloading(false); } }}><ArrowClockwise className={reloading ? "spin" : ""} />{t("reloadLatestDraft")}</button>
        </div>
      </section>}
      {stage !== "intro" && <>
        <button type="button" className={styles.mobileChapter} data-testid="survey-chapters-open" disabled={locked} aria-haspopup="dialog" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}>
          <span>{surveySectionLabel(sections.find(section => section.id === progress.chapter.id)?.title ?? "", locale)}</span><CaretDown />
        </button>
        <div className={styles.progressHeader} data-testid="survey-progress" data-position={progress.position} data-total={progress.total} data-answered={progress.answered}>
          <div className={styles.progressMeta}><span>{stage === "review" ? answeredLabel : positionLabel}</span><SurveySaveStatus snapshot={snapshot} locale={locale} disabled={sessionLocked || leaving} onRetry={() => void draft.save(locale).catch(() => undefined)} /></div>
          <progress value={progress.answered} max={Math.max(1, progress.total)} aria-label={answeredLabel} />
          {stage === "answering" && <div className={styles.progressDetails}><span>{answeredLabel}</span><button type="button" className={styles.textButton} data-testid="survey-review" disabled={locked} onClick={review}>{hk ? "查看作答進度" : "查看作答进度"}</button></div>}
        </div>
      </>}
      <div hidden={stage !== "answering"}>
        {progress.chapter.title && <p className={styles.questionContext}>{progress.chapter.title}</p>}
        <fieldset ref={questionsRef} className="survey-questions" disabled={locked}>
          <Survey model={model} /><SurveySupplements controller={supplementController} locale={locale} locked={locked} />
        </fieldset>
      </div>
      {stage === "review" && <section className={styles.review} aria-labelledby="survey-review-heading">
        <h2 id="survey-review-heading" ref={reviewHeadingRef} tabIndex={-1}>{hk ? "核對你的作答" : "核对你的作答"}</h2>
        <p>{hk ? "展開章節查看回答，也可以返回修改。已回答題數不代表有效資料已足夠。" : "展开章节查看回答，也可以返回修改。已回答题数不代表有效信息已足够。"}</p>
        <CompletionSummary model={model} rules={record.completionRules} issues={issues} locale={locale} disabled={locked} headingRef={completionHeadingRef} onJump={jumpTo} />
        {!issues.length && <p className={styles.reviewReady}><Check />{hk ? "已符合目前問卷的提交要求。" : "已符合当前问卷的提交要求。"}</p>}
        <SurveyReviewSections model={model} sections={sections} supplements={record.supplements ?? []} locale={locale} disabled={locked} onJump={jumpTo} />
      </section>}
      {submitError && <div className={styles.errorPanel}><ErrorNotice locale={locale} message={submitError} /></div>}
      {stage !== "intro" && <div className={styles.actions}>
        {stage === "answering" ? <>
          <button type="button" className={styles.backButton} data-testid="survey-previous" disabled={locked || model.isFirstElement} onClick={() => move(true)}><ArrowLeft />{t("previousQuestion")}</button>
          <button type="button" className={styles.primaryButton} data-testid="survey-next" disabled={locked} onClick={() => move(false)}>{model.isLastElement ? (hk ? "核對作答" : "核对作答") : t("nextQuestion")}<ArrowRight /></button>
        </> : <>
          <button type="button" className={styles.backButton} disabled={locked} onClick={() => { const id = model.currentSingleQuestion?.name; if (id) jumpTo(id); }}><ArrowLeft />{hk ? "返回填寫" : "返回填写"}</button>
          <button type="button" className={styles.primaryButton} data-testid="survey-submit" disabled={locked || reloading || issues.length > 0} onClick={() => void submit()}><Check />{t(snapshot.submitting ? "submitting" : "submit")}</button>
        </>}
      </div>}
    </div>
    {drawerOpen && <Modal title={hk ? "問卷章節" : "问卷章节"} locale={locale} onClose={() => setDrawerOpen(false)} className={styles.chapterDrawer}>
      {sectionNavigation}<button type="button" className={styles.reviewLink} disabled={locked} onClick={review}><ListChecks />{hk ? "核對作答" : "核对作答"}</button>
    </Modal>}
  </div>;
}
