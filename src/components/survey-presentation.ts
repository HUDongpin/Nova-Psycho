import { Question, type Model, type TextMarkdownEvent } from "survey-core";
import type { TitleEmphasis } from "../domain/survey-presentation";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

/** A narrow title renderer: no general Markdown or supplied HTML is interpreted. */
export function configureTitleEmphasis(model: Model, emphasis: TitleEmphasis[] = []): void {
  model.onTextMarkdown.add((_sender: Model, options: TextMarkdownEvent) => {
    if (options.name !== "title" || options.item || !(options.element instanceof Question)) return;
    const question = options.element;
    const rule = emphasis.find(candidate => candidate.itemId === question.name && candidate.expectedTitle === question.title && candidate.expectedTitle === options.text);
    if (!rule || !rule.phrase) return;
    const position = options.text.indexOf(rule.phrase);
    if (position < 0) return;
    options.html = `${escapeHtml(options.text.slice(0, position))}<strong>${escapeHtml(rule.phrase)}</strong>${escapeHtml(options.text.slice(position + rule.phrase.length))}`;
  });
}
