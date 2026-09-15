export type Locale = "zh-CN" | "zh-HK";
export type Role = "admin" | "staff" | "parent" | "student" | "teacher";
export type Region = "CN" | "HK";
export interface User { id: string; name: string; role: Role; region: Region }
export interface Session { user: User | null; region: Region; mode: "demo" | "service"; demoAccounts: Pick<User, "id" | "name" | "role">[]; siblingUrl: string | null }
export interface Family { id: string; familyName: string; childName: string; age: number; birthDate: string; grade: string; region: Region; guardianLabel: string; assignedTo: string | null; createdAt: string; consent: boolean; members: { id: string; name: string; role: Role }[] }
export type AssessmentStatus = "pending" | "queued" | "published" | "failed";
export interface Assessment { id: string; familyId: string; childName: string; respondentId: string; respondentName: string; respondentRole: Role; scaleVersionId: string; scaleTitle: string; status: AssessmentStatus; createdAt: string; submittedAt?: string; reportId: string | null; canRespond: boolean }
export interface Report { id: string; familyId: string; childName: string; title: string; respondentRole: Role; scaleTitle: string; createdAt: string; generationMode: "template" | "ai"; risk: boolean; demo: boolean; dimensions: { key: string; label: string; raw: number | null; max: number; band: string }[]; assessmentId: string; comparison: { available: boolean; previousDate?: string; changes?: { key: string; label: string; delta: number }[]; reason?: string } }
export interface Scale { id: string; scaleId: string; version: string; title: string; description: string; demo: boolean; minAge: number; maxAge: number; roles: Role[]; retakeDays: number; source: string; rights: string | { digital: boolean; commercial: boolean; reference: string }; status: "active" | "retired" }
export interface Goal { id: string; familyId: string; title: string; detail: string; status: "active" | "completed"; createdAt: string }
export interface Observation { id: string; familyId: string; body: string; createdAt: string; authorName: string }
export interface Workspace { user: User; region: Region; mode: "demo" | "service"; families: Family[]; assessments: Assessment[]; reports: Report[]; scales: Scale[]; goals: Goal[]; observations: Observation[]; staff: { id: string; name: string }[]; contentVersions: { id: string; kind: string; version: string; createdAt: string }[]; summary: Record<string, number> }
export interface SurveyRecord { id: string; status: AssessmentStatus; childName: string; scaleTitle: string; demo: boolean; description: string; surveyJson: Record<string, unknown>; draftAnswers: Record<string, number>; draftRevision: number; consentRequired: boolean }
export interface Privacy { version: string; title: string; sections: { title: string; body: string }[] }
/** Identifies an existing account that an administrator is issuing a recovery link for. */
export interface RecoveryTarget { memberId: string; memberName: string }
export class ApiError extends Error { constructor(message: string, public code: string, public status: number) { super(message); this.name = "ApiError"; } }
export function apiUrl(path: string, locale: Locale): string { return `${path}${path.includes("?") ? "&" : "?"}locale=${locale}`; }
export async function api<T>(path: string, locale: Locale, options: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown; signal?: AbortSignal; headers?: Record<string, string> } = {}): Promise<T> {
  const response = await fetch(apiUrl(path, locale), { method: options.method || "GET", credentials: "same-origin", cache: "no-store", headers: { ...(options.body === undefined ? {} : { "Content-Type": "application/json" }), ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: options.signal });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(data?.error || (locale === "zh-HK" ? "服務暫時未能回應，請重試。" : "服务暂时未能响应，请重试。"), data?.code || "REQUEST_FAILED", response.status);
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
  return family && member ? scales.filter(scale => scale.status === "active" && scale.roles.includes(member.role) && family.age >= scale.minAge && family.age <= scale.maxAge) : [];
}
