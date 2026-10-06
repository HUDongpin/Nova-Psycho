import path from "node:path";

// Dedicated advisory-lock pair for report-file retention during backup.
// Backup takes the exclusive SESSION lock outside any transaction, then starts
// a REPEATABLE READ snapshot. Deletion takes the matching shared transaction
// lock so it waits for the copy to finish rather than racing it.
export const REPORT_RETENTION_LOCK_CLASS = 807001;
export const REPORT_RETENTION_LOCK_ID = 1;
export const REPORT_RETENTION_LOCK_TIMEOUT = "60s";

export const PRIVATE_PDF_KEY_PATTERN = /^[0-9a-f-]{36}\.[0-9a-f-]{36}\.zh-(CN|HK)\.pdf\.enc$/;

type Queryable = { query: (sql: string, values?: unknown[]) => Promise<unknown> };

export function assertPrivatePdfKey(key: string): string {
  if (typeof key !== "string" || !PRIVATE_PDF_KEY_PATTERN.test(key)) throw new Error("Invalid private report key");
  return key;
}

export function privatePdfPath(reportDir: string, key: string): string {
  assertPrivatePdfKey(key);
  const root = path.resolve(reportDir);
  const dest = path.resolve(root, key);
  if (path.dirname(dest) !== root || dest === root || !dest.startsWith(root + path.sep)) {
    throw new Error("Invalid private report key");
  }
  return dest;
}

export async function acquireSharedReportRetentionLock(client: Queryable): Promise<void> {
  // The application pool sets a 15s statement_timeout. A backup can hold the
  // exclusive lock through dump and copy, so deletion must wait rather than fail.
  await client.query("SET LOCAL statement_timeout = 0");
  await client.query("SET LOCAL lock_timeout = 0");
  await client.query("SELECT pg_advisory_xact_lock_shared($1, $2)", [REPORT_RETENTION_LOCK_CLASS, REPORT_RETENTION_LOCK_ID]);
}

export async function acquireExclusiveReportRetentionLock(client: Queryable): Promise<void> {
  await client.query(`SET lock_timeout = '${REPORT_RETENTION_LOCK_TIMEOUT}'`);
  await client.query("SELECT pg_advisory_lock($1, $2)", [REPORT_RETENTION_LOCK_CLASS, REPORT_RETENTION_LOCK_ID]);
}

export async function releaseExclusiveReportRetentionLock(client: Queryable): Promise<void> {
  await client.query("SELECT pg_advisory_unlock($1, $2)", [REPORT_RETENTION_LOCK_CLASS, REPORT_RETENTION_LOCK_ID]);
}
