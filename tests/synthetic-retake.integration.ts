import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import type { Actor, Locale, ReportPayload, RespondentRole, ScaleDefinition, StoredAnswer, TriadRoleComparison } from "../src/domain/types";

const configPath = process.env.NOVA_SYNTHETIC_RETAKE_TEST_CONFIG;
assert.ok(configPath, "Explicit owned test configuration required");
const runtimeRoot = path.resolve("work/qa/synthetic-retake-20261020/local-retake-runtime");
const relative = path.relative(runtimeRoot, path.resolve(configPath));
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
const config = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, string>;
assert.equal(config.NOVA_SYNTHETIC_RETAKE_TEST_OWNER, "local-synthetic-retake-20261020");
const url = new URL(config.DATABASE_URL);
assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "55568"); assert.equal(url.pathname, "/nova_synthetic_retake_test");
assert.equal(config.NOVA_MODE, "service"); assert.equal(config.NOVA_REGION, "HK"); assert.equal(config.NOVA_AUTH_PROVIDER, "clerk");
assert.equal(config.NOVA_AI_ENABLED, "false"); assert.equal(config.NOVA_REPORT_STORAGE, "database"); assert.equal(config.NOVA_WORKER_MODE, "continuous");
assert.equal(config.NOVA_PUBLIC_URL, "https://synthetic-retake.example.invalid"); assert.equal(process.env.NODE_OPTIONS, undefined);
for (const [key, value] of Object.entries(config)) process.env[key] = value;
const output = path.resolve(config.NOVA_SYNTHETIC_RETAKE_TEST_OUTPUT);
assert.ok(output.startsWith(path.dirname(path.resolve(configPath)) + path.sep));
await fs.mkdir(output, { recursive: true, mode: 0o700 });

const direct = new pg.Client({ connectionString: config.DATABASE_URL });
const roles: RespondentRole[] = ["student", "parent", "teacher"];
const password = randomBytes(24).toString("base64url"), prefix = `retake_${randomBytes(6).toString("hex")}`;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hashBytes = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const results: { name: string; passed: boolean; error?: string }[] = [];
let completed = false;
let closeDatabase: (() => Promise<void>) | undefined, closePdfBrowser: (() => Promise<void>) | undefined;
async function persist() {
  await fs.writeFile(path.join(output, "results.json"), JSON.stringify({ passed: completed && results.every(r => r.passed), completed, syntheticOnly: true, databaseHost: "127.0.0.1", postgres: 18, mode: "service", aiEnabled: false, timestampsModified: false, proxyBoundary: "Direct real route handlers; no external Clerk or browser", results }, null, 2), { mode: 0o600 });
}
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, error: error instanceof assert.AssertionError ? error.message : error instanceof Error ? error.name : "UnknownError" }); throw error; }
  finally { await persist(); }
}
type Retake = { roundId: string; assessmentIds: Record<RespondentRole, string>; reused: boolean };
try {
  await direct.connect();
  assert.equal((await direct.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0, "Only a new empty database may be initialized");
  await direct.query(await fs.readFile("src/lib/schema.sql", "utf8"));
  await direct.query("INSERT INTO deployment_settings(singleton,region,mode) VALUES(true,'HK','service')");
  const route = await import("../src/app/api/[...path]/route");
  const auth = await import("../src/lib/auth");
  closeDatabase = (await import("../src/lib/db")).closeDatabase;
  closePdfBrowser = (await import("../src/lib/pdf")).closePdfBrowser;
  const { processReportJob } = await import("../src/lib/worker");
  const { startSyntheticRetake } = await import("../src/lib/synthetic-retake");
  const { childScaleStaffNotes, parentScaleStaffNotes, teacherScaleStaffNotes } = await import("../src/domain/triad-scales");
  const { previewAnswers } = await import("../src/domain/triad-report");
  const { scoreAssessment } = await import("../src/domain/scoring");
  const { ensureSyntheticTriadContent } = await import("../scripts/migrations/20261020-synthetic-triad-content");
  const definitions: Record<RespondentRole, ScaleDefinition> = { student: childScaleStaffNotes, parent: parentScaleStaffNotes, teacher: teacherScaleStaffNotes };
  const users = {} as Record<RespondentRole, { id: string; username: string }>;
  const cookies = {} as Record<RespondentRole, string>, actors = {} as Record<RespondentRole, Actor>;
  for (const role of roles) {
    users[role] = { id: randomUUID(), username: `${prefix}_${role}` };
    await direct.query("INSERT INTO users(id,region,username,name,role,password_hash,demo) VALUES($1,'HK',$2,$3,$4,$5,false)", [users[role].id, users[role].username, `Synthetic retake ${role}`, role, await auth.hashPassword(password)]);
    const s = definitions[role];
    assert.equal(s.norm.validated, false);
    await direct.query("INSERT INTO scales(id,scale_id,version,definition) VALUES($1,$2,$3,$4)", [`${s.id}@${s.version}`, s.id, s.version, JSON.stringify(s)]);
  }
  await direct.query("BEGIN");
  await ensureSyntheticTriadContent(direct); await direct.query("COMMIT");
  const scaleFingerprint = hash((await direct.query("SELECT id,definition FROM scales ORDER BY id")).rows);
  async function newFamily() {
    const id = randomUUID();
    await direct.query("INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label) VALUES($1,'HK','Synthetic retake family','Synthetic retake child','2014-01-01','初中','Synthetic guardian')", [id]);
    for (const role of roles) await direct.query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,$3)", [id, users[role].id, role]);
    for (const scope of ["assessment", "sensitive_data", "parent_report"]) await direct.query("INSERT INTO consents(id,family_id,actor_id,guardian_name,method,notice_version,scopes) VALUES($1,$2,$3,'Synthetic guardian','synthetic','synthetic-retake-v1',$4)", [randomUUID(), id, users.parent.id, JSON.stringify([scope])]);
    return id;
  }
  const familyId = await newFamily();
  process.env.NOVA_TEST_ACCOUNT_USERNAMES = roles.map(r => users[r].username).join(",");
  process.env.NOVA_SYNTHETIC_TEST_FAMILY_IDS = familyId;
  async function request(method: "GET" | "POST" | "PATCH", endpoint: string, cookie = "", body?: unknown) {
    const req = new Request(`${config.NOVA_PUBLIC_URL}/api/${endpoint}`, { method, headers: { Origin: config.NOVA_PUBLIC_URL, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return route[method](req, { params: Promise.resolve({ path: endpoint.split("?")[0].split("/") }) });
  }
  async function json<T = Record<string, unknown>>(method: "GET" | "POST" | "PATCH", endpoint: string, cookie = "", body?: unknown, statuses = [200]): Promise<T> {
    const r = await request(method, endpoint, cookie, body), value = await r.json();
    assert.ok(statuses.includes(r.status), `${method} ${endpoint.replace(/[0-9a-f-]{36}/g, "<id>")} HTTP${r.status} ${value.code ?? ""}`);
    return value as T;
  }
  async function denied(endpoint: string, cookie: string, body: unknown, statuses: number[], code?: string) {
    const r = await request("POST", endpoint, cookie, body); assert.ok(statuses.includes(r.status), `Expected rejection, got HTTP${r.status}`); if (code) assert.equal((await r.json()).code, code);
  }
  const answerSet = (role: RespondentRole, round: 1 | 2): Record<string, StoredAnswer> => {
    const scale = structuredClone(definitions[role]);
    for (const item of scale.items) if (item.id === "c_age" || item.id === "p_age") item.choices = item.choices.filter(c => c.value === 12);
    const value = previewAnswers(scale, "calm");
    for (const item of scale.items) if (typeof value[item.id] === "string") value[item.id] = `Synthetic retake response ${role}`;
    for (const id of scale.dimensions[0].items) {
      const item = scale.items.find(i => i.id === id)!;
      const allowed = item.choices.map(c => c.value).filter(v => !item.excludeValues?.includes(v) && !scale.riskRules.some(rule => rule.itemId === id && rule.values.includes(v)));
      value[id] = round === 1 ? Math.min(...allowed) : Math.max(...allowed);
    }
    assert.equal(scoreAssessment(definitions[role], value, { age: 12, region: "HK", role }).status, "valid");
    return value;
  };
  await check("real designated login creates test-session proof", async () => {
    for (const role of roles) {
      const response = await request("POST", "auth/test-login", "", { username: users[role].username, password }); assert.equal(response.status, 200);
      cookies[role] = response.headers.get("set-cookie")!.split(";")[0];
      actors[role] = (await auth.actorOf(new Request(config.NOVA_PUBLIC_URL, { headers: { Cookie: cookies[role] } })))!;
      assert.equal(actors[role].sessionMethod, "test");
    }
  });
  const firstTasks = {} as Record<RespondentRole, string>;
  await check("first round is assigned and fully submitted through real routes", async () => {
    for (const role of roles) firstTasks[role] = (await json<{ id: string }>("POST", "assessments", cookies.parent, { familyId, respondentId: users[role].id, scaleVersionId: `${definitions[role].id}@${definitions[role].version}`, locale: "zh-HK" }, [201])).id;
    for (const role of roles) assert.equal((await json("POST", `assessments/${firstTasks[role]}/submit`, cookies[role], { answers: answerSet(role, 1), acknowledged: true, revision: 0 })).status, "queued");
  });
  const firstRoundId = (await direct.query("SELECT triad_round_id FROM assessments WHERE id=$1", [firstTasks.parent])).rows[0].triad_round_id as string;
  const endpoint = `families/${familyId}/synthetic-retake`, retakeBody = { previousRoundId: firstRoundId, locale: "zh-HK" };
  await check("unpublished first round cannot authorize retake", () => denied(endpoint, cookies.parent, retakeBody, [409]));
  async function publish(tasks: Record<RespondentRole, string>, stem: string) {
    const jobs = (await direct.query("SELECT id FROM report_jobs WHERE assessment_id=ANY($1::uuid[])", [Object.values(tasks)])).rows; assert.equal(jobs.length, 1);
    assert.deepEqual(await processReportJob(jobs[0].id), { status: "published" });
    const report = (await direct.query("SELECT * FROM reports WHERE assessment_id=$1", [tasks.parent])).rows[0]; assert.ok(report);
    assert.equal(report.payload.syntheticTest, true); assert.equal(report.payload.aiModel, null); assert.equal(report.payload.generationMode, "template");
    const pdfs: Record<string, string> = {};
    for (const locale of ["zh-CN", "zh-HK"] as Locale[]) {
      const r = await request("GET", `reports/${report.id}/pdf?locale=${locale}`, cookies.parent); assert.equal(r.status, 200);
      const pdf = Buffer.from(await r.arrayBuffer()); assert.equal(pdf.subarray(0, 4).toString(), "%PDF"); pdfs[locale] = hashBytes(pdf);
      await fs.writeFile(path.join(output, `${stem}-${locale}.pdf`), pdf, { mode: 0o600 });
      await fs.writeFile(path.join(output, `${stem}-${locale}.html`), report.html_documents[locale], { mode: 0o600 });
    }
    return { report, pdfs };
  }
  let first: Awaited<ReturnType<typeof publish>>;
  await check("first published report provides the parent-only retake capability", async () => {
    first = await publish(firstTasks, "round-1");
    for (const role of roles) {
      const w = await json<{ families: { id: string; syntheticRetake?: { previousRoundId: string } }[] }>("GET", "workspace", cookies[role]);
      const capability = w.families.find(f => f.id === familyId)?.syntheticRetake;
      if (role === "parent") assert.deepEqual(capability, { previousRoundId: firstRoundId }); else assert.equal(capability, undefined);
    }
  });
  const firstSnapshotHash = hash((await direct.query("SELECT id,answers,snapshot,submitted_at,created_at FROM assessments WHERE id=ANY($1::uuid[]) ORDER BY id", [Object.values(firstTasks)])).rows);
  await check("ordinary generic assignment still enforces the retake interval", async () => {
    await denied("assessments", cookies.parent, { familyId, respondentId: users.parent.id, scaleVersionId: `${definitions.parent.id}@${definitions.parent.version}`, locale: "zh-HK" }, [409], "RETAKE_INTERVAL");
  });
  await check("ordinary actor, student and teacher cannot use the retake exception", async () => {
    const plain = { ...actors.parent }; delete plain.sessionMethod;
    await assert.rejects(startSyntheticRetake(plain, familyId, retakeBody), (e: { status?: number }) => e.status === 403);
    for (const role of ["student", "teacher"] as const) await denied(endpoint, cookies[role], retakeBody, [403]);
  });
  await check("unscoped family and missing configuration do not permit retake", async () => {
    const other = await newFamily(); await denied(`families/${other}/synthetic-retake`, cookies.parent, retakeBody, [403, 404]);
    process.env.NOVA_SYNTHETIC_TEST_FAMILY_IDS = "";
    try { await denied(endpoint, cookies.parent, retakeBody, [403]); } finally { process.env.NOVA_SYNTHETIC_TEST_FAMILY_IDS = familyId; }
  });
  await check("disabled member and withdrawn report consent block retake", async () => {
    await direct.query("UPDATE users SET disabled=true WHERE id=$1", [users.teacher.id]);
    try { await denied(endpoint, cookies.parent, retakeBody, [403]); } finally { await direct.query("UPDATE users SET disabled=false WHERE id=$1", [users.teacher.id]); }
    const grant = (await direct.query("UPDATE consents SET revoked_at=now() WHERE family_id=$1 AND scopes='[\"parent_report\"]'::jsonb RETURNING id", [familyId])).rows[0].id;
    try { await denied(endpoint, cookies.parent, retakeBody, [409]); } finally { await direct.query("UPDATE consents SET revoked_at=NULL WHERE id=$1", [grant]); }
  });
  await check("client cannot add a generic bypass flag and retired source versions are rejected", async () => {
    await denied(endpoint, cookies.parent, { ...retakeBody, bypassInterval: true }, [422]);
    const id = `${definitions.teacher.id}@${definitions.teacher.version}`;
    await direct.query("UPDATE scales SET status='retired' WHERE id=$1", [id]);
    try { await denied(endpoint, cookies.parent, retakeBody, [409]); } finally { await direct.query("UPDATE scales SET status='active' WHERE id=$1", [id]); }
    assert.equal((await direct.query("SELECT count(*)::int AS n FROM triad_rounds WHERE family_id=$1", [familyId])).rows[0].n, 1);
  });
  let second: Retake;
  await check("concurrent retake requests create one same-version three-party round", async () => {
    const responses = await Promise.all(Array.from({ length: 4 }, () => json<Retake>("POST", endpoint, cookies.parent, retakeBody, [200, 201])));
    assert.equal(new Set(responses.map(r => r.roundId)).size, 1); assert.equal(responses.filter(r => !r.reused).length, 1); second = responses[0];
    assert.notEqual(second.roundId, firstRoundId);
    assert.equal((await direct.query("SELECT count(*)::int AS n FROM triad_rounds WHERE family_id=$1", [familyId])).rows[0].n, 2);
    const tasks = (await direct.query("SELECT * FROM assessments WHERE triad_round_id=$1", [second.roundId])).rows; assert.equal(tasks.length, 3);
    for (const role of roles) { const task = tasks.find(t => t.respondent_role === role); assert.ok(task); assert.equal(task.id, second.assessmentIds[role]); assert.equal(task.respondent_id, users[role].id); assert.equal(task.scale_version_id, `${definitions[role].id}@${definitions[role].version}`); assert.equal(task.status, "pending"); assert.deepEqual(task.draft_answers, {}); assert.equal(task.answers, null); assert.equal(task.snapshot, null); }
  });
  await check("incomplete second round hides new-retake capability and old retry stays idempotent", async () => {
    const w = await json<{ families: { id: string; syntheticRetake?: unknown }[] }>("GET", "workspace", cookies.parent); assert.equal(w.families.find(f => f.id === familyId)?.syntheticRetake, undefined);
    const repeated = await json<Retake>("POST", endpoint, cookies.parent, retakeBody, [200, 201]); assert.equal(repeated.roundId, second.roundId); assert.equal(repeated.reused, true);
  });
  await check("second-round drafts and three submissions preserve normal conflict handling", async () => {
    for (const role of roles) {
      const answers = answerSet(role, 2), task = second.assessmentIds[role];
      assert.equal((await json("PATCH", `assessments/${task}`, cookies[role], { answers, acknowledged: true, revision: 0 })).revision, 1);
      const stale = await request("PATCH", `assessments/${task}`, cookies[role], { answers: {}, acknowledged: true, revision: 0 }); assert.equal(stale.status, 409); assert.equal((await stale.json()).code, "DRAFT_CONFLICT");
      assert.equal((await json("POST", `assessments/${task}/submit`, cookies[role], { answers, acknowledged: true, revision: 1 })).status, "queued");
    }
  });
  await check("second report compares actual first and second results for all three roles", async () => {
    const generated = await publish(second.assessmentIds, "round-2"), payload = generated.report.payload as ReportPayload;
    assert.equal(payload.comparison.available, true); assert.equal(payload.triad?.comparisons?.length, 3);
    for (const role of roles) {
      const comparison: TriadRoleComparison = payload.triad!.comparisons!.find(c => c.role === role)!; assert.ok(comparison.available);
      const a = scoreAssessment(definitions[role], answerSet(role, 1), { age: 12, region: "HK", role });
      const b = scoreAssessment(definitions[role], answerSet(role, 2), { age: 12, region: "HK", role });
      const key = definitions[role].dimensions[0].key, prior = a.dimensions.find(d => d.key === key)!.raw!, current = b.dimensions.find(d => d.key === key)!.raw!;
      const delta: NonNullable<TriadRoleComparison["changes"]>[number] = comparison.changes!.find(d => d.key === key)!;
      assert.deepEqual({ previous: delta.previous, current: delta.current, delta: delta.delta }, { previous: prior, current, delta: Math.round((current - prior) * 1e6) / 1e6 });
      assert.ok(delta.delta > 0); assert.equal(comparison.previousDate, first.report.payload.triad.sources.find((s: { role: string }) => s.role === role).submittedAt);
      assert.ok(Date.parse(comparison.currentDate) > Date.parse(comparison.previousDate!));
    }
    for (const locale of ["zh-CN", "zh-HK"] as Locale[]) assert.ok(generated.report.html_documents[locale].includes(locale === "zh-CN" ? "和上一轮相比" : "和上一輪相比"));
    assert.equal((await direct.query("SELECT count(*)::int AS n FROM reports WHERE family_id=$1", [familyId])).rows[0].n, 2);
  });
  await check("first report PDFs, HTML, answers and snapshots remain byte-identical", async () => {
    assert.equal(hash((await direct.query("SELECT * FROM reports WHERE id=$1", [first.report.id])).rows[0]), hash(first.report));
    assert.equal(hash((await direct.query("SELECT id,answers,snapshot,submitted_at,created_at FROM assessments WHERE id=ANY($1::uuid[]) ORDER BY id", [Object.values(firstTasks)])).rows), firstSnapshotHash);
    for (const locale of ["zh-CN", "zh-HK"]) { const r = await request("GET", `reports/${first.report.id}/pdf?locale=${locale}`, cookies.parent); assert.equal(r.status, 200); assert.equal(hashBytes(Buffer.from(await r.arrayBuffer())), first.pdfs[locale]); }
  });
  await check("replaying the original retake after publication never creates a third round", async () => {
    const r = await json<Retake>("POST", endpoint, cookies.parent, retakeBody, [200, 201]); assert.equal(r.roundId, second.roundId); assert.equal(r.reused, true);
    assert.equal((await direct.query("SELECT count(*)::int AS n FROM triad_rounds WHERE family_id=$1", [familyId])).rows[0].n, 2);
    const w = await json<{ families: { id: string; syntheticRetake?: { previousRoundId: string } }[] }>("GET", "workspace", cookies.parent); assert.equal(w.families.find(f => f.id === familyId)?.syntheticRetake?.previousRoundId, second.roundId);
    assert.equal(hash((await direct.query("SELECT id,definition FROM scales ORDER BY id")).rows), scaleFingerprint);
  });
  for (const role of roles) await json("POST", "auth/test-logout", cookies[role], {});
  completed = true; await persist(); console.log(`Synthetic retake integration passed: ${results.length} checks.`);
} catch (error) {
  console.error(error instanceof assert.AssertionError ? `Assertion failed: ${error.message}` : `Integration failed: ${error instanceof Error ? error.name : "UnknownError"}`);
  process.exitCode = 1; await persist();
} finally { await closePdfBrowser?.().catch(() => {}); await closeDatabase?.().catch(() => {}); await direct.end().catch(() => {}); }
