import { api, ApiError, errorMessage, type Locale, type SurveyRecord } from "./api";
import { copy } from "./copy";

type Answers = Record<string, number | number[] | string>;
export type DraftStatus = "saved" | "unsaved" | "saving" | "failed" | "conflict" | "submitting";
export interface DraftSnapshot {
  status: DraftStatus;
  revision: number;
  answers: Answers;
  hasUnsavedChanges: boolean;
  conflict: boolean;
  submitting: boolean;
  loggingOut: boolean;
  authenticationPaused: boolean;
  error: string | null;
}
const sameAnswers = (left: Answers, right: Answers) => {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every(key => JSON.stringify(left[key]) === JSON.stringify(right[key]));
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
  private loggingOut = false;
  private disposed = false;
  private authenticationPaused = false;
  private epoch = 0;
  private uncertainSubmission = false;
  private requests = new Set<AbortController>();
  private status: DraftStatus = "saved";
  private error: string | null = null;
  private tail: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private snapshot: DraftSnapshot;

  constructor(record: SurveyRecord, private readonly onAuthenticationLost?: () => void) {
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
    return { status: this.status, revision: this.revision, answers: { ...this.answers }, hasUnsavedChanges: this.generation !== this.savedGeneration || this.uncertainSubmission, conflict: this.conflict, submitting: this.submitting, loggingOut: this.loggingOut, authenticationPaused: this.authenticationPaused, error: this.error };
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
    if (this.authenticationPaused || this.disposed) return;
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save(locale).catch(() => undefined);
    }, 700);
  }
  setAcknowledged(value: boolean, locale: Locale) {
    if (this.loggingOut || this.disposed || this.authenticationPaused) return;
    this.acknowledged = value;
    if (!value) this.cancelTimer();
    else if (this.generation !== this.savedGeneration && !this.conflict && !this.submitting) this.schedule(locale);
  }
  update(answers: Answers, locale: Locale) {
    if (!this.acknowledged || this.consentRequired || this.conflict || this.submitting || this.completed || this.loggingOut || this.disposed || this.authenticationPaused || sameAnswers(this.answers, answers)) return;
    this.answers = { ...answers };
    this.generation += 1;
    this.status = "unsaved";
    this.error = null;
    this.publish();
    this.schedule(locale);
  }
  private fail(error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      this.suspendAuthentication();
      this.onAuthenticationLost?.();
      return;
    }
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
  private current(epoch: number) { return !this.disposed && !this.authenticationPaused && epoch === this.epoch; }
  private requireCurrent(epoch: number) {
    if (this.disposed) throw new Error("Assessment session is no longer active.");
    if (!this.current(epoch)) throw new ApiError("Please sign in again before continuing this draft.", "DRAFT_AUTHENTICATION_PAUSED", 401);
  }
  private async persist(requestedGeneration: number, locale: Locale, epoch: number): Promise<number> {
    if (this.disposed) return this.revision;
    this.requireCurrent(epoch);
    if (this.conflict) throw this.conflictError();
    // Repeated flushes never enqueue a second write for an already saved edit.
    if (this.completed || this.disposed || this.savedGeneration >= requestedGeneration) return this.revision;
    if (!this.acknowledged || this.consentRequired) return this.revision;
    const generation = this.generation;
    const answers = { ...this.answers };
    const expectedRevision = this.revision;
    this.status = this.submitting ? "submitting" : "saving";
    this.publish();
    const controller = new AbortController();
    this.requests.add(controller);
    try {
      const result = await api<{ ok: true; revision: number }>(`/api/assessments/${encodeURIComponent(this.id)}`, locale, { method: "PATCH", body: { answers, acknowledged: true, revision: expectedRevision }, signal: controller.signal });
      this.requireCurrent(epoch);
      if (!Number.isInteger(result.revision) || result.revision <= expectedRevision) throw new Error("Invalid saved draft revision returned by the service.");
      // Advance the expected server revision only after the server acknowledges
      // this exact write. A 409 never adopts the competing writer's revision.
      this.revision = result.revision;
      this.savedGeneration = generation;
      this.error = null;
      this.status = this.submitting ? "submitting" : this.generation === this.savedGeneration ? "saved" : "unsaved";
      this.publish();
      return this.revision;
    } catch (error) { if (this.current(epoch)) this.fail(error); throw error; }
    finally { this.requests.delete(controller); }
  }
  save(locale: Locale): Promise<number> {
    this.cancelTimer();
    const generation = this.generation;
    const epoch = this.epoch;
    return this.enqueue(() => this.persist(generation, locale, epoch));
  }
  async prepareForReload(locale: Locale) {
    this.cancelTimer();
    if (this.authenticationPaused) return;
    if (!this.loggingOut && !this.disposed && this.acknowledged && !this.conflict && !this.submitting && this.generation !== this.savedGeneration) {
      await this.save(locale).catch(() => undefined);
    }
    await this.tail;
  }
  prepareForLogout(locale: Locale): Promise<void> {
    const epoch = this.epoch;
    this.loggingOut = true;
    this.cancelTimer();
    this.publish();
    // The queue includes saves and submissions started before the exit click.
    return this.enqueue(async () => {
      this.requireCurrent(epoch);
      if (this.generation === this.savedGeneration) return;
      if (this.conflict) throw this.conflictError();
      if (!this.acknowledged || this.consentRequired) {
        throw new ApiError(copy(locale)(this.consentRequired ? "consentNeeded" : "acknowledgeNeeded"), "ACKNOWLEDGEMENT_REQUIRED", 422);
      }
      await this.persist(this.generation, locale, epoch);
      this.requireCurrent(epoch);
      if (this.generation !== this.savedGeneration) throw new Error(copy(locale)("logoutDraftFailed"));
    });
  }
  cancelLogout() {
    if (this.disposed) return;
    this.loggingOut = false;
    this.publish();
  }
  dispose() {
    this.disposed = true;
    this.epoch += 1;
    this.cancelTimer();
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
    this.tail = Promise.resolve();
  }
  suspendAuthentication() {
    if (this.disposed || this.authenticationPaused) return;
    this.authenticationPaused = true;
    this.epoch += 1;
    this.uncertainSubmission ||= this.submitting;
    this.submitting = false;
    this.loggingOut = false;
    this.acknowledged = false;
    this.cancelTimer();
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
    // An aborted network request can still finish at the server. Old work keeps
    // its captured epoch; a newly verified session need not wait for its response.
    this.tail = Promise.resolve();
    this.status = this.conflict ? "conflict" : this.generation !== this.savedGeneration ? "unsaved" : "saved";
    this.error = null;
    this.publish();
  }
  resumeFromServer(record: SurveyRecord) {
    if (this.disposed || record.id !== this.id) return;
    this.authenticationPaused = false;
    this.acknowledged = false;
    this.uncertainSubmission = false;
    this.submitting = false;
    this.loggingOut = false;
    this.observeServer(record);
    if (!this.conflict) {
      this.status = this.generation !== this.savedGeneration ? "unsaved" : "saved";
      this.error = null;
    }
    this.publish();
  }
  observeServer(record: SurveyRecord) {
    if (this.disposed || record.id !== this.id) return;
    this.consentRequired = record.consentRequired;
    if (record.status !== "pending") { this.completed = true; this.cancelTimer(); }
    if (this.conflict) return;
    const dirty = this.generation !== this.savedGeneration;
    if ((record.draftRevision !== this.revision || record.status !== "pending") && dirty) {
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
    const epoch = this.epoch;
    this.requireCurrent(epoch);
    if (this.loggingOut || this.disposed) throw new Error(copy(locale)("loggingOut"));
    if (this.completed) throw new Error("Assessment is already submitted.");
    if (this.conflict) throw this.conflictError();
    if (!this.acknowledged || this.consentRequired) throw new ApiError("Please confirm the assessment notice first.", "ACKNOWLEDGEMENT_REQUIRED", 422);
    this.cancelTimer();
    this.submitting = true;
    this.status = "submitting";
    this.publish();
    return this.enqueue(async () => {
      try {
        this.requireCurrent(epoch);
        await this.persist(this.generation, locale, epoch);
        this.requireCurrent(epoch);
        if (this.conflict) throw this.conflictError();
        const controller = new AbortController();
        this.requests.add(controller);
        let result: { id: string; status: "queued" | "published"; reportId: string | null };
        try {
          result = await api<typeof result>(`/api/assessments/${encodeURIComponent(this.id)}/submit`, locale, { method: "POST", body: { answers: { ...this.answers }, acknowledged: true, revision: this.revision }, signal: controller.signal });
        } finally { this.requests.delete(controller); }
        this.requireCurrent(epoch);
        this.completed = true;
        this.savedGeneration = this.generation;
        this.status = "saved";
        this.submitting = false;
        this.publish();
        return result;
      } catch (error) {
        if (this.current(epoch)) {
          // Preserve a possible accepted submission until a fresh GET confirms it.
          if (!(error instanceof ApiError && error.status === 401)) this.submitting = false;
          this.fail(error);
        }
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
