import type { Model, Question } from "survey-core";
import type { SurveySupplement } from "../domain/survey-supplements";

/** Keeps optional detail in SurveyJS data; only render targets and revisions are stored here. */
export class SurveySupplementController {
  private connected = false;
  private cleaning = false;
  private revision = 0;
  private notifyQueued = false;
  private listeners = new Set<() => void>();
  private hosts = new Map<string, { root: HTMLElement; host: HTMLElement }>();

  constructor(readonly model: Model, readonly supplements: SurveySupplement[], private readonly canWrite: () => boolean) {}

  getSnapshot = () => this.revision;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish() { this.revision += 1; for (const listener of this.listeners) listener(); }
  private notify = () => {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => { this.notifyQueued = false; if (this.connected) this.publish(); });
  };

  private active(supplement: SurveySupplement): boolean {
    const parent = this.model.getQuestionByName(supplement.parentId);
    if (!parent?.isVisible) return false;
    // A sibling's visibility event can arrive before this parent has updated its
    // cached visibility. Evaluate its assigned condition against current data.
    if (parent.visibleIf && !this.model.runCondition(parent.visibleIf)) return false;
    const value = this.model.getValue(supplement.parentId);
    const selected = typeof value === "number" ? [value] : Array.isArray(value) ? value : [];
    return supplement.anyOf.some(value => selected.includes(value));
  }

  currentSupplement(): SurveySupplement | null {
    const current = this.model.currentSingleQuestion;
    return this.supplements.find(supplement => supplement.parentId === current?.name && this.active(supplement)) ?? null;
  }
  hasCurrentSupplement(): boolean { return this.currentSupplement() !== null; }
  hostFor(parentId: string): HTMLElement | null {
    const host = this.hosts.get(parentId)?.host;
    return host?.isConnected ? host : null;
  }

  cleanup() {
    if (this.cleaning) return;
    this.cleaning = true;
    try {
      for (const supplement of this.supplements) {
        const value = this.model.getValue(supplement.itemId);
        if (value !== undefined && (!this.active(supplement) || (typeof value === "string" && !value.trim()))) this.model.clearValue(supplement.itemId);
      }
    } finally { this.cleaning = false; }
  }
  readAnswers(): Record<string, number | number[] | string> {
    this.cleanup();
    const answers = { ...this.model.data };
    // Recursive clear events may reach a draft listener while another field is
    // still being cleared. Every returned snapshot excludes all hidden details.
    for (const supplement of this.supplements) {
      if (!this.active(supplement) || (typeof answers[supplement.itemId] === "string" && !answers[supplement.itemId].trim())) delete answers[supplement.itemId];
    }
    return answers;
  }
  write(itemId: string, value: string): void {
    const supplement = this.currentSupplement();
    if (!this.connected || !this.canWrite() || this.model.mode !== "edit" || supplement?.itemId !== itemId || value.length > supplement.maxLength) return;
    if (value.trim()) this.model.setValue(itemId, value);
    else this.model.clearValue(itemId);
  }

  private changed = () => { this.cleanup(); this.notify(); };
  private propertyChanged = (_sender: unknown, event: { name: string }) => { if (event.name === "readOnly") this.notify(); };
  private ensureHost(parentId: string, root: HTMLElement) {
    const previous = this.hosts.get(parentId);
    if (previous?.root === root) {
      if (previous.host.parentElement !== root) root.append(previous.host);
      return;
    }
    previous?.host.remove();
    const host = root.ownerDocument.createElement("div");
    host.className = "survey-supplement-host";
    root.append(host);
    this.hosts.set(parentId, { root, host });
  }
  private rendered = (_sender: Model, event: { question: Question; htmlElement: HTMLElement }) => {
    if (!this.supplements.some(supplement => supplement.parentId === event.question.name)) return;
    this.ensureHost(event.question.name, event.htmlElement);
    this.notify();
  };

  connect(root?: HTMLElement | null): void {
    if (this.connected) return;
    this.connected = true;
    this.model.onValueChanged.add(this.changed);
    this.model.onQuestionVisibleChanged.add(this.changed);
    this.model.onCurrentPageChanged.add(this.notify);
    this.model.onAfterRenderQuestion.add(this.rendered);
    this.model.onPropertyChanged.add(this.propertyChanged);
    this.cleanup();
    // Child render events can precede the runner's layout effect on first mount
    // and StrictMode replay. Seed only matching question roots already present.
    if (root) for (const element of root.querySelectorAll<HTMLElement>("[data-name]")) {
      const parentId = element.dataset.name;
      if (parentId && this.supplements.some(supplement => supplement.parentId === parentId)) this.ensureHost(parentId, element);
    }
    this.publish();
  }
  dispose(): void {
    if (!this.connected) return;
    this.connected = false;
    this.model.onValueChanged.remove(this.changed);
    this.model.onQuestionVisibleChanged.remove(this.changed);
    this.model.onCurrentPageChanged.remove(this.notify);
    this.model.onAfterRenderQuestion.remove(this.rendered);
    this.model.onPropertyChanged.remove(this.propertyChanged);
    for (const { host } of this.hosts.values()) host.remove();
    this.hosts.clear();
    this.publish();
  }
}
