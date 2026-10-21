import type { InstrumentWriteBlockReason } from "../domain/validation";
import type { CompletionIssue, CompletionRules } from "../domain/completion";
import type { TitleEmphasis } from "../domain/survey-presentation";
import type { SurveySupplement } from "../domain/survey-supplements";

export type Locale = "zh-CN" | "zh-HK";
export type Role = "admin" | "staff" | "parent" | "student" | "teacher";
export type Region = "CN" | "HK";
export interface User { id: string; name: string; role: Role; region: Region }
export interface Session { user: User | null; region: Region; mode: "demo" | "service"; demoAccounts: Pick<User, "id" | "name" | "role">[]; siblingUrl: string | null; authProvider: "local" | "clerk"; sessionMethod?: "test"; testAccountLoginEnabled?: boolean; identityState: "signed_out" | "email_unverified" | "profile_required" | "ready" }
export interface ConsentChoices { assessment: boolean; sensitiveData: boolean; parentReport: boolean; aiProcessing: boolean }
export interface Family { syntheticRetake?: { previousRoundId: string }; id: string; familyName: string; childName: string; age: number; birthDate: string; grade: string; region: Region; guardianLabel: string; assignedTo: string | null; assignedName?: string | null; canInviteMembers: boolean; joinCode?: string | null; createdAt: string; consent: boolean; consents?: ConsentChoices; members: { id: string; name: string; role: Role }[] }
export type AssessmentStatus = "pending" | "queued" | "published" | "failed";
export type SubmissionPhase = "waiting" | "reporting" | "consent" | null;
export interface Assessment { id: string; familyId: string; childName: string; respondentId: string; respondentName: string; respondentRole: Role; scaleVersionId: string; scaleTitle: string; status: AssessmentStatus; phase?: SubmissionPhase; createdAt: string; submittedAt?: string; reportId: string | null; privacyRefreshRequired?: boolean; canRespond: boolean; responseBlockedReason?: InstrumentWriteBlockReason; syntheticTest?: boolean; canRetryReport: boolean; reviewFlags?: ("age_mismatch")[]; statedAge?: number }
export interface Report { id: string; familyId: string; childName: string; title: string; respondentRole: Role; scaleTitle: string; combined?: boolean; privacyRefreshRequired?: boolean; createdAt: string; generationMode: "template" | "ai"; risk: boolean; demo: boolean; dimensions: { key: string; label: string; raw: number | null; max: number; band: string }[]; assessmentId: string; comparison: { available: boolean; previousDate?: string; changes?: { key: string; label: string; delta: number }[]; reason?: string } }
export interface Scale { id: string; scaleId: string; version: string; title: string; description: string; demo: boolean; minAge: number; maxAge: number; roles: Role[]; retakeDays: number; source: string; rights: string | { digital: boolean; commercial: boolean; reference: string }; status: "active" | "retired"; isDefaultVersion?: boolean }
export interface Goal { id: string; familyId: string; title: string; detail: string; status: "active" | "completed"; createdAt: string }
export interface Observation { id: string; familyId: string; body: string; createdAt: string; authorName: string }
export interface Workspace { user: User; region: Region; mode: "demo" | "service"; families: Family[]; assessments: Assessment[]; reports: Report[]; scales: Scale[]; goals: Goal[]; observations: Observation[]; staff: { id: string; name: string }[]; contentVersions: { id: string; kind: string; version: string; libraryKey?: string | null; createdAt: string }[]; alerts: { id: string; familyId: string; childName: string; createdAt: string | null; viewedAt?: string | null }[]; staffNotes: { familyId: string; assessmentId: string; itemId: string; label: string; value: string }[]; summary: Record<string, number> }
export interface SurveyRecord { id: string; status: AssessmentStatus; childName: string; scaleTitle: string; demo: boolean; description: string; surveyJson: Record<string, unknown>; draftAnswers: Record<string, number | number[] | string>; draftRevision: number; consentRequired: boolean; responseBlockedReason?: InstrumentWriteBlockReason; syntheticTest?: boolean; phase?: SubmissionPhase; safetyGuidance?: boolean; completionRules?: CompletionRules; titleEmphasis?: TitleEmphasis[]; supplements?: SurveySupplement[] }
export interface Privacy { version: string; title: string; sections: { title: string; body: string }[] }
/** Report-pipeline status from GET /api/ops/status (admin only). */
export interface OpsStatus {
  region: Region;
  mode: "demo" | "service";
  checkedAt: string;
  jobs: { ready: number; running: number; done: number; failed: number };
  oldestReadySeconds: number | null;
  expiredLeases: number;
  worker: { mode: "continuous" | "queue"; state: "idle" | "processing" | "backlog" | "failed" | "unavailable"; alive: boolean; workerId: string | null; heartbeatAgeSeconds: number | null; uptimeSeconds: number | null; cycles: number | null };
  warnings: string[];
}
/** Unauthenticated liveness probe from GET /api/health. */
export interface HealthStatus { ok: boolean; region: Region; mode: "demo" | "service" }
/** Identifies an existing account that an administrator is issuing a recovery link for. */
export interface RecoveryTarget { memberId: string; memberName: string }
export class ApiError extends Error { constructor(message: string, public code: string, public status: number, public field?: string, public completionIssues?: CompletionIssue[]) { super(message); this.name = "ApiError"; } }
function completionDetails(value: unknown): CompletionIssue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = (candidate: unknown): candidate is string[] => Array.isArray(candidate) && candidate.every(id => typeof id === "string");
  const count = (candidate: unknown): candidate is number => typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0;
  const result: CompletionIssue[] = [];
  for (const issue of value) {
    if (!issue || typeof issue !== "object") return undefined;
    if (issue.kind === "required_missing" && typeof issue.itemId === "string") result.push({ kind: issue.kind, itemId: issue.itemId });
    else if (issue.kind === "insufficient_coverage" && typeof issue.dimensionKey === "string" && ids(issue.itemIds) && ids(issue.unansweredItemIds) && ids(issue.excludedItemIds) && count(issue.answered) && count(issue.required) && count(issue.total)) {
      result.push({ kind: issue.kind, dimensionKey: issue.dimensionKey, itemIds: [...issue.itemIds], answered: issue.answered, required: issue.required, total: issue.total, unansweredItemIds: [...issue.unansweredItemIds], excludedItemIds: [...issue.excludedItemIds] });
    } else return undefined;
  }
  return result;
}
export function isAuthenticationLost(error: unknown): boolean { return error instanceof ApiError && (error.status === 401 || (error.status === 403 && error.code === "ACCOUNT_REVOKED")); }
export function apiUrl(path: string, locale: Locale): string { return `${path}${path.includes("?") ? "&" : "?"}locale=${locale}`; }
export async function api<T>(path: string, locale: Locale, options: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown; signal?: AbortSignal; headers?: Record<string, string> } = {}): Promise<T> {
  const response = await fetch(apiUrl(path, locale), { method: options.method || "GET", credentials: "same-origin", cache: "no-store", headers: { ...(options.body === undefined ? {} : { "Content-Type": "application/json" }), ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: options.signal });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(data?.error || (locale === "zh-HK" ? "服務暫時未能回應，請重試。" : "服务暂时未能响应，请重试。"), data?.code || "REQUEST_FAILED", response.status, typeof data?.field === "string" ? data.field : undefined, data?.code === "INCOMPLETE_TRIAD" && response.status === 422 ? completionDetails(data.completionIssues) : undefined);
  return data as T;
}
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
export function retryAssessmentReport(id: string, locale: Locale) {
  return api<{ id: string; status: "queued" }>(`/api/assessments/${encodeURIComponent(id)}/retry-report`, locale, { method: "POST", body: {} });
}
export function isStaff(role: Role) { return role === "admin" || role === "staff"; }
export function isAdult(role: Role) { return isStaff(role) || role === "parent"; }
export function eligibleScales(scales: Scale[], family: Family | undefined, respondentId: string): Scale[] {
  const member = family?.members.find(person => person.id === respondentId);
  if (!family || !member) return [];
  const matching = scales.filter(scale => scale.status === "active" && scale.roles.includes(member.role) && family.age >= scale.minAge && family.age <= scale.maxAge);
  const official = matching.filter(scale => !scale.demo);
  const eligible = official.length ? official : matching;
  return [...eligible.filter(scale => scale.isDefaultVersion), ...eligible.filter(scale => !scale.isDefaultVersion)];
}
