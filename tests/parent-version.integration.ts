import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import { Model } from "survey-core";
import type { Assessment, Locale, Report, Session, SurveyRecord, Workspace } from "../src/components/api";
import { modelInput } from "../src/domain/narrative";
import { scoreAssessment } from "../src/domain/scoring";
import { surveyDefinition } from "../src/domain/survey";
import { previewAnswers } from "../src/domain/triad-report";
import { childScaleSafety, parentScale, parentScaleSafety, parentScaleV1, teacherScaleSafety } from "../src/domain/triad-scales";
import type { AssessmentSnapshot, Region, RespondentRole, ScaleDefinition, ScaleItem, StoredAnswer } from "../src/domain/types";

type Client = { base: string; cookie: string };
type Answers = Record<string, StoredAnswer>;
type LegacyCase = { familyId: string; clients: Record<string, Client>; tasks: Record<string, string>; locale: Locale };
type LegacyPending = LegacyCase & { revision: number; expectedAnswers: Answers };
type LegacyHistory = LegacyCase & { reportId: string; documents: Array<{ locale: Locale; htmlSha256: string; pdfSha256: string }> };
type LegacyFixtures = { syntheticOnly: boolean; regions: Record<Region, { pending: LegacyPending; history: LegacyHistory }> };
type Regional = { region: Region; locale: Locale; base: string; database: pg.Client; admin: Client; assigned: Client; unassigned: Client; legacy: LegacyFixtures["regions"][Region] };
type Case = { familyId: string; parent: Client; parentTask: Assessment; joinCode: string };
type Triad = Case & { clients: Record<RespondentRole, Client>; tasks: Record<RespondentRole, Assessment> };
type Supplement = ScaleItem & { supplementFor: string; showIf: { itemId: string; anyOf: number[] } };
type Result = { name: string; passed: boolean; durationMs: number; error?: string };

const stageDir = path.resolve("work/questionnaire-version-d-20261015");
const evidenceRoot = path.join(stageDir, "api-verification");
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
const outputDir = path.resolve(process.env.NOVA_PARENT_VERSION_OUTPUT_DIR ?? path.join(evidenceRoot, runId));
const nonce = randomBytes(6).toString("hex");
const roles = ["parent", "student", "teacher"] as const;
const definitions = { parent: parentScaleSafety, student: childScaleSafety, teacher: teacherScaleSafety };
const versions = { parent: "growth-parent@1.2.0", student: "growth-child@1.1.0", teacher: "growth-teacher@1.1.0" };
const results: Result[] = [];
const created: Array<{ region: Region; scenario: string; familyId: string; assessmentId: string; reportId?: string }> = [];
const connections: pg.Client[] = [];
const guardedPending = new Set<string>();
let completed = false;
let failure: string | undefined;
let resultReady = false;
let safeAssertion: string | undefined;

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) { safeAssertion = message; throw new Error(message); }
}
const equal = (actual: unknown, expected: unknown, message: string) => requireCondition(isDeepStrictEqual(actual, expected), message);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const jsonValue = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const within = (base: string, target: string) => { const relative = path.relative(base, target); return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative); };
function loopback(value: string): string {
  const url = new URL(value);
  requireCondition(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash, "API origins must be plain loopback HTTP");
  return url.origin;
}
async function request(client: Client, route: string, method = "GET", data?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  requireCondition(route.startsWith("/api/") && !route.includes("\\"), "Only local API routes may be requested");
  const directTask = /^\/api\/assessments\/([^/?]+)(?:[/?]|$)/.exec(route)?.[1];
  requireCondition(method === "GET" || !directTask || !guardedPending.has(directTask), "Frozen legacy pending tasks are read-only in this test");
  return fetch(loopback(client.base) + route, { method, redirect: "error", signal: AbortSignal.timeout(30000), headers: { ...(client.cookie ? { Cookie: client.cookie } : {}), ...(method === "GET" ? {} : { Origin: client.base }), ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
}
async function ok<T>(client: Client, route: string, method = "GET", data?: unknown): Promise<T> {
  const response = await request(client, route, method, data);
  requireCondition(response.ok, `${method} ${route.split("?")[0].replace(/[0-9a-f-]{36}/g, "<id>")} must succeed (HTTP ${response.status})`);
  return response.json() as Promise<T>;
}
async function rejected(client: Client, route: string, method: string, data: unknown, code: string): Promise<void> {
  const response = await request(client, route, method, data);
  equal(response.status, code === "RETAKE_INTERVAL" ? 409 : 422, `${code} must use the expected HTTP status`);
  const body = await response.json() as { code?: string };
  equal(body.code, code, `${code} must remain the rejection reason`);
}
function authenticated(base: string, response: Response): Client {
  const cookie = response.headers.get("set-cookie");
  requireCondition(cookie, "Successful authentication must return a session cookie");
  return { base, cookie: cookie.split(";")[0] };
}
async function login(base: string, role: "admin" | "staff", name?: string): Promise<Client> {
  const visitor = { base, cookie: "" }, session = await ok<Session>(visitor, "/api/session");
  equal(session.mode, "demo", "Only explicit demo environments may be used");
  equal(session.authProvider, "local", "Local authentication must be active");
  const accounts = session.demoAccounts.filter(account => account.role === role && (!name || account.name.includes(name)));
  equal(accounts.length, 1, "Exactly one requested synthetic demonstration account must exist");
  const response = await request(visitor, "/api/auth/demo", "POST", { accountId: accounts[0].id });
  equal(response.status, 200, "Synthetic demonstration login must succeed");
  return authenticated(base, response);
}
const workspace = (client: Client, locale: Locale) => ok<Workspace>(client, `/api/workspace?locale=${locale}`);
const detail = (client: Client, id: string, locale: Locale) => ok<SurveyRecord>(client, `/api/assessments/${id}?locale=${locale}`);
function task(view: Workspace, familyId: string, role: RespondentRole): Assessment {
  const matches = view.assessments.filter(candidate => candidate.familyId === familyId && candidate.respondentRole === role);
  equal(matches.length, 1, "Each fixture respondent must have exactly one assessment");
  return matches[0];
}
async function persist(): Promise<void> {
  if (!resultReady) return;
  await fs.writeFile(path.join(outputDir, "results.json"), JSON.stringify({ runId, completed, passed: completed && !failure, syntheticOnly: true, aiEnabled: false, loopbackOnly: true, frozenPendingTasksReadOnly: true, fixtures: created, results, ...(failure ? { failure } : {}) }, null, 2) + "\n", { mode: 0o600 });
}
async function check<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  safeAssertion = undefined;
  try { const value = await fn(); results.push({ name, passed: true, durationMs: Date.now() - started }); console.log(`PASS ${name}`); return value; }
  catch (error) { failure = safeAssertion ?? (error instanceof Error ? error.name : "UnknownError"); results.push({ name, passed: false, durationMs: Date.now() - started, error: failure }); throw error; }
  finally { await persist(); }
}
async function row(regional: Regional, id: string): Promise<{ scale_version_id: string; status: string; draft_answers: Answers; draft_revision: number; answers: Answers | null; snapshot: AssessmentSnapshot | null }> {
  const found = await regional.database.query("SELECT scale_version_id,status,draft_answers,draft_revision,answers,snapshot FROM assessments WHERE id=$1 AND region=$2", [id, regional.region]);
  equal(found.rows.length, 1, "Exactly one region-scoped assessment must exist");
  return found.rows[0];
}
function supplements(): Supplement[] {
  const items = parentScale.items.filter((item): item is Supplement => typeof item.supplementFor === "string" && !!item.showIf);
  equal(parentScale.version, "1.1.0", "Current parent version must be 1.1.0 before running the fixed integration");
  equal(items.length, 7, "Parent 1.1.0 must register exactly seven supplementary fields");
  equal(parentScale.items.length, 152, "Parent 1.1.0 definition must have 145 main items plus seven supplements");
  for (const item of items) {
    equal(item.kind, "text", "Each supplement must be text"); equal(item.required, false, "Each supplement must be optional"); equal(item.report, "staff", "Each supplement must be staff-only");
    equal(item.showIf.itemId, item.supplementFor, "Supplement visibility must reference its own parent");
    requireCondition(!parentScale.dimensions.some(dimension => dimension.items.includes(item.id)) && !parentScale.riskRules.some(rule => rule.itemId === item.id), "Supplements must not contribute to scores or safety rules");
  }
  equal(parentScale.dimensions, parentScaleV1.dimensions, "Parent score dimensions must remain identical to version 1.0.0");
  for (const old of parentScaleV1.items.filter(item => (item.kind ?? "single") !== "text")) {
    const current = parentScale.items.find(item => item.id === old.id);
    requireCondition(current, "Every prior numeric or multiselect item must still exist");
    equal(current.choices.map(choice => choice.value), old.choices.map(choice => choice.value), "Prior numeric choice values must not change");
    equal(current.excludeValues, old.excludeValues, "Prior NA values must not change");
  }
  return items;
}
function syntheticAnswers(scale: ScaleDefinition): Answers {
  const copy = structuredClone(scale);
  for (const item of copy.items) if (item.id === "p_age" || item.id === "c_age") item.choices = item.choices.filter(choice => choice.value === 12);
  const answers = previewAnswers(copy, "calm");
  for (const item of copy.items) if (item.kind === "text") { if (item.supplementFor) delete answers[item.id]; else if (Object.hasOwn(answers, item.id)) answers[item.id] = "本地合成测试说明"; }
  return answers;
}
function allOtherAnswers(items: Supplement[], region: Region, withText: boolean): Answers {
  const answers = syntheticAnswers(parentScale);
  for (const item of items) {
    const parent = parentScale.items.find(candidate => candidate.id === item.supplementFor)!;
    answers[parent.id] = parent.kind === "multi" ? [item.showIf.anyOf[0]] : item.showIf.anyOf[0];
    if (withText) answers[item.id] = `D_STAFF_ONLY_${region}_${nonce}_${item.id}`;
  }
  answers.q14_1 = -1;
  equal(scoreAssessment(parentScale, answers, { age: 12, region, role: "parent" }).status, "valid", "Synthetic parent answers with one genuine NA must be scoreable");
  return answers;
}
async function registerParent(regional: Regional, scenario: string): Promise<Case> {
  const visitor = { base: regional.base, cookie: "" };
  const response = await request(visitor, `/api/triad/parent?locale=${regional.locale}`, "POST", { parentName: "版本验证合成家长", username: `dv_${regional.region.toLowerCase()}_${scenario}_${nonce}`, password: randomBytes(24).toString("base64url"), relationship: "母亲", childName: "版本验证合成孩子", birthDate: `${new Date().getUTCFullYear() - 12}-01-01`, grade: "初中", accepted: true });
  equal(response.status, 201, "New synthetic parent registration must succeed");
  const value = await response.json() as { familyId: string; joinCode: string };
  const parent = authenticated(regional.base, response), parentTask = task(await workspace(parent, regional.locale), value.familyId, "parent");
  created.push({ region: regional.region, scenario, familyId: value.familyId, assessmentId: parentTask.id });
  await persist();
  equal(parentTask.scaleVersionId, versions.parent, "New parent tasks must use the safety revision by default");
  return { familyId: value.familyId, joinCode: value.joinCode, parent, parentTask };
}
async function registerTriad(regional: Regional): Promise<Triad> {
  const parent = await registerParent(regional, "mixed");
  const clients = { parent: parent.parent } as Record<RespondentRole, Client>;
  for (const role of ["student", "teacher"] as const) {
    const response = await request({ base: regional.base, cookie: "" }, `/api/triad/join?locale=${regional.locale}`, "POST", { code: parent.joinCode, role, name: `版本验证合成${role}`, username: `dv_${regional.region.toLowerCase()}_${role}_${nonce}`, password: randomBytes(24).toString("base64url") });
    equal(response.status, 201, "Synthetic student and teacher joining must succeed");
    clients[role] = authenticated(regional.base, response);
  }
  const view = await workspace(parent.parent, regional.locale), tasks = {} as Record<RespondentRole, Assessment>;
  for (const role of roles) { tasks[role] = task(view, parent.familyId, role); equal(tasks[role].scaleVersionId, versions[role], "Mixed-version registration must use the current safety revisions"); }
  return { ...parent, clients, tasks };
}
async function assign(regional: Regional, assessment: Assessment, scaleVersionId: string): Promise<{ id: string }> {
  return ok(regional.admin, "/api/assessments", "POST", { familyId: assessment.familyId, respondentId: assessment.respondentId, scaleVersionId, locale: regional.locale });
}
async function retainLegacy(regional: Regional): Promise<void> {
  const fixture = regional.legacy.pending;
  const view = await workspace(fixture.clients.parent, fixture.locale), assigned = task(view, fixture.familyId, "parent");
  equal(assigned.id, fixture.tasks.parent, "Frozen pending assessment identity must remain unchanged");
  equal(assigned.scaleVersionId, "growth-parent@1.0.0", "Frozen pending assessment must retain version 1.0.0");
  equal(assigned.status, "pending", "Frozen legacy task must remain pending");
  const record = await detail(fixture.clients.parent, assigned.id, fixture.locale);
  equal(record.draftAnswers, fixture.expectedAnswers, "Frozen legacy draft answers must remain exactly unchanged");
  equal(record.draftRevision, fixture.revision, "Frozen legacy draft revision must remain unchanged");
  equal(record.surveyJson, jsonValue(surveyDefinition(parentScaleV1, "parent", fixture.locale)), "Old task wording and SurveyJS definition must remain version 1.0.0");
  requireCondition(!record.supplements?.length, "Old task must not acquire version 1.1.0 supplements");
  const stored = await row(regional, assigned.id);
  equal(stored.draft_answers, fixture.expectedAnswers, "Database must preserve the frozen legacy draft");
  equal(stored.draft_revision, fixture.revision, "Database must preserve the frozen revision");
}
async function unchangedLegacyDocuments(regional: Regional): Promise<void> {
  for (const expected of regional.legacy.history.documents) {
    const prefix = `/api/reports/${regional.legacy.history.reportId}`;
    const html = await request(regional.legacy.history.clients.parent, `${prefix}/document?locale=${expected.locale}`);
    const pdf = await request(regional.legacy.history.clients.parent, `${prefix}/pdf?locale=${expected.locale}`);
    equal(html.status, 200, "Legacy report HTML must remain authorized and available"); equal(pdf.status, 200, "Legacy report PDF must remain authorized and available");
    equal(hash(await html.text()), expected.htmlSha256, "Frozen legacy HTML must be byte-identical");
    equal(hash(Buffer.from(await pdf.arrayBuffer())), expected.pdfSha256, "Frozen legacy PDF must be byte-identical");
  }
}
async function waitReport(regional: Regional, triad: Triad): Promise<Report> {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const reports = (await workspace(triad.parent, regional.locale)).reports.filter(report => report.familyId === triad.familyId);
    if (reports.length) { equal(reports.length, 1, "Exactly one mixed-version report must publish"); return reports[0]; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("ReportTimeout");
}
async function verifyReportPrivacy(regional: Regional, triad: Triad, report: Report, sentinels: string[]): Promise<void> {
  equal(report.combined, true, "Mixed versions must produce a combined triad report");
  equal(report.generationMode, "template", "AI-disabled report must use templates");
  for (const locale of ["zh-CN", "zh-HK"] as const) {
    const endpoint = `/api/reports/${report.id}`, htmlResponse = await request(triad.parent, `${endpoint}/document?locale=${locale}`);
    const pdfResponse = await request(triad.parent, `${endpoint}/pdf?locale=${locale}`);
    equal(htmlResponse.status, 200, "Mixed-version HTML must be available"); equal(pdfResponse.status, 200, "Mixed-version PDF must be available");
    const html = await htmlResponse.text(), pdf = Buffer.from(await pdfResponse.arrayBuffer());
    equal(pdf.subarray(0, 4).toString(), "%PDF", "Mixed-version document must be a real PDF");
    const stem = `${regional.region.toLowerCase()}-mixed-parent-${locale}`, pdfPath = path.join(outputDir, `${stem}.pdf`);
    await fs.writeFile(path.join(outputDir, `${stem}.html`), html, { flag: "wx", mode: 0o600 });
    await fs.writeFile(pdfPath, pdf, { flag: "wx", mode: 0o600 });
    const text = execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 10000000 });
    const rendered = JSON.stringify(await ok(triad.parent, `${endpoint}?locale=${locale}`));
    for (const sentinel of sentinels) requireCondition(!html.includes(sentinel) && !text.replace(/\s/g, "").includes(sentinel) && !rendered.includes(sentinel), "Staff-only supplements must be absent from parent JSON, HTML and rendered PDF text");
  }
  const stored = await row(regional, triad.parentTask.id);
  requireCondition(stored.snapshot && stored.answers, "Accepted parent answers and snapshot must be stored");
  const aiInput = JSON.stringify(modelInput(stored.snapshot));
  for (const sentinel of sentinels) requireCondition(!aiInput.includes(sentinel), "Staff-only supplements must be absent from modelInput");
  equal(stored.snapshot.aiConsented, false, "New synthetic parent must not grant AI processing consent");
  for (const client of [triad.parent, triad.clients.student, triad.clients.teacher, regional.unassigned]) {
    const notes = (await workspace(client, regional.locale)).staffNotes;
    requireCondition(!notes.some(note => note.familyId === triad.familyId), "Parent, student, teacher and unassigned staff must not see this family's staff notes");
    for (const sentinel of sentinels) requireCondition(!JSON.stringify(notes).includes(sentinel), "Unauthorized staffNotes must not contain supplementary text");
  }
  for (const client of [regional.admin, regional.assigned]) {
    const notes = (await workspace(client, regional.locale)).staffNotes.filter(note => note.familyId === triad.familyId);
    for (const sentinel of sentinels) equal(notes.filter(note => note.value === sentinel).length, 1, "Admin and assigned staff must each see every supplement once");
  }
}
async function testRegion(regional: Regional, items: Supplement[]): Promise<void> {
  const prefix = regional.region;
  await check(`${prefix} default versions and 90-day policy metadata`, async () => {
    const view = await workspace(regional.admin, regional.locale);
    for (const id of Object.values(versions)) { const scale = view.scales.find(candidate => candidate.id === id); requireCondition(scale, "All intended default scales must be present"); equal(scale.isDefaultVersion, true, "Current role instrument must be marked as default"); equal(scale.retakeDays, 90, "Triad retake policy must remain 90 days"); }
    requireCondition(view.scales.find(scale => scale.id === "growth-parent@1.0.0")?.isDefaultVersion !== true, "Legacy parent must remain available without being the default");
  });
  await check(`${prefix} frozen legacy pending detail and draft remain unchanged`, () => retainLegacy(regional));
  await check(`${prefix} new-version assignment reuses frozen legacy pending identity`, async () => {
    const old = task(await workspace(regional.legacy.pending.clients.parent, regional.locale), regional.legacy.pending.familyId, "parent");
    equal((await assign(regional, old, versions.parent)).id, old.id, "Requesting new version must reuse existing old pending task");
    await retainLegacy(regional);
  });
  await check(`${prefix} old completed round blocks an immediate new-version retake`, async () => {
    const old = task(await workspace(regional.legacy.history.clients.parent, regional.locale), regional.legacy.history.familyId, "parent");
    await rejected(regional.admin, "/api/assessments", "POST", { familyId: old.familyId, respondentId: old.respondentId, scaleVersionId: versions.parent, locale: regional.locale }, "RETAKE_INTERVAL");
  });
  await check(`${prefix} frozen bilingual legacy report hashes remain unchanged`, () => unchangedLegacyDocuments(regional));
  const triad = await check(`${prefix} new registration creates the intended mixed versions`, () => registerTriad(regional));
  await check(`${prefix} old-version assignment reuses new pending identity`, async () => {
    equal((await assign(regional, triad.parentTask, "growth-parent@1.0.0")).id, triad.parentTask.id, "Requesting old version must reuse existing new pending task");
    equal(task(await workspace(triad.parent, regional.locale), triad.familyId, "parent").scaleVersionId, versions.parent, "Reused new pending task must retain its assigned version");
  });
  await check(`${prefix} supplements metadata preserves 145 main questions`, async () => {
    const record = await detail(triad.parent, triad.parentTask.id, regional.locale), model = new Model(record.surveyJson);
    equal(model.getAllQuestions().length, 145, "Supplements must not increase the main SurveyJS question count");
    model.data = allOtherAnswers(items, regional.region, false);
    equal(model.getAllQuestions().filter(question => question.isVisible).length, 144, "Calm parent fixture must retain 144 visible main questions without the safety follow-up");
    equal(record.supplements?.length, 7, "API must expose seven optional supplement descriptors");
    for (const item of items) {
      requireCondition(!model.getQuestionByName(item.id), "Supplement cannot appear as a separate SurveyJS main question");
      const meta = record.supplements?.find(candidate => candidate.itemId === item.id);
      equal(meta, { itemId: item.id, parentId: item.supplementFor, label: item.label[regional.locale], anyOf: item.showIf.anyOf, maxLength: 2000 }, "Supplement metadata must preserve parent, label, trigger and length bound");
    }
  });
  const answers = allOtherAnswers(items, regional.region, true);
  await check(`${prefix} hidden, unknown, invalid and oversize supplements reject without writes`, async () => {
    const before = await detail(triad.parent, triad.parentTask.id, regional.locale), item = items[0], parent = parentScale.items.find(candidate => candidate.id === item.supplementFor)!;
    const otherChoice = parent.choices.find(choice => !item.showIf.anyOf.includes(choice.value)); requireCondition(otherChoice, "Supplement parent must provide a non-trigger choice");
    const hidden = { ...answers, [parent.id]: parent.kind === "multi" ? [otherChoice.value] : otherChoice.value };
    for (const [invalid, code] of [[hidden, "INVALID_ANSWERS"], [{ ...answers, unregistered_other: "synthetic" }, "INVALID_ANSWERS"], [{ ...answers, [item.id]: 1 }, "INVALID_ANSWERS"], [{ ...answers, [item.id]: "x".repeat(2001) }, "VALIDATION_FAILED"]] as const) {
      await rejected(triad.parent, `/api/assessments/${triad.parentTask.id}`, "PATCH", { answers: invalid, acknowledged: true, revision: before.draftRevision }, code);
      await rejected(triad.parent, `/api/assessments/${triad.parentTask.id}/submit`, "POST", { answers: invalid, acknowledged: true, revision: before.draftRevision }, code);
    }
    const after = await detail(triad.parent, triad.parentTask.id, regional.locale);
    equal(after.draftAnswers, before.draftAnswers, "Rejected supplementary input must not change the draft"); equal(after.draftRevision, before.draftRevision, "Rejected supplementary input must not advance the revision");
  });
  await check(`${prefix} numeric answers and real NA survive supplement draft storage`, async () => {
    const saved = await ok<{ revision: number }>(triad.parent, `/api/assessments/${triad.parentTask.id}`, "PATCH", { answers, acknowledged: true, revision: 0 });
    equal(saved.revision, 1, "Accepted synthetic draft must advance once");
    const read = await detail(triad.parent, triad.parentTask.id, regional.locale);
    equal(read.draftAnswers, answers, "Supplement draft must preserve all parent answers exactly"); equal(read.draftAnswers.q14_1, -1, "Genuine NA must remain -1");
  });
  await check(`${prefix} mixed-version submissions publish one staff-private report`, async () => {
    const assignedId = (await workspace(regional.assigned, regional.locale)).user.id;
    await ok(regional.admin, `/api/families/${triad.familyId}/assignment`, "PATCH", { assignedTo: assignedId });
    for (const role of roles) await ok(triad.clients[role], `/api/assessments/${triad.tasks[role].id}/submit`, "POST", { answers: role === "parent" ? answers : syntheticAnswers(definitions[role]), acknowledged: true, revision: role === "parent" ? 1 : 0 });
    const report = await waitReport(regional, triad);
    created.find(fixture => fixture.familyId === triad.familyId)!.reportId = report.id;
    const stored = await row(regional, triad.parentTask.id);
    equal(stored.answers, answers, "Published parent answers must preserve numeric values, NA and supplements");
    const expected = scoreAssessment(parentScale, answers, { age: 12, region: regional.region, role: "parent" });
    equal(stored.snapshot?.score.dimensions, expected.dimensions, "Supplement content must not affect parent numeric scores");
    await verifyReportPrivacy(regional, triad, report, items.map(item => String(answers[item.id])));
    const view = await workspace(triad.parent, regional.locale);
    for (const role of roles) equal(task(view, triad.familyId, role).status, "published", "All mixed-version source assessments must publish together");
  });
  await check(`${prefix} new completed round blocks an immediate old-version retake`, async () => {
    await rejected(regional.admin, "/api/assessments", "POST", { familyId: triad.familyId, respondentId: triad.parentTask.respondentId, scaleVersionId: "growth-parent@1.0.0", locale: regional.locale }, "RETAKE_INTERVAL");
  });
  await check(`${prefix} legacy fixtures remain unchanged after new-version operations`, async () => { await retainLegacy(regional); await unchangedLegacyDocuments(regional); });
}
async function extraCases(regional: Regional, items: Supplement[]): Promise<void> {
  await check("CN seven visible optional supplements may all be empty on real submission", async () => {
    const fixture = await registerParent(regional, "blank"), answers = allOtherAnswers(items, regional.region, false);
    const emptyAnswers = { ...answers, ...Object.fromEntries(items.map(item => [item.id, ""])) };
    await ok(fixture.parent, `/api/assessments/${fixture.parentTask.id}/submit`, "POST", { answers: emptyAnswers, acknowledged: true, revision: 0 });
    const stored = await row(regional, fixture.parentTask.id);
    equal(stored.status, "queued", "Empty optional supplements must allow the parent to submit and wait for other roles");
    equal(stored.answers, answers, "Empty supplements must normalize away without changing other answers");
  });
  await check("CN independent old-version task rejects new supplement while preserving its draft", async () => {
    const family = await ok<{ id: string }>(regional.admin, "/api/families", "POST", { familyName: "旧版字段拒绝合成家庭", childName: "旧版字段拒绝合成孩子", birthDate: `${new Date().getUTCFullYear() - 12}-01-01`, grade: "初中", guardianLabel: "母亲" });
    const invitation = await ok<{ url: string }>(regional.admin, `/api/families/${family.id}/invites`, "POST", { role: "parent" });
    const token = new URLSearchParams(new URL(invitation.url).hash.slice(1)).get("token"); requireCondition(token, "Synthetic invitation must carry a token");
    const response = await request({ base: regional.base, cookie: "" }, "/api/invite", "POST", { token, name: "旧版验证合成家长", username: `dv_legacy_reject_${nonce}`, password: randomBytes(24).toString("base64url") });
    equal(response.status, 200, "Independent legacy respondent must accept invitation");
    const client = authenticated(regional.base, response), session = await ok<Session>(client, "/api/session"); requireCondition(session.user, "Synthetic legacy respondent must authenticate");
    await ok(client, `/api/families/${family.id}/consent`, "POST", { accepted: true, guardianName: "合成家长", aiProcessing: false });
    const assigned = await ok<{ id: string }>(regional.admin, "/api/assessments", "POST", { familyId: family.id, respondentId: session.user.id, scaleVersionId: "growth-parent@1.0.0", locale: regional.locale });
    created.push({ region: regional.region, scenario: "legacy-field-reject", familyId: family.id, assessmentId: assigned.id });
    equal((await row(regional, assigned.id)).scale_version_id, "growth-parent@1.0.0", "Independent legacy rejection fixture must actually use version 1.0.0");
    const answers = syntheticAnswers(parentScaleV1); answers.q14_1 = -1;
    const saved = await ok<{ revision: number }>(client, `/api/assessments/${assigned.id}`, "PATCH", { answers, acknowledged: true, revision: 0 });
    await rejected(client, `/api/assessments/${assigned.id}/submit`, "POST", { answers: { ...answers, [items[0].id]: "SYNTHETIC_UNREGISTERED_SUPPLEMENT" }, acknowledged: true, revision: saved.revision }, "INVALID_ANSWERS");
    const after = await detail(client, assigned.id, regional.locale);
    equal(after.status, "pending", "Old-version rejection must not submit its task"); equal(after.draftAnswers, answers, "Old-version rejection must preserve its draft exactly"); equal(after.draftRevision, saved.revision, "Old-version rejection must preserve draft revision");
  });
}

async function main(): Promise<void> {
  equal(process.env.NOVA_AI_ENABLED, "false", "Run with NOVA_AI_ENABLED=false");
  requireCondition(within(evidenceRoot, outputDir), "Evidence output must be a new directory inside stage D api-verification");
  const fixtureFile = path.join(stageDir, "legacy-private-fixtures.json");
  equal((await fs.stat(fixtureFile)).mode & 0o777, 0o600, "Legacy synthetic fixture credentials must be mode 0600");
  const fixtureBytes = await fs.readFile(fixtureFile), fixtures = JSON.parse(fixtureBytes.toString()) as LegacyFixtures;
  equal(fixtures.syntheticOnly, true, "Legacy fixtures must be explicitly synthetic");
  const items = supplements();
  execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(outputDir, "results.json"), "{}\n", { flag: "wx", mode: 0o600 }); resultReady = true;
  const regionals: Regional[] = [];
  for (const region of ["CN", "HK"] as const) {
    const configFile = path.join(stageDir, "runtime", region.toLowerCase(), "private-config.json");
    equal((await fs.stat(configFile)).mode & 0o777, 0o600, "Runtime test credentials must be mode 0600");
    const config = JSON.parse(await fs.readFile(configFile, "utf8")) as Record<string, string>;
    equal(config.NOVA_MODE, "demo", "Runtime must be demo mode"); equal(config.NOVA_AI_ENABLED, "false", "Runtime AI must be disabled"); equal(config.NOVA_AUTH_PROVIDER, "local", "Runtime auth must be local"); equal(config.NOVA_REGION, region, "Runtime region must match");
    const base = loopback(config.NOVA_PUBLIC_URL), configured = process.env[region === "CN" ? "NOVA_INTEGRATION_CN_URL" : "NOVA_INTEGRATION_HK_URL"];
    if (configured) equal(loopback(configured), base, "API override must match this owned runtime");
    equal(base, `http://127.0.0.1:${region === "CN" ? 3238 : 3239}`, "Only stage D app ports may be used");
    const dbUrl = new URL(config.DATABASE_URL);
    equal(dbUrl.hostname, "127.0.0.1", "Database reads must stay on loopback"); equal(dbUrl.pathname, `/nova_d_${region.toLowerCase()}`, "Database must belong to stage D"); equal(dbUrl.username, `nova_d_${region.toLowerCase()}`, "Database user must belong to stage D"); equal(Number(dbUrl.port), region === "CN" ? 55458 : 55460, "Database port must match stage D");
    for (const legacy of [fixtures.regions[region].pending, fixtures.regions[region].history]) for (const client of Object.values(legacy.clients)) equal(loopback(client.base), base, "Legacy clients must belong to this region's loopback app");
    guardedPending.add(fixtures.regions[region].pending.tasks.parent);
    const database = new pg.Client({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 5000, options: "-c default_transaction_read_only=on" });
    await database.connect(); connections.push(database);
    equal((await database.query("SHOW default_transaction_read_only")).rows[0].default_transaction_read_only, "on", "All direct database verification must be read-only");
    equal((await database.query("SELECT region,mode FROM deployment_settings")).rows, [{ region, mode: "demo" }], "Database deployment marker must be synthetic and region-correct");
    const storedVersions = await database.query("SELECT id,definition FROM scales WHERE id=ANY($1::text[])", [Object.values(versions)]);
    equal(storedVersions.rows.length, 3, "Fixed instrument versions must be installed before any test fixture mutation");
    for (const role of roles) equal(storedVersions.rows.find(item => item.id === versions[role])?.definition, jsonValue(definitions[role]), "Server-stored fixed definition must equal the tested source version");
    const legacyVersion = await database.query("SELECT definition FROM scales WHERE id=$1", ["growth-parent@1.0.0"]);
    equal(legacyVersion.rows[0]?.definition, jsonValue(parentScaleV1), "Stored legacy parent definition must remain unchanged");
    const locale = region === "CN" ? "zh-CN" : "zh-HK", admin = await login(base, "admin"), assigned = await login(base, "staff", region === "CN" ? "陈" : "陳"), unassigned = await login(base, "staff", "何");
    regionals.push({ region, locale, base, database, admin, assigned, unassigned, legacy: fixtures.regions[region] });
  }
  for (const regional of regionals) await testRegion(regional, items);
  await extraCases(regionals[0], items);
  await check("all frozen legacy pending tasks and report hashes survive the full test", async () => {
    for (const regional of regionals) { await retainLegacy(regional); await unchangedLegacyDocuments(regional); }
    equal(hash(await fs.readFile(fixtureFile)), hash(fixtureBytes), "Private legacy fixture file must remain byte-identical");
  });
  completed = true;
}

try { await main(); console.log(`Parent version integration passed: ${results.length} checks.`); }
catch (error) { failure ??= safeAssertion ?? (error instanceof Error ? error.name : "UnknownError"); console.error(`FAIL parent version integration: ${failure}`); process.exitCode = 1; }
finally { await Promise.all(connections.map(connection => connection.end())); await persist(); }
