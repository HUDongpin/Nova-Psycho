import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { HttpError } from "./http";

// The privacy notice records these as separate acts. A legacy row may still
// list more than one of them. A later withdrawal of one purpose is stored in
// consent_scope_revocations; the original row text stays. Readers grant a
// listed purpose only while that row is active and that purpose is not revoked.
export const PARTICIPATION_SCOPES = ["assessment", "sensitive_data"] as const;
export const PARENT_REPORT_SCOPE = "parent_report";
export const CONSENT_SCOPES = ["assessment", "parent_report", "sensitive_data", "ai_processing"] as const;
export type ConsentScope = typeof CONSENT_SCOPES[number];
export const REQUIRED_WITHDRAW_SCOPES = ["assessment", "sensitive_data"] as const;
export const ACTIVE_CONSENT_ROWS_SQL = `SELECT (
  SELECT COALESCE(jsonb_agg(to_jsonb(scope_name)), '[]'::jsonb)
  FROM jsonb_array_elements_text(consents.scopes) AS scope_name
  WHERE NOT EXISTS (
    SELECT 1 FROM consent_scope_revocations r
    WHERE r.consent_id = consents.id AND r.scope = scope_name
  )
) AS scopes FROM consents WHERE family_id=$1 AND revoked_at IS NULL`;

export function consentScopeGrantedSql(familyIdExpr: string, scope: ConsentScope): string {
  if (!/^(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*$/i.test(familyIdExpr)) throw new Error("Unsafe family id expression");
  return `EXISTS (SELECT 1 FROM consents c WHERE c.family_id=${familyIdExpr} AND c.revoked_at IS NULL AND c.scopes @> '["${scope}"]'::jsonb AND NOT EXISTS (SELECT 1 FROM consent_scope_revocations r WHERE r.consent_id=c.id AND r.scope='${scope}'))`;
}

export function scopeList(value: unknown): string[] {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  return value.filter((scope): scope is string => typeof scope === "string" && scope.length > 0);
}

export function grantedScopes(rows: { scopes?: unknown }[]): Set<string> {
  const granted = new Set<string>();
  for (const row of rows) for (const scope of scopeList(row.scopes)) granted.add(scope);
  return granted;
}

export function hasGranted(rows: { scopes?: unknown }[], required: readonly string[]): boolean {
  const granted = grantedScopes(rows);
  return required.every(scope => granted.has(scope));
}

export function rejectBundledConsent(input: unknown): void {
  if (input && typeof input === "object" && "accepted" in input) {
    throw new HttpError(422, "请分别提交测评、敏感资料和家长报告的同意选择，不能用一次同意代表三项。", "CONSENT_SCOPE_REQUIRED", "accepted");
  }
}

export function recordedScopes(choices: { assessment?: boolean; sensitiveData?: boolean; parentReport?: boolean; aiProcessing?: boolean }): string[] {
  const scopes: string[] = [];
  if (choices.assessment) scopes.push("assessment");
  if (choices.sensitiveData) scopes.push("sensitive_data");
  if (choices.parentReport) scopes.push("parent_report");
  if (choices.aiProcessing) scopes.push("ai_processing");
  return scopes;
}

export async function insertConsentRecords(client: PoolClient, record: {
  familyId: string; actorId: string | null; guardianName: string;
  method: "online_guardian" | "offline_signed" | "synthetic"; reference?: string | null;
  noticeVersion: string; scopes: readonly string[];
}): Promise<void> {
  for (const scope of record.scopes) {
    await client.query(
      "INSERT INTO consents(id,family_id,actor_id,guardian_name,method,reference,notice_version,scopes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [randomUUID(), record.familyId, record.actorId, record.guardianName, record.method, record.reference ?? null, record.noticeVersion, JSON.stringify([scope])]
    );
  }
}
