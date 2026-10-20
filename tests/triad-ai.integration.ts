import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import type { Assessment, Session, Workspace } from "../src/components/api";
import { previewAnswers } from "../src/domain/triad-report";
import { buildTriadNarrativeSource, eligibleTriadAdviceIds } from "../src/domain/triad-narrative";
import { childScaleStaffNotes, parentScaleStaffNotes, teacherScaleStaffNotes } from "../src/domain/triad-scales";
import type { AssessmentSnapshot, Locale, ReportPayload, RespondentRole, ScaleDefinition } from "../src/domain/types";
import { closeDatabase, query } from "../src/lib/db";
import { closePdfBrowser } from "../src/lib/pdf";
import { processReportJob } from "../src/lib/worker";

type Client = { cookie: string };
type Fixture = { familyId: string; clients: Record<RespondentRole, Client>; tasks: Record<RespondentRole, Assessment>; jobId: string };
const roles = ["student", "parent", "teacher"] as const;
const definitions = { student: childScaleStaffNotes, parent: parentScaleStaffNotes, teacher: teacherScaleStaffNotes };
const region = process.env.NOVA_REGION;
assert.ok(region === "CN" || region === "HK");
assert.equal(process.env.NOVA_MODE, "demo");
assert.equal(process.env.NOVA_AUTH_PROVIDER, "local");
const base = new URL(process.env.NOVA_PUBLIC_URL!);
const dbUrl = new URL(process.env.DATABASE_URL!);
assert.equal(base.protocol, "http:");
assert.equal(base.hostname, "127.0.0.1");
assert.equal(dbUrl.hostname, "127.0.0.1");
const output = path.resolve(process.env.NOVA_TRIAD_AI_TEST_OUTPUT!);
assert.ok(path.relative(path.resolve("work"), output).startsWith("triad-ai-"));
await fs.mkdir(output, { recursive: true, mode: 0o700 });
const nonce = randomBytes(5).toString("hex");
const results: Array<{ name: string; passed: boolean }> = [];
const captured: unknown[] = [];
let browser: Browser | undefined;
let responseMode: "reverse" | "invalid" | "redirect" | "timeout" = "reverse";
let beforeAnswer: (() => Promise<void>) | undefined;
let completed = false;
const nativeFetch = globalThis.fetch;
// A missed dependency injection fails closed instead of contacting a real provider.
globalThis.fetch = (async (input, init) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  assert.ok(target.protocol === "http:" && target.hostname === "127.0.0.1", "Synthetic run forbids non-loopback fetch");
  return nativeFetch(input, init);
}) as typeof fetch;
const server = createServer(async (request, response) => {
  try {
    let body = "";
    for await (const chunk of request) body += chunk;
    const envelope = JSON.parse(body);
    assert.equal(envelope.model, "synthetic-triad-ordering");
    const input = JSON.parse(envelope.messages[1].content);
    captured.push(input);
    const ids: string[] = input.advice.map((block: { id: string }) => block.id);
    assert.ok(ids.length >= 2);
    assert.equal(new Set(ids).size, ids.length);
    if (beforeAnswer) { const action = beforeAnswer; beforeAnswer = undefined; await action(); }
    if (responseMode === "redirect") {
      response.statusCode = 302;
      response.setHeader("Location", "https://blocked.invalid/never-follow");
      response.end();
      return;
    }
    if (responseMode === "timeout") await new Promise(resolve => setTimeout(resolve, 8500));
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ adviceIds: responseMode === "reverse" ? [...ids].reverse() : ["invented-advice"] }) } }] }));
  } catch {
    response.statusCode = 500;
    response.end("{}");
  }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const serverAddress = server.address();
assert.ok(serverAddress && typeof serverAddress === "object");
const provider = `https://llm-local-synthetic.${region === "CN" ? "cn-beijing" : "cn-hongkong"}.maas.aliyuncs.com/compatible-mode/v1`;
Object.assign(process.env, {
  NOVA_AI_ENABLED: "true", NOVA_TRIAD_AI_ENABLED: "true", NOVA_AI_BASE_URL: provider,
  NOVA_AI_API_KEY: "synthetic-key-no-provider-access", NOVA_AI_MODEL: "synthetic-triad-ordering", NOVA_AI_DEPLOYMENT_SCOPE: region,
});
const narrativeFetcher: typeof fetch = async (input, init) => {
  assert.equal(String(input), `${provider}/chat/completions`);
  assert.equal(init?.redirect, "error");
  assert.ok(init?.signal);
  return nativeFetch(`http://127.0.0.1:${serverAddress.port}/chat/completions`, { ...init, headers: { "Content-Type": "application/json" } });
};
const visitor: Client = { cookie: "" };
const locale: Locale = region === "CN" ? "zh-CN" : "zh-HK";

async function request(client: Client, route: string, method = "GET", body?: unknown) {
  assert.ok(route.startsWith("/api/"));
  return fetch(`${base.origin}${route}`, {
    method, redirect: "error", signal: AbortSignal.timeout(30000),
    headers: { ...(client.cookie ? { Cookie: client.cookie } : {}), ...(method === "GET" ? {} : { Origin: base.origin }), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function ok<T>(client: Client, route: string, method = "GET", body?: unknown): Promise<T> {
  const response = await request(client, route, method, body);
  assert.equal(response.ok, true, `${method} ${route.replace(/[a-f0-9-]{36}/g, "<id>")} HTTP ${response.status}`);
  return response.json() as Promise<T>;
}
function authenticated(response: Response): Client {
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie);
  return { cookie: cookie.split(";")[0] };
}
async function consent(fixture: Pick<Fixture, "familyId" | "clients">, action: "grant" | "withdraw", scope = "ai_processing") {
  return ok(fixture.clients.parent, `/api/families/${fixture.familyId}/consent`, "POST", { action, scope, guardianName: "合成授权家长" });
}
function answers(scale: ScaleDefinition, role: RespondentRole, risk: boolean) {
  const copy = structuredClone(scale);
  for (const item of copy.items) if (item.id === "p_age" || item.id === "c_age") item.choices = item.choices.filter(choice => choice.value === 12);
  const value = previewAnswers(copy, risk ? "risk" : "calm");
  for (const item of copy.items) if (typeof value[item.id] === "string") value[item.id] = `PRIVATE_${role}_${item.id}_${nonce}`;
  return value;
}
async function fixture(name: string, options: { noConsentRole?: RespondentRole; riskRole?: RespondentRole; mixedAdvice?: boolean } = {}): Promise<Fixture> {
  const parent = await request(visitor, `/api/triad/parent?locale=${locale}`, "POST", {
    parentName: "合成授权家长", username: `qa_${nonce}_${name}_parent`, password: randomBytes(16).toString("hex"),
    relationship: "母亲", childName: `PRIVATE_CHILD_${nonce}`, birthDate: `${new Date().getUTCFullYear() - 12}-01-01`,
    grade: "初中", assessment: true, sensitiveData: true, parentReport: true,
  });
  assert.equal(parent.status, 201);
  const created = await parent.json() as { familyId: string; joinCode: string };
  const clients = { parent: authenticated(parent) } as Record<RespondentRole, Client>;
  for (const role of ["student", "teacher"] as const) {
    const response = await request(visitor, `/api/triad/join?locale=${locale}`, "POST", {
      code: created.joinCode, role, name: `PRIVATE_${role}_${nonce}`, username: `qa_${nonce}_${name}_${role}`, password: randomBytes(16).toString("hex"),
    });
    assert.equal(response.status, 201);
    clients[role] = authenticated(response);
  }
  const w = await ok<Workspace>(clients.parent, "/api/workspace");
  const tasks = {} as Record<RespondentRole, Assessment>;
  for (const role of roles) {
    const found = w.assessments.filter(task => task.familyId === created.familyId && task.respondentRole === role);
    assert.equal(found.length, 1);
    tasks[role] = found[0];
    assert.equal(tasks[role].scaleVersionId, `${definitions[role].id}@${definitions[role].version}`);
  }
  const partial = { familyId: created.familyId, clients };
  await consent(partial, "grant");
  for (const [index, role] of roles.entries()) {
    if (options.noConsentRole === role) await consent(partial, "withdraw");
    await ok(clients[role], `/api/assessments/${tasks[role].id}/submit`, "POST", { answers: answers(definitions[role], role, options.riskRole === role), revision: 0, acknowledged: true });
    if (options.noConsentRole === role) await consent(partial, "grant");
    if (index < 2) assert.equal((await query("SELECT id FROM reports WHERE family_id=$1", [created.familyId])).length, 0);
    if (options.mixedAdvice && index < 2) {
      const frozen = await query<{ snapshot: AssessmentSnapshot }>("SELECT snapshot FROM assessments WHERE id=$1", [tasks[role].id]);
      await query("INSERT INTO content_versions(id,kind,version,content,library_key,origin) VALUES(gen_random_uuid(),'advice',$1,$2,'growth-triad','seed')", [`98.0.${index}`, JSON.stringify(frozen[0].snapshot.advice.content)]);
    }
  }
  const jobs = await query("SELECT j.id,j.source_assessment_ids FROM report_jobs j JOIN assessments a ON a.id=j.assessment_id WHERE a.family_id=$1", [created.familyId]);
  assert.equal(jobs.length, 1);
  assert.deepEqual([...jobs[0].source_assessment_ids].sort(), roles.map(role => tasks[role].id).sort());
  return { ...partial, tasks, jobId: jobs[0].id };
}
async function report(f: Fixture) {
  const rows = await query<{ payload: ReportPayload; html_documents: Record<Locale, string>; id: string; pdf_keys: Record<Locale, string> }>("SELECT id,payload,html_documents,pdf_keys FROM reports WHERE family_id=$1", [f.familyId]);
  assert.equal(rows.length, 1);
  return rows[0];
}
async function defaultOrder(f: Fixture): Promise<string[]> {
  const sources = await query<{ respondent_role: RespondentRole; snapshot: AssessmentSnapshot }>("SELECT respondent_role,snapshot FROM assessments WHERE id=ANY($1::uuid[])", [roles.map(role => f.tasks[role].id)]);
  const parent = sources.find(source => source.respondent_role === "parent")!;
  return eligibleTriadAdviceIds(sources.map(source => buildTriadNarrativeSource(source.respondent_role, source.snapshot.scale.dimensions, source.snapshot.score, source.snapshot.aiConsented)), parent.snapshot.advice);
}
async function verifyDocuments(f: Fixture, name: string) {
  const row = await report(f);
  for (const language of ["zh-CN", "zh-HK"] as const) {
    const response = await request(f.clients.parent, `/api/reports/${row.id}/document?locale=${language}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.equal(html, row.html_documents[language]);
    assert.ok(html.includes(row.payload.generationMode === "ai" ? "AI" : language === "zh-CN" ? "规则模板生成" : "規則模板產生"));
    const pdf = await request(f.clients.parent, `/api/reports/${row.id}/pdf?locale=${language}`);
    assert.equal(pdf.status, 200);
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
    const stem = path.join(output, `${name}-${language}`);
    await fs.writeFile(`${stem}.html`, html);
    await fs.writeFile(`${stem}.pdf`, bytes);
    const text = execFileSync("pdftotext", ["-layout", `${stem}.pdf`, "-"], { encoding: "utf8" }).replace(/\s+/g, "");
    let prior = -1;
    for (const id of row.payload.selectedAdviceIds) {
      const block = row.payload.advice.content.blocks.find(item => item.id === id)!;
      const offset = text.indexOf(block.title[language].replace(/\s+/g, ""), prior + 1);
      assert.ok(offset > prior, "PDF must preserve approved advice order");
      prior = offset;
    }
    assert.ok(!text.includes(`PRIVATE_student_`) && !text.includes("_staff_"));
    const context = await browser!.newContext({ viewport: { width: 1100, height: 900 } });
    await context.route("**/*", route => new URL(route.request().url()).origin === base.origin ? route.continue() : route.abort());
    const split = f.clients.parent.cookie.indexOf("=");
    await context.addCookies([{ name: f.clients.parent.cookie.slice(0, split), value: f.clients.parent.cookie.slice(split + 1), url: base.origin }]);
    const page = await context.newPage();
    await page.goto(`${base.origin}/api/reports/${row.id}/document?locale=${language}`);
    assert.equal(await page.locator("article").count(), 1);
    const headings = await page.locator(".advice h3").allTextContents();
    assert.equal(headings.length, row.payload.selectedAdviceIds.length);
    for (const [index, id] of row.payload.selectedAdviceIds.entries()) assert.ok(headings[index].includes(row.payload.advice.content.blocks.find(item => item.id === id)!.title[language]));
    await page.screenshot({ path: `${stem}.png`, fullPage: true });
    await context.close();
    execFileSync("pdftoppm", ["-scale-to", "1100", "-png", `${stem}.pdf`, `${stem}-page`]);
  }
  for (const role of ["student", "teacher"] as const) assert.equal((await request(f.clients[role], `/api/reports/${row.id}`)).status, 403);
}
async function check(name: string, action: () => Promise<void>) {
  try { await action(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false }); throw error; }
}

try {
  const marker = await query("SELECT region,mode FROM deployment_settings");
  assert.deepEqual(marker.map(row => ({ region: row.region, mode: row.mode })), [{ region, mode: "demo" }]);
  const session = await ok<Session>(visitor, "/api/session");
  assert.equal(session.mode, "demo");
  browser = await chromium.launch({ headless: true, executablePath: process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined });
  let successful: Fixture;
  await check("same-round AI publication and immutable parent advice version", async () => {
    successful = await fixture("success", { mixedAdvice: true });
    const snapshots = await query<{ snapshot: AssessmentSnapshot }>("SELECT snapshot FROM assessments WHERE id=$1", [successful.tasks.parent.id]);
    const advice = snapshots[0].snapshot.advice;
    const versions = await query("SELECT count(DISTINCT snapshot->'advice'->>'id')::int AS n FROM assessments WHERE id=ANY($1::uuid[])", [roles.map(role => successful.tasks[role].id)]);
    assert.equal(versions[0].n, 3);
    // A later library version must not replace the already accepted snapshot.
    await query("INSERT INTO content_versions(id,kind,version,content,library_key,origin) VALUES(gen_random_uuid(),'advice','99.0.0',$1,'growth-triad','seed')", [JSON.stringify({ ...advice.content, blocks: advice.content.blocks.map(block => ({ ...block, title: { "zh-CN": "LATER_CONTENT", "zh-HK": "LATER_CONTENT" } })) })]);
    assert.deepEqual(await processReportJob(successful.jobId, { narrativeFetcher }), { status: "published" });
    const row = await report(successful);
    assert.equal(row.payload.generationMode, "ai");
    assert.equal(row.payload.aiModel, "synthetic-triad-ordering");
    assert.equal(row.payload.fallbackReason, null);
    assert.equal(row.payload.advice.id, advice.id);
    const input = captured.at(-1) as { advice: Array<{ id: string }>; sources: Array<{ role: RespondentRole; dimensions: unknown[] }> };
    assert.deepEqual(Object.keys(input).sort(), ["advice", "outputContract", "sources"]);
    assert.deepEqual(input.sources.map(source => source.role).sort(), [...roles].sort());
    for (const source of input.sources) {
      assert.deepEqual(Object.keys(source).sort(), ["ageBand", "dimensions", "role"]);
      for (const dimension of source.dimensions) assert.deepEqual(Object.keys(dimension as object).sort(), ["domain", "higherMeans", "key", "raw"]);
    }
    assert.deepEqual(row.payload.selectedAdviceIds, input.advice.map(block => block.id).reverse());
    assert.ok(!JSON.stringify(input).includes("PRIVATE_"));
    assert.equal(captured.length, 1);
    await verifyDocuments(successful, "ai");
    const hash = createHash("sha256").update(JSON.stringify(row)).digest("hex");
    assert.deepEqual(await processReportJob(successful.jobId, { narrativeFetcher }), { status: "already_done" });
    assert.equal(captured.length, 1);
    assert.equal(createHash("sha256").update(JSON.stringify(await report(successful))).digest("hex"), hash);
    await query("INSERT INTO content_versions(id,kind,version,content,library_key,origin) VALUES(gen_random_uuid(),'advice','99.0.1',$1,'growth-triad','seed')", [JSON.stringify(advice.content)]);
  });
  await check("invalid provider output publishes bilingual template", async () => {
    responseMode = "invalid";
    const f = await fixture("invalid");
    assert.deepEqual(await processReportJob(f.jobId, { narrativeFetcher }), { status: "published" });
    const row = await report(f);
    assert.equal(row.payload.generationMode, "template");
    assert.equal(row.payload.fallbackReason, "invalid_output");
    assert.equal(row.payload.aiModel, null);
    assert.deepEqual(row.payload.selectedAdviceIds, await defaultOrder(f));
    await verifyDocuments(f, "fallback");
    responseMode = "reverse";
  });
  if (region === "CN") for (const mode of ["redirect", "timeout"] as const) await check(`real loopback ${mode} falls back automatically`, async () => {
    const f = await fixture(mode), count = captured.length;
    responseMode = mode;
    const started = Date.now();
    assert.deepEqual(await processReportJob(f.jobId, { narrativeFetcher }), { status: "published" });
    if (mode === "timeout") assert.ok(Date.now() - started >= 7900, "Actual abort budget must be exercised");
    assert.equal(captured.length, count + 1);
    const row = await report(f);
    assert.equal(row.payload.fallbackReason, "provider_unavailable");
    assert.deepEqual(row.payload.selectedAdviceIds, await defaultOrder(f));
    responseMode = "reverse";
  });
  for (const role of roles) await check(`${role} submission consent cannot be granted retroactively`, async () => {
    const f = await fixture(`consent_${role}`, { noConsentRole: role }), count = captured.length;
    assert.deepEqual(await processReportJob(f.jobId, { narrativeFetcher }), { status: "published" });
    assert.equal(captured.length, count);
    assert.equal((await report(f)).payload.fallbackReason, "no_ai_consent");
  });
  for (const role of roles) await check(`${role} safety risk skips AI`, async () => {
    const f = await fixture(`risk_${role}`, { riskRole: role }), count = captured.length;
    assert.deepEqual(await processReportJob(f.jobId, { narrativeFetcher }), { status: "published" });
    assert.equal(captured.length, count);
    const row = await report(f);
    assert.equal(row.payload.fallbackReason, "risk_template");
    assert.ok(row.payload.triad!.safety.length > 0);
    assert.equal((await query("SELECT id FROM staff_alerts WHERE family_id=$1", [f.familyId])).length, 1);
  });
  await check("queued AI withdrawal makes no provider request", async () => {
    const f = await fixture("queued_withdraw"), count = captured.length;
    await consent(f, "withdraw");
    assert.deepEqual(await processReportJob(f.jobId, { narrativeFetcher }), { status: "published" });
    assert.equal(captured.length, count);
    assert.equal((await report(f)).payload.fallbackReason, "no_ai_consent");
  });
  await check("AI withdrawal and regrant during inference discards its ordering", async () => {
    const f = await fixture("inference_withdraw"), count = captured.length;
    beforeAnswer = async () => { await consent(f, "withdraw"); await consent(f, "grant"); };
    assert.deepEqual(await processReportJob(f.jobId, { narrativeFetcher }), { status: "published" });
    assert.equal(captured.length, count + 1);
    const row = await report(f);
    assert.equal(row.payload.generationMode, "template");
    assert.equal(row.payload.fallbackReason, "ai_consent_changed");
    assert.deepEqual(row.payload.selectedAdviceIds, await defaultOrder(f));
  });
  await check("parent report withdrawal during inference pauses publication", async () => {
    const f = await fixture("report_withdraw");
    beforeAnswer = () => consent(f, "withdraw", "parent_report").then(() => undefined);
    assert.deepEqual(await processReportJob(f.jobId, { narrativeFetcher }), { status: "paused" });
    assert.equal((await query("SELECT id FROM reports WHERE family_id=$1", [f.familyId])).length, 0);
    const jobs = await query("SELECT state,last_error_code FROM report_jobs WHERE id=$1", [f.jobId]);
    assert.equal(jobs[0].state, "paused");
    assert.equal(jobs[0].last_error_code, "PARENT_REPORT_CONSENT_REQUIRED");
  });
  await check("feature flag disables only triad AI", async () => {
    const f = await fixture("flag"), count = captured.length;
    process.env.NOVA_TRIAD_AI_ENABLED = "false";
    assert.deepEqual(await processReportJob(f.jobId, { narrativeFetcher }), { status: "published" });
    assert.equal(captured.length, count);
    assert.equal((await report(f)).payload.fallbackReason, "triad_ai_disabled");
  });
  completed = true;
} finally {
  await browser?.close();
  await closePdfBrowser();
  await closeDatabase();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  globalThis.fetch = nativeFetch;
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify({ region, completed, passed: completed && results.every(result => result.passed), syntheticOnly: true, liveAi: false, providerRequests: captured.length, results }, null, 2) + "\n");
}
