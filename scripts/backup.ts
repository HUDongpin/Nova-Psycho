import { createRegionalBackup } from "./backup-lib";
import { closeDatabase } from "../src/lib/db";

// Creates one regional backup: a REPEATABLE READ snapshot dump, an archive of
// the report files that snapshot references, and a manifest describing both.
//
// The report encryption key is deliberately NOT included. It is recorded only as a
// fingerprint so that restore can detect a mismatched key. Per docs/deployment.md the
// key is backed up separately under its own controls and must never travel with the
// database and report files.
//
// Run with: node scripts/run-region.mjs CN backup

try {
  await createRegionalBackup();
} finally {
  await closeDatabase();
}
