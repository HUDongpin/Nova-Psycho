import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { assignFamily, recordConsent } from "../src/lib/families";
import { closeDatabase, pool } from "../src/lib/db";
import { HttpError } from "../src/lib/http";
import { getConfig } from "../src/lib/config";
import { familyScope } from "../src/lib/access";
import { ACTIVE_CONSENT_ROWS_SQL, hasGranted } from "../src/lib/consent";
import { noticeVersion } from "../src/lib/privacy";
import type { Actor } from "../src/domain/types";
import { assertThrowawayDatabase, TestDatabaseRefused } from "./test-database-guard";

// Real-lock regression for a consent withdrawal that started before reassignment.
// The old staff request must wait on the family row, lose the assignment, then
// be refused with the original parent_report grant unchanged.
// Run only against the throwaway server:
//   DATABASE_URL=postgresql://127.0.0.1:55432/nova_consent_race \
//   NOVA_REGION=CN NOVA_MODE=demo NOVA_PUBLIC_URL=http://127.0.0.1:3199 \
//   NOVA_REPORT_DIR=/tmp/nova-consent-race-reports NOVA_REPORT_KEY=<64 hex chars> \
//   NOVA_AI_ENABLED=false npm run test:consent-race

const region = "CN" as const;
const oldStaff: Actor = { id: randomUUID(), name: "Synthetic old staff", role: "staff", region };
const newStaff: Actor = { id: randomUUID(), name: "Synthetic new staff", role: "staff", region };
const admin: Actor = { id: randomUUID(), name: "Synthetic admin", role: "admin", region };
const parent: Actor = { id: randomUUID(), name: "Synthetic parent", role: "parent", region };

function assertConsentRaceTarget(): void {
  let url: URL;
  try { url = new URL(getConfig().databaseUrl); }
  catch { throw new TestDatabaseRefused("DATABASE_URL is not a URL"); }
  if (url.hostname !== "127.0.0.1" || url.port !== "55432" || url.pathname !== "/nova_consent_race") {
    throw new TestDatabaseRefused("Consent race refuses any database except 127.0.0.1:55432/nova_consent_race");
  }
}

async function waitForFamilyLock(match: RegExp): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const rows = await pool().query<{ query: string }>(
      "SELECT query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND state='active'"
    );
    if (rows.rows.some(row => match.test(row.query) && /FOR UPDATE/i.test(row.query))) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for a family lock: ${match}`);
}

async function raceReassignment(): Promise<void> {
  const familyId = randomUUID();
  const consentId = randomUUID();
  await pool().query(
    "INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label,assigned_to) VALUES($1,'CN','Synthetic race family','Synthetic child','2014-01-02','S2','Synthetic guardian',$2)",
    [familyId, oldStaff.id]
  );
  await pool().query(
    "INSERT INTO consents(id,family_id,actor_id,guardian_name,method,reference,notice_version,scopes) VALUES($1,$2,$3,'Synthetic guardian','offline_signed','SYNTHETIC-ORIGINAL',$4,$5)",
    [consentId, familyId, admin.id, noticeVersion, JSON.stringify(["parent_report"])]
  );
  assert.equal((await pool().query("SELECT id FROM staff_alerts WHERE family_id=$1", [familyId])).rowCount, 0);
  const before = await pool().query("SELECT revoked_at FROM consents WHERE id=$1", [consentId]);
  assert.equal(before.rows[0].revoked_at, null);

  const holder = await pool().connect();
  let open = false;
  try {
    await holder.query("BEGIN");
    open = true;
    await holder.query("SELECT id FROM families WHERE id=$1 FOR UPDATE", [familyId]);
    let assignmentSettled = false;
    const assignment = assignFamily(admin, familyId, { assignedTo: newStaff.id }).then(
      value => { assignmentSettled = true; return value; },
      error => { assignmentSettled = true; throw error; }
    );
    await waitForFamilyLock(/SELECT id FROM families WHERE id=\$1 AND region=\$2 FOR UPDATE/);
    assert.equal(assignmentSettled, false, "reassignment finished before it was waiting on the family lock");
    let consentSettled = false;
    const consent = recordConsent(oldStaff, familyId, {
      action: "withdraw", scope: "parent_report", guardianName: "Synthetic guardian", reference: "SYNTHETIC-STALE"
    }).then(
      () => { consentSettled = true; return { refused: false as const }; },
      (error: unknown) => { consentSettled = true; return { refused: true as const, error }; }
    );
    await waitForFamilyLock(/FROM families f WHERE f\.id=\$1/);
    assert.equal(consentSettled, false, "the in-flight withdrawal finished before the family lock was released");
    await holder.query("COMMIT");
    open = false;
    const assigned = await assignment;
    assert.equal(assigned.assignedTo, newStaff.id);
    const stale = await consent;
    assert.equal(stale.refused, true, "the old staff withdrawal was accepted after reassignment");
    assert.ok(stale.error instanceof HttpError);
    assert.equal(stale.error.status, 404);
    assert.equal(stale.error.code, "NOT_FOUND");
    const saved = await pool().query<{ revoked_at: Date | null }>("SELECT revoked_at FROM consents WHERE id=$1", [consentId]);
    assert.equal(saved.rows[0].revoked_at, null);
    assert.equal((await pool().query("SELECT id FROM consent_scope_revocations WHERE family_id=$1", [familyId])).rowCount, 0);
    const fresh = recordConsent(oldStaff, familyId, {
      action: "withdraw", scope: "parent_report", guardianName: "Synthetic guardian", reference: "SYNTHETIC-FRESH"
    });
    await assert.rejects(fresh, (error: unknown) => error instanceof HttpError && error.status === 404);
    await recordConsent(newStaff, familyId, {
      action: "withdraw", scope: "parent_report", guardianName: "Synthetic guardian", reference: "SYNTHETIC-CURRENT"
    });
    const withdrawn = await pool().query<{ revoked_at: Date | null }>("SELECT revoked_at FROM consents WHERE id=$1", [consentId]);
    assert.notEqual(withdrawn.rows[0].revoked_at, null);
    await recordConsent(newStaff, familyId, {
      action: "grant", scope: "parent_report", guardianName: "Synthetic guardian", reference: "SYNTHETIC-CURRENT"
    });
    const restored = await pool().query(ACTIVE_CONSENT_ROWS_SQL, [familyId]);
    assert.equal(hasGranted(restored.rows, ["parent_report"]), true);
  } finally {
    if (open) await holder.query("ROLLBACK");
    holder.release();
  }
}

async function reassignmentWithAlertFollowsFamilyScope(): Promise<void> {
  // The in-lock check is familyScope, not a second alert rule. This branch's
  // helper still matches any staff_alerts row after the family is assigned to
  // someone else, so the old staff member stays allowed. PR #11 narrows that
  // helper to an unresolved alert only while assigned_to is null; the same
  // query then refuses the old staff member.
  const familyId = randomUUID();
  const consentId = randomUUID();
  await pool().query(
    "INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label,assigned_to) VALUES($1,'CN','Synthetic alert family','Synthetic child','2014-01-02','S2','Synthetic guardian',$2)",
    [familyId, oldStaff.id]
  );
  await pool().query("INSERT INTO staff_alerts(id,family_id,region) VALUES($1,$2,'CN')", [randomUUID(), familyId]);
  await pool().query(
    "INSERT INTO consents(id,family_id,actor_id,guardian_name,method,reference,notice_version,scopes) VALUES($1,$2,$3,'Synthetic guardian','offline_signed','SYNTHETIC-ALERT',$4,$5)",
    [consentId, familyId, admin.id, noticeVersion, JSON.stringify(["parent_report"])]
  );
  const holder = await pool().connect();
  let open = false;
  try {
    await holder.query("BEGIN");
    open = true;
    await holder.query("SELECT id FROM families WHERE id=$1 FOR UPDATE", [familyId]);
    const assignment = assignFamily(admin, familyId, { assignedTo: newStaff.id });
    await waitForFamilyLock(/SELECT id FROM families WHERE id=\$1 AND region=\$2 FOR UPDATE/);
    let consentSettled = false;
    const consent = recordConsent(oldStaff, familyId, {
      action: "withdraw", scope: "parent_report", guardianName: "Synthetic guardian", reference: "SYNTHETIC-ALERT-STALE"
    }).then(
      () => { consentSettled = true; return { refused: false as const }; },
      (error: unknown) => { consentSettled = true; return { refused: true as const, error }; }
    );
    await waitForFamilyLock(/FROM families f WHERE f\.id=\$1/);
    assert.equal(consentSettled, false, "the alert withdrawal finished before the family lock was released");
    await holder.query("COMMIT");
    open = false;
    await assignment;
    const stale = await consent;
    const scope = familyScope(oldStaff, 2);
    const visible = await pool().query(`SELECT f.id FROM families f WHERE f.id=$1 AND ${scope.sql}`, [familyId, ...scope.values]);
    const inScope = (visible.rowCount ?? 0) > 0;
    assert.equal(stale.refused, !inScope, "the locked consent check must follow familyScope after reassignment");
    const saved = await pool().query<{ revoked_at: Date | null }>("SELECT revoked_at FROM consents WHERE id=$1", [consentId]);
    assert.equal(saved.rows[0].revoked_at === null, !inScope);
    if (!inScope && stale.refused) {
      assert.ok(stale.error instanceof HttpError);
      assert.equal(stale.error.status, 404);
    }
  } finally {
    if (open) await holder.query("ROLLBACK");
    holder.release();
  }
}

async function legacyCarryForward(): Promise<void> {
  const familyId = randomUUID();
  const consentId = randomUUID();
  await pool().query(
    "INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label) VALUES($1,'CN','Synthetic legacy family','Synthetic child','2014-06-15','S2','Synthetic guardian')",
    [familyId]
  );
  await pool().query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,'parent')", [familyId, parent.id]);
  await pool().query(
    "INSERT INTO consents(id,family_id,actor_id,guardian_name,method,reference,notice_version,scopes,created_at) VALUES($1,$2,$3,'Synthetic original guardian','online_guardian','SYNTHETIC-ORIGINAL-REFERENCE','nova-privacy-2026-09-v1',$4,'2026-10-01T00:00:00Z')",
    [consentId, familyId, parent.id, JSON.stringify(["assessment", "parent_report", "sensitive_data"])]
  );
  const before = (await pool().query("SELECT to_jsonb(c) AS value FROM consents c WHERE id=$1", [consentId])).rows[0].value;
  await recordConsent(parent, familyId, { action: "withdraw", scope: "parent_report", guardianName: "Synthetic current guardian" });
  const after = (await pool().query("SELECT to_jsonb(c) AS value FROM consents c WHERE id=$1", [consentId])).rows[0].value;
  assert.deepEqual(after, before);
  const revocations = await pool().query<{ scope: string; consent_id: string }>("SELECT scope, consent_id FROM consent_scope_revocations WHERE family_id=$1", [familyId]);
  assert.deepEqual(revocations.rows, [{ scope: "parent_report", consent_id: consentId }]);
  assert.equal((await pool().query("SELECT id FROM consents WHERE family_id=$1", [familyId])).rowCount, 1);
  const active = await pool().query(ACTIVE_CONSENT_ROWS_SQL, [familyId]);
  assert.equal(hasGranted(active.rows, ["assessment", "sensitive_data"]), true);
  assert.equal(hasGranted(active.rows, ["parent_report"]), false);

  await recordConsent(parent, familyId, { action: "grant", scope: "parent_report", guardianName: "Synthetic new guardian" });
  const untouched = (await pool().query("SELECT to_jsonb(c) AS value FROM consents c WHERE id=$1", [consentId])).rows[0].value;
  assert.deepEqual(untouched, before);
  const added = await pool().query<{ notice_version: string; guardian_name: string; reference: string | null; scopes: string[] }>(
    "SELECT notice_version, guardian_name, reference, scopes FROM consents WHERE family_id=$1 AND id<>$2",
    [familyId, consentId]
  );
  assert.equal(added.rowCount, 1);
  assert.equal(added.rows[0].notice_version, noticeVersion);
  assert.equal(added.rows[0].guardian_name, "Synthetic new guardian");
  assert.equal(added.rows[0].reference, null);
  assert.deepEqual(added.rows[0].scopes, ["parent_report"]);
  const restored = await pool().query(ACTIVE_CONSENT_ROWS_SQL, [familyId]);
  assert.equal(hasGranted(restored.rows, ["assessment", "sensitive_data", "parent_report"]), true);
}

async function main() {
  assertConsentRaceTarget();
  await assertThrowawayDatabase();
  const schema = await fs.readFile(new URL("../src/lib/schema.sql", import.meta.url), "utf8");
  await pool().query(schema);
  const config = getConfig();
  await pool().query(
    "INSERT INTO deployment_settings(singleton,region,mode) VALUES(true,$1,$2) ON CONFLICT(singleton) DO NOTHING",
    [config.region, config.mode]
  );
  for (const person of [oldStaff, newStaff, admin, parent]) {
    await pool().query("INSERT INTO users(id,region,name,role,demo) VALUES($1,$2,$3,$4,false)", [person.id, region, person.name, person.role]);
  }
  await raceReassignment();
  await reassignmentWithAlertFollowsFamilyScope();
  await legacyCarryForward();
  console.log(JSON.stringify({
    synthetic: true,
    staleWithdrawalRefused: true,
    originalGrantUnchanged: true,
    currentAssigneeCanManage: true,
    legacyRowUntouched: true,
    legacyReadExcludesWithdrawnScope: true,
    newGrantKeepsItsOwnEvidence: true
  }));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "consent lock race failed");
  process.exitCode = 1;
}).finally(async () => {
  await closeDatabase();
});
