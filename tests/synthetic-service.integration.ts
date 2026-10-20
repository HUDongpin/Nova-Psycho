import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import type { Actor, AssessmentSnapshot, Locale, ReportPayload, RespondentRole, ScaleDefinition } from "../src/domain/types";

const configPath = process.env.NOVA_SYNTHETIC_SERVICE_TEST_CONFIG;
assert.ok(configPath, "Explicit owned local configuration is required");
const runtimeRoot = path.resolve("work/qa/synthetic-online-20261020/local-service-runtime");
const relative = path.relative(runtimeRoot, path.resolve(configPath));
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
const config = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, string>;
assert.equal(config.NOVA_SYNTHETIC_SERVICE_TEST_OWNER, "local-synthetic-service-20261020");
const url = new URL(config.DATABASE_URL);
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.port, "55558");
assert.equal(url.pathname, "/nova_synthetic_service_test");
assert.equal(config.NOVA_MODE, "service");
assert.equal(config.NOVA_REGION, "HK");
assert.equal(config.NOVA_AUTH_PROVIDER, "clerk");
assert.equal(config.NOVA_AI_ENABLED, "false");
assert.equal(config.NOVA_REPORT_STORAGE, "database");
assert.equal(config.NOVA_WORKER_MODE, "continuous");
assert.equal(config.NOVA_PUBLIC_URL, "https://synthetic.example.invalid");
assert.equal(process.env.NODE_OPTIONS, undefined);
for (const [key, value] of Object.entries(config)) process.env[key] = value;
const output = path.resolve(config.NOVA_SYNTHETIC_SERVICE_TEST_OUTPUT);
assert.ok(output.startsWith(path.dirname(path.resolve(configPath)) + path.sep));
await fs.mkdir(output, { recursive: true, mode: 0o700 });

const direct = new pg.Client({ connectionString: config.DATABASE_URL });
const results: { name: string; passed: boolean; error?: string }[] = [];
const roles: RespondentRole[] = ["student", "parent", "teacher"];
const password = randomBytes(24).toString("base64url");
const prefix = `synthetic_${randomBytes(6).toString("hex")}`;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const origin = config.NOVA_PUBLIC_URL;
let closeDatabase: (() => Promise<void>) | undefined;
let closePdfBrowser: (() => Promise<void>) | undefined;
let completed = false;
async function persist() {
  await fs.writeFile(path.join(output, "results.json"), JSON.stringify({
    passed: completed && results.every(result => result.passed), completed, syntheticOnly: true,
    databaseHost: "127.0.0.1", mode: "service", region: "HK", auth: "real test-session cookies",
    proxyBoundary: "Route handlers invoked directly; no Next middleware or external Clerk calls",
    aiEnabled: false, results,
  }, null, 2), { mode: 0o600 });
}
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) {
    results.push({ name, passed: false, error: error instanceof assert.AssertionError ? error.message : error instanceof Error ? error.name : "UnknownError" });
    throw error;
  } finally { await persist(); }
}
try {
  await direct.connect();
  assert.equal((await direct.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0, "Only a new empty owned database may be initialized");
  await direct.query(await fs.readFile("src/lib/schema.sql", "utf8"));
  await direct.query("INSERT INTO deployment_settings(singleton,region,mode) VALUES(true,'HK','service')");
  const route = await import("../src/app/api/[...path]/route");
  const auth = await import("../src/lib/auth");
  const db = await import("../src/lib/db");
  closeDatabase = db.closeDatabase;
  closePdfBrowser = (await import("../src/lib/pdf")).closePdfBrowser;
  const { processReportJob } = await import("../src/lib/worker");
  const { saveDraft, submitAssessment } = await import("../src/lib/assessments");
  const { getSyntheticTestFamilyMembers } = await import("../src/lib/synthetic-testing");
  const { childScaleStaffNotes, parentScaleStaffNotes, teacherScaleStaffNotes } = await import("../src/domain/triad-scales");
  const { previewAnswers, TRIAD_BUNDLE } = await import("../src/domain/triad-report");
  const { scoreAssessment } = await import("../src/domain/scoring");
  const { triadAdvice, triadTemplate } = await import("../src/lib/triad");
  const definitions: Record<RespondentRole, ScaleDefinition> = { student: childScaleStaffNotes, parent: parentScaleStaffNotes, teacher: teacherScaleStaffNotes };
  const users = {} as Record<RespondentRole, { id: string; username: string }>;
  const cookie = {} as Record<RespondentRole, string>;
  const actors = {} as Record<RespondentRole, Actor>;
  let adviceId = "", templateId = "";
  for (const role of roles) {
    users[role] = { id: randomUUID(), username: `${prefix}_${role}` };
    await direct.query("INSERT INTO users(id,region,username,name,role,password_hash,demo) VALUES($1,'HK',$2,$3,$4,$5,false)", [
      users[role].id, users[role].username, `Synthetic ${role}`, role, await auth.hashPassword(password),
    ]);
    const scale = definitions[role];
    await direct.query("INSERT INTO scales(id,scale_id,version,definition) VALUES($1,$2,$3,$4)", [`${scale.id}@${scale.version}`, scale.id, scale.version, JSON.stringify(scale)]);
    assert.equal(scale.norm.validated, false);
  }
  await check("bounded content migration adds keyed seeds once and preserves general library", async () => {
    const { ensureSyntheticTriadContent } = await import("../scripts/migrations/20261020-synthetic-triad-content");
    await direct.query("INSERT INTO content_versions(id,kind,version,content) VALUES($1,'template','1.0.0',$2)", [randomUUID(), JSON.stringify({ synthetic: "Existing general content" })]);
    const original = hash((await direct.query("SELECT * FROM content_versions WHERE library_key IS NULL ORDER BY id")).rows);
    await direct.query("BEGIN");
    try {
      assert.deepEqual(await ensureSyntheticTriadContent(direct), [{ kind: "advice", inserted: true }, { kind: "template", inserted: true }]);
      assert.deepEqual(await ensureSyntheticTriadContent(direct), [{ kind: "advice", inserted: false }, { kind: "template", inserted: false }]);
      assert.equal(hash((await direct.query("SELECT * FROM content_versions WHERE library_key IS NULL ORDER BY id")).rows), original);
      await direct.query("COMMIT");
    } catch (error) { await direct.query("ROLLBACK"); throw error; }
    const rows = (await direct.query("SELECT id,kind FROM content_versions WHERE library_key='growth-triad'")).rows;
    adviceId = rows.find(row => row.kind === "advice").id;
    templateId = rows.find(row => row.kind === "template").id;
  });
  const baselineDefinitions = hash((await direct.query("SELECT id,definition FROM scales ORDER BY id")).rows);
  async function family() {
    const id = randomUUID();
    await direct.query("INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label) VALUES($1,'HK','Synthetic test family','Synthetic test child','2014-01-01','初中','Synthetic guardian')", [id]);
    for (const role of roles) await direct.query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,$3)", [id, users[role].id, role]);
    for (const scope of ["assessment", "sensitive_data", "parent_report", "ai_processing"]) await direct.query("INSERT INTO consents(id,family_id,actor_id,guardian_name,method,notice_version,scopes) VALUES($1,$2,$3,'Synthetic guardian','synthetic','synthetic-test-v1',$4)", [randomUUID(), id, users.parent.id, JSON.stringify([scope])]);
    return id;
  }
  const familyId = await family();
  process.env.NOVA_TEST_ACCOUNT_USERNAMES = roles.map(role => users[role].username).join(",");
  process.env.NOVA_SYNTHETIC_TEST_FAMILY_IDS = familyId;
  async function request(method: "GET" | "POST" | "PATCH", endpoint: string, session = "", body?: unknown) {
    const r = new Request(`${origin}/api/${endpoint}`, { method, headers: { Origin: origin, ...(session ? { Cookie: session } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return route[method](r, { params: Promise.resolve({ path: endpoint.split("?")[0].split("/") }) });
  }
  async function json<T = Record<string, unknown>>(method: "GET" | "POST" | "PATCH", endpoint: string, session = "", body?: unknown, expected = 200): Promise<T> {
    const response = await request(method, endpoint, session, body);
    const value = await response.json();
    assert.equal(response.status, expected, `${method} ${endpoint.replace(/[0-9a-f-]{36}/g, "<id>")} ${value.code ?? ""}`);
    return value as T;
  }
  async function rejected(method: "POST" | "PATCH", endpoint: string, session: string, body: unknown, code = "UNVALIDATED_INSTRUMENT", status = 409) {
    const value = await json(method, endpoint, session, body, status);
    assert.equal(value.code, code);
  }
  const answers = (role: RespondentRole) => {
    const scale = structuredClone(definitions[role]);
    for (const item of scale.items) if (item.id === "c_age" || item.id === "p_age") item.choices = item.choices.filter(choice => choice.value === 12);
    const value = previewAnswers(scale, "calm");
    for (const item of scale.items) if (typeof value[item.id] === "string") value[item.id] = `Synthetic local response ${role}`;
    assert.equal(scoreAssessment(definitions[role], value, { age: 12, region: "HK", role }).status, "valid");
    return value;
  };
  await check("password login issues authentic test-session actors", async () => {
    for (const role of roles) {
      const response = await request("POST", "auth/test-login", "", { username: users[role].username, password });
      assert.equal(response.status, 200);
      cookie[role] = response.headers.get("set-cookie")!.split(";")[0];
      assert.ok(cookie[role].startsWith("nova_hk_test_session="));
      actors[role] = (await auth.actorOf(new Request(origin, { headers: { Cookie: cookie[role] } })))!;
      assert.equal(actors[role].sessionMethod, "test");
      assert.equal(actors[role].id, users[role].id);
    }
  });
  const tasks = {} as Record<RespondentRole, string>;
  await check("test parent assigns unvalidated questionnaires only in configured family", async () => {
    for (const role of roles) tasks[role] = (await json<{ id: string }>("POST", "assessments", cookie.parent, { familyId, respondentId: users[role].id, scaleVersionId: `${definitions[role].id}@${definitions[role].version}`, locale: "zh-HK" }, 201)).id;
    const members = await getSyntheticTestFamilyMembers(familyId, "HK");
    assert.equal(members?.length, 3);
  });
  await check("ordinary actor remains denied even inside designated family", async () => {
    const plain = { ...actors.parent }; delete plain.sessionMethod;
    await assert.rejects(saveDraft(plain, tasks.parent, { answers: answers("parent"), acknowledged: true, revision: 0 }), (error: { code?: string }) => error.code === "UNVALIDATED_INSTRUMENT");
    await assert.rejects(submitAssessment(plain, tasks.parent, { answers: answers("parent"), acknowledged: true, revision: 0 }), (error: { code?: string }) => error.code === "UNVALIDATED_INSTRUMENT");
  });
  await check("client cannot opt into synthetic mode through request fields", async () => {
    await rejected("PATCH", `assessments/${tasks.parent}`, cookie.parent, { answers: {}, acknowledged: true, revision: 0, syntheticTest: true }, "VALIDATION_FAILED", 422);
  });
  await check("draft save restores exact values and rejects stale revisions", async () => {
    const first = answers("parent");
    const saved = await json("PATCH", `assessments/${tasks.parent}`, cookie.parent, { answers: first, acknowledged: true, revision: 0 });
    assert.equal(saved.revision, 1);
    const record = await json("GET", `assessments/${tasks.parent}`, cookie.parent);
    assert.equal(record.syntheticTest, true);
    assert.equal(record.responseBlockedReason, undefined);
    assert.deepEqual(record.draftAnswers, first);
    await rejected("PATCH", `assessments/${tasks.parent}`, cookie.parent, { answers: {}, acknowledged: true, revision: 0 }, "DRAFT_CONFLICT");
    assert.deepEqual((await json("GET", `assessments/${tasks.parent}`, cookie.parent)).draftAnswers, first);
  });
  await check("removing family configuration immediately restores formal restriction", async () => {
    process.env.NOVA_SYNTHETIC_TEST_FAMILY_IDS = "";
    try {
      await rejected("PATCH", `assessments/${tasks.parent}`, cookie.parent, { answers: {}, acknowledged: true, revision: 1 });
      assert.equal((await json("GET", `assessments/${tasks.parent}`, cookie.parent)).responseBlockedReason, "UNVALIDATED_INSTRUMENT");
    } finally { process.env.NOVA_SYNTHETIC_TEST_FAMILY_IDS = familyId; }
  });
  await check("a disabled member or extra member invalidates synthetic family", async () => {
    await direct.query("UPDATE users SET disabled=true WHERE id=$1", [users.teacher.id]);
    try { await rejected("PATCH", `assessments/${tasks.parent}`, cookie.parent, { answers: {}, acknowledged: true, revision: 1 }); }
    finally { await direct.query("UPDATE users SET disabled=false WHERE id=$1", [users.teacher.id]); }
    const extra = randomUUID();
    await direct.query("INSERT INTO users(id,region,name,role,demo) VALUES($1,'HK','Synthetic extra member','teacher',false)", [extra]);
    await direct.query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,'teacher')", [familyId, extra]);
    try { await rejected("PATCH", `assessments/${tasks.parent}`, cookie.parent, { answers: {}, acknowledged: true, revision: 1 }); }
    finally { await direct.query("DELETE FROM memberships WHERE family_id=$1 AND user_id=$2", [familyId, extra]); }
  });
  await check("test session cannot assign or write in an unscoped family", async () => {
    const unscoped = await family();
    await rejected("POST", "assessments", cookie.parent, { familyId: unscoped, respondentId: users.parent.id, scaleVersionId: `${definitions.parent.id}@${definitions.parent.version}`, locale: "zh-HK" });
  });
  await check("consent remains necessary for synthetic drafts", async () => {
    const revoked = (await direct.query("UPDATE consents SET revoked_at=now() WHERE family_id=$1 AND scopes='[\"sensitive_data\"]'::jsonb RETURNING id", [familyId])).rows[0].id;
    try { await rejected("PATCH", `assessments/${tasks.parent}`, cookie.parent, { answers: answers("parent"), acknowledged: true, revision: 1 }, "GUARDIAN_CONSENT_REQUIRED"); }
    finally { await direct.query("UPDATE consents SET revoked_at=NULL WHERE id=$1", [revoked]); }
  });
  await check("three API submissions create one fixed-source job without AI consent", async () => {
    for (const role of roles) {
      const result = await json("POST", `assessments/${tasks[role]}/submit`, cookie[role], { answers: answers(role), acknowledged: true, revision: role === "parent" ? 1 : 0 });
      assert.equal(result.status, "queued");
      const snapshot = (await direct.query("SELECT snapshot FROM assessments WHERE id=$1", [tasks[role]])).rows[0].snapshot as AssessmentSnapshot;
      assert.equal(snapshot.syntheticTest, true);
      assert.equal(snapshot.aiConsented, false);
      assert.equal(snapshot.score.demo, true);
      assert.equal(snapshot.scale.norm.validated, false);
    }
    assert.equal((await direct.query("SELECT count(*)::int AS n FROM report_jobs WHERE assessment_id=ANY($1::uuid[])", [Object.values(tasks)])).rows[0].n, 1);
  });
  async function verifyReport(jobId: string, familyId: string, stem: string) {
    assert.deepEqual(await processReportJob(jobId), { status: "published" });
    const row = (await direct.query("SELECT id,payload,html_documents FROM reports WHERE family_id=$1 ORDER BY created_at DESC LIMIT 1", [familyId])).rows[0];
    assert.ok(row);
    const payload = row.payload as ReportPayload;
    assert.equal(payload.syntheticTest, true);
    assert.equal(payload.generationMode, "template");
    assert.equal(payload.aiModel, null);
    assert.equal(payload.aiConsented, false);
    assert.equal(payload.score.demo, true);
    assert.equal(payload.scale.norm.validated, false);
    for (const locale of ["zh-CN", "zh-HK"] as Locale[]) {
      assert.ok(row.html_documents[locale].includes(locale === "zh-CN" ? "线上合成测试报告" : "線上合成測試報告"));
      const response = await request("GET", `reports/${row.id}/pdf?locale=${locale}`, cookie.parent);
      assert.equal(response.status, 200);
      const pdf = Buffer.from(await response.arrayBuffer());
      assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
      await fs.writeFile(path.join(output, `${stem}-${locale}.pdf`), pdf, { mode: 0o600 });
      await fs.writeFile(path.join(output, `${stem}-${locale}.html`), row.html_documents[locale], { mode: 0o600 });
    }
    assert.deepEqual(await processReportJob(jobId), { status: "already_done" });
  }
  await check("real worker produces labeled bilingual database PDFs once", async () => {
    const job = (await direct.query("SELECT id FROM report_jobs WHERE assessment_id=ANY($1::uuid[])", [Object.values(tasks)])).rows[0];
    await verifyReport(job.id, familyId, "current-synthetic");
    assert.equal((await direct.query("SELECT count(*)::int AS n FROM report_files WHERE family_id=$1", [familyId])).rows[0].n, 2);
  });
  await check("published synthetic reports retain role and consent read boundaries", async () => {
    const reportId = (await direct.query("SELECT id FROM reports WHERE family_id=$1", [familyId])).rows[0].id;
    for (const role of ["student", "teacher"] as const) {
      const response = await request("GET", `reports/${reportId}`, cookie[role]);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, "ROLE_DENIED");
    }
    const grant = (await direct.query("SELECT id FROM consents WHERE family_id=$1 AND scopes='[\"parent_report\"]'::jsonb AND revoked_at IS NULL", [familyId])).rows[0].id;
    await direct.query("UPDATE consents SET revoked_at=now() WHERE id=$1", [grant]);
    try {
      const response = await request("GET", `reports/${reportId}/pdf`, cookie.parent);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "GUARDIAN_CONSENT_REQUIRED");
    } finally { await direct.query("UPDATE consents SET revoked_at=NULL WHERE id=$1", [grant]); }
  });
  await check("replayed submission is immutable and immediate retake is still blocked", async () => {
    const before = hash((await direct.query("SELECT id,answers,snapshot,submitted_at FROM assessments WHERE id=ANY($1::uuid[]) ORDER BY id", [Object.values(tasks)])).rows);
    const replay = await json("POST", `assessments/${tasks.parent}/submit`, cookie.parent, { answers: answers("parent"), acknowledged: true, revision: 1 });
    assert.equal(replay.status, "published");
    assert.equal(hash((await direct.query("SELECT id,answers,snapshot,submitted_at FROM assessments WHERE id=ANY($1::uuid[]) ORDER BY id", [Object.values(tasks)])).rows), before);
    await rejected("POST", "assessments", cookie.parent, { familyId, respondentId: users.parent.id, scaleVersionId: `${definitions.parent.id}@${definitions.parent.version}`, locale: "zh-HK" }, "RETAKE_INTERVAL");
    assert.equal((await direct.query("SELECT count(*)::int AS n FROM reports WHERE family_id=$1", [familyId])).rows[0].n, 1);
  });
  await check("legacy unmarked teacher snapshot is accepted only through canonical scoped bindings", async () => {
    const legacyFamily = await family(), round = randomUUID(), sourceIds: string[] = [];
    process.env.NOVA_SYNTHETIC_TEST_FAMILY_IDS = `${familyId},${legacyFamily}`;
    await direct.query("INSERT INTO triad_rounds(id,family_id,region) VALUES($1,$2,'HK')", [round, legacyFamily]);
    for (const role of roles) {
      const id = randomUUID(), submittedAt = new Date().toISOString(), scale = definitions[role];
      const snapshot: AssessmentSnapshot = { scale, score: scoreAssessment(scale, answers(role), { age: 12, region: "HK", role }), advice: { id: adviceId, version: "1.0.0", content: triadAdvice }, template: { id: templateId, version: "1.0.0", content: triadTemplate }, childName: "Synthetic legacy child", grade: "初中", submittedAt, aiConsented: role === "teacher", ...(role === "teacher" ? {} : { syntheticTest: true }) };
      assert.equal(scale.bundle, TRIAD_BUNDLE);
      await direct.query("INSERT INTO assessments(id,family_id,region,respondent_id,respondent_role,scale_version_id,locale,status,answers,snapshot,submitted_at,acknowledged_at,triad_round_id) VALUES($1,$2,'HK',$3,$4,$5,'zh-HK','queued',$6,$7,$8,$8,$9)", [id, legacyFamily, users[role].id, role, `${scale.id}@${scale.version}`, JSON.stringify(answers(role)), JSON.stringify(snapshot), submittedAt, round]);
      sourceIds.push(id);
    }
    const before = hash((await direct.query("SELECT id,answers,snapshot,submitted_at FROM assessments WHERE id=ANY($1::uuid[]) ORDER BY id", [sourceIds])).rows);
    const jobId = randomUUID();
    await direct.query("INSERT INTO report_jobs(id,assessment_id,source_assessment_ids) VALUES($1,$2,$3)", [jobId, sourceIds[1], sourceIds]);
    await verifyReport(jobId, legacyFamily, "legacy-teacher");
    assert.equal(hash((await direct.query("SELECT id,answers,snapshot,submitted_at FROM assessments WHERE id=ANY($1::uuid[]) ORDER BY id", [sourceIds])).rows), before);
  });
  await check("canonical scale validation flags remain byte-identical", async () => {
    assert.equal(hash((await direct.query("SELECT id,definition FROM scales ORDER BY id")).rows), baselineDefinitions);
  });
  for (const role of roles) await json("POST", "auth/test-logout", cookie[role], {});
  completed = true;
  await persist();
  console.log(`Synthetic service integration passed: ${results.length} checks.`);
} catch (error) {
  console.error(error instanceof assert.AssertionError ? `Assertion failed: ${error.message}` : `Integration failed: ${error instanceof Error ? error.name : "UnknownError"}`);
  process.exitCode = 1;
  await persist();
} finally {
  await closePdfBrowser?.().catch(() => {});
  await closeDatabase?.().catch(() => {});
  await direct.end().catch(() => {});
}
