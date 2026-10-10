import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { deleteFamily } from "../src/lib/families";
import { acknowledgeSafetyAlert, resolveSafetyAlert } from "../src/lib/triad";
import { closeDatabase, pool } from "../src/lib/db";
import { HttpError } from "../src/lib/http";
import type { Actor } from "../src/domain/types";

// DB regression for alert lock order. Family is locked before the alert, matching
// deleteFamily (family, then actor, then the cascade into staff_alerts).
// Run against a throwaway database:
//   DATABASE_URL=postgresql://127.0.0.1:55432/nova_alert_race \
//   NOVA_REGION=CN NOVA_MODE=demo NOVA_PUBLIC_URL=http://127.0.0.1:3199 \
//   NOVA_REPORT_DIR=/Volumes/Mars/nova-psycho-fixes-pgtmp/reports \
//   NOVA_REPORT_KEY=<64 hex chars> npm run test:alert-race

const region = "CN" as const;
const oldStaff: Actor = { id: randomUUID(), name: "Synthetic old staff", role: "staff", region };
const newStaff: Actor = { id: randomUUID(), name: "Synthetic new staff", role: "staff", region };
const admin: Actor = { id: randomUUID(), name: "Synthetic admin", role: "admin", region };

function isDeadlock(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "40P01";
}

async function waitForFamilyLock(minWaiters: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    const rows = await pool().query<{ query: string }>(
      "SELECT query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND wait_event_type='Lock'"
    );
    const waiting = rows.rows.filter(row => /families/i.test(row.query) && /FOR (NO KEY )?UPDATE/i.test(row.query));
    if (waiting.length >= minWaiters) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${minWaiters} family-row lock waiter(s)`);
}

async function seed(familyId: string, alertId: string, assignee: string) {
  await pool().query(
    "INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label,assigned_to) VALUES($1,$2,'Synthetic race family','Synthetic child','2014-01-02','S2','Synthetic guardian',$3)",
    [familyId, region, assignee]
  );
  await pool().query("INSERT INTO staff_alerts(id,family_id,region) VALUES($1,$2,$3)", [alertId, familyId, region]);
}

async function authorityWhileFamilyReassigned(action: "resolved" | "viewed") {
  const familyId = randomUUID();
  const alertId = randomUUID();
  await seed(familyId, alertId, oldStaff.id);
  const holder = await pool().connect();
  let open = false;
  try {
    await holder.query("BEGIN");
    open = true;
    await holder.query("UPDATE families SET assigned_to=$1 WHERE id=$2", [newStaff.id, familyId]);
    let settled = false;
    const pending = (action === "resolved" ? resolveSafetyAlert(oldStaff, alertId) : acknowledgeSafetyAlert(oldStaff, alertId)).then(
      () => { settled = true; return { refused: false as const }; },
      (error: unknown) => { settled = true; return { refused: true as const, error }; }
    );
    await waitForFamilyLock(1);
    assert.equal(settled, false, `${action} returned before the family lock was released`);
    await holder.query("COMMIT");
    open = false;
    const result = await pending;
    assert.equal(result.refused, true, `${action} was accepted after the family was reassigned`);
    assert.ok(result.error instanceof HttpError);
    assert.ok(result.error.status === 403 || result.error.status === 404, `${action} status ${result.error.status}`);
    const saved = await pool().query<{ viewed_at: Date | null; resolved_at: Date | null; viewed_by: string | null; resolved_by: string | null }>(
      "SELECT viewed_at,resolved_at,viewed_by,resolved_by FROM staff_alerts WHERE id=$1",
      [alertId]
    );
    assert.equal(saved.rows[0].viewed_at, null);
    assert.equal(saved.rows[0].resolved_at, null);
    assert.equal(saved.rows[0].viewed_by, null);
    assert.equal(saved.rows[0].resolved_by, null);
  } finally {
    if (open) await holder.query("ROLLBACK");
    holder.release();
  }
}

async function noDeadlockWithDelete() {
  const familyId = randomUUID();
  const alertId = randomUUID();
  await seed(familyId, alertId, oldStaff.id);
  const holder = await pool().connect();
  let open = false;
  try {
    await holder.query("BEGIN");
    open = true;
    await holder.query("SELECT id FROM families WHERE id=$1 FOR UPDATE", [familyId]);
    const pending = Promise.allSettled([
      deleteFamily(admin, familyId, { confirmation: "Synthetic child" }),
      resolveSafetyAlert(oldStaff, alertId)
    ]);
    await waitForFamilyLock(2);
    await holder.query("COMMIT");
    open = false;
    const [removed, resolved] = await pending;
    for (const outcome of [removed, resolved]) {
      if (outcome.status === "rejected") assert.equal(isDeadlock(outcome.reason), false, "deleteFamily and resolve deadlocked");
    }
    assert.equal(removed.status, "fulfilled", removed.status === "rejected" ? String(removed.reason) : "");
    if (resolved.status === "rejected") assert.ok(resolved.reason instanceof HttpError, String(resolved.reason));
  } finally {
    if (open) await holder.query("ROLLBACK");
    holder.release();
  }
}

async function main() {
  const schema = await fs.readFile(new URL("../src/lib/schema.sql", import.meta.url), "utf8");
  await pool().query(schema);
  await pool().query("INSERT INTO deployment_settings(singleton,region,mode) VALUES(true,$1,'demo') ON CONFLICT(singleton) DO NOTHING", [region]);
  for (const person of [oldStaff, newStaff, admin]) {
    await pool().query("INSERT INTO users(id,region,name,role,demo) VALUES($1,$2,$3,$4,false)", [person.id, region, person.name, person.role]);
  }
  await authorityWhileFamilyReassigned("resolved");
  await authorityWhileFamilyReassigned("viewed");
  await noDeadlockWithDelete();
  console.log(JSON.stringify({ synthetic: true, resolveRefusedAfterReassignment: true, acknowledgeRefusedAfterReassignment: true, resolvedByUnchanged: true, deleteDidNotDeadlock: true }));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : "alert lock race failed");
  process.exitCode = 1;
}).finally(async () => {
  await closeDatabase();
});
