import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import pg from "pg";
import { backupKeyFromEnv, decryptFile, fingerprintKey, maskUrl, pgConnection, requireReportKey, run, sha256File, type BackupManifest } from "./backup-lib";

// Restores one regional backup into an ISOLATED environment.
//
// This script never writes to the database named by DATABASE_URL. The target is
// supplied explicitly through NOVA_RESTORE_DATABASE_URL and NOVA_RESTORE_REPORT_DIR,
// and it refuses to proceed unless that target is empty. docs/deployment.md is explicit
// that a restore drill must not run commands that overwrite an existing database, so the
// guards below are the point of the script rather than a courtesy.
//
// Run with: node scripts/run-region.mjs CN restore <backup-directory> [--verify-only]

const args = process.argv.slice(2).filter((value) => !value.startsWith("--"));
const flags = new Set(process.argv.slice(2).filter((value) => value.startsWith("--")));
const backupDir = args[0] ? path.resolve(args[0]) : null;
const verifyOnly = flags.has("--verify-only");

if (!backupDir) {
  console.error("Usage: node scripts/run-region.mjs <CN|HK> restore <backup-directory> [--verify-only]");
  process.exit(2);
}
for (const flag of flags) {
  if (flag !== "--verify-only") { console.error(`Unknown option: ${flag}`); process.exit(2); }
}

const manifest = JSON.parse(await fs.readFile(path.join(backupDir, "manifest.json"), "utf8")) as BackupManifest;
if (manifest.formatVersion !== 1) throw new Error(`Unsupported backup format version: ${manifest.formatVersion}`);

console.log(`Backup ${manifest.region} (${manifest.mode}) created ${manifest.createdAt}, encrypted: ${manifest.encrypted ? "yes" : "no"}`);

// 1. Checksums first: never act on a damaged archive.
const databasePath = path.join(backupDir, manifest.database.file);
const reportsPath = path.join(backupDir, manifest.reports.file);
for (const [label, file, expected] of [["database", databasePath, manifest.database.sha256], ["reports", reportsPath, manifest.reports.sha256]] as const) {
  const actual = await sha256File(file);
  if (actual !== expected) throw new Error(`Checksum mismatch for the ${label} archive. The backup is damaged or was modified.`);
  console.log(`  checksum ok  ${label}`);
}

// 2. The report key must match, or every restored PDF would be unreadable.
const reportKey = requireReportKey();
const actualFingerprint = fingerprintKey(reportKey);
if (actualFingerprint !== manifest.reportKeyFingerprint) {
  throw new Error(`NOVA_REPORT_KEY does not match this backup (expected ${manifest.reportKeyFingerprint}, got ${actualFingerprint}). Restoring anyway would produce permanently unreadable PDFs.`);
}
console.log("  report key matches the backup");

if (verifyOnly) {
  console.log("");
  console.log("Verification only: checksums and report key are valid. Nothing was restored.");
  process.exit(0);
}

// 3. Resolve and validate the target. This is the destructive-operation gate.
const targetUrl = process.env.NOVA_RESTORE_DATABASE_URL;
const targetReportDir = process.env.NOVA_RESTORE_REPORT_DIR;
const targetRegion = process.env.NOVA_RESTORE_REGION ?? manifest.region;

if (!targetUrl || !targetReportDir) {
  throw new Error("Set NOVA_RESTORE_DATABASE_URL and NOVA_RESTORE_REPORT_DIR to the isolated target. Restoring into the live environment is not supported.");
}
if (process.env.DATABASE_URL && targetUrl === process.env.DATABASE_URL) {
  throw new Error("The restore target is the same database as DATABASE_URL. Refusing to overwrite a live environment.");
}
if (targetRegion !== manifest.region) {
  throw new Error(`Region mismatch: the backup is ${manifest.region} but the target is ${targetRegion}. Regional data must not cross regions.`);
}

const target = pgConnection(targetUrl);
console.log(`Target: ${target.label}  (backup source is a different database)`);

const client = new pg.Client({ host: target.args[1], port: Number(target.args[3]), user: target.args[5], password: target.env.PGPASSWORD, database: target.args[7] });
try {
  await client.connect();
} catch (error) {
  console.error("");
  console.error(`Could not connect to the restore target.`);
  console.error(`Create an empty database first, for example:`);
  console.error(`  createdb -h ${target.args[1]} -p ${target.args[3]} -U ${target.args[5]} <new-database-name>`);
  throw error;
}

try {
  const existing = await client.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'");
  if (existing.rows[0].n > 0) {
    throw new Error(`The restore target already contains ${existing.rows[0].n} table(s) in the public schema. Refusing to restore over existing data. Create a new, empty database for the drill.`);
  }
  console.log("  target schema is empty");

  const reportDirEntries = await fs.readdir(path.resolve(targetReportDir)).catch(() => [] as string[]);
  if (reportDirEntries.length > 0) {
    throw new Error(`The restore target report directory already contains ${reportDirEntries.length} entry(ies). Refusing to restore over existing files.`);
  }
  console.log("  target report directory is empty");
} finally {
  await client.end();
}

// 4. Restore. Decrypt to temporary files when the backup is encrypted.
const temporaries: string[] = [];
let dumpToRestore = databasePath;
let reportsToRestore = reportsPath;
const backupKey = backupKeyFromEnv();
if (manifest.encrypted) {
  if (!backupKey) throw new Error("This backup is encrypted. Set NOVA_BACKUP_KEY to the key used when it was taken.");
  dumpToRestore = path.join(backupDir, ".restore-database.dump");
  reportsToRestore = path.join(backupDir, ".restore-reports.tar.gz");
  temporaries.push(dumpToRestore, reportsToRestore);
  await decryptFile(databasePath, dumpToRestore, backupKey);
  await decryptFile(reportsPath, reportsToRestore, backupKey);
  console.log("  decrypted");
}

try {
  await run("pg_restore", [...target.args, "--no-owner", "--no-acl", "--exit-on-error", dumpToRestore], { env: target.env });
  console.log("  database restored");

  await fs.mkdir(path.resolve(targetReportDir), { recursive: true, mode: 0o700 });
  await run("tar", ["-xzf", reportsToRestore, "-C", path.resolve(targetReportDir)]);
  await fs.chmod(path.resolve(targetReportDir), 0o700);
  console.log("  report files restored");
} finally {
  for (const file of temporaries) await fs.rm(file, { force: true });
}

// 5. Verify the result rather than trusting the exit codes.
const verify = new pg.Client({ host: target.args[1], port: Number(target.args[3]), user: target.args[5], password: target.env.PGPASSWORD, database: target.args[7] });
await verify.connect();
let failures = 0;
try {
  const settings = await verify.query("SELECT region, mode FROM deployment_settings WHERE singleton=true");
  const row = settings.rows[0];
  const regionOk = row?.region === manifest.region;
  const modeOk = row?.mode === manifest.mode;
  console.log("");
  console.log(`  ${regionOk ? "ok  " : "FAIL"} region ${row?.region ?? "(missing)"} expected ${manifest.region}`);
  console.log(`  ${modeOk ? "ok  " : "FAIL"} mode ${row?.mode ?? "(missing)"} expected ${manifest.mode}`);
  if (!regionOk || !modeOk) failures += 1;

  for (const [table, expected] of Object.entries(manifest.database.tables)) {
    const result = await verify.query(`SELECT count(*)::int AS n FROM ${table}`);
    const actual = result.rows[0].n;
    const ok = actual === expected;
    if (!ok) failures += 1;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${table} ${actual}${ok ? "" : ` expected ${expected}`}`);
  }
} finally {
  await verify.end();
}

const restoredReports = (await fs.readdir(path.resolve(targetReportDir))).length;
const reportsOk = restoredReports === manifest.reports.fileCount;
if (!reportsOk) failures += 1;
console.log(`  ${reportsOk ? "ok  " : "FAIL"} report files ${restoredReports} expected ${manifest.reports.fileCount}`);

console.log("");
if (failures) {
  console.log(`${failures} verification check(s) FAILED. Do not switch service traffic to this environment.`);
  process.exit(1);
}
console.log("Restore verified. Remaining manual checks before this environment serves traffic:");
console.log("  1. The report worker must be started (or already running) for this target; it completes physical deletion.");
console.log("  2. Open a historical report and confirm the PDF downloads and renders.");
console.log("  3. Publish one new assessment end to end and confirm automatic publication.");
console.log("  4. Confirm the deletion queue drains and that no orphaned report files remain.");
console.log("  5. Only then switch service traffic. This restore did not touch the live environment.");
console.log("");
console.log(`The restored environment uses the report key you supplied (${actualFingerprint}).`);
