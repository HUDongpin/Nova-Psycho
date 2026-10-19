import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Actor } from "../src/domain/types";
import { demoScale } from "../src/domain/demo";
import { actorOf, cookieName, hashToken } from "../src/lib/auth";
import { familyFor } from "../src/lib/access";
import { acceptInvitation, assignFamily, createFamily, createInvitation, deleteFamily, recordConsent } from "../src/lib/families";
import { closeDatabase, pool, query } from "../src/lib/db";
import { getConfig } from "../src/lib/config";
import { removePrivatePdf, writePrivatePdf } from "../src/lib/storage";

// This harness is restricted to the disposable pass-2 integration database.
const config = getConfig(), database = new URL(config.databaseUrl);
assert.equal(config.mode, "demo"); assert.equal(config.region, "CN");
assert.equal(config.reportStorage, "filesystem"); assert.equal(config.ai.enabled, false);
assert.equal(database.hostname, "127.0.0.1"); assert.equal(database.port, "55492");
assert.equal(database.pathname, "/nova_pass2_cn");
assert.equal(database.searchParams.get("application_name"), "nova_pass2_lifecycle");
const output = "work/qa/review-pass2/lifecycle";
await mkdir(output, { recursive: true });
const results: { name: string; passed: boolean; detail?: string }[] = [];
const users = new Set<string>(), families = new Set<string>(), files = new Set<string>();
const admin: Actor = { id: randomUUID(), name: "Synthetic lifecycle admin", role: "admin", region: "CN" };
const staff: Actor = { id: randomUUID(), name: "Synthetic lifecycle staff", role: "staff", region: "CN" };
const scaleId = `synthetic-lifecycle-${randomUUID()}`;
async function check(name: string, action: () => Promise<void>) {
  console.log(`RUN ${name}`);
  try { await action(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) }); console.log(`FAIL ${name}`); throw error; }
}
async function newFamily(owner = admin) {
  const { id } = await createFamily(owner, { familyName: "Synthetic lifecycle family", childName: "Synthetic lifecycle child", birthDate: "2014-01-01", grade: "Synthetic grade", guardianLabel: "Synthetic guardian" });
  families.add(id); return id;
}
async function consent(id: string) { await recordConsent(admin, id, { accepted: true, guardianName: "Synthetic guardian", reference: "SYNTHETIC-LIFECYCLE" }); }
function invitationToken(url: string) { return new URLSearchParams(new URL(url).hash.slice(1)).get("token")!; }
async function waitForLock(sqlFragment: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const waiting = await query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock' AND position($2 in query)>0", ["nova_pass2_lifecycle", sqlFragment]);
    if (waiting.length) return;
    await delay(20);
  }
  throw new Error("Synthetic operation did not reach the expected PostgreSQL lock barrier");
}
try {
  for (const actor of [admin, staff]) {
    await query("INSERT INTO users(id,region,name,role,demo) VALUES($1,$2,$3,$4,true)", [actor.id, actor.region, actor.name, actor.role]); users.add(actor.id);
  }
  await query("INSERT INTO scales(id,scale_id,version,definition) VALUES($1,$1,'synthetic', $2)", [scaleId, JSON.stringify(demoScale)]);
  await check("admission then deletion cascades family records and preserves independent account/session", async () => {
    const id = await newFamily(); await consent(id);
    const invitation = await createInvitation(admin, id, { role: "student" });
    const userId = await acceptInvitation({ token: invitationToken(invitation.url), name: "Synthetic lifecycle student", username: `lifecycle.${randomUUID()}`, password: "synthetic-lifecycle-password" }); users.add(userId);
    // This lifecycle fixture starts with an existing authenticated session;
    // credential verification is covered by the session issuance regressions.
    const token = randomBytes(48).toString("hex");
    await query("INSERT INTO sessions(token_hash,user_id,region,expires_at) VALUES($1,$2,$3,now()+interval '12 hours')", [hashToken(token), userId, config.region]);
    const request = new Request("http://127.0.0.1:3202/api/session", { headers: { cookie: `${cookieName()}=${token}` } });
    const assessmentId = randomUUID(), key = `${assessmentId}.${randomUUID()}.zh-CN.pdf.enc`; files.add(key);
    await query("INSERT INTO assessments(id,family_id,region,respondent_id,respondent_role,scale_version_id,locale) VALUES($1,$2,'CN',$3,'student',$4,'zh-CN')", [assessmentId, id, userId, scaleId]);
    await query("INSERT INTO report_jobs(id,assessment_id) VALUES($1,$2)", [randomUUID(), assessmentId]);
    await query("INSERT INTO reports(id,assessment_id,family_id,region,payload,pdf_keys) VALUES($1,$1,$2,'CN','{}',$3)", [assessmentId, id, JSON.stringify({ "zh-CN": key })]);
    await query("INSERT INTO report_files(file_key,report_id,family_id,region,locale,encrypted_body) VALUES($1,$2,$3,'CN','zh-CN',$4)", [key, assessmentId, id, Buffer.alloc(37)]);
    await query("INSERT INTO staff_alerts(id,family_id,region) VALUES($1,$2,'CN')", [randomUUID(), id]);
    await query("INSERT INTO goals(id,family_id,title,detail,created_by) VALUES($1,$2,'Synthetic goal','Synthetic detail',$3)", [randomUUID(), id, admin.id]);
    await query("INSERT INTO observations(id,family_id,body,created_by) VALUES($1,$2,'Synthetic observation',$3)", [randomUUID(), id, admin.id]);
    await writePrivatePdf(key, Buffer.from("%PDF synthetic-lifecycle"));
    await deleteFamily(admin, id, { confirmation: "Synthetic lifecycle child" }); families.delete(id);
    for (const table of ["memberships", "consents", "invitations", "assessments", "reports", "report_files", "staff_alerts", "goals", "observations"]) {
      assert.equal((await query(`SELECT 1 FROM ${table} WHERE family_id=$1`, [id])).length, 0, `${table} must cascade`);
    }
    assert.equal((await query("SELECT 1 FROM families WHERE id=$1", [id])).length, 0);
    assert.equal((await query("SELECT 1 FROM report_jobs WHERE assessment_id=$1", [assessmentId])).length, 0);
    const surviving = await actorOf(request); assert.equal(surviving!.id, userId);
    await assert.rejects(familyFor(surviving!, id), { code: "NOT_FOUND" });
    assert.equal((await query("SELECT 1 FROM file_deletion_jobs WHERE file_key=$1", [key])).length, 1);
    await removePrivatePdf(key); await query("DELETE FROM file_deletion_jobs WHERE file_key=$1", [key]); files.delete(key);
    await assert.rejects(stat(`${config.reportDir}/${key}`), { code: "ENOENT" });
  });
  await check("deletion then invitation retry cannot create a new account", async () => {
    const id = await newFamily(); await consent(id);
    const invitation = await createInvitation(admin, id, { role: "student" });
    await deleteFamily(admin, id, { confirmation: "Synthetic lifecycle child" }); families.delete(id);
    const username = `lifecycle.${randomUUID()}`;
    await assert.rejects(acceptInvitation({ token: invitationToken(invitation.url), name: "Synthetic removed invitee", username, password: "synthetic-lifecycle-password" }), { code: "INVALID_INVITATION" });
    assert.equal((await query("SELECT 1 FROM users WHERE username=$1", [username])).length, 0);
  });
  for (const operation of ["assignment", "invitation"] as const) await check(`${operation} denies account revoked during an actual family-lock wait`, async () => {
    const id = await newFamily(staff), owner = operation === "assignment" ? admin : staff;
    const blocker = await pool().connect(); let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN"); await blocker.query("SELECT id FROM families WHERE id=$1 FOR UPDATE", [id]);
      pending = (operation === "assignment" ? assignFamily(admin, id, { assignedTo: staff.id }) : createInvitation(staff, id, { role: "parent" })).then(value => ({ value }), error => ({ error }));
      await waitForLock("FROM families WHERE id=$1 AND region=$2 FOR UPDATE");
      await query("UPDATE users SET disabled=true WHERE id=$1", [owner.id]);
      await blocker.query("COMMIT");
      const result = await pending as { error?: { code?: string } };
      assert.equal(result.error?.code, "ACCOUNT_REVOKED");
      assert.equal((await query("SELECT 1 FROM invitations WHERE family_id=$1", [id])).length, 0);
    } finally {
      await blocker.query("ROLLBACK"); blocker.release(); await pending;
      await query("UPDATE users SET disabled=false WHERE id=$1", [owner.id]);
    }
  });
  await check("assignment and recovery-token FK use a compatible user-lock order", async () => {
    const id = await newFamily(), recovery = await pool().connect(); let pending: Promise<unknown> | undefined;
    try {
      await recovery.query("BEGIN"); await recovery.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [staff.id]);
      pending = assignFamily(admin, id, { assignedTo: staff.id }).then(value => ({ value }), error => ({ error }));
      await waitForLock("role='staff' AND NOT disabled FOR SHARE");
      await recovery.query("SET LOCAL lock_timeout='500ms'");
      await recovery.query("INSERT INTO recovery_tokens(token_hash,user_id,region,expires_at,created_by) VALUES($1,$2,'CN',now()+interval '1 hour',$3)", [randomUUID(), staff.id, admin.id]);
      await recovery.query("COMMIT");
      const result = await pending as { value?: { assignedTo: string }; error?: unknown };
      assert.equal(result.error, undefined); assert.equal(result.value?.assignedTo, staff.id);
    } finally { await recovery.query("ROLLBACK"); recovery.release(); await pending; }
  });
} finally {
  for (const id of families) await query("DELETE FROM families WHERE id=$1", [id]);
  for (const key of files) { await removePrivatePdf(key); await query("DELETE FROM file_deletion_jobs WHERE file_key=$1", [key]); }
  await query("DELETE FROM scales WHERE id=$1", [scaleId]);
  await query("DELETE FROM audit_events WHERE actor_id=ANY($1::uuid[])", [[...users]]);
  await query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[...users]]);
  await closeDatabase();
  await writeFile(`${output}/postgres-results.json`, JSON.stringify({ syntheticOnly: true, results }, null, 2));
}
console.log(`Lifecycle database checks: ${results.length} passed`);
