import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

// The privacy notice records these as separate acts. A legacy row may still
// list more than one of them; readers treat every listed purpose as granted.
export const PARTICIPATION_SCOPES = ["assessment", "sensitive_data"] as const;
export const PARENT_REPORT_SCOPE = "parent_report";
export const ACTIVE_CONSENT_ROWS_SQL = "SELECT scopes FROM consents WHERE family_id=$1 AND revoked_at IS NULL";

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
