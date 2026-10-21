import type { Model } from "survey-core";
import { answerableQuestions } from "./survey-navigation";

export interface SurveyChapter { id: string; title: string }
export interface SurveyProgress { position: number; total: number; answered: number; chapter: SurveyChapter }
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
  return {
    getSnapshot,
    subscribe(listener: () => void) {
      const change = () => {
        const previous = snapshot;
        if (getSnapshot() !== previous) listener();
      };
      model.onCurrentPageChanged.add(change);
      model.onQuestionVisibleChanged.add(change);
      model.onValueChanged.add(change);
      return () => {
        model.onCurrentPageChanged.remove(change);
        model.onQuestionVisibleChanged.remove(change);
        model.onValueChanged.remove(change);
      };
    },
  };
}
