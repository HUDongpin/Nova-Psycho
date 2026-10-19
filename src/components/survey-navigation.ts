import { Serializer, type Model, type Question } from "survey-core";

/** Wait after a single-choice answer before moving to the next question. */
export const CHOICE_AUTO_ADVANCE_MS = 5000;

if (!Serializer.findProperty("question", "noAutoAdvance")) {
  Serializer.addProperty("question", { name: "noAutoAdvance:boolean", default: false });
}

export function questionSkipsAutoAdvance(question: Question | null | undefined): boolean {
  return question?.getPropertyValue("noAutoAdvance") === true;
}

type AdvanceHooks = {
  delay?: number;
  onPending?: () => void;
  onClear?: () => void;
  isSuspended?: () => boolean;
};

function isCurrentSingleChoice(model: Model, question: Question | undefined): boolean {
  if (!question || question.getType() !== "radiogroup") return false;
  if (!question.isVisible || question.isEmpty()) return false;
  const current = model.currentSingleQuestion;
  return !!current && current.name === question.name;
}

export function answerableQuestions(model: Model): Question[] {
  return model.getAllQuestions().filter(question => question.isVisible && question.hasInput);
}

/** Open a saved draft on the first question that still needs an answer. */
export function focusFirstUnanswered(model: Model): void {
  const questions = answerableQuestions(model);
  const pending = questions.find(question => question.isEmpty());
  const target = pending ?? questions[questions.length - 1];
  if (target) model.currentElement = target;
}

/** "第 2/9 题" — the question on screen, not the count of saved answers. */
export function questionProgressLabel(model: Model, traditional: boolean): string {
  const questions = answerableQuestions(model);
  const current = model.currentSingleQuestion;
  const index = current ? questions.findIndex(question => question.name === current.name) : -1;
  const position = index >= 0 ? index + 1 : 1;
  const total = Math.max(questions.length, position);
  return traditional ? `第 ${position}/${total} 題` : `第 ${position}/${total} 题`;
}

/** Configure the visible-question ordinal for this survey model's lifetime. */
export function configureQuestionProgress(model: Model, traditional: boolean): void {
  model.onGetProgressText.add((_sender, options) => {
    options.text = questionProgressLabel(model, traditional);
  });
  model.onCurrentPageChanged.add(() => {
    // SurveyJS 3.0.3 invalidates this cache with undefined on navigation. Publish
    // the actual label so React updates even when the answered count is unchanged.
    model.progressTextModel.setPropertyValue("progressText", questionProgressLabel(model, traditional));
  });
}

/**
 * Move to the next question after a single-choice answer.
 * Checkboxes and comments stay put so the respondent can finish them and use Next.
 * Questions marked noAutoAdvance, including the safety items, never advance on the timer.
 * The last question never auto-completes; submission stays on the explicit submit button.
 * A new answer, or leaving the question, replaces the previous wait.
 */
export type AutoAdvanceController = (() => void) & { cancel: () => void };

export function bindChoiceAutoAdvance(model: Model, hooks: AdvanceHooks = {}): AutoAdvanceController {
  const delay = hooks.delay ?? CHOICE_AUTO_ADVANCE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (notify: boolean) => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    if (notify) hooks.onClear?.();
  };
  const onValueChanged = (_sender: Model, options: { question?: Question }) => {
    clear(true);
    if (model.mode !== "edit" || hooks.isSuspended?.()) return;
    if (!isCurrentSingleChoice(model, options.question)) return;
    if (questionSkipsAutoAdvance(options.question)) return;
    if (model.isLastElement) return;
    const from = model.currentSingleQuestion;
    timer = setTimeout(() => {
      timer = undefined;
      hooks.onClear?.();
      if (model.mode !== "edit" || hooks.isSuspended?.() || model.currentSingleQuestion !== from || model.isLastElement || questionSkipsAutoAdvance(from)) return;
      model.nextPage();
    }, delay);
    hooks.onPending?.();
  };
  const onMoved = () => clear(true);
  model.onValueChanged.add(onValueChanged);
  model.onCurrentPageChanged.add(onMoved);
  const dispose = () => {
    clear(false);
    model.onValueChanged.remove(onValueChanged);
    model.onCurrentPageChanged.remove(onMoved);
  };
  return Object.assign(dispose, { cancel: () => clear(true) });
}

/** A review jump waits for SurveyJS's render event instead of a fixed timeout. */
export function bindCompletionNavigation(model: Model, cancelAdvance: () => void, canNavigate: () => boolean) {
  let pending: string | null = null;
  let connected = false;
  const rendered = new Map<string, HTMLElement>();
  const focus = (question: Question, element: HTMLElement) => {
    if (pending !== question.name || !canNavigate() || !question.isVisible || model.currentSingleQuestion?.name !== question.name || !element.isConnected) return;
    pending = null;
    question.focus();
    element.scrollIntoView({ block: "start" });
  };
  const afterRender = (_sender: Model, options: { question: Question; htmlElement: HTMLElement }) => {
    rendered.set(options.question.name, options.htmlElement);
    focus(options.question, options.htmlElement);
  };
  return {
    connect() {
      if (connected) return;
      model.onAfterRenderQuestion.add(afterRender);
      connected = true;
    },
    jump(itemId: string): boolean {
      cancelAdvance();
      if (!canNavigate()) return false;
      const question = answerableQuestions(model).find(candidate => candidate.name === itemId);
      if (!question) return false;
      // The current input is already rendered, including after an effect replay.
      if (model.currentSingleQuestion?.name === itemId) {
        pending = null;
        question.focus();
        rendered.get(itemId)?.scrollIntoView({ block: "start" });
        return true;
      }
      pending = itemId;
      model.currentElement = question;
      const element = rendered.get(itemId);
      if (element) focus(question, element);
      return true;
    },
    cancel() { pending = null; },
    dispose() { pending = null; rendered.clear(); model.onAfterRenderQuestion.remove(afterRender); connected = false; }
  };
}
