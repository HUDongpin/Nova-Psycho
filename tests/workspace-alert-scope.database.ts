import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import type { Actor } from "../src/domain/types";

const databaseUrl = process.env.NOVA_ALERT_SCOPE_TEST_DATABASE_URL;
assert.ok(databaseUrl, "Set NOVA_ALERT_SCOPE_TEST_DATABASE_URL to a local synthetic database");
const address = new URL(databaseUrl);
assert.ok(["127.0.0.1", "localhost"].includes(address.hostname));
assert.match(address.pathname, /^\/nova_(remediation_cn_20261021|alert_scope_test_[a-z0-9_]+)$/);
assert.equal(address.password, "");
Object.assign(process.env, {
  DATABASE_URL: databaseUrl, NOVA_REGION: "CN", NOVA_MODE: "demo", NOVA_AUTH_PROVIDER: "local",
  NOVA_AI_ENABLED: "false", NOVA_PUBLIC_URL: "http://127.0.0.1:3310",
  NOVA_REPORT_DIR: "work/alert-scope-private", NOVA_REPORT_KEY: randomBytes(32).toString("hex")
});
const { workspaceFor } = await import("../src/lib/workspace");
const { closeDatabase } = await import("../src/lib/db");
const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();
const owner: Actor = { id: randomUUID(), name: "Synthetic owner", role: "staff", region: "CN" };
const other: Actor = { id: randomUUID(), name: "Synthetic other", role: "staff", region: "CN" };
const admin: Actor = { id: randomUUID(), name: "Synthetic admin", role: "admin", region: "CN" };
const parent: Actor = { id: randomUUID(), name: "Synthetic parent", role: "parent", region: "CN" };
const familyIds = [randomUUID(), randomUUID(), randomUUID()];
const alertIds = familyIds.map(() => randomUUID());
const identities = ["SYNTHETIC_OWNED_IDENTITY", "SYNTHETIC_EMERGENCY_IDENTITY", "SYNTHETIC_HK_IDENTITY"];
try {
  assert.deepEqual((await db.query("SELECT region,mode FROM deployment_settings WHERE singleton=true")).rows, [{ region: "CN", mode: "demo" }]);
  for (const actor of [owner, other, admin, parent]) {
    await db.query("INSERT INTO users(id,region,name,role,demo) VALUES($1,$2,$3,$4,true)", [actor.id, actor.region, actor.name, actor.role]);
  }
  for (let index = 0; index < familyIds.length; index++) {
    const region = index === 2 ? "HK" : "CN";
    await db.query("INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label,assigned_to) VALUES($1,$2,'Synthetic family',$3,'2013-04-12','S2','Synthetic guardian',$4)", [familyIds[index], region, identities[index], index === 0 ? owner.id : null]);
    await db.query("INSERT INTO staff_alerts(id,family_id,region) VALUES($1,$2,$3)", [alertIds[index], familyIds[index], region]);
  }
  const visible = async (actor: Actor) => (await workspaceFor(actor, "zh-CN")).alerts.filter(alert => alertIds.includes(alert.id)).map(alert => alert.familyId).sort();
  assert.deepEqual(await visible(owner), familyIds.slice(0, 2).sort());
  assert.deepEqual(await visible(admin), familyIds.slice(0, 2).sort());
  assert.deepEqual(await visible(other), [familyIds[1]], "Unrelated staff must not receive another assignee's child identity");
  assert.deepEqual(await visible(parent), []);
  console.log("PASS: assignee/admin scope, regional emergency access, unrelated staff and parent exclusion");

  await db.query("UPDATE staff_alerts SET viewed_at=now(),viewed_by=$1 WHERE id=$2", [other.id, alertIds[1]]);
  assert.deepEqual(await visible(other), [familyIds[1]], "Acknowledgement must not end unassigned emergency access");
  await db.query("UPDATE families SET assigned_to=$1 WHERE id=$2", [owner.id, familyIds[1]]);
  assert.deepEqual(await visible(other), [], "Assignment must remove the previous emergency identity access");
  assert.deepEqual(await visible(owner), familyIds.slice(0, 2).sort());
  await db.query("UPDATE families SET assigned_to=NULL WHERE id=$1", [familyIds[1]]);
  await db.query("UPDATE staff_alerts SET resolved_at=now(),resolved_by=$1 WHERE id=$2", [admin.id, alertIds[1]]);
  assert.deepEqual(await visible(other), []);
  console.log("PASS: acknowledgement retains emergency access; assignment and resolution remove it");
} finally {
  await closeDatabase();
  await db.query("DELETE FROM families WHERE id=ANY($1::uuid[])", [familyIds]);
  await db.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[owner.id, other.id, admin.id, parent.id]]);
  await db.end();
}
