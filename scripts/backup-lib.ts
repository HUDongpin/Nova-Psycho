import { createHash,createCipheriv,createDecipheriv,randomBytes } from "node:crypto";
import { createReadStream,createWriteStream } from "node:fs";
import { appendFile,chmod,copyFile,mkdir,mkdtemp,open,readdir,rm,stat,writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import pg from "pg";
import { getConfig } from "../src/lib/config";
import { acquireExclusiveReportRetentionLock,assertPrivatePdfKey,privatePdfPath,releaseExclusiveReportRetentionLock } from "../src/lib/report-retention";

// Shared helpers for the backup and restore scripts. Kept out of src/ because this
// is operational tooling that never runs inside the Next.js application.

export const run = promisify(execFile);

export const MAGIC = "NOVA1";
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
// Layout: MAGIC | nonce | ciphertext | auth tag. The tag trails the payload so the
// file can be written in one streaming pass; the tag is not known until the last block.
export const FRONT_BYTES = MAGIC.length + NONCE_BYTES;
export const HEADER_BYTES = FRONT_BYTES + TAG_BYTES;

export interface BackupManifest {
  formatVersion: 1;
  region: "CN" | "HK";
  mode: "demo" | "service";
  createdAt: string;
  encrypted: boolean;
  // A fingerprint lets restore detect a wrong key without ever storing the key.
  reportKeyFingerprint: string;
  database: { file: string; bytes: number; sha256: string; tables: Record<string, number> };
  reports: { file: string; bytes: number; sha256: string; fileCount: number };
  tools: { node: string; pgDump: string };
}

export function maskUrl(url: string): string {
  return url.replace(/:\/\/([^:@/]+):[^@]*@/, "://$1:***@");
}

export function parseDbUrl(url: string) {
  const parsed = new URL(url);
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) throw new Error(`Not a PostgreSQL URL: ${maskUrl(url)}`);
  return {
    host: parsed.hostname,
    port: parsed.port || "5432",
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, "")
  };
}

// The password is passed through the environment, never as an argument, so it
// cannot be read out of the process table.
export function pgConnection(url: string): { args: string[]; env: NodeJS.ProcessEnv; label: string } {
  const c = parseDbUrl(url);
  return {
    args: ["--host", c.host, "--port", c.port, "--username", c.user, "--dbname", c.database],
    env: { ...process.env, PGPASSWORD: c.password },
    label: `${c.host}:${c.port}/${c.database}`
  };
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

export function fingerprintKey(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

// Same framing as the report store: MAGIC | nonce | auth tag | ciphertext.
// The header and tag are written with explicit file operations rather than by
// interleaving writes around a pipeline, so their positions cannot depend on
// stream buffering order.
export async function encryptFile(source: string, destination: string, key: Buffer): Promise<void> {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  await writeFile(destination, Buffer.concat([Buffer.from(MAGIC), nonce]), { mode: 0o600 });
  await pipeline(createReadStream(source), cipher, createWriteStream(destination, { flags: "a" }));
  await appendFile(destination, cipher.getAuthTag());
}

export async function decryptFile(source: string, destination: string, key: Buffer): Promise<void> {
  const { size } = await stat(source);
  if (size < HEADER_BYTES) throw new Error("Backup file is too short to be valid");
  const handle = await open(source, "r");
  const front = Buffer.alloc(FRONT_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    await handle.read(front, 0, FRONT_BYTES, 0);
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    await handle.close();
  }
  if (front.subarray(0, MAGIC.length).toString() !== MAGIC) throw new Error("Backup file is not in the expected encrypted format");
  const decipher = createDecipheriv("aes-256-gcm", key, front.subarray(MAGIC.length, FRONT_BYTES));
  decipher.setAuthTag(tag);
  try {
    await pipeline(createReadStream(source, { start: FRONT_BYTES, end: size - TAG_BYTES - 1 }), decipher, createWriteStream(destination, { mode: 0o600 }));
  } catch (error) {
    await rm(destination, { force: true });
    // A wrong key surfaces as an authentication failure, not as readable output.
    throw new Error(`Could not decrypt ${source}. The backup key does not match, or the file is damaged. (${(error as Error).message})`);
  }
}

export function backupKeyFromEnv(name = "NOVA_BACKUP_KEY"): Buffer | null {
  const raw = process.env[name];
  if (!raw) return null;
  if (!/^[a-f0-9]{64}$/i.test(raw)) throw new Error(`${name} must be 64 hex characters (32 bytes)`);
  return Buffer.from(raw, "hex");
}

export function requireReportKey(): Buffer {
  const raw = process.env.NOVA_REPORT_KEY ?? "";
  if (!/^[a-f0-9]{64}$/i.test(raw)) throw new Error("NOVA_REPORT_KEY must be 64 hex characters (32 bytes)");
  return Buffer.from(raw, "hex");
}

export function timestampSlug(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-").replace("Z", "Z");
}

export const COUNTED_TABLES = [
  "users","families","memberships","consents","invitations","scales","content_versions",
  "assessments","reports","report_jobs","goals","observations","audit_events","file_deletion_jobs"
] as const;
export type CountedTable = typeof COUNTED_TABLES[number];

export function isCountedTable(name: string): name is CountedTable {
  return (COUNTED_TABLES as readonly string[]).includes(name);
}

export function countedTableSql(table: string): string {
  if (!isCountedTable(table)) throw new Error(`Unsupported table name: ${table}`);
  return `SELECT count(*)::int AS n FROM ${table}`;
}

export function collectReferencedPdfKeys(rows: { pdf_keys: unknown }[]): string[] {
  const keys = new Set<string>();
  for (const row of rows) {
    const value = row.pdf_keys;
    if (value == null) continue;
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("reports.pdf_keys must be an object of filenames");
    for (const entry of Object.values(value as Record<string, unknown>)) {
      if (typeof entry !== "string") throw new Error("reports.pdf_keys must contain filename strings");
      keys.add(assertPrivatePdfKey(entry));
    }
  }
  return [...keys].sort();
}

export async function stageReferencedReports(reportDir: string, stagingDir: string, keys: string[]): Promise<number> {
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  for (const key of keys) {
    const source = privatePdfPath(reportDir, key);
    const destination = privatePdfPath(stagingDir, key);
    try {
      await copyFile(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Referenced report file is missing: ${key}`);
      throw error;
    }
    await chmod(destination, 0o600);
  }
  const staged = (await readdir(stagingDir)).filter(name => {
    try { assertPrivatePdfKey(name); return true; } catch { return false; }
  });
  if (staged.length !== keys.length) throw new Error(`Staged ${staged.length} report files, expected ${keys.length}`);
  return staged.length;
}

export async function missingRestoredReportKeys(reportDir: string, rows: { pdf_keys: unknown }[]): Promise<string[]> {
  const missing: string[] = [];
  for (const key of collectReferencedPdfKeys(rows)) {
    try {
      await stat(privatePdfPath(reportDir, key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") missing.push(key);
      else throw error;
    }
  }
  return missing;
}

export interface BackupSnapshotContext {
  snapshotId: string;
  counts: Record<CountedTable, number>;
  pdfKeys: string[];
}

export async function withConsistentBackupSnapshot<T>(fn: (ctx: BackupSnapshotContext) => Promise<T>): Promise<T> {
  const config = getConfig();
  const lockClient = new pg.Client({ connectionString: config.databaseUrl });
  const snapshotClient = new pg.Client({ connectionString: config.databaseUrl });
  let lockHeld = false;
  let snapshotOpen = false;
  try {
    await lockClient.connect();
    try {
      await acquireExclusiveReportRetentionLock(lockClient);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not acquire the report retention lock within 60s. ${message}`);
    }
    lockHeld = true;

    await snapshotClient.connect();
    await snapshotClient.query("SET statement_timeout = 0");
    await snapshotClient.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    snapshotOpen = true;
    const exported = await snapshotClient.query<{ snapshot_id: string }>("SELECT pg_export_snapshot() AS snapshot_id");
    const settings = await snapshotClient.query<{ region: string; mode: string }>("SELECT region, mode FROM deployment_settings WHERE singleton=true");
    if (settings.rows[0]?.region !== config.region) throw new Error("Database region does not match process region");
    if (settings.rows[0]?.mode !== config.mode) throw new Error("Database data classification does not match process mode");

    const counts = {} as Record<CountedTable, number>;
    for (const table of COUNTED_TABLES) {
      const counted = await snapshotClient.query<{ n: number }>(countedTableSql(table));
      if (counted.rows[0] == null) throw new Error(`Could not count ${table}`);
      counts[table] = counted.rows[0].n;
    }
    const pdfRows = await snapshotClient.query<{ pdf_keys: unknown }>("SELECT pdf_keys FROM reports");
    const result = await fn({
      snapshotId: exported.rows[0].snapshot_id,
      counts,
      pdfKeys: collectReferencedPdfKeys(pdfRows.rows)
    });
    await snapshotClient.query("COMMIT");
    snapshotOpen = false;
    return result;
  } finally {
    if (snapshotOpen) {
      try { await snapshotClient.query("ROLLBACK"); } catch { /* closing */ }
    }
    try { await snapshotClient.end(); } catch { /* closed */ }
    if (lockHeld) {
      try { await releaseExclusiveReportRetentionLock(lockClient); } catch { /* closing */ }
    }
    try { await lockClient.end(); } catch { /* closed */ }
  }
}

export interface CreatedBackup {
  target: string;
  manifest: BackupManifest;
}

export async function createExclusiveBackupTarget(target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Backup directory already exists: ${target}`);
    }
    throw error;
  }
}

export async function createRegionalBackup(): Promise<CreatedBackup> {
  const config = getConfig();
  if (config.reportStorage === "database") throw new Error("Database-backed reports require a PostgreSQL backup including report_files and a separately preserved NOVA_REPORT_KEY. The filesystem backup command does not support this storage mode.");
  const backupKey = backupKeyFromEnv();
  const reportKey = requireReportKey();
  const root = path.resolve(process.env.NOVA_BACKUP_DIR ?? "work/backups");
  const publicAssets = path.resolve("public");
  if (root === publicAssets || root.startsWith(publicAssets + path.sep)) {
    throw new Error("Backups must not be written inside public assets");
  }

  const connection = pgConnection(config.databaseUrl);
  const { stdout: pgDumpVersion } = await run("pg_dump", ["--version"]);
  const target = path.join(root, config.region, timestampSlug());
  let finalized = false;
  let targetCreated = false;

  try {
    const dumpPath = path.join(target, "database.dump");
    const reportArchivePath = path.join(target, "reports.tar.gz");
    const snapshotResult = await withConsistentBackupSnapshot(async ctx => {
      await createExclusiveBackupTarget(target);
      targetCreated = true;
      console.log(`Backing up ${config.region} (${config.mode}) from ${connection.label}`);
      console.log(`Destination: ${target}`);

      await run("pg_dump", [...connection.args, "--format=custom", "--no-owner", "--no-acl", `--snapshot=${ctx.snapshotId}`, "--file", dumpPath], { env: connection.env });
      await chmod(dumpPath, 0o600);

      const { stdout: dumpContents } = await run("pg_restore", ["--list", dumpPath]);
      const archivedTables = (dumpContents.match(/TABLE DATA/g) ?? []).length;
      if (archivedTables === 0) throw new Error("The dump contains no table data; refusing to record a backup that would restore nothing");

      const stagingDir = await mkdtemp(path.join(target, ".staging-"));
      try {
        const fileCount = await stageReferencedReports(config.reportDir, stagingDir, ctx.pdfKeys);
        await run("tar", ["-czf", reportArchivePath, "-C", stagingDir, "."]);
        await chmod(reportArchivePath, 0o600);
        return { counts: ctx.counts, fileCount, archivedTables };
      } finally {
        await rm(stagingDir, { recursive: true, force: true });
      }
    });

    let databaseFile = "database.dump";
    let reportsFile = "reports.tar.gz";
    if (backupKey) {
      databaseFile = "database.dump.enc";
      reportsFile = "reports.tar.gz.enc";
      try {
        await encryptFile(dumpPath, path.join(target, databaseFile), backupKey);
        await encryptFile(reportArchivePath, path.join(target, reportsFile), backupKey);
      } finally {
        await rm(dumpPath, { force: true });
        await rm(reportArchivePath, { force: true });
      }
    }

    const databaseBytes = (await stat(path.join(target, databaseFile))).size;
    const reportsBytes = (await stat(path.join(target, reportsFile))).size;
    const manifest: BackupManifest = {
      formatVersion: 1,
      region: config.region,
      mode: config.mode,
      createdAt: new Date().toISOString(),
      encrypted: Boolean(backupKey),
      reportKeyFingerprint: fingerprintKey(reportKey),
      database: { file: databaseFile, bytes: databaseBytes, sha256: await sha256File(path.join(target, databaseFile)), tables: snapshotResult.counts },
      reports: { file: reportsFile, bytes: reportsBytes, sha256: await sha256File(path.join(target, reportsFile)), fileCount: snapshotResult.fileCount },
      tools: { node: process.version, pgDump: pgDumpVersion.trim() }
    };
    await writeFile(path.join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    finalized = true;

    console.log("");
    console.log(`  database    ${databaseFile}  ${databaseBytes} bytes  ${snapshotResult.archivedTables} table(s)`);
    console.log(`  reports     ${reportsFile}  ${reportsBytes} bytes  ${snapshotResult.fileCount} referenced encrypted file(s)`);
    console.log(`  encrypted   ${manifest.encrypted ? "yes (AES-256-GCM)" : "NO"}`);
    console.log(`  key print   ${manifest.reportKeyFingerprint}`);
    console.log("");
    console.log(`Rows: ${Object.entries(snapshotResult.counts).map(([table, n]) => `${table}=${n}`).join(" ")}`);
    if (!manifest.encrypted) {
      console.log("");
      console.log("WARNING: NOVA_BACKUP_KEY was not set, so this backup is not encrypted at the file level.");
      console.log("The database dump contains answer and snapshot data in plaintext. Store it only on");
      console.log("encrypted, access-controlled media, or set NOVA_BACKUP_KEY and take the backup again.");
    }
    console.log("");
    console.log("The report encryption key is NOT in this backup, by design. Back it up separately:");
    console.log("without the matching key, every restored PDF is permanently unreadable.");
    console.log(`Restore with: node scripts/run-region.mjs ${config.region} restore ${target}`);
    return { target, manifest };
  } finally {
    if (!finalized && targetCreated) await rm(target, { recursive: true, force: true });
  }
}
