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

function consentAlias(alias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error("Unsafe consent alias");
  return alias;
}

function familyExpr(expr: string): string {
  if (!/^(\$[1-9][0-9]*|(?:[A-Za-z_][A-Za-z0-9_]*\.)?[A-Za-z_][A-Za-z0-9_]*)$/.test(expr)) throw new Error("Unsafe family id expression");
  return expr;
}

function scopeExpr(expr: string): string {
  if (!/^(\$[1-9][0-9]*|'[a-z_]+'|[A-Za-z_][A-Za-z0-9_]*)$/.test(expr)) throw new Error("Unsafe scope expression");
  return expr;
}

// One predicate for every read. A purpose listed on an active row is granted
// only when consent_scope_revocations does not name it.
export function scopeNotRevokedSql(alias: string, scope: string): string {
  const name = consentAlias(alias);
  return `NOT EXISTS (SELECT 1 FROM consent_scope_revocations r WHERE r.consent_id=${name}.id AND r.scope=${scopeExpr(scope)})`;
}

export function effectiveScopesSelect(alias: string): string {
  const name = consentAlias(alias);
  return `(
  SELECT COALESCE(jsonb_agg(to_jsonb(scope_name)), '[]'::jsonb)
  FROM jsonb_array_elements_text(${name}.scopes) AS scope_name
  WHERE ${scopeNotRevokedSql(name, "scope_name")}
)`;
}

export function consentScopePredicate(alias: string, scope: ConsentScope): string {
  const name = consentAlias(alias);
  return `${name}.revoked_at IS NULL AND ${name}.scopes @> '["${scope}"]'::jsonb AND ${scopeNotRevokedSql(name, `'${scope}'`)}`;
}

export const ACTIVE_CONSENT_ROWS_SQL = `SELECT ${effectiveScopesSelect("consents")} AS scopes FROM consents WHERE family_id=$1 AND revoked_at IS NULL`;

export function consentScopeGrantedSql(familyIdExpr: string, scope: ConsentScope): string {
  return `EXISTS (SELECT 1 FROM consents c WHERE c.family_id=${familyExpr(familyIdExpr)} AND ${consentScopePredicate("c", scope)})`;
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
