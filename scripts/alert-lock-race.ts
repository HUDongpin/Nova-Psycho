import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { assignFamily } from "../src/lib/families";
import { acknowledgeSafetyAlert, resolveSafetyAlert } from "../src/lib/triad";
import { closeDatabase, pool } from "../src/lib/db";
import { HttpError } from "../src/lib/http";
import type { Actor } from "../src/domain/types";

// Concurrency regression for reviewer finding R2. Holds the alert row so resolve or
// acknowledge blocks, lets assignment commit, then requires the blocked call to
// refuse and leave resolved_by / viewed_by unchanged.
// Run against a throwaway database:
//   DATABASE_URL=postgresql://127.0.0.1:55432/nova_alert_race \
//   NOVA_REGION=CN NOVA_MODE=demo NOVA_PUBLIC_URL=http://127.0.0.1:3199 \
//   NOVA_REPORT_DIR=/tmp/nova-alert-race-reports NOVA_REPORT_KEY=<64 hex chars> \
//   npm run test:alert-race

const region = "CN" as const;
const oldStaff: Actor = { id: randomUUID(), name: "Synthetic old staff", role: "staff", region };
const newStaff: Actor = { id: randomUUID(), name: "Synthetic new staff", role: "staff", region };
const admin: Actor = { id: randomUUID(), name: "Synthetic admin", role: "admin", region };

async function waitForAlertLock(): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    const rows = await pool().query<{ query: string }>(
      "SELECT query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%staff_alerts%' AND query LIKE '%FOR UPDATE%'"
    );
    const waiting = rows.rows.find(row => !row.query.trimStart().startsWith("UPDATE"));
    if (waiting) return waiting.query;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for the alert lock");
}

async function seed(familyId: string, alertId: string, assignee: string) {
  await pool().query(
    "INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label,assigned_to) VALUES($1,$2,'Synthetic race family','Synthetic child','2014-01-02','S2','Synthetic guardian',$3)",
    [familyId, region, assignee]
  );
  await pool().query("INSERT INTO staff_alerts(id,family_id,region) VALUES($1,$2,$3)", [alertId, familyId, region]);
}

async function race(action: "resolved" | "viewed") {
  const familyId = randomUUID();
  const alertId = randomUUID();
  await seed(familyId, alertId, oldStaff.id);
  const holder = await pool().connect();
  let open = false;
  try {
    await holder.query("BEGIN");
    open = true;
    await holder.query("SELECT id FROM staff_alerts WHERE id=$1 FOR UPDATE", [alertId]);
    let settled = false;
    const pending = (action === "resolved" ? resolveSafetyAlert(oldStaff, alertId) : acknowledgeSafetyAlert(oldStaff, alertId)).then(
      () => { settled = true; return { refused: false as const }; },
      (error: unknown) => { settled = true; return { refused: true as const, error }; }
    );
    const waiting = await waitForAlertLock();
    assert.equal(settled, false, `${action} returned before the alert lock was released`);
    assert.match(waiting, /FOR UPDATE/);
    assert.doesNotMatch(waiting.trimStart(), /^UPDATE/);
    await assignFamily(admin, familyId, { assignedTo: newStaff.id });
    const assigned = await pool().query<{ assigned_to: string }>("SELECT assigned_to FROM families WHERE id=$1", [familyId]);
    assert.equal(assigned.rows[0].assigned_to, newStaff.id, "reassignment must commit while the alert call is still blocked");
    await holder.query("COMMIT");
    open = false;
    const result = await pending;
    assert.equal(result.refused, true, `${action} was accepted after the family was reassigned`);
    assert.ok(result.error instanceof HttpError);
    assert.equal(result.error.status, 403);
    assert.equal(result.error.code, "ROLE_DENIED");
    const saved = await pool().query<{ resolved_by: string | null; viewed_by: string | null }>("SELECT resolved_by,viewed_by FROM staff_alerts WHERE id=$1", [alertId]);
    assert.equal(saved.rows[0].resolved_by, null);
    assert.equal(saved.rows[0].viewed_by, null);
    assert.notEqual(saved.rows[0].resolved_by, oldStaff.id);
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
  await race("resolved");
  await race("viewed");
  console.log(JSON.stringify({ synthetic: true, resolveRefusedAfterReassignment: true, acknowledgeRefusedAfterReassignment: true, resolvedByUnchanged: true }));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "alert lock race failed");
  process.exitCode = 1;
}).finally(async () => {
  await closeDatabase();
});
