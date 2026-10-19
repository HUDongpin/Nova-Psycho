import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { assignFamily, recordConsent } from "../src/lib/families";
import { closeDatabase, pool } from "../src/lib/db";
import { HttpError } from "../src/lib/http";
import { getConfig } from "../src/lib/config";
import { familyScope } from "../src/lib/access";
import { ACTIVE_CONSENT_ROWS_SQL, hasGranted } from "../src/lib/consent";
import { noticeVersion } from "../src/lib/privacy";
import type { Actor, Region } from "../src/domain/types";
import { assertThrowawayDatabase, assertThrowawayTarget, TestDatabaseRefused } from "./test-database-guard";

// Real-lock regression for a consent withdrawal that started before reassignment.
// Run only against the throwaway server:
//   DATABASE_URL=postgresql://127.0.0.1:55432/nova_consent_race \
//   NOVA_REGION=CN NOVA_MODE=demo NOVA_PUBLIC_URL=http://127.0.0.1:3199 \
//   NOVA_REPORT_DIR=/tmp/nova-consent-race-reports NOVA_REPORT_KEY=<64 hex chars> \
//   NOVA_AI_ENABLED=false npm run test:consent-race

export interface RaceActors {
  region: Region;
  oldStaff: Actor;
  newStaff: Actor;
  admin: Actor;
  parent: Actor;
}

export function assertConsentRaceTarget(): void {
  const config = getConfig();
  assertThrowawayTarget({ mode: config.mode, databaseUrl: config.databaseUrl, aiEnabled: config.ai.enabled });
  const url = new URL(config.databaseUrl);
  if (url.port !== "55432" || url.pathname !== "/nova_consent_race") {
    throw new TestDatabaseRefused("Consent race refuses any database except port 55432 database nova_consent_race");
  }
}

export function raceFixture(region: Region): RaceActors {
  return {
    region,
    oldStaff: { id: randomUUID(), name: "Synthetic old staff", role: "staff", region },
    newStaff: { id: randomUUID(), name: "Synthetic new staff", role: "staff", region },
    admin: { id: randomUUID(), name: "Synthetic admin", role: "admin", region },
    parent: { id: randomUUID(), name: "Synthetic parent", role: "parent", region }
  };
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

async function raceReassignment(actors: RaceActors): Promise<void> {
  const { region, oldStaff, newStaff, admin } = actors;
  const familyId = randomUUID();
  const consentId = randomUUID();
  await pool().query(
    "INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label,assigned_to) VALUES($1,$2,'Synthetic race family','Synthetic child','2014-01-02','S2','Synthetic guardian',$3)",
    [familyId, region, oldStaff.id]
  );
  await pool().query(
    "INSERT INTO consents(id,family_id,actor_id,guardian_name,method,reference,notice_version,scopes) VALUES($1,$2,$3,'Synthetic guardian','offline_signed','SYNTHETIC-ORIGINAL',$4,$5)",
    [consentId, familyId, admin.id, noticeVersion, JSON.stringify(["parent_report"])]
  );
  assert.equal((await pool().query("SELECT id FROM staff_alerts WHERE family_id=$1", [familyId])).rowCount, 0);
  const before = (await pool().query("SELECT to_jsonb(c) AS value FROM consents c WHERE id=$1", [consentId])).rows[0].value;

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
    assert.deepEqual((await pool().query("SELECT to_jsonb(c) AS value FROM consents c WHERE id=$1", [consentId])).rows[0].value, before);
    assert.equal((await pool().query("SELECT id FROM consent_scope_revocations WHERE family_id=$1", [familyId])).rowCount, 0);
    const fresh = recordConsent(oldStaff, familyId, {
      action: "withdraw", scope: "parent_report", guardianName: "Synthetic guardian", reference: "SYNTHETIC-FRESH"
    });
    await assert.rejects(fresh, (error: unknown) => error instanceof HttpError && error.status === 404);
    await recordConsent(newStaff, familyId, {
      action: "withdraw", scope: "parent_report", guardianName: "Synthetic current guardian", reference: "SYNTHETIC-CURRENT"
    });
    assert.deepEqual((await pool().query("SELECT to_jsonb(c) AS value FROM consents c WHERE id=$1", [consentId])).rows[0].value, before);
    const withdrawal = await pool().query<{ actor_id: string; guardian_name: string; method: string; reference: string; scope: string }>(
      "SELECT actor_id,guardian_name,method,reference,scope FROM consent_scope_revocations WHERE consent_id=$1",
      [consentId]
    );
    assert.equal(withdrawal.rowCount, 1);
    assert.equal(withdrawal.rows[0].actor_id, newStaff.id);
    assert.equal(withdrawal.rows[0].guardian_name, "Synthetic current guardian");
    assert.equal(withdrawal.rows[0].method, "offline_signed");
    assert.equal(withdrawal.rows[0].reference, "SYNTHETIC-CURRENT");
    assert.equal(withdrawal.rows[0].scope, "parent_report");
    assert.equal(hasGranted((await pool().query(ACTIVE_CONSENT_ROWS_SQL, [familyId])).rows, ["parent_report"]), false);
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

async function reassignmentWithAlertFollowsFamilyScope(actors: RaceActors): Promise<void> {
  // The in-lock check is familyScope, not a second alert rule. An unresolved
  // alert lets regional staff in only while the family is unassigned. After
  // reassignment the same query refuses the previous staff member.
  const { region, oldStaff, newStaff, admin } = actors;
  const familyId = randomUUID();
  const consentId = randomUUID();
  await pool().query(
    "INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label,assigned_to) VALUES($1,$2,'Synthetic alert family','Synthetic child','2014-01-02','S2','Synthetic guardian',$3)",
    [familyId, region, oldStaff.id]
  );
  await pool().query("INSERT INTO staff_alerts(id,family_id,region) VALUES($1,$2,$3)", [randomUUID(), familyId, region]);
  await pool().query(
    "INSERT INTO consents(id,family_id,actor_id,guardian_name,method,reference,notice_version,scopes) VALUES($1,$2,$3,'Synthetic guardian','offline_signed','SYNTHETIC-ALERT',$4,$5)",
    [consentId, familyId, admin.id, noticeVersion, JSON.stringify(["parent_report"])]
  );
  const before = (await pool().query("SELECT to_jsonb(c) AS value FROM consents c WHERE id=$1", [consentId])).rows[0].value;
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
    const saved = (await pool().query("SELECT to_jsonb(c) AS value FROM consents c WHERE id=$1", [consentId])).rows[0].value;
    if (!inScope && stale.refused) {
      assert.deepEqual(saved, before);
      assert.equal((await pool().query("SELECT id FROM consent_scope_revocations WHERE consent_id=$1", [consentId])).rowCount, 0);
      assert.ok(stale.error instanceof HttpError);
      assert.equal(stale.error.status, 404);
    }
    if (inScope) {
      assert.equal(stale.refused, false);
      assert.deepEqual(saved, before);
      assert.equal((await pool().query("SELECT id FROM consent_scope_revocations WHERE consent_id=$1 AND scope='parent_report'", [consentId])).rowCount, 1);
    }
  } finally {
    if (open) await holder.query("ROLLBACK");
    holder.release();
  }
}

async function legacyCarryForward(actors: RaceActors): Promise<void> {
  const { region, parent } = actors;
  const familyId = randomUUID();
  const consentId = randomUUID();
  await pool().query(
    "INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label) VALUES($1,$2,'Synthetic legacy family','Synthetic child','2014-06-15','S2','Synthetic guardian')",
    [familyId, region]
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
  const revocations = await pool().query<{ scope: string; consent_id: string; guardian_name: string; method: string; reference: string | null; actor_id: string }>(
    "SELECT scope,consent_id,guardian_name,method,reference,actor_id FROM consent_scope_revocations WHERE family_id=$1",
    [familyId]
  );
  assert.equal(revocations.rowCount, 1);
  assert.equal(revocations.rows[0].scope, "parent_report");
  assert.equal(revocations.rows[0].consent_id, consentId);
  assert.equal(revocations.rows[0].guardian_name, "Synthetic current guardian");
  assert.equal(revocations.rows[0].method, "online_guardian");
  assert.equal(revocations.rows[0].reference, null);
  assert.equal(revocations.rows[0].actor_id, parent.id);
  assert.equal((await pool().query("SELECT id FROM consents WHERE family_id=$1", [familyId])).rowCount, 1);
  const active = await pool().query(ACTIVE_CONSENT_ROWS_SQL, [familyId]);
  assert.equal(hasGranted(active.rows, ["assessment", "sensitive_data"]), true);
  assert.equal(hasGranted(active.rows, ["parent_report"]), false);

  await recordConsent(parent, familyId, { action: "withdraw", scope: "assessment", guardianName: "Synthetic current guardian", confirmWithdraw: true });
  await recordConsent(parent, familyId, { action: "withdraw", scope: "sensitive_data", guardianName: "Synthetic current guardian", confirmWithdraw: true });
  assert.deepEqual((await pool().query("SELECT to_jsonb(c) AS value FROM consents c WHERE id=$1", [consentId])).rows[0].value, before);
  assert.equal((await pool().query("SELECT scope FROM consent_scope_revocations WHERE consent_id=$1", [consentId])).rowCount, 3);
  assert.equal(hasGranted((await pool().query(ACTIVE_CONSENT_ROWS_SQL, [familyId])).rows, ["assessment", "sensitive_data", "parent_report"]), false);

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
  assert.equal(hasGranted(restored.rows, ["parent_report"]), true);
  assert.equal(hasGranted(restored.rows, ["assessment", "sensitive_data"]), false);
}

async function main() {
  assertConsentRaceTarget();
  const actors = raceFixture(getConfig().region);
  await assertThrowawayDatabase();
  const schema = await fs.readFile(new URL("../src/lib/schema.sql", import.meta.url), "utf8");
  await pool().query(schema);
  const config = getConfig();
  await pool().query(
    "INSERT INTO deployment_settings(singleton,region,mode) VALUES(true,$1,$2) ON CONFLICT(singleton) DO NOTHING",
    [config.region, config.mode]
  );
  for (const person of [actors.oldStaff, actors.newStaff, actors.admin, actors.parent]) {
    await pool().query("INSERT INTO users(id,region,name,role,demo) VALUES($1,$2,$3,$4,false)", [person.id, actors.region, person.name, person.role]);
  }
  await raceReassignment(actors);
  await reassignmentWithAlertFollowsFamilyScope(actors);
  await legacyCarryForward(actors);
  console.log(JSON.stringify({
    synthetic: true,
    region: actors.region,
    staleWithdrawalRefused: true,
    originalGrantUnchanged: true,
    currentAssigneeCanManage: true,
    legacyRowUntouched: true,
    legacyReadExcludesWithdrawnScope: true,
    newGrantKeepsItsOwnEvidence: true,
    withdrawalKeepsItsOwnEvidence: true
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : "consent lock race failed");
    process.exitCode = 1;
  }).finally(async () => {
    await closeDatabase();
  });
}
