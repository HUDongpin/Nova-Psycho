/**
 * Synthetic HTTP -> PostgreSQL -> worker -> HTML/PDF regression.
 * Usage: NOVA_AI_ENABLED=false NOVA_TRIAD_COMPARISON_CN_CONFIG=/absolute/work/.../cn/private-config.json
 *        NOVA_TRIAD_COMPARISON_HK_CONFIG=/absolute/work/.../hk/private-config.json
 *        node --import tsx tests/triad-comparison.integration.ts
 * Optional NOVA_TRIAD_COMPARISON_OUTPUT_DIR must be inside work/.
 * Config files must be mode 0600, describe dedicated loopback PostgreSQL databases
 * named nova_triad_comparison_*, and set NOVA_TEST_CLOCK_FILE inside their directory.
 * A test-only preload in the dedicated web/worker processes must read that file and
 * support Date offsets -91 * 86400000 then 0, preserving Date.parse/UTC semantics. The observer is read-only; accepted
 * assessments, their timestamps, and immutable report documents are never edited.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium, type Browser } from "playwright";
import type { Assessment, Report, Session, Workspace } from "../src/components/api";
import { previewAnswers } from "../src/domain/triad-report";
import { childScaleStaffNotes as childScale, parentScaleStaffNotes as parentScale, teacherScaleStaffNotes as teacherScale } from "../src/domain/triad-scales";
import { scoreAssessment } from "../src/domain/scoring";
import type { Locale, Region, ReportPayload, RespondentRole, ScaleDefinition, StoredAnswer, TriadRoleComparison } from "../src/domain/types";

type Client = { base: string; cookie: string };
type Config = Record<string, string>;
type Regional = { region: Region; locale: Locale; base: string; database: pg.Client; config: Config; admin: Client };
type Triad = { familyId: string; clients: Record<RespondentRole, Client>; tasks: Record<RespondentRole, Assessment> };
type StoredReport = { payload: ReportPayload & { triad: NonNullable<ReportPayload["triad"]> }; source_assessment_ids: string[] };
type Documents = Record<Locale, { htmlSha256: string; pdfSha256: string }>;
const roles = ["student", "parent", "teacher"] as const;
const definitions = { parent: parentScale, student: childScale, teacher: teacherScale };
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
const nonce = randomBytes(6).toString("hex");
const output = path.resolve(process.env.NOVA_TRIAD_COMPARISON_OUTPUT_DIR ?? `work/qa/triad-comparison-${runId}`);
const results: { name: string; passed: boolean; durationMs: number; error?: string }[] = [];
const fixtures: { region: Region; familyId: string; rounds: { reportId: string; assessmentIds: string[] }[] }[] = [];
const observers: pg.Client[] = [];
let browser: Browser | undefined;
let completed = false;
let failure: string | undefined;
let evidenceReady = false;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const local = (value: string) => { const u = new URL(value); assert.ok(u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash, "Explicit plain loopback HTTP origins required"); return u.origin; };
async function persist() { if (evidenceReady) await fs.writeFile(path.join(output, "results.json"), JSON.stringify({ runId, completed, passed: completed && !failure, syntheticOnly: true, aiEnabled: false, loopbackOnly: true, readOnlyDatabaseObserver: true, testClock: "dedicated process Date offset -91 days then 0; database clock unchanged", acceptedSnapshotsModified: false, fixtures, results, ...(failure ? { failure } : {}) }, null, 2) + "\n", { mode: 0o600 }); }
async function check<T>(name: string, action: () => Promise<T>): Promise<T> { const start = Date.now(); try { const value = await action(); results.push({ name, passed: true, durationMs: Date.now() - start }); console.log(`PASS ${name}`); return value; } catch (error) { failure = error instanceof assert.AssertionError ? error.message : error instanceof Error ? error.name : "UnknownError"; results.push({ name, passed: false, durationMs: Date.now() - start, error: failure }); throw error; } finally { await persist(); } }
async function request(client: Client, route: string, method = "GET", data?: unknown) { assert.ok(route.startsWith("/api/") && !route.includes("\\")); return fetch(local(client.base) + route, { method, redirect: "error", signal: AbortSignal.timeout(45000), headers: { ...(client.cookie ? { Cookie: client.cookie } : {}), ...(method === "GET" ? {} : { Origin: client.base }), ...(data === undefined ? {} : { "Content-Type": "application/json" }) }, body: data === undefined ? undefined : JSON.stringify(data) }); }
async function ok<T>(client: Client, route: string, method = "GET", data?: unknown): Promise<T> { const response = await request(client, route, method, data); assert.ok(response.ok, `${method} ${route.replace(/[0-9a-f-]{36}/g, "<id>")} HTTP ${response.status}`); return response.json() as Promise<T>; }
function session(base: string, response: Response): Client { const cookie = response.headers.get("set-cookie"); assert.ok(cookie); return { base, cookie: cookie.split(";")[0] }; }
async function reject(client: Client, route: string, method: string, data: unknown, status: number, code: string) { const response = await request(client, route, method, data); assert.equal(response.status, status, code); assert.equal((await response.json()).code, code); }
const workspace = (client: Client, locale: Locale) => ok<Workspace>(client, `/api/workspace?locale=${locale}`);
async function admin(base: string, region: Region): Promise<Client> { const visitor = { base, cookie: "" }, value = await ok<Session>(visitor, "/api/session"); assert.equal(value.mode, "demo"); assert.equal(value.region, region); assert.equal(value.authProvider, "local"); const account = value.demoAccounts.filter(a => a.role === "admin"); assert.equal(account.length, 1); const response = await request(visitor, "/api/auth/demo", "POST", { accountId: account[0].id }); assert.equal(response.status, 200); return session(base, response); }
async function regional(region: Region): Promise<Regional> {
  const configFile = process.env[`NOVA_TRIAD_COMPARISON_${region}_CONFIG`]; assert.ok(configFile, `Explicit NOVA_TRIAD_COMPARISON_${region}_CONFIG required`);
  const configPath = path.resolve(configFile), relativeConfig = path.relative(path.resolve("work"), configPath);
  assert.ok(relativeConfig && !relativeConfig.startsWith("..") && !path.isAbsolute(relativeConfig), "Runtime config must be inside work/");
  assert.equal((await fs.stat(configFile)).mode & 0o777, 0o600);
  const config = JSON.parse(await fs.readFile(configFile, "utf8")) as Config;
  assert.equal(config.NOVA_MODE, "demo"); assert.equal(config.NOVA_REGION, region); assert.equal(config.NOVA_AUTH_PROVIDER, "local"); assert.equal(config.NOVA_AI_ENABLED, "false");
  const clockRelative = path.relative(path.dirname(configPath), path.resolve(config.NOVA_TEST_CLOCK_FILE));
  assert.ok(clockRelative && !clockRelative.startsWith("..") && !path.isAbsolute(clockRelative), "Clock must be owned by this regional configuration directory");
  assert.equal((await fs.stat(config.NOVA_TEST_CLOCK_FILE)).mode & 0o777, 0o600);
  assert.equal(Number(await fs.readFile(config.NOVA_TEST_CLOCK_FILE, "utf8")), -91 * 86400000, "Start every regional run at the first-round synthetic clock");
  const base = local(config.NOVA_PUBLIC_URL), address = new URL(config.DATABASE_URL);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(address.hostname), "Database must be loopback");
  assert.match(address.pathname, /^\/nova_triad_comparison_[a-z0-9_]+$/, "Use a dedicated synthetic comparison database");
  assert.ok(address.port, "Database port must be explicit");
  assert.equal(config.NOVA_DATA_REGION, region);
  const database = new pg.Client({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 5000, options: "-c default_transaction_read_only=on" }); await database.connect(); observers.push(database);
  assert.equal((await database.query("SHOW default_transaction_read_only")).rows[0].default_transaction_read_only, "on");
  assert.deepEqual((await database.query("SELECT region,mode FROM deployment_settings")).rows, [{ region, mode: "demo" }]);
  return { region, locale: region === "CN" ? "zh-CN" : "zh-HK", base, database, config, admin: await admin(base, region) };
}
async function register(r: Regional): Promise<Triad> {
  const visitor = { base: r.base, cookie: "" }, response = await request(visitor, `/api/triad/parent?locale=${r.locale}`, "POST", { parentName: "合成比较家长", username: `cmp_${r.region.toLowerCase()}_p_${nonce}`, password: randomBytes(24).toString("base64url"), relationship: "母亲", childName: "合成比较孩子", birthDate: `${new Date().getUTCFullYear() - 12}-01-01`, grade: "初中", assessment: true, sensitiveData: true, parentReport: true });
  assert.equal(response.status, 201); const value = await response.json() as { familyId: string; joinCode: string };
  const clients = { parent: session(r.base, response) } as Record<RespondentRole, Client>;
  for (const role of ["student", "teacher"] as const) { const joined = await request(visitor, `/api/triad/join?locale=${r.locale}`, "POST", { code: value.joinCode, role, name: `合成比较${role}`, username: `cmp_${r.region.toLowerCase()}_${role}_${nonce}`, password: randomBytes(24).toString("base64url") }); assert.equal(joined.status, 201); clients[role] = session(r.base, joined); }
  const w = await workspace(clients.parent, r.locale), tasks = {} as Triad["tasks"];
  for (const role of roles) { const matches = w.assessments.filter(a => a.familyId === value.familyId && a.respondentRole === role); assert.equal(matches.length, 1); tasks[role] = matches[0]; assert.equal(matches[0].scaleVersionId, `${definitions[role].id}@${definitions[role].version}`); }
  fixtures.push({ region: r.region, familyId: value.familyId, rounds: [] }); return { familyId: value.familyId, clients, tasks };
}
function answers(scale: ScaleDefinition, role: RespondentRole, second: boolean): Record<string, StoredAnswer> {
  const copy = structuredClone(scale); for (const item of copy.items) if (item.id === "c_age" || item.id === "p_age") item.choices = item.choices.filter(choice => choice.value === 12);
  const result = previewAnswers(copy, "calm");
  for (const item of copy.items) if (typeof result[item.id] === "string") result[item.id] = `${role === "student" ? "STUDENT_PRIVATE" : item.report === "staff" ? "STAFF_PRIVATE" : "ADULT_SYNTHETIC"}_${nonce}`;
  const dimension = scale.dimensions[0];
  for (const id of dimension.items) { const item = scale.items.find(i => i.id === id)!; const values = item.choices.map(c => c.value).filter(v => !item.excludeValues?.includes(v) && !scale.riskRules.some(rule => rule.itemId === id && rule.values.includes(v))); result[id] = second ? Math.max(...values) : Math.min(...values); }
  assert.equal(scoreAssessment(scale, result, { role, age: 12, region: "CN" }).status, "valid"); return result;
}
async function submit(r: Regional, triad: Triad, second: boolean) { for (const role of roles) await ok(triad.clients[role], `/api/assessments/${triad.tasks[role].id}/submit?locale=${r.locale}`, "POST", { answers: answers(definitions[role], role, second), acknowledged: true, revision: 0 }); }
async function waitReport(r: Regional, triad: Triad): Promise<Report> { const ids = Object.values(triad.tasks).map(task => task.id), deadline = Date.now() + 120000; while (Date.now() < deadline) { const reports = (await workspace(triad.clients.parent, r.locale)).reports.filter(report => ids.includes(report.assessmentId)); if (reports.length) { assert.equal(reports.length, 1); return reports[0]; } await new Promise(resolve => setTimeout(resolve, 1000)); } assert.fail("Expected automatic worker publication within 120 seconds"); }
async function stored(r: Regional, triad: Triad, report: Report): Promise<StoredReport> { const rows = await r.database.query("SELECT r.payload,j.source_assessment_ids FROM reports r JOIN report_jobs j ON j.assessment_id=r.assessment_id WHERE r.id=$1 AND r.family_id=$2 AND r.region=$3", [report.id, triad.familyId, r.region]); assert.equal(rows.rows.length, 1); return rows.rows[0]; }
async function documents(r: Regional, triad: Triad, report: Report, round: number, save: boolean): Promise<Documents> {
  const collected = {} as Documents;
  for (const locale of ["zh-CN", "zh-HK"] as const) {
    const endpoint = `/api/reports/${report.id}`, htmlResponse = await request(triad.clients.parent, `${endpoint}/document?locale=${locale}`), pdfResponse = await request(triad.clients.parent, `${endpoint}/pdf?locale=${locale}`);
    assert.equal(htmlResponse.status, 200); assert.equal(pdfResponse.status, 200); const html = await htmlResponse.text(), pdf = Buffer.from(await pdfResponse.arrayBuffer()); assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
    assert.ok(!html.includes(`STUDENT_PRIVATE_${nonce}`) && !html.includes(`STAFF_PRIVATE_${nonce}`));
    if (save) { const stem = `${r.region.toLowerCase()}-round-${round}-${locale}`, pdfFile = path.join(output, `${stem}.pdf`); await fs.writeFile(path.join(output, `${stem}.html`), html, { flag: "wx", mode: 0o600 }); await fs.writeFile(pdfFile, pdf, { flag: "wx", mode: 0o600 }); const text = execFileSync("pdftotext", ["-layout", pdfFile, "-"], { encoding: "utf8", maxBuffer: 10000000 }); await fs.writeFile(path.join(output, `${stem}.txt`), text, { mode: 0o600 }); assert.ok(!text.replace(/\s/g, "").includes(`STUDENT_PRIVATE_${nonce}`) && !text.replace(/\s/g, "").includes(`STAFF_PRIVATE_${nonce}`)); if (round === 2) { for (const role of roles) { const label = definitions[role].dimensions[0].label[locale]; assert.ok(html.includes(label), "Every role's changed dimension appears in HTML"); assert.ok(text.replace(/\s/g, "").includes(label.replace(/\s/g, "")), "Every role's changed dimension appears in rendered PDF text"); } } }
    collected[locale] = { htmlSha256: hash(html), pdfSha256: hash(pdf) };
  }
  return collected;
}
async function browse(r: Regional, triad: Triad, report: Report) {
  browser ??= await chromium.launch({ headless: true, executablePath: process.env.NOVA_CHROMIUM_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  for (const locale of ["zh-CN", "zh-HK"] as const) for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 1000 }, isMobile: mobile, hasTouch: mobile });
    try { await context.route("**/*", route => new URL(route.request().url()).origin === r.base ? route.continue() : route.abort()); await context.addInitScript(value => localStorage.setItem("nova-locale", value), locale); const cookie = triad.clients.parent.cookie, split = cookie.indexOf("="); await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: r.base, httpOnly: true, sameSite: "Lax" }]); const page = await context.newPage(), errors: string[] = []; page.on("pageerror", error => errors.push(error.name)); await page.goto(`${r.base}/#report/${report.id}`); const frame = page.frameLocator("iframe.report-frame"); await frame.locator("h1").waitFor({ timeout: 45000 }); const body = await frame.locator("body").innerText(); assert.ok(body.includes(locale === "zh-CN" ? "和上一轮相比" : "和上一輪相比"), "Real parent report iframe displays longitudinal comparison"); assert.equal(await frame.locator(".comparison-role").count(), 3, "Every respondent has a separate longitudinal section"); for (const [index, role] of roles.entries()) { assert.ok(body.includes(definitions[role].dimensions[0].label[locale])); const section = frame.locator(".comparison-role").nth(index); const previous = scoreAssessment(definitions[role], answers(definitions[role], role, false), { role, age: 12, region: r.region }).dimensions[0].raw!, current = scoreAssessment(definitions[role], answers(definitions[role], role, true), { role, age: 12, region: r.region }).dimensions[0].raw!; const cells = await section.locator("tbody tr").first().locator("td").allInnerTexts(); assert.deepEqual(cells.slice(0, 2), [String(previous), String(current)], "Browser comparison table displays actual prior/current values"); assert.equal(cells[2].split("\n")[0], `+${current - previous}`, "Browser displays the deterministic change"); } const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1); const reportOverflow = await frame.locator("html").evaluate(node => node.scrollWidth > node.clientWidth + 1); assert.equal(pageOverflow, false, "Parent report page fits viewport"); assert.equal(reportOverflow, false, "Comparison document fits its iframe at this viewport"); assert.deepEqual(errors, []); const stem = `${r.region.toLowerCase()}-${locale}-${mobile ? "mobile" : "desktop"}`; await page.screenshot({ path: path.join(output, `${stem}-report.png`), fullPage: true }); const heading = frame.getByRole("heading", { name: /和上一轮相比|和上一輪相比/ }); await heading.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, `${stem}-comparison.png`), fullPage: true }); const download = await Promise.all([page.waitForEvent("download"), page.locator('a[download]').click()]); const downloadPath = await download[0].path(); assert.ok(downloadPath); assert.equal((await fs.readFile(downloadPath)).subarray(0, 4).toString(), "%PDF", "Parent download link returns the real frozen PDF"); } finally { await context.close(); }
  }
}
async function testRegion(r: Regional) {
  const triad = await check(`${r.region} parent/student/teacher register through real APIs`, () => register(r));
  const first = await check(`${r.region} first complete round automatically publishes without history`, async () => { await submit(r, triad, false); const report = await waitReport(r, triad); assert.equal(report.combined, true); assert.equal(report.generationMode, "template"); assert.equal(report.comparison.available, false); const row = await stored(r, triad, report); assert.equal(row.payload.triad.comparisons?.length, 3); for (const c of row.payload.triad.comparisons!) { assert.equal(c.available, false); assert.equal(c.reason, "first_assessment"); } assert.deepEqual([...row.source_assessment_ids].sort(), Object.values(triad.tasks).map(t => t.id).sort()); fixtures.find(f => f.familyId === triad.familyId)!.rounds.push({ reportId: report.id, assessmentIds: row.source_assessment_ids }); return { report, stored: row, documents: await documents(r, triad, report, 1, true) }; });
  const initialAssessments = await r.database.query("SELECT id,answers,snapshot,submitted_at FROM assessments WHERE family_id=$1 AND region=$2 ORDER BY id", [triad.familyId, r.region]);
  await check(`${r.region} immediate repeat remains blocked by the 90-day retake rule`, async () => { for (const role of roles) await reject(triad.clients.parent, "/api/assessments", "POST", { familyId: triad.familyId, respondentId: triad.tasks[role].respondentId, scaleVersionId: triad.tasks[role].scaleVersionId, locale: r.locale }, 409, "RETAKE_INTERVAL"); });
  await check(`${r.region} after 91 virtual days parent assigns a new bounded triad round`, async () => { await fs.writeFile(r.config.NOVA_TEST_CLOCK_FILE, "0", { mode: 0o600 }); const old = { ...triad.tasks }; for (const role of roles) { const created = await ok<{ id: string }>(triad.clients.parent, "/api/assessments", "POST", { familyId: triad.familyId, respondentId: old[role].respondentId, scaleVersionId: old[role].scaleVersionId, locale: r.locale }); assert.notEqual(created.id, old[role].id); const w = await workspace(triad.clients.parent, r.locale); triad.tasks[role] = w.assessments.find(a => a.id === created.id)!; assert.ok(triad.tasks[role]); } const rounds = await r.database.query("SELECT DISTINCT triad_round_id FROM assessments WHERE id=ANY($1::uuid[]) AND family_id=$2", [Object.values(triad.tasks).map(t => t.id), triad.familyId]); assert.equal(rounds.rows.length, 1); assert.ok(rounds.rows[0].triad_round_id); });
  const second = await check(`${r.region} repeated submissions publish same-role longitudinal scores`, async () => { await submit(r, triad, true); const report = await waitReport(r, triad), row = await stored(r, triad, report); assert.equal(report.comparison.available, true); assert.equal(row.payload.generationMode, "template"); assert.equal(row.payload.triad.comparisons?.length, 3); for (const role of roles) { const c: TriadRoleComparison = row.payload.triad.comparisons!.find(candidate => candidate.role === role)!; assert.ok(c); assert.equal(c.available, true); const previousDate = first.stored.payload.triad.sources.find(source => source.role === role)!.submittedAt; assert.equal(c.previousDate, previousDate); assert.ok(Date.parse(c.currentDate) - Date.parse(c.previousDate!) >= 90 * 86400000); const dimension = definitions[role].dimensions[0], change = c.changes!.find(change => change.key === dimension.key)!; const prior = scoreAssessment(definitions[role], answers(definitions[role], role, false), { role, age: 12, region: r.region }).dimensions[0].raw!, current = scoreAssessment(definitions[role], answers(definitions[role], role, true), { role, age: 12, region: r.region }).dimensions[0].raw!; assert.equal(change.previous, prior); assert.equal(change.current, current); assert.equal(change.delta, Number((current - prior).toFixed(4))); assert.ok(change.delta > 0); assert.equal(change.higherMeans, dimension.higherMeans); } fixtures.find(f => f.familyId === triad.familyId)!.rounds.push({ reportId: report.id, assessmentIds: row.source_assessment_ids }); await documents(r, triad, report, 2, true); return report; });
  await check(`${r.region} frozen first report and accepted first-round data remain byte-stable`, async () => { assert.deepEqual(await documents(r, triad, first.report, 1, false), first.documents); const current = await r.database.query("SELECT id,answers,snapshot,submitted_at FROM assessments WHERE id=ANY($1::uuid[]) ORDER BY id", [initialAssessments.rows.map(row => row.id)]); assert.deepEqual(current.rows, initialAssessments.rows); });
  await check(`${r.region} comparison respects existing parent and regional access boundaries`, async () => { for (const role of ["student", "teacher"] as const) await reject(triad.clients[role], `/api/reports/${second.id}`, "GET", undefined, 403, "ROLE_DENIED"); await reject({ base: r.base, cookie: "" }, `/api/reports/${second.id}/pdf`, "GET", undefined, 401, "UNAUTHENTICATED"); });
  await check(`${r.region} parent browser displays and downloads bilingual reports on desktop/mobile`, () => browse(r, triad, second));
}
async function main() { assert.equal(process.env.NOVA_AI_ENABLED, "false"); const relative = path.relative(path.resolve("work"), output); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative)); await fs.mkdir(output, { recursive: true, mode: 0o700 }); await fs.writeFile(path.join(output, "results.json"), "{}\n", { flag: "wx", mode: 0o600 }); evidenceReady = true; execFileSync("pdftotext", ["-v"], { stdio: "ignore" }); const cn = await regional("CN"), hk = await regional("HK"); assert.notEqual(cn.base, hk.base); const cnDatabase = new URL(cn.config.DATABASE_URL), hkDatabase = new URL(hk.config.DATABASE_URL); assert.notEqual(`${cnDatabase.hostname}:${cnDatabase.port}${cnDatabase.pathname}`, `${hkDatabase.hostname}:${hkDatabase.port}${hkDatabase.pathname}`, "Regional databases must be independent"); for (const r of [cn, hk]) await testRegion(r); completed = true; console.log(`Triad comparison integration passed: ${results.length} checks.`); }
try { await main(); } catch (error) { failure ??= error instanceof assert.AssertionError ? error.message : error instanceof Error ? error.name : "UnknownError"; console.error(`FAIL triad comparison integration: ${failure}`); process.exitCode = 1; } finally { await browser?.close(); await Promise.all(observers.map(observer => observer.end())); await persist(); }
