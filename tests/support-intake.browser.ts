import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { SurveyRecord, Workspace } from "../src/components/api";
import { childScaleSupportIntake, parentScaleSupportIntake, teacherScaleSupportIntake } from "../src/domain/triad-scales";
import type { Locale, Region, RespondentRole, ScaleDefinition, StoredAnswer } from "../src/domain/types";

/** Real local API + browser regression. Start isolated demo CN/HK apps and workers first. */
const origins: Record<Region, string> = {
  CN: process.env.NOVA_SUPPORT_INTAKE_CN_URL ?? "http://127.0.0.1:3260",
  HK: process.env.NOVA_SUPPORT_INTAKE_HK_URL ?? "http://127.0.0.1:3261"
};
for (const origin of Object.values(origins)) {
  const url = new URL(origin);
  assert.ok(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname));
  assert.equal(origin, url.origin, "Use a local origin without credentials, path, query or fragment");
}
const output = path.resolve(process.env.NOVA_SUPPORT_INTAKE_BROWSER_OUTPUT ?? "work/support-intake-20261023/browser");
const work = path.resolve("work");
assert.ok(output.startsWith(work + path.sep), "Evidence must stay in work/");
await mkdir(output, { recursive: true });
assert.ok((await realpath(output)).startsWith((await realpath(work)) + path.sep), "Evidence must not escape work through a symlink");
const browser = await chromium.launch({ headless: true, executablePath: process.env.NOVA_CHROMIUM_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const contexts = new Set<BrowserContext>();
const results: { name: string; passed: boolean; detail?: string }[] = [];
const pageErrors: string[] = [];
const blockedOrigins = new Set<string>();
const fixtures: { scenario: string; familyId: string; assessments: Record<RespondentRole, string>; reportId?: string }[] = [];
const definitions: Record<RespondentRole, ScaleDefinition> = { parent: parentScaleSupportIntake, student: childScaleSupportIntake, teacher: teacherScaleSupportIntake };
const count = { parent: 25, student: 20, teacher: 15 };
const safety = { parent: "q22", student: "c14", teacher: "t15" };
const calm = { parent: 7, student: 6, teacher: 6 };
const followups = { parent: ["q23"], student: ["c15", "c16"], teacher: ["t16"] };
const optional = { parent: "q37", student: "c22", teacher: "t21" };
const profiles = { desktop: { width: 1280, height: 1000 }, mobile: { width: 390, height: 844 } };
type Profile = keyof typeof profiles;
type Client = { context: BrowserContext; page: Page; origin: string; locale: Locale };
const startedAt = new Date().toISOString();
const localYear = Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Hong_Kong", year: "numeric" }).format(new Date()));

async function until(predicate: () => Promise<boolean>, message: string, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.fail(message);
}
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) {
    results.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
async function api(client: Client, endpoint: string, method = "GET", data?: unknown) {
  assert.ok(endpoint.startsWith("/api/") && !endpoint.startsWith("//"));
  const target = new URL(endpoint, client.origin);
  assert.equal(target.origin, client.origin);
  return client.context.request.fetch(target.href, { method, maxRedirects: 0, headers: { Origin: client.origin }, ...(data === undefined ? {} : { data }) });
}
async function json<T>(client: Client, endpoint: string, method = "GET", data?: unknown, expected = 200): Promise<T> {
  const response = await api(client, endpoint, method, data);
  assert.equal(response.status(), expected, `${method} ${new URL(endpoint, client.origin).pathname} must succeed`);
  return response.json() as Promise<T>;
}
async function client(region: Region, locale: Locale, profile: Profile): Promise<Client> {
  const origin = origins[region], mobile = profile === "mobile";
  const context = await browser.newContext({ viewport: profiles[profile], isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce", serviceWorkers: "block" });
  contexts.add(context); context.setDefaultTimeout(15000);
  await context.addInitScript(language => localStorage.setItem("nova-locale", language), locale);
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { blockedOrigins.add(url.origin); await route.abort(); }
    else await route.continue();
  });
  await context.routeWebSocket("**/*", socket => {
    const url = new URL(socket.url());
    if (url.host === new URL(origin).host && url.protocol === "ws:") socket.connectToServer();
    else { blockedOrigins.add(url.origin); socket.close(); }
  });
  const page = await context.newPage();
  page.on("pageerror", error => pageErrors.push(error.message));
  const value = { context, page, origin, locale };
  const session = await json<{ mode: string; region: string; authProvider: string }>(value, "/api/session");
  assert.equal(session.mode, "demo", "Only isolated local demo servers are allowed");
  assert.equal(session.region, region);
  assert.equal(session.authProvider, "local");
  return value;
}
function credentials(role: RespondentRole) {
  return { role, name: `合成简版核查${role}`, username: `intake_${role}_${randomBytes(8).toString("hex")}`, password: randomBytes(24).toString("base64url") };
}
async function workspace(client: Client) { return json<Workspace>(client, `/api/workspace?locale=${client.locale}`); }
async function record(client: Client, id: string) { return json<SurveyRecord>(client, `/api/assessments/${id}?locale=${client.locale}`); }
async function createFamily(region: Region, locale: Locale, profile: Profile, age: 8 | 17) {
  const parent = await client(region, locale, profile), student = await client(region, locale, profile), teacher = await client(region, locale, profile);
  await json(parent, `/api/auth/register?locale=${locale}`, "POST", credentials("parent"), 201);
  const family = await json<{ familyId: string; joinCode: string }>(parent, `/api/triad/family?locale=${locale}`, "POST", {
    requestId: randomUUID(), relationship: "母亲", childName: `合成简版核查${age}岁`, birthDate: `${localYear - age}-01-01`,
    grade: age === 8 ? "小学一至三年级" : "高中", assessment: true, sensitiveData: true, parentReport: true
  }, 201);
  await json(student, `/api/triad/join?locale=${locale}`, "POST", { ...credentials("student"), code: family.joinCode }, 201);
  await json(teacher, `/api/auth/register?locale=${locale}`, "POST", credentials("teacher"), 201);
  await json(teacher, `/api/triad/join?locale=${locale}`, "POST", { code: family.joinCode }, 201);
  const view = await workspace(parent);
  const assessments = {} as Record<RespondentRole, string>;
  for (const role of ["parent", "student", "teacher"] as const) {
    const task = view.assessments.find(task => task.familyId === family.familyId && task.respondentRole === role);
    assert.ok(task, `Created family needs ${role} assessment`);
    assert.equal(task.scaleVersionId, `${definitions[role].id}@2.0.0`);
    assessments[role] = task.id;
  }
  return { clients: { parent, student, teacher }, familyId: family.familyId, assessments };
}
function question(page: Page, id: string) { return page.locator(`.survey-questions [data-name="${id}"]:visible`); }
async function currentId(page: Page) {
  const current = page.locator(".survey-questions .sd-question[data-name]:visible");
  await current.first().waitFor();
  assert.equal(await current.count(), 1, "Grouped chapters retain one active question and manual navigation");
  return (await current.getAttribute("data-name"))!;
}
async function choose(page: Page, id: string, value: number) {
  const input = question(page, id).locator(`input[value="${value}"]`);
  if (!(await input.isChecked())) await input.locator("xpath=ancestor::label[1]").click();
  assert.equal(await input.isChecked(), true, `${id} must retain selected answer`);
}
async function start(client: Client, id: string) {
  await client.page.goto(`${client.origin}/#assessment/${id}`);
  await client.page.locator('.survey-container[data-stage="intro"]').waitFor();
  await client.page.locator(".survey-assent-panel input[type=checkbox]").check();
  assert.equal(await client.page.getByTestId("survey-submit").count(), 0);
  await client.page.getByTestId("survey-start").click();
  await client.page.locator('.survey-container[data-stage="answering"]').waitFor();
}
async function progressCount(page: Page, total: number) {
  await page.waitForFunction(expected => document.querySelector<HTMLElement>('[data-testid="survey-progress"]')?.dataset.total === String(expected), total);
}
async function noOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(dimensions.html <= dimensions.width + 1 && dimensions.body <= dimensions.width + 1, "No horizontal overflow");
}
async function capture(page: Page, name: string) { await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: "disabled" }); }
async function expandReview(page: Page) {
  const closed = page.locator('section[aria-labelledby="survey-review-heading"] details:not([open]) > summary');
  while (await closed.count()) await closed.first().click();
}
async function jumpFromReview(page: Page, id: string) {
  await page.getByTestId("survey-review").click();
  await page.locator('.survey-container[data-stage="review"]').waitFor();
  await expandReview(page);
  await page.locator(`[data-review-question-id="${id}"]`).click();
  await question(page, id).waitFor();
}
async function exerciseSafety(client: Client, id: string, role: RespondentRole, label: string) {
  const page = client.page, trigger = safety[role];
  await choose(page, trigger, 1);
  await progressCount(page, count[role] + followups[role].length);
  await page.getByTestId("survey-next").click();
  for (const followId of followups[role]) {
    await question(page, followId).waitFor();
    const item = definitions[role].items.find(item => item.id === followId)!;
    if (item.kind === "text") await question(page, followId).locator("textarea").fill("SYNTHETIC_LOCAL_SAFETY_DETAIL");
    else await choose(page, followId, 3);
    if (followId !== followups[role].at(-1)) await page.getByTestId("survey-next").click();
  }
  await capture(page, `${label}-safety-followup`);
  await jumpFromReview(page, trigger);
  await choose(page, trigger, calm[role]);
  await progressCount(page, count[role]);
  await until(async () => {
    const saved = (await record(client, id)).draftAnswers;
    return JSON.stringify(saved[trigger]) === JSON.stringify([calm[role]]) && followups[role].every(key => !Object.hasOwn(saved, key));
  }, "Changing safety to the exclusive no-current-concern answer must clear hidden details in the real saved draft");
  const before = await record(client, id);
  await page.reload();
  await page.locator('.survey-container[data-stage="intro"]').waitFor();
  await page.locator(".survey-assent-panel input[type=checkbox]").check();
  await page.getByTestId("survey-start").click();
  await page.locator('.survey-container[data-stage="answering"]').waitFor();
  assert.deepEqual((await record(client, id)).draftAnswers, before.draftAnswers, "Real saved answers must survive page reload");
  await progressCount(page, count[role]);
}
async function fill(client: Client, id: string, role: RespondentRole, scenario: string, pauseForAutoAdvance: boolean) {
  const page = client.page, scale = definitions[role], label = `${scenario}-${role}`;
  const seen = new Set<string>();
  await start(client, id);
  await progressCount(page, count[role]);
  await capture(page, `${label}-start`);
  let safetyTested = false;
  for (let step = 0; step < 50; step++) {
    if (await page.locator('.survey-container[data-stage="review"]').isVisible()) break;
    const name = await currentId(page), item = scale.items.find(item => item.id === name);
    assert.ok(item, "UI must only render the assigned short-form definition");
    seen.add(name);
    if (name === safety[role] && !safetyTested) {
      await exerciseSafety(client, id, role, label);
      safetyTested = true;
      continue;
    }
    if (item.kind === "text") {
      assert.equal(name, optional[role], "Only the optional ordinary writing prompt remains after safety reset");
      assert.equal(await question(page, name).locator("textarea").inputValue(), "");
    } else {
      const value = item.gate ?? (name === safety[role] ? calm[role] : name === "c23" ? 1 : item.excludeValues?.includes(-1) ? -1 : item.choices[0].value);
      await choose(page, name, value);
    }
    if (pauseForAutoAdvance && step === 0) await page.waitForTimeout(5500);
    assert.equal(await currentId(page), name, "Answer selection must not navigate automatically");
    await noOverflow(page);
    await page.getByTestId("survey-next").click();
    await page.waitForFunction(previous => {
      if (document.querySelector('.survey-container[data-stage="review"]')) return true;
      const visible = Array.from(document.querySelectorAll<HTMLElement>(".survey-questions .sd-question[data-name]")).find(node => node.offsetHeight > 0);
      return visible?.dataset.name !== previous;
    }, name);
    assert.ok(step < 49, "Manual navigation must reach review");
  }
  assert.ok(safetyTested);
  assert.equal(seen.size, count[role], "Every ordinary question was visited through the UI");
  await page.locator('.survey-container[data-stage="review"]').waitFor();
  await expandReview(page);
  assert.equal(await page.locator("[data-review-question-id]").count(), count[role]);
  assert.equal(await page.getByTestId("survey-submit").isEnabled(), true, "Blank optional writing and honest unknown answers do not block submission");
  await noOverflow(page);
  await capture(page, `${label}-review`);
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/assessments/${id}/submit` && response.request().method() === "POST");
  await page.getByTestId("survey-submit").click();
  const response = await responsePromise;
  assert.equal(response.status(), 200, "Explicit review submission must succeed against the real local API");
  const submitted = await response.json();
  assert.equal(submitted.status, "queued");
  const request = response.request().postDataJSON() as { answers: Record<string, StoredAnswer> };
  assert.equal(Object.hasOwn(request.answers, optional[role]), false, "Blank optional writing is not fabricated");
  assert.ok(followups[role].every(key => !Object.hasOwn(request.answers, key)));
  await until(async () => (await record(client, id)).status !== "pending", "Submitted assessment must leave pending state");
}
async function reports(family: Awaited<ReturnType<typeof createFamily>>, scenario: string, evidence: typeof fixtures[number]) {
  const parent = family.clients.parent;
  let view = await workspace(parent);
  await until(async () => { view = await workspace(parent); return view.reports.some(report => report.familyId === family.familyId); }, "Local worker must publish the completed synthetic family report", 60000);
  const report = view.reports.find(report => report.familyId === family.familyId)!;
  evidence.reportId = report.id;
  assert.equal(report.generationMode, "template");
  assert.equal(report.resultMode, "support-intake");
  assert.deepEqual(report.dimensions, []);
  assert.equal(view.staffIntakeResponses, undefined, "Parent workspace must not expose staff-only responses");
  for (const locale of ["zh-CN", "zh-HK"] as const) {
    const document = await api(parent, `/api/reports/${report.id}/document?locale=${locale}`);
    assert.equal(document.status(), 200);
    const html = await document.text();
    assert.match(html, /support-intake-report/);
    assert.doesNotMatch(html, /SYNTHETIC_LOCAL_SAFETY_DETAIL|原始平均分|有效回答还不够|有效回答還不夠/);
    await writeFile(path.join(output, `${scenario}-report-${locale}.html`), html);
    const pdf = await api(parent, `/api/reports/${report.id}/pdf?locale=${locale}`);
    assert.equal(pdf.status(), 200);
    const bytes = await pdf.body();
    assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
    await writeFile(path.join(output, `${scenario}-report-${locale}.pdf`), bytes);
  }
  for (const role of ["student", "teacher"] as const) {
    assert.equal((await api(family.clients[role], `/api/reports/${report.id}/pdf?locale=${parent.locale}`)).status(), 403);
  }
}

try {
  for (const [region, locale, profile, age] of [
    ["CN", "zh-CN", "desktop", 8], ["CN", "zh-CN", "mobile", 17],
    ["HK", "zh-HK", "desktop", 17], ["HK", "zh-HK", "mobile", 8]
  ] as const) {
    const scenario = `${region.toLowerCase()}-${profile}-age${age}`;
    const family = await createFamily(region, locale, profile, age);
    const evidence = { scenario, familyId: family.familyId, assessments: family.assessments };
    fixtures.push(evidence);
    try {
      for (const role of ["parent", "student", "teacher"] as const) {
        await check(`${scenario}-${role}: exact normal count, explicit start, safety visibility/reset, real draft reload, manual navigation and review submission`, () => fill(family.clients[role], family.assessments[role], role, scenario, role === "parent"));
      }
      await check(`${scenario}: automatic private bilingual template report and PDF, role denial`, () => reports(family, scenario, evidence));
    } catch (error) {
      for (const [role, value] of Object.entries(family.clients)) await capture(value.page, `${scenario}-${role}-failure`).catch(() => undefined);
      throw error;
    } finally {
      for (const value of Object.values(family.clients)) { await value.context.close(); contexts.delete(value.context); }
    }
  }
  assert.deepEqual(pageErrors, [], "No uncaught browser errors");
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
  await writeFile(path.join(output, "browser-results.json"), JSON.stringify({ passed: results.length === 16 && results.every(result => result.passed) && pageErrors.length === 0, startedAt, completedAt: new Date().toISOString(), syntheticOnly: true, realLocalApi: true, mode: "demo", results, pageErrors, blockedOrigins: [...blockedOrigins], fixtures }, null, 2));
}
