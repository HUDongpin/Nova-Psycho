import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { demoAdvice, demoTemplate } from "../src/domain/demo";
import { scoreAssessment } from "../src/domain/scoring";
import { previewAnswers } from "../src/domain/triad-report";
import { childScaleStaffNotes as childScale, parentScaleStaffNotes as parentScale, parentScaleV1, teacherScaleStaffNotes as teacherScale } from "../src/domain/triad-scales";
import type { AssessmentSnapshot, Locale, Region, ReportPayload, RespondentRole, ScaleDefinition } from "../src/domain/types";
import { getConfig } from "../src/lib/config";
import { closeDatabase, query } from "../src/lib/db";
import { closePdfBrowser } from "../src/lib/pdf";
import { readPrivatePdf } from "../src/lib/storage";
import { processReportJob } from "../src/lib/worker";
import { noticeVersion } from "../src/lib/privacy";

// Reproducible setup: node scripts/triad-comparison-checks.mjs
// Dedicated synthetic database only. This script invokes the real PostgreSQL
// query, worker, HTML renderer, encrypted storage and Chromium PDF renderer.
// It does not alter existing submissions or run the background queue.
const OWNER = "nova-triad-selection-v1";
const roles: RespondentRole[] = ["student", "parent", "teacher"];
const definitions = { student: childScale, parent: parentScale, teacher: teacherScale };
type Family = { id: string; users: Record<RespondentRole, string> };
type Round = { id: string | null; family: Family; assessmentIds: string[]; parentId: string; dates: Record<RespondentRole, string> };
type Options = {
  id?: string; region?: Region; submittedAt?: string; value?: number; age?: number;
  parentVersion?: ScaleDefinition; status?: "queued" | "failed"; unbound?: boolean;
  pendingRole?: RespondentRole; missingSnapshotRole?: RespondentRole; teacherId?: string;
};
const results: { name: string; passed: boolean; durationMs: number; error?: string }[] = [];
const createdFamilies: string[] = [];
const reportArtifacts: { name: string; reportId: string; locale: Locale; bytes: number; file: string }[] = [];
const fixtureIds: string[] = [];
let output = "";
let completed = false;
let failure: string | undefined;

const time = (date: string) => `${date}T00:00:00.000Z`;
async function persist() {
  if (!output) return;
  await fs.writeFile(path.join(output, "results.json"), JSON.stringify({
    completed, passed: completed && !failure, syntheticOnly: true, realPostgreSql: true, queryMocks: false,
    realWorker: true, realPdf: true, aiEnabled: false, database: new URL(getConfig().databaseUrl).pathname.slice(1),
    acceptedSnapshotsModified: false, createdFamilies, reportArtifacts, results, ...(failure ? { failure } : {})
  }, null, 2) + "\n", { mode: 0o600 });
}
async function check(name: string, action: () => Promise<void>) {
  const start = Date.now();
  try { await action(); results.push({ name, passed: true, durationMs: Date.now() - start }); console.log(`PASS ${name}`); }
  catch (error) {
    failure = error instanceof assert.AssertionError ? error.message : error instanceof Error ? error.name : "UnknownError";
    results.push({ name, passed: false, durationMs: Date.now() - start, error: failure });
    throw error;
  } finally { await persist(); }
}
async function user(role: RespondentRole, region: Region = "CN") {
  const id = randomUUID();
  await query("INSERT INTO users(id,region,name,role,demo) VALUES($1,$2,$3,$4,true)", [id, region, `合成轮次验证${role}`, role]);
  return id;
}
async function family(existingUsers?: Family["users"]): Promise<Family> {
  const id = randomUUID();
  const users = existingUsers ?? { student: await user("student"), parent: await user("parent"), teacher: await user("teacher") };
  await query("INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label) VALUES($1,'CN','合成轮次验证家庭','合成轮次验证孩子','2015-01-01','小学','合成监护人')", [id]);
  for (const role of roles) await query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,$3)", [id, users[role], role]);
  for (const scope of ["assessment", "sensitive_data", "parent_report"]) await query("INSERT INTO consents(id,family_id,actor_id,guardian_name,method,reference,notice_version,scopes) VALUES($1,$2,$3,'合成监护人','synthetic','SYNTHETIC-TRIAD-SELECTION',$4,$5)", [randomUUID(), id, users.parent, noticeVersion, JSON.stringify([scope])]);
  createdFamilies.push(id);
  return { id, users };
}
async function round(f: Family, createdAt: string, options: Options = {}): Promise<Round> {
  const id = options.unbound ? null : options.id ?? randomUUID(), region = options.region ?? "CN";
  if (id) await query("INSERT INTO triad_rounds(id,family_id,region,created_at) VALUES($1,$2,$3,$4)", [id, f.id, region, createdAt]);
  const result: Round = { id, family: f, assessmentIds: [], parentId: "", dates: {} as Round["dates"] };
  for (const [index, role] of roles.entries()) {
    const scale = role === "parent" ? options.parentVersion ?? parentScale : definitions[role];
    const preview = structuredClone(scale), age = options.age ?? 12;
    for (const item of preview.items) if (item.id === "c_age" || item.id === "p_age") item.choices = item.choices.filter(choice => choice.value === age);
    const answers = previewAnswers(preview);
    for (const item of scale.items) if (item.visibleFromAge !== undefined && age < item.visibleFromAge) delete answers[item.id];
    for (const item of scale.items) if (typeof answers[item.id] === "string") answers[item.id] = "合成文字，仅供本地验证";
    for (const itemId of scale.dimensions[0].items) answers[itemId] = options.value ?? 4;
    const submittedAt = new Date(Date.parse(options.submittedAt ?? createdAt) + (index + 1) * 60000).toISOString();
    const score = scoreAssessment(scale, answers, { age, region, role });
    assert.equal(score.status, "valid", "Synthetic complete fixture must be valid");
    const snapshot: AssessmentSnapshot = {
      scale, score, advice: { id: "synthetic-advice", version: "1.0.0", content: demoAdvice },
      template: { id: "synthetic-template", version: "1.0.0", content: demoTemplate },
      childName: "合成轮次验证孩子", grade: "小学", submittedAt, aiConsented: false
    };
    const assessmentId = randomUUID(), pending = options.pendingRole === role;
    await query(`INSERT INTO assessments(id,family_id,region,respondent_id,respondent_role,scale_version_id,locale,
      status,answers,snapshot,created_at,submitted_at,acknowledged_at,triad_round_id)
      VALUES($1,$2,$3,$4,$5,$6,'zh-CN',$7,$8,$9,$10,$11,$11,$12)`, [
      assessmentId, f.id, region, role === "teacher" ? options.teacherId ?? f.users.teacher : f.users[role], role,
      `${scale.id}@${scale.version}`, pending ? "pending" : options.status ?? "queued",
      pending ? null : JSON.stringify(answers), pending || options.missingSnapshotRole === role ? null : JSON.stringify(snapshot),
      createdAt, pending ? null : submittedAt, id
    ]);
    result.assessmentIds.push(assessmentId);
    result.dates[role] = submittedAt;
    if (role === "parent") result.parentId = assessmentId;
    fixtureIds.push(assessmentId);
  }
  return result;
}
async function job(r: Round, state = "ready", attempts = 0) {
  const id = randomUUID();
  await query("INSERT INTO report_jobs(id,assessment_id,source_assessment_ids,state,attempts) VALUES($1,$2,$3,$4,$5)", [id, r.parentId, r.assessmentIds, state, attempts]);
  return id;
}
async function publish(r: Round, name: string, attempts = 0): Promise<ReportPayload> {
  const before = await query("SELECT id,answers,snapshot,submitted_at,respondent_id,triad_round_id FROM assessments WHERE id=ANY($1::uuid[]) ORDER BY id", [fixtureIds]);
  const target = await job(r, "ready", attempts);
  assert.deepEqual(await processReportJob(target), { status: "published" }, "Real worker must publish requested fixture job");
  const rows = await query<{ payload: ReportPayload; pdf_keys: Record<Locale, string>; html_documents: Record<Locale, string> }>("SELECT payload,pdf_keys,html_documents FROM reports WHERE assessment_id=$1 AND family_id=$2", [r.parentId, r.family.id]);
  assert.equal(rows.length, 1);
  const report = rows[0];
  assert.equal(report.payload.generationMode, "template");
  assert.equal(report.payload.aiModel, null);
  assert.equal(report.payload.triad?.comparisons?.length, 3);
  assert.equal(JSON.stringify(report.payload.triad?.comparisons).includes("respondentId"), false);
  const after = await query("SELECT id,answers,snapshot,submitted_at,respondent_id,triad_round_id FROM assessments WHERE id=ANY($1::uuid[]) ORDER BY id", [fixtureIds]);
  assert.deepEqual(after, before, "Generation must preserve accepted answers, snapshots, identities and round bindings");
  for (const locale of ["zh-CN", "zh-HK"] as const) {
    const pdf = await readPrivatePdf(report.pdf_keys[locale]);
    assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
    const file = `${name}-${locale}.pdf`;
    await fs.writeFile(path.join(output, file), pdf, { flag: "wx", mode: 0o600 });
    await fs.writeFile(path.join(output, `${name}-${locale}.html`), report.html_documents[locale], { flag: "wx", mode: 0o600 });
    reportArtifacts.push({ name, reportId: r.parentId, locale, bytes: pdf.length, file });
  }
  assert.deepEqual(await processReportJob(target), { status: "already_done" }, "Duplicate delivery must keep the frozen report");
  return report.payload;
}
function assertBaseline(payload: ReportPayload, prior: Round, expectedPrevious: number, expectedCurrent: number) {
  for (const comparison of payload.triad!.comparisons!) {
    assert.equal(comparison.available, true);
    assert.equal(comparison.previousDate, prior.dates[comparison.role]);
    const firstKey = definitions[comparison.role].dimensions[0].key;
    const change = comparison.changes!.find(item => item.key === firstKey)!;
    assert.ok(change);
    assert.equal(change.previous, expectedPrevious);
    assert.equal(change.current, expectedCurrent);
    assert.equal(change.delta, expectedCurrent - expectedPrevious);
  }
}
async function guard() {
  assert.equal(process.env.NOVA_TRIAD_SELECTION_OWNERSHIP, OWNER, "Explicit dedicated test ownership required");
  assert.equal(process.env.NOVA_AUTH_PROVIDER, "local");
  assert.equal(process.env.NOVA_AI_ENABLED, "false");
  assert.equal(process.env.NODE_OPTIONS, undefined, "Run without a test clock or inherited Node preload");
  const config = getConfig(), url = new URL(config.databaseUrl);
  assert.equal(config.mode, "demo"); assert.equal(config.region, "CN"); assert.equal(config.ai.enabled, false);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)); assert.ok(url.port);
  assert.match(url.pathname, /^\/nova_triad_selection_[a-z0-9_]+$/);
  const publicUrl = new URL(config.publicUrl);
  assert.equal(publicUrl.protocol, "http:"); assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(publicUrl.hostname));
  assert.equal(config.reportStorage, "filesystem");
  const selectionRoot = process.env.NOVA_TRIAD_SELECTION_ROOT, proposed = process.env.NOVA_TRIAD_SELECTION_OUTPUT_DIR;
  assert.ok(selectionRoot && proposed, "Explicit owned root and private output directory required");
  const rootRelative = path.relative(path.resolve("work"), path.resolve(selectionRoot));
  assert.ok(rootRelative && !rootRelative.startsWith("..") && !path.isAbsolute(rootRelative), "Selection root must remain in work/");
  for (const target of [config.reportDir, path.resolve(proposed)]) {
    const relative = path.relative(path.resolve(selectionRoot), target);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Reports and evidence must remain under the owned selection root");
  }
  assert.equal((await query("SELECT owner FROM triad_selection_test_owner WHERE singleton=true"))[0]?.owner, OWNER);
  assert.equal((await query("SELECT current_database() AS name"))[0]?.name, url.pathname.slice(1));
  output = path.resolve(proposed);
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(output, "results.json"), "{}\n", { flag: "wx", mode: 0o600 });
}
async function main() {
  await guard();
  await check("latest earlier complete round is usable without a report or report job", async () => {
    const f = await family();
    await round(f, time("2026-01-01"), { value: 1 });
    const prior = await round(f, time("2026-03-01"), { value: 2 });
    const current = await round(f, time("2026-09-01"), { value: 5 });
    assert.equal((await query("SELECT id FROM reports WHERE family_id=$1", [f.id])).length, 0);
    assert.equal((await query("SELECT id FROM report_jobs WHERE assessment_id=ANY($1::uuid[])", [prior.assessmentIds])).length, 0);
    assertBaseline(await publish(current, "missing-prior-report"), prior, 2, 5);
  });
  await check("failed previous report remains baseline when old job runs after newer and invalid rounds", async () => {
    const f = await family();
    await round(f, time("2026-01-01"), { value: 1 });
    const prior = await round(f, time("2026-03-01"), { value: 2, status: "failed" });
    const failedJob = await job(prior, "failed", 3);
    await round(f, time("2026-04-01"), { value: 5, pendingRole: "teacher" });
    await round(f, time("2026-05-01"), { value: 5, missingSnapshotRole: "student" });
    await round(f, time("2026-06-01"), { value: 5, unbound: true });
    await round(await family(f.users), time("2026-07-01"), { value: 5 });
    await round(f, time("2026-08-01"), { region: "HK", value: 5 });
    // A malformed chronological history must not provide a future baseline.
    await round(f, time("2026-08-15"), { submittedAt: time("2026-10-01"), value: 1 });
    const current = await round(f, time("2026-09-01"), { value: 4 });
    const newer = await round(f, time("2026-11-01"), { value: 5 });
    const newerJob = await job(newer);
    assertBaseline(await publish(current, "failed-prior-delayed-current", 1), prior, 2, 4);
    assert.equal((await query("SELECT state FROM report_jobs WHERE id=$1", [failedJob]))[0].state, "failed");
    assert.equal((await query("SELECT state FROM report_jobs WHERE id=$1", [newerJob]))[0].state, "ready");
  });
  await check("incomplete unbound other-family other-region and newer-only histories are not first-round baselines", async () => {
    const f = await family();
    await round(f, time("2026-01-01"), { pendingRole: "teacher" });
    await round(f, time("2026-02-01"), { unbound: true });
    await round(await family(f.users), time("2026-03-01"));
    await round(f, time("2026-04-01"), { region: "HK" });
    const current = await round(f, time("2026-09-01"));
    await round(f, time("2026-10-01"));
    const payload = await publish(current, "no-eligible-history");
    assert.deepEqual(payload.comparison, { available: false, reason: "first_assessment" });
    for (const comparison of payload.triad!.comparisons!) {
      assert.equal(comparison.available, false); assert.equal(comparison.reason, "first_assessment");
      assert.equal(comparison.previousDate, undefined); assert.equal(comparison.changes, undefined);
    }
  });
  await check("latest incompatible parent version is disclosed instead of skipping to older compatible history", async () => {
    const f = await family();
    await round(f, time("2026-01-01"), { value: 1 });
    const prior = await round(f, time("2026-05-01"), { parentVersion: parentScaleV1, value: 2 });
    const current = await round(f, time("2026-09-01"), { value: 5 });
    const payload = await publish(current, "latest-parent-version-mismatch");
    assert.equal(payload.comparison.available, true);
    for (const comparison of payload.triad!.comparisons!) {
      assert.equal(comparison.previousDate, prior.dates[comparison.role]);
      if (comparison.role === "parent") {
        assert.equal(comparison.available, false); assert.equal(comparison.reason, "incompatible_version");
        assert.equal(comparison.changes, undefined);
      } else {
        assert.equal(comparison.available, true);
        assert.equal(comparison.changes![0].previous, 2); assert.equal(comparison.changes![0].delta, 3);
      }
    }
  });
  await check("new teacher is excluded while age-11 child comparison explicitly omits the gated dimension", async () => {
    const f = await family(), oldTeacher = await user("teacher");
    const prior = await round(f, time("2026-03-01"), { age: 11, value: 2, teacherId: oldTeacher });
    const current = await round(f, time("2026-09-01"), { age: 11, value: 5 });
    const payload = await publish(current, "teacher-change-age-11");
    const student = payload.triad!.comparisons!.find(item => item.role === "student")!;
    assert.equal(student.available, true); assert.equal(student.previousDate, prior.dates.student);
    assert.deepEqual(student.omitted?.map(item => item.key), ["c18"]);
    assert.equal(student.changes!.some(item => item.key === "c18"), false);
    const teacher = payload.triad!.comparisons!.find(item => item.role === "teacher")!;
    assert.equal(teacher.available, false); assert.equal(teacher.reason, "different_respondent");
    assert.equal(teacher.previousDate, prior.dates.teacher);
  });
  await check("round UUID tie-break excludes a later round even when its submissions predate the current round", async () => {
    const f = await family(), createdAt = time("2026-01-01");
    const prefix = randomUUID().slice(0, 24);
    const prior = await round(f, createdAt, { id: `${prefix}000000000001`, submittedAt: time("2026-02-01"), value: 2 });
    const current = await round(f, createdAt, { id: `${prefix}000000000002`, submittedAt: time("2026-09-01"), value: 5 });
    await round(f, createdAt, { id: `${prefix}000000000003`, submittedAt: time("2026-06-01"), value: 1 });
    assertBaseline(await publish(current, "same-created-at-order"), prior, 2, 5);
  });
  completed = true;
  console.log(`Real PostgreSQL triad selection passed: ${results.length} cases, ${reportArtifacts.length} rendered PDFs.`);
}
try { await main(); }
catch (error) { failure ??= error instanceof assert.AssertionError ? error.message : error instanceof Error ? error.name : "UnknownError"; console.error(`FAIL triad selection: ${failure}`); process.exitCode = 1; }
finally { await closePdfBrowser(); await closeDatabase(); await persist(); }
