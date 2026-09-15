import { api, ApiError, errorMessage, type Locale, type SurveyRecord } from "./api";

type Answers = Record<string, number>;
export type DraftStatus = "saved" | "unsaved" | "saving" | "failed" | "conflict" | "submitting";
export interface DraftSnapshot {
  status: DraftStatus;
  revision: number;
  answers: Answers;
  hasUnsavedChanges: boolean;
  conflict: boolean;
  submitting: boolean;
  error: string | null;
}
const sameAnswers = (left: Answers, right: Answers) => {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key]);
};

/** One controller survives all language remounts of an open assessment. */
export class AssessmentDraftSession {
  readonly id: string;
  private revision: number;
  private answers: Answers;
  private generation = 0;
  private savedGeneration = 0;
  private acknowledged = false;
  private consentRequired: boolean;
  private conflict = false;
  private submitting = false;
  private completed = false;
  private status: DraftStatus = "saved";
  private error: string | null = null;
  private tail: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private snapshot: DraftSnapshot;

  constructor(record: SurveyRecord) {
    if (!Number.isInteger(record.draftRevision) || record.draftRevision < 0) {
      throw new Error("Invalid draft revision returned by the service.");
    }
    this.id = record.id;
    this.revision = record.draftRevision;
    this.answers = { ...record.draftAnswers };
    this.consentRequired = record.consentRequired;
    this.completed = record.status !== "pending";
    this.snapshot = this.makeSnapshot();
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private makeSnapshot(): DraftSnapshot {
    return { status: this.status, revision: this.revision, answers: { ...this.answers }, hasUnsavedChanges: this.generation !== this.savedGeneration, conflict: this.conflict, submitting: this.submitting, error: this.error };
  }
  private publish() {
    this.snapshot = this.makeSnapshot();
    for (const listener of this.listeners) listener();
  }
  cancelTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    // A rejected operation reaches its caller, while later operations remain
    // serialized. The conflict flag prevents them from writing after a 409.
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  private schedule(locale: Locale) {
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save(locale).catch(() => undefined);
    }, 700);
  }
  setAcknowledged(value: boolean, locale: Locale) {
    this.acknowledged = value;
    if (!value) this.cancelTimer();
    else if (this.generation !== this.savedGeneration && !this.conflict && !this.submitting) this.schedule(locale);
  }
  update(answers: Answers, locale: Locale) {
    if (!this.acknowledged || this.consentRequired || this.conflict || this.submitting || this.completed || sameAnswers(this.answers, answers)) return;
    this.answers = { ...answers };
    this.generation += 1;
    this.status = "unsaved";
    this.error = null;
    this.publish();
    this.schedule(locale);
  }
  private fail(error: unknown) {
    this.error = errorMessage(error);
    if (error instanceof ApiError && error.code === "DRAFT_CONFLICT") {
      this.conflict = true;
      this.status = "conflict";
      this.cancelTimer();
    } else if (!this.conflict) this.status = "failed";
    this.publish();
  }
  private conflictError() {
    return new ApiError("A newer draft exists. Reload it before continuing.", "DRAFT_CONFLICT", 409);
  }
  private async persist(requestedGeneration: number, locale: Locale): Promise<number> {
    if (this.conflict) throw this.conflictError();
    // Repeated flushes never enqueue a second write for an already saved edit.
    if (this.completed || this.savedGeneration >= requestedGeneration) return this.revision;
    if (!this.acknowledged || this.consentRequired) return this.revision;
    const generation = this.generation;
    const answers = { ...this.answers };
    const expectedRevision = this.revision;
    this.status = this.submitting ? "submitting" : "saving";
    this.publish();
    try {
      const result = await api<{ ok: true; revision: number }>(`/api/assessments/${encodeURIComponent(this.id)}`, locale, { method: "PATCH", body: { answers, acknowledged: true, revision: expectedRevision } });
      if (!Number.isInteger(result.revision) || result.revision <= expectedRevision) throw new Error("Invalid saved draft revision returned by the service.");
      // Advance the expected server revision only after the server acknowledges
      // this exact write. A 409 never adopts the competing writer's revision.
      this.revision = result.revision;
      this.savedGeneration = generation;
      this.error = null;
      this.status = this.submitting ? "submitting" : this.generation === this.savedGeneration ? "saved" : "unsaved";
      this.publish();
      return this.revision;
    } catch (error) { this.fail(error); throw error; }
  }
  save(locale: Locale): Promise<number> {
    this.cancelTimer();
    const generation = this.generation;
    return this.enqueue(() => this.persist(generation, locale));
  }
  async prepareForReload(locale: Locale) {
    this.cancelTimer();
    if (this.acknowledged && !this.conflict && !this.submitting && this.generation !== this.savedGeneration) {
      await this.save(locale).catch(() => undefined);
    }
    await this.tail;
  }
  observeServer(record: SurveyRecord) {
    this.consentRequired = record.consentRequired;
    if (record.status !== "pending") { this.completed = true; this.cancelTimer(); }
    if (this.conflict) return;
    const dirty = this.generation !== this.savedGeneration;
    if (record.draftRevision !== this.revision && dirty) {
      this.fail(this.conflictError());
      return;
    }
    // A fresh read may replace a fully persisted local snapshot. It may never
    // rebase outstanding edits onto another writer's newer revision.
    if (!dirty) {
      this.revision = record.draftRevision;
      this.answers = { ...record.draftAnswers };
      this.status = "saved";
      this.error = null;
      this.publish();
    }
  }
  async submit(locale: Locale) {
    if (this.conflict) throw this.conflictError();
    if (!this.acknowledged || this.consentRequired) throw new ApiError("Please confirm the assessment notice first.", "ACKNOWLEDGEMENT_REQUIRED", 422);
    this.cancelTimer();
    this.submitting = true;
    this.status = "submitting";
    this.publish();
    return this.enqueue(async () => {
      try {
        await this.persist(this.generation, locale);
        if (this.conflict) throw this.conflictError();
        const result = await api<{ id: string; status: "queued" | "published"; reportId: string | null }>(`/api/assessments/${encodeURIComponent(this.id)}/submit`, locale, { method: "POST", body: { answers: { ...this.answers }, acknowledged: true, revision: this.revision } });
        this.completed = true;
        this.savedGeneration = this.generation;
        this.status = "saved";
        this.submitting = false;
        this.publish();
        return result;
      } catch (error) {
        this.submitting = false;
        this.fail(error);
        throw error;
      }
    });
  }
  async discardAfterConflict() {
    this.acknowledged = false;
    this.cancelTimer();
    await this.tail;
  }
}
