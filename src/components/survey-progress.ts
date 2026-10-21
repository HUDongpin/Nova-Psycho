import type { Model } from "survey-core";
import { answerableQuestions } from "./survey-navigation";

export interface SurveyChapter { id: string; title: string }
export interface SurveyProgress { position: number; total: number; answered: number; chapter: SurveyChapter }
export interface SurveySectionProgress {
  id: string;
  title: string;
  questionIds: string[];
  answered: number;
  total: number;
  targetId: string;
}
const ungrouped: SurveyChapter = { id: "assessment", title: "" };

/** Capture assigned section names before SurveyJS expands pages for inputPerPage. */
export function createQuestionChapters(json: Record<string, unknown>): ReadonlyMap<string, SurveyChapter> {
  const chapters = new Map<string, SurveyChapter>();
  const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const title = (value: unknown) => typeof value === "string" ? value : "";
  const visit = (elements: unknown, id: string, headings: string[]) => {
    if (!Array.isArray(elements)) return;
    for (const value of elements) {
      const element = record(value);
      if (!element) continue;
      if (Array.isArray(element.elements)) {
        visit(element.elements, id, [...headings, title(element.title)].filter((text, index, all) => text && all.indexOf(text) === index));
      } else if (typeof element.name === "string") chapters.set(element.name, { id, title: headings.join(" · ") });
    }
  };
  if (Array.isArray(json.pages)) {
    for (const value of json.pages) {
      const page = record(value);
      if (page) visit(page.elements, title(page.name) || "assessment", [title(page.title)].filter(Boolean));
    }
  } else visit(json.elements, "assessment", []);
  return chapters;
}

export function readSurveyProgress(model: Model, chapters: ReadonlyMap<string, SurveyChapter>): SurveyProgress {
  const questions = answerableQuestions(model);
  const current = model.currentSingleQuestion;
  const index = current ? questions.findIndex(question => question.name === current.name) : -1;
  return {
    position: index >= 0 ? index + 1 : questions.length ? 1 : 0,
    total: questions.length,
    answered: questions.filter(question => !question.isEmpty() && !(typeof question.value === "string" && !question.value.trim())).length,
    chapter: current ? chapters.get(current.name) ?? ungrouped : ungrouped,
  };
}

export function createSurveyProgressStore(model: Model, chapters: ReadonlyMap<string, SurveyChapter>) {
  let snapshot = readSurveyProgress(model, chapters);
  const getSnapshot = () => {
    const next = readSurveyProgress(model, chapters);
    if (next.position !== snapshot.position || next.total !== snapshot.total || next.answered !== snapshot.answered || next.chapter !== snapshot.chapter) snapshot = next;
    return snapshot;
  };
  const events = [model.onCurrentPageChanged, model.onQuestionVisibleChanged, model.onPageVisibleChanged, model.onPanelVisibleChanged, model.onValueChanged];
  return {
    getSnapshot,
    subscribe(listener: () => void) {
      let previous = getSnapshot();
      const change = () => {
        const next = getSnapshot();
        if (next === previous) return;
        previous = next;
        listener();
      };
      events.forEach(event => event.add(change));
      return () => events.forEach(event => event.remove(change));
    },
  };
}

/** Derive navigation sections without changing the survey's questions or completion state. */
export function readSurveySections(model: Model, chapters: ReadonlyMap<string, SurveyChapter>): readonly SurveySectionProgress[] {
  const sections = new Map<string, SurveySectionProgress>();
  const sourceOrder = new Map([...chapters.keys()].map((id, index) => [id, index]));
  const questions = answerableQuestions(model)
    .sort((left, right) => (sourceOrder.get(left.name) ?? chapters.size) - (sourceOrder.get(right.name) ?? chapters.size));
  for (const question of questions) {
    const chapter = chapters.get(question.name) ?? ungrouped;
    let section = sections.get(chapter.id);
    if (!section) {
      section = { id: chapter.id, title: chapter.title.split(" · ")[0], questionIds: [], answered: 0, total: 0, targetId: question.name };
      sections.set(chapter.id, section);
    }
    const answered = !question.isEmpty() && !(typeof question.value === "string" && !question.value.trim());
    // The first unanswered question replaces the initial first-question target.
    if (!answered && section.answered === section.total) section.targetId = question.name;
    section.questionIds.push(question.name);
    section.total += 1;
    if (answered) section.answered += 1;
  }
  return [...sections.values()];
}

export function createSurveySectionsStore(model: Model, chapters: ReadonlyMap<string, SurveyChapter>) {
  let snapshot = readSurveySections(model, chapters);
  const getSnapshot = () => {
    const next = readSurveySections(model, chapters);
    const same = next.length === snapshot.length && next.every((section, index) => {
      const previous = snapshot[index];
      return section.id === previous.id && section.title === previous.title && section.answered === previous.answered &&
        section.total === previous.total && section.targetId === previous.targetId &&
        section.questionIds.every((id, questionIndex) => id === previous.questionIds[questionIndex]);
    });
    if (!same) snapshot = next;
    return snapshot;
  };
  const events = [model.onCurrentPageChanged, model.onQuestionVisibleChanged, model.onPageVisibleChanged, model.onPanelVisibleChanged, model.onValueChanged];
  return {
    getSnapshot,
    subscribe(listener: () => void) {
      let previous = getSnapshot();
      const change = () => {
        const next = getSnapshot();
        if (next === previous) return;
        previous = next;
        listener();
      };
      events.forEach(event => event.add(change));
      return () => events.forEach(event => event.remove(change));
    },
  };
}
