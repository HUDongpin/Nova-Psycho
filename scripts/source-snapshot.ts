import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";

// Guards the sanitized source copies kept under work/. Such a copy is a frozen
// snapshot for delegation and audit, never a working tree, and nothing stops it
// from being edited in place or silently falling behind trunk.
//
// Two distinct failures are reported separately:
//   modified  the snapshot no longer matches its own manifest, so it was edited
//             in place. This is an integrity failure and exits non-zero.
//   drifted   trunk has moved on since the snapshot was taken. Expected over
//             time, informational only, exits zero.
//
// Usage:
//   tsx scripts/source-snapshot.ts record <snapshot-dir>
//   tsx scripts/source-snapshot.ts check  <snapshot-dir> [--against <trunk-dir>]

const SKIP_DIRECTORIES = new Set(["node_modules", ".next", ".next-hk", ".next-verify", "work", ".git", ".workbuddy-ai"]);
const SKIP_FILES = new Set([".DS_Store"]);
// Written into a snapshot but never present in trunk, so it would always be
// reported as "gone from trunk". It stays integrity-checked, just not compared.
const SNAPSHOT_ONLY_FILES = new Set(["SNAPSHOT-README.md"]);

interface Manifest {
  formatVersion: 1;
  recordedAt: string;
  root: string;
  fileCount: number;
  files: Record<string, string>;
}

async function walk(root: string, relative = ""): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      found.push(...await walk(root, path.join(relative, entry.name)));
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue;
      found.push(path.join(relative, entry.name));
    }
  }
  return found.sort();
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function fingerprint(root: string): Promise<Record<string, string>> {
  const files = await walk(root);
  const map: Record<string, string> = {};
  for (const relative of files) map[relative] = await sha256(path.join(root, relative));
  return map;
}

const manifestPath = (root: string) => `${root}.manifest.json`;

async function record(root: string): Promise<void> {
  const files = await fingerprint(root);
  const manifest: Manifest = {
    formatVersion: 1,
    recordedAt: new Date().toISOString(),
    root: path.basename(root),
    fileCount: Object.keys(files).length,
    files
  };
  await fs.writeFile(manifestPath(root), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Recorded ${manifest.fileCount} files from ${root}`);
  console.log(`Manifest: ${manifestPath(root)}`);
}

async function check(root: string, trunk: string): Promise<number> {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath(root), "utf8")) as Manifest;
  } catch {
    console.error(`No manifest at ${manifestPath(root)}. Run 'record' first.`);
    return 2;
  }

  const current = await fingerprint(root);

  // Integrity: has the snapshot itself been edited since it was recorded?
  const edited = Object.keys(current).filter(file => manifest.files[file] !== undefined && manifest.files[file] !== current[file]);
  const added = Object.keys(current).filter(file => manifest.files[file] === undefined);
  const removed = Object.keys(manifest.files).filter(file => current[file] === undefined);

  // Staleness: how far has trunk moved since the snapshot was taken?
  const trunkFiles = await fingerprint(trunk);
  const changedInTrunk = Object.keys(manifest.files).filter(file => trunkFiles[file] !== undefined && trunkFiles[file] !== manifest.files[file]);
  const goneFromTrunk = Object.keys(manifest.files).filter(file => trunkFiles[file] === undefined && !SNAPSHOT_ONLY_FILES.has(file));
  const newInTrunk = Object.keys(trunkFiles).filter(file => manifest.files[file] === undefined && !SNAPSHOT_ONLY_FILES.has(file));

  console.log(`Snapshot : ${root}`);
  console.log(`Recorded : ${manifest.recordedAt} (${manifest.fileCount} files)`);
  console.log("");
  console.log(`  snapshot edited in place : ${edited.length + added.length + removed.length}`);
  console.log(`  trunk changed since then : ${changedInTrunk.length}`);
  console.log(`  removed from trunk       : ${goneFromTrunk.length}`);
  console.log(`  added to trunk since     : ${newInTrunk.length}`);
  console.log("");

  const integrityFailures = edited.length + added.length + removed.length;
  if (integrityFailures) {
    console.log("INTEGRITY FAILURE — the snapshot is no longer the tree that was recorded.");
    for (const file of edited.slice(0, 10)) console.log(`  edited  ${file}`);
    for (const file of added.slice(0, 10)) console.log(`  added   ${file}`);
    for (const file of removed.slice(0, 10)) console.log(`  removed ${file}`);
    console.log("");
  }

  if (changedInTrunk.length || goneFromTrunk.length || newInTrunk.length) {
    console.log("The snapshot is stale. That is expected over time; it is still not a working tree.");
    for (const file of changedInTrunk.slice(0, 10)) console.log(`  trunk moved on  ${file}`);
    for (const file of goneFromTrunk.slice(0, 10)) console.log(`  gone from trunk ${file}`);
    for (const file of newInTrunk.slice(0, 10)) console.log(`  new in trunk    ${file}`);
    if (changedInTrunk.length + goneFromTrunk.length + newInTrunk.length > 30) console.log("  (list truncated)");
  } else {
    console.log("The snapshot matches the current trunk exactly.");
  }

  return integrityFailures ? 1 : 0;
}

const [command, target, ...rest] = process.argv.slice(2);
if (!command || !target || !["record", "check"].includes(command)) {
  console.error("Usage: tsx scripts/source-snapshot.ts <record|check> <snapshot-dir> [--against <trunk-dir>]");
  process.exit(2);
}
const againstIndex = rest.indexOf("--against");
const trunk = againstIndex >= 0 && rest[againstIndex + 1] ? path.resolve(rest[againstIndex + 1]) : process.cwd();

if (command === "record") await record(path.resolve(target));
else process.exit(await check(path.resolve(target), trunk));
