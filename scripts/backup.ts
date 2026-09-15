import fs from "node:fs/promises";
import path from "node:path";
import { backupKeyFromEnv, encryptFile, fingerprintKey, pgConnection, requireReportKey, run, sha256File, timestampSlug, type BackupManifest } from "./backup-lib";
import { getConfig } from "../src/lib/config";
import { closeDatabase, query } from "../src/lib/db";

// Creates one regional backup: a transactionally consistent database dump, an archive
// of the private report directory, and a manifest describing both.
//
// The report encryption key is deliberately NOT included. It is recorded only as a
// fingerprint so that restore can detect a mismatched key. Per docs/deployment.md the
// key is backed up separately under its own controls and must never travel with the
// database and report files.
//
// Run with: node scripts/run-region.mjs CN backup

const COUNTED_TABLES = ["users","families","memberships","consents","invitations","scales","content_versions","assessments","reports","report_jobs","goals","observations","audit_events","file_deletion_jobs"];

const config = getConfig();
const backupKey = backupKeyFromEnv();
const reportKey = requireReportKey();

const root = path.resolve(process.env.NOVA_BACKUP_DIR ?? "work/backups");
const publicAssets = path.resolve("public");
if (root === publicAssets || root.startsWith(publicAssets + path.sep)) {
  throw new Error("Backups must not be written inside public assets");
}

const target = path.join(root, config.region, timestampSlug());
await fs.mkdir(target, { recursive: true, mode: 0o700 });

const dumpPath = path.join(target, "database.dump");
const reportArchivePath = path.join(target, "reports.tar.gz");

const connection = pgConnection(config.databaseUrl);
console.log(`Backing up ${config.region} (${config.mode}) from ${connection.label}`);
console.log(`Destination: ${target}`);

const { stdout: pgDumpVersion } = await run("pg_dump", ["--version"]);
await run("pg_dump", [...connection.args, "--format=custom", "--no-owner", "--no-acl", "--file", dumpPath], { env: connection.env });
await fs.chmod(dumpPath, 0o600);

// Confirm the dump is readable rather than trusting the exit code alone. In the
// pg_restore listing the "TABLE DATA" token sits mid-line after the OID columns, so
// it must not be anchored to the start of the line.
const { stdout: dumpContents } = await run("pg_restore", ["--list", dumpPath]);
const archivedTables = (dumpContents.match(/TABLE DATA/g) ?? []).length;
if (archivedTables === 0) throw new Error("The dump contains no table data; refusing to record a backup that would restore nothing");

const reportDirExists = await fs.stat(config.reportDir).then(() => true).catch(() => false);
if (reportDirExists) {
  await run("tar", ["-czf", reportArchivePath, "-C", config.reportDir, "."]);
} else {
  await fs.mkdir(config.reportDir, { recursive: true, mode: 0o700 });
  await run("tar", ["-czf", reportArchivePath, "-C", config.reportDir, "."]);
}
await fs.chmod(reportArchivePath, 0o600);
const reportFileCount = (await fs.readdir(config.reportDir)).length;

const counts: Record<string, number> = {};
for (const table of COUNTED_TABLES) {
  const rows = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  counts[table] = rows[0].n;
}

let databaseFile = "database.dump";
let reportsFile = "reports.tar.gz";
if (backupKey) {
  databaseFile = "database.dump.enc";
  reportsFile = "reports.tar.gz.enc";
  await encryptFile(dumpPath, path.join(target, databaseFile), backupKey);
  await encryptFile(reportArchivePath, path.join(target, reportsFile), backupKey);
  await fs.rm(dumpPath, { force: true });
  await fs.rm(reportArchivePath, { force: true });
}

const databaseBytes = (await fs.stat(path.join(target, databaseFile))).size;
const reportsBytes = (await fs.stat(path.join(target, reportsFile))).size;

const manifest: BackupManifest = {
  formatVersion: 1,
  region: config.region,
  mode: config.mode,
  createdAt: new Date().toISOString(),
  encrypted: Boolean(backupKey),
  reportKeyFingerprint: fingerprintKey(reportKey),
  database: { file: databaseFile, bytes: databaseBytes, sha256: await sha256File(path.join(target, databaseFile)), tables: counts },
  reports: { file: reportsFile, bytes: reportsBytes, sha256: await sha256File(path.join(target, reportsFile)), fileCount: reportFileCount },
  tools: { node: process.version, pgDump: pgDumpVersion.trim() }
};
await fs.writeFile(path.join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

await closeDatabase();

console.log("");
console.log(`  database    ${databaseFile}  ${databaseBytes} bytes  ${archivedTables} table(s)`);
console.log(`  reports     ${reportsFile}  ${reportsBytes} bytes  ${reportFileCount} encrypted file(s)`);
console.log(`  encrypted   ${manifest.encrypted ? "yes (AES-256-GCM)" : "NO"}`);
console.log(`  key print   ${manifest.reportKeyFingerprint}`);
console.log("");
console.log(`Rows: ${Object.entries(counts).map(([table, n]) => `${table}=${n}`).join(" ")}`);
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
