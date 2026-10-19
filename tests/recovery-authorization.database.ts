import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import type { Actor } from "../src/domain/types";
import { closeDatabase } from "../src/lib/db";
import { createRecovery } from "../src/lib/recovery";

const url = process.env.NOVA_RECOVERY_LOCK_TEST_DATABASE_URL;
assert.ok(url, "Set NOVA_RECOVERY_LOCK_TEST_DATABASE_URL to a fresh synthetic database");
const address = new URL(url);
assert.ok(["127.0.0.1", "localhost"].includes(address.hostname));
assert.match(address.pathname, /^\/nova_(pass2_cn|recovery_lock_test_[a-z0-9_]+)$/);
assert.equal(address.password, "");
Object.assign(process.env, { DATABASE_URL: url, NOVA_REGION: "CN", NOVA_MODE: "demo", NOVA_PUBLIC_URL: "http://127.0.0.1:3202", NOVA_REPORT_STORAGE: "database", NOVA_WORKER_MODE: "continuous", NOVA_REPORT_KEY: "0".repeat(64), NOVA_AI_ENABLED: "false", NOVA_AUTH_PROVIDER: "local", VERCEL: "0" });
const observer = new pg.Client({ connectionString: url, application_name: "synthetic-issuer-observer", statement_timeout: 10000 });
const barrier = new pg.Client({ connectionString: url, application_name: "synthetic-issuer-barrier", statement_timeout: 10000 });
const ids: string[] = [];
let running: Promise<{ code: string; status: number } | { ok: true }> | undefined;
try {
  await observer.connect(); await barrier.connect();
  assert.deepEqual((await observer.query("SELECT region,mode FROM deployment_settings WHERE singleton=true")).rows, [{ region: "CN", mode: "demo" }]);
  const blockerPid = (await barrier.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  for (const change of ["disabled=true", "role='staff'", "region='HK'", "deleted", "missing"]) {
    const actor: Actor = { id: randomUUID(), name: "Synthetic recovery issuer", role: "admin", region: "CN" };
    const target = randomUUID(); ids.push(actor.id, target);
    await observer.query("INSERT INTO users(id,region,name,role,demo) VALUES($1,'CN','Synthetic recovery issuer','admin',true),($2,'CN','Synthetic recovery target','parent',true)", [actor.id, target]);
    await observer.query("INSERT INTO recovery_tokens(token_hash,user_id,region,expires_at) VALUES($1,$2,'CN',now()+interval '1 hour')", [randomBytes(32).toString("hex"), target]);
    if (change === "missing") await observer.query("DELETE FROM users WHERE id=$1", [actor.id]);
    await barrier.query("BEGIN");
    await barrier.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [target]);
    running = createRecovery(actor, target).then(() => ({ ok: true as const }), error => ({ code: String(error?.code), status: Number(error?.status) }));
    let waited = false;
    for (let attempt = 0; attempt < 500; attempt++) {
      const blocked = await observer.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='nova-cn' AND $1::int=ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT id,name,role,disabled FROM users%'", [blockerPid]);
      if (blocked.rows[0].n === 1) { waited = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(waited, "Actual issuance must wait for its target account");
    if (change === "deleted") await observer.query("DELETE FROM users WHERE id=$1", [actor.id]);
    else if (change !== "missing") await observer.query(`UPDATE users SET ${change} WHERE id=$1`, [actor.id]);
    await barrier.query("COMMIT");
    const outcome = await running;
    console.log(JSON.stringify({ change, actualTargetWait: waited, outcome }));
    assert.deepEqual(outcome, { code: "FORBIDDEN", status: 403 });
    assert.deepEqual((await observer.query("SELECT count(*)::int AS n,count(*) FILTER (WHERE used_at IS NULL)::int AS active FROM recovery_tokens WHERE user_id=$1", [target])).rows, [{ n: 1, active: 1 }]);
    console.log(`PASS: issuer ${change} while target is locked cannot issue or retire a recovery link`);
  }
} finally {
  await barrier.query("ROLLBACK").catch(() => {});
  await running;
  await observer.query("DELETE FROM audit_events WHERE actor_id=ANY($1::uuid[])", [ids]);
  await observer.query("DELETE FROM recovery_tokens WHERE user_id=ANY($1::uuid[]) OR created_by=ANY($1::uuid[])", [ids]);
  await observer.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [ids]);
  await closeDatabase(); await barrier.end(); await observer.end();
}
