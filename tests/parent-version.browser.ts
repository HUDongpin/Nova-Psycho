import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
import { parentScale, parentScaleV1 } from "../src/domain/triad-scales";
import { answerVisible } from "../src/domain/scoring";
import type { StoredAnswer } from "../src/domain/types";
import type { SurveyRecord } from "../src/components/api";

const base = process.env.NOVA_PARENT_VERSION_BASE_URL ?? "http://127.0.0.1:3238";
assert.ok(["http://127.0.0.1:3238", "http://127.0.0.1:3239"].includes(base));
const hk = base.endsWith("3239"), region = hk ? "HK" : "CN", locale = hk ? "zh-HK" : "zh-CN";
const mobile = process.env.NOVA_PARENT_VERSION_MOBILE === "true";
const run = process.env.NOVA_PARENT_VERSION_RUN ?? "first";
assert.match(run, /^[a-z0-9-]+$/);
const output = `work/questionnaire-version-d-20261015/browser/${locale}-${mobile ? "mobile" : "desktop"}-${run}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const contexts: BrowserContext[] = [];
const checks: { name: string; passed: boolean; detail?: string }[] = [];
const pageErrors: string[] = [];
const fixtures: { familyId: string; assessmentId: string }[] = [];
const sentinel = "SYNTHETIC_PARENT_VERSION_SUPPLEMENT";
const supplementValues: Record<string, number> = { p_together: 5, p_grade: 6, p_curriculum: 6, p_care: 7, p_changes: 8, p_focus: 11, q31: 10 };

async function check(name: string, action: () => Promise<void>) {
  try { await action(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, passed: false, detail: error instanceof Error ? error.message : "verification failed" }); throw error; }
}
async function until(test: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 120)); }
  assert.fail(message);
}
async function context() {
  const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 1000 }, isMobile: mobile, hasTouch: mobile });
  contexts.push(ctx); ctx.setDefaultTimeout(15000);
  await ctx.addInitScript(value => localStorage.setItem("nova-locale", value), locale);
  await ctx.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  return ctx;
}
function answersBefore(targetId: string) {
  const answers: Record<string, StoredAnswer> = {};
  for (const item of parentScale.items) {
    if (item.id === targetId) break;
    if (item.supplementFor || !answerVisible(answers, item)) continue;
    answers[item.id] = item.kind === "text" ? "SYNTHETIC_CONTEXT" : item.kind === "multi"
      ? [item.id === "q22" ? 7 : item.choices[0].value]
      : item.gate ?? (item.id === "p_age" ? 12 : item.choices.find(choice => !item.excludeValues?.includes(choice.value))!.value);
  }
  return answers;
}
async function fixture(target: string, otherSaved = false) {
  const ctx = await context();
  const api = async (path: string, method = "GET", data?: unknown) => ctx.request.fetch(base + path, { method, headers: { Origin: base }, ...(data === undefined ? {} : { data }) });
  const session = await (await api("/api/session")).json(); assert.equal(session.mode, "demo"); assert.equal(session.region, region);
  const response = await api("/api/triad/parent", "POST", { parentName: "合成新版家长", childName: "合成新版孩子", username: `version_${randomBytes(8).toString("hex")}`, password: randomBytes(24).toString("base64url"), relationship: "母亲", birthDate: `${new Date().getUTCFullYear() - 12}-01-01`, grade: "初中", accepted: true });
  assert.equal(response.status(), 201, "Synthetic new parent registration succeeds");
  const created = await response.json();
  const w = await (await api("/api/workspace")).json();
  const task = w.assessments.find((a: { familyId: string; respondentRole: string }) => a.familyId === created.familyId && a.respondentRole === "parent");
  assert.equal(task.scaleVersionId, "growth-parent@1.1.0");
  fixtures.push({ familyId: created.familyId, assessmentId: task.id });
  const path = `/api/assessments/${task.id}`;
  const answers = answersBefore(target);
  if (otherSaved) { answers[target] = supplementValues[target]; answers[`${target}_other`] = `${sentinel}_restored`; }
  const saved = await api(path, "PATCH", { answers, acknowledged: true, revision: 0 }); assert.equal(saved.status(), 200);
  const page = await ctx.newPage(); page.on("pageerror", error => pageErrors.push(error.message));
  const record = async (): Promise<SurveyRecord> => (await api(`${path}?locale=${locale}`)).json();
  const open = async () => {
    await page.goto(`${base}/#assessment/${task.id}`);
    await page.locator(".survey-assent-panel input[type=checkbox]").check();
    if (otherSaved) await page.locator(".sd-navigation__prev-btn").click();
    await until(async () => await current(page) === target, `Draft opens at ${target}`);
  };
  return { ctx, page, api, record, open, path, answers };
}
async function current(page: Page) { return page.locator(".survey-questions [data-name]:visible").evaluateAll(nodes => nodes.map(n => n.getAttribute("data-name")).find(Boolean) ?? null); }
async function choice(page: Page, id: string, value: number, multi: boolean) {
  const input = page.locator(`.survey-questions [data-name="${id}"] input[type="${multi ? "checkbox" : "radio"}"][value="${value}"]`);
  await input.locator("xpath=ancestor::label[1]").click();
}
const supplement = (page: Page, id: string) => page.locator(`[data-testid="survey-supplement"][data-supplement-id="${id}"]`);
const waitForTimer = () => new Promise(resolve => setTimeout(resolve, 5300));

try {
  await check("frozen old draft stays on 1.0 with its original wording and no supplemental inputs", async () => {
    const privateFixture = JSON.parse(await readFile("work/questionnaire-version-d-20261015/legacy-private-fixtures.json", "utf8"));
    const old = privateFixture.regions[region].pending;
    const ctx = await context();
    const cookie = old.clients.parent.cookie;
    const split = cookie.indexOf("=");
    await ctx.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: base, httpOnly: true, sameSite: "Lax" }]);
    const response = await ctx.request.get(`${base}/api/assessments/${old.tasks.parent}?locale=${locale}`); assert.equal(response.status(), 200);
    const detail = await response.json();
    assert.equal(detail.supplements, undefined); assert.deepEqual(detail.draftAnswers, old.expectedAnswers);
    const page = await ctx.newPage(); page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(`${base}/#assessment/${old.tasks.parent}`);
    await page.locator(".survey-assent-panel input[type=checkbox]").check();
    assert.equal(await page.getByTestId("survey-supplement").count(), 0);
    assert.equal(parentScaleV1.version, "1.0.0");
    await page.screenshot({ path: `${output}/legacy-draft.png`, fullPage: true });
  });
  for (const [parentId, value] of Object.entries(supplementValues)) {
    await check(`${parentId}: other opens an optional named input in the same question and persists its canonical key`, async () => {
      const f = await fixture(parentId); await f.open();
      const main = parentScale.items.find(item => item.id === parentId)!;
      const child = parentScale.items.find(item => item.supplementFor === parentId)!;
      const record = await f.record(); assert.equal(record.supplements?.length, 7);
      const beforeProgress = await f.page.locator(".sd-progress__text:visible").innerText();
      await choice(f.page, parentId, value, main.kind === "multi");
      const field = supplement(f.page, child.id); await field.waitFor();
      assert.equal(await field.evaluate(node => node.closest("[data-name]")?.getAttribute("data-name")), parentId);
      const input = field.getByRole("textbox", { name: child.label[locale], exact: true });
      assert.equal(await input.getAttribute("aria-required"), "false"); assert.equal(await input.getAttribute("maxlength"), "2000");
      assert.equal(await input.evaluate(node => node === document.activeElement), false, "Expanding must not steal focus");
      assert.equal(await f.page.locator(".sd-progress__text:visible").innerText(), beforeProgress, "Supplement is not another main question");
      assert.equal(await f.page.locator(".survey-advance-track").count(), 0, "Other must not arm auto-advance");
      await input.fill(`${sentinel}_${parentId}`);
      await until(async () => (await f.record()).draftAnswers[child.id] === `${sentinel}_${parentId}`, "Canonical supplemental value is saved");
      const actual = (await f.record()).draftAnswers;
      assert.deepEqual(actual[parentId], main.kind === "multi" ? [value] : value);
      assert.ok(!Object.keys(actual).some(key => key.includes("Comment")));
      if (parentId === "p_curriculum") { await waitForTimer(); assert.equal(await current(f.page), parentId); }
      await f.page.locator(`.survey-questions [data-name="${parentId}"]`).screenshot({ path: `${output}/${parentId}.png` });
      await input.fill("");
      await until(async () => !Object.hasOwn((await f.record()).draftAnswers, child.id), "Empty optional supplement is omitted");
      await f.page.locator(".sd-navigation__next-btn").click();
      const mainItems = parentScale.items.filter(item => !item.supplementFor);
      const next = mainItems[mainItems.findIndex(item => item.id === parentId) + 1].id;
      await until(async () => await current(f.page) === next, "Next remains the next original main question");
      assert.notEqual(await current(f.page), child.id);
    });
  }
  await check("saved other text restores once through StrictMode, language remount and refresh", async () => {
    const f = await fixture("p_curriculum", true); await f.open();
    let field = supplement(f.page, "p_curriculum_other");
    assert.equal(await field.count(), 1); assert.equal(await field.locator("textarea").inputValue(), `${sentinel}_restored`);
    await f.page.getByRole("button", { name: hk ? "简" : "繁", exact: true }).click();
    await f.page.locator(".survey-assent-panel input[type=checkbox]").check();
    await f.page.locator(".sd-navigation__prev-btn").click();
    field = supplement(f.page, "p_curriculum_other"); await field.waitFor();
    assert.equal(await field.count(), 1); assert.equal(await field.locator("textarea").inputValue(), `${sentinel}_restored`);
    const label = parentScale.items.find(item => item.id === "p_curriculum_other")!.label[hk ? "zh-CN" : "zh-HK"];
    await field.getByRole("textbox", { name: label, exact: true }).waitFor();
    await f.page.reload(); await f.page.locator(".survey-assent-panel input[type=checkbox]").check();
    await f.page.locator(".sd-navigation__prev-btn").click(); await field.waitFor();
    assert.equal(await field.count(), 1); assert.equal(await field.locator("textarea").inputValue(), `${sentinel}_restored`);
    await f.page.locator(".survey-assent-panel input[type=checkbox]").uncheck();
    assert.equal(await field.locator("textarea").isEditable(), false, "Unconfirmed survey cannot edit supplemental data");
    await f.page.locator(".survey-assent-panel input[type=checkbox]").check();
    await f.page.getByTestId("survey-notice-open").click(); await f.page.getByRole("dialog").waitFor();
    await waitForTimer(); assert.equal(await current(f.page), "p_curriculum");
    await f.page.keyboard.press("Escape");
    assert.equal(await field.locator("textarea").inputValue(), `${sentinel}_restored`);
    await choice(f.page, "p_curriculum", 1, false);
    await until(async () => await field.count() === 0, "Changing away from Other removes its input");
    await until(async () => !Object.hasOwn((await f.record()).draftAnswers, "p_curriculum_other"), "Changing away from Other removes stored hidden text");
    await choice(f.page, "p_curriculum", 6, false); await field.waitFor();
    assert.equal(await field.locator("textarea").inputValue(), "", "Old hidden supplemental text must not reappear");
    await choice(f.page, "p_curriculum", 1, false);
    await until(async () => await current(f.page) === "p_care", "Fresh ordinary choice retains automatic next-question behavior");
  });
  await check("long optional input and whitespace honor the existing text boundary", async () => {
    const f = await fixture("p_curriculum"); await f.open(); await choice(f.page, "p_curriculum", 6, false);
    const input = supplement(f.page, "p_curriculum_other").locator("textarea");
    await input.fill("a".repeat(2000)); assert.equal((await input.inputValue()).length, 2000);
    await input.press("End"); await input.press("b"); assert.equal((await input.inputValue()).length, 2000);
    await until(async () => (await f.record()).draftAnswers.p_curriculum_other === "a".repeat(2000), "Exactly 2000 characters save");
    await input.fill("   ");
    await until(async () => !Object.hasOwn((await f.record()).draftAnswers, "p_curriculum_other"), "Whitespace is omitted without making optional text required");
  });
  await check("a competing draft keeps local supplemental text and locks editing without overwriting server data", async () => {
    const f = await fixture("p_curriculum", true); await f.open();
    const field = supplement(f.page, "p_curriculum_other"); await field.waitFor();
    const latest = await f.record();
    const rival = await f.api(f.path, "PATCH", { acknowledged: true, revision: latest.draftRevision, answers: { ...latest.draftAnswers, p_curriculum_other: `${sentinel}_other_tab` } }); assert.equal(rival.status(), 200);
    await field.locator("textarea").fill(`${sentinel}_local_conflict`);
    await f.page.locator(".draft-conflict").waitFor();
    assert.equal(await field.locator("textarea").isEditable(), false);
    assert.equal(await field.locator("textarea").inputValue(), `${sentinel}_local_conflict`);
    assert.equal((await f.record()).draftAnswers.p_curriculum_other, `${sentinel}_other_tab`);
    await f.page.screenshot({ path: `${output}/supplement-conflict.png`, fullPage: true });
  });
  assert.deepEqual(pageErrors, [], "No unhandled browser errors");
} catch (error) {
  process.exitCode = 1; console.error(error instanceof Error ? error.message : "Parent-version browser checks failed");
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify({ region, locale, mobile, checks, pageErrors, fixtures, passed: !process.exitCode, evidence: "real loopback API/PostgreSQL; synthetic data; no mocked application responses" }, null, 2));
  for (const ctx of contexts) await ctx.close(); await browser.close();
}
