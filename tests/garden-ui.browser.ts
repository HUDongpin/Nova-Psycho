import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { AssessmentStatus, Locale, Report, Role, SubmissionPhase, SurveyRecord, Workspace } from "../src/components/api";
import { copy } from "../src/components/copy";

const base = process.env.NOVA_GARDEN_BASE_URL ?? "http://127.0.0.1:3100";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const output = path.resolve(process.env.NOVA_GARDEN_OUTPUT_DIR ?? "work/garden-ui/browser");
assert.ok(output.startsWith(path.resolve("work") + path.sep));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.NOVA_CHROMIUM_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const checks: { name: string; passed: boolean; detail?: string }[] = [];
const errors: string[] = [];
const contexts: BrowserContext[] = [];
const assessmentId = "22222222-2222-4222-8222-222222222222";
const familyId = "33333333-3333-4333-8333-333333333333";
const reportId = "44444444-4444-4444-8444-444444444444";
type DisplayState = "pending" | "waiting" | "reporting" | "consent" | "failed" | "ready";

async function check(name: string, action: () => Promise<void>) {
  try { await action(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, passed: false, detail: String(error) }); throw error; }
}

async function fixture(locale: Locale, mobile: boolean, initial: DisplayState = "pending", role: Role = "parent", safety = false) {
  const hk = locale === "zh-HK";
  const t = copy(locale);
  const user = { id: "11111111-1111-4111-8111-111111111111", name: "合成界面使用者", role, region: hk ? "HK" as const : "CN" as const };
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 1000 }, reducedMotion: "reduce" });
  contexts.push(context);
  context.setDefaultTimeout(15000);
  await context.addInitScript(value => localStorage.setItem("nova-locale", value), locale);
  await context.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  let state = initial, revision = 2, failSave = false, retries = 0;
  let answers: SurveyRecord["draftAnswers"] = { first: 0 };
  const phase = (): SubmissionPhase => state === "waiting" || state === "reporting" || state === "consent" ? state : null;
  const status = (): AssessmentStatus => state === "pending" ? "pending" : state === "failed" ? "failed" : state === "ready" ? "published" : "queued";
  const report: Report = { id: reportId, familyId, childName: "合成孩子", title: hk ? "合成成長記錄" : "合成成长记录", respondentRole: "parent", scaleTitle: "合成界面问卷", createdAt: "2026-10-21T00:00:00Z", generationMode: "template", risk: false, demo: true, dimensions: [], assessmentId, comparison: { available: false } };
  const record = (): SurveyRecord => ({
    id: assessmentId, status: status(), phase: phase(), childName: "合成孩子", scaleTitle: hk ? "合成家庭了解問卷" : "合成家庭了解问卷", description: "", demo: true,
    consentRequired: false, safetyGuidance: safety, draftAnswers: answers, draftRevision: revision,
    surveyJson: { pages: [
      { name: "learning", title: hk ? "學習與日常" : "学习与日常", elements: [
        { type: "radiogroup", name: "first", title: hk ? "最近的學習安排" : "最近的学习安排", isRequired: true, noAutoAdvance: true, choices: [{ value: 0, text: "没有" }, { value: 1, text: "有时" }, { value: -1, text: "不了解或不适用" }] },
        { type: "comment", name: "optional", title: hk ? "想補充的話（選答）" : "想补充的话（选答）" },
      ] },
      { name: "relationship", title: hk ? "關係和溝通" : "关系和沟通", elements: [
        { type: "radiogroup", name: "gate", title: "是否需要描述", isRequired: true, noAutoAdvance: true, choices: [{ value: 0, text: "不需要" }, { value: 1, text: "需要" }] },
        { type: "comment", name: "detail", title: "描述情境", visibleIf: "{gate} = 1" },
        { type: "checkbox", name: "last", title: "方便的方式", choices: [{ value: 1, text: "一起阅读" }, { value: 2, text: "一起散步" }] },
      ] },
    ] },
  });
  const workspace = (): Workspace => ({
    user, region: user.region, mode: "demo", families: [], goals: [], observations: [], scales: [], staff: [], contentVersions: [], alerts: [], staffNotes: [],
    reports: state === "ready" && role === "parent" ? [report] : [],
    assessments: [{ id: assessmentId, familyId, childName: "合成孩子", respondentId: user.id, respondentName: user.name, respondentRole: role, scaleVersionId: "synthetic-ui@1.0.0", scaleTitle: record().scaleTitle, status: status(), phase: phase(), createdAt: "2026-10-21T00:00:00Z", reportId: state === "ready" && role === "parent" ? reportId : null, canRespond: state === "pending", canRetryReport: state === "failed" && role === "parent" }],
    summary: { families: 0, pendingAssessments: state === "pending" ? 1 : 0, publishedReports: state === "ready" ? 1 : 0, activeGoals: 0, riskReports: 0 },
  });
  await context.route("**/api/**", async route => {
    const url = new URL(route.request().url()), method = route.request().method();
    if (url.pathname === "/api/session") return route.fulfill({ json: { user, region: user.region, mode: "demo", demoAccounts: [], siblingUrl: null, authProvider: "local" } });
    if (url.pathname === "/api/workspace") return route.fulfill({ json: workspace() });
    if (url.pathname === `/api/assessments/${assessmentId}` && method === "GET") return route.fulfill({ json: record() });
    if (url.pathname === `/api/assessments/${assessmentId}` && method === "PATCH") {
      if (failSave) { failSave = false; return route.fulfill({ status: 500, json: { code: "SYNTHETIC_SAVE_FAILURE", error: "合成保存失败" } }); }
      const body = route.request().postDataJSON();
      assert.equal(body.revision, revision);
      answers = body.answers; revision++;
      return route.fulfill({ json: { id: assessmentId, revision } });
    }
    if (url.pathname === `/api/assessments/${assessmentId}/submit`) {
      state = "waiting";
      return route.fulfill({ json: { id: assessmentId, status: "queued", reportId: null, phase: "waiting", safetyGuidance: safety } });
    }
    if (url.pathname === `/api/assessments/${assessmentId}/retry-report`) {
      retries++; state = "reporting";
      return route.fulfill({ json: { id: assessmentId, status: "queued" } });
    }
    // This pre-existing frozen document must be rendered verbatim, without being regenerated.
    const html = '<!DOCTYPE html><html><body><h1 id="frozen-original">合成历史报告原文</h1><p>FROZEN_ORIGINAL_DOCUMENT</p></body></html>';
    if (url.pathname === `/api/reports/${reportId}`) return route.fulfill({ json: { ...report, html, downloadUrl: `/api/reports/${reportId}/pdf` } });
    if (url.pathname === `/api/reports/${reportId}/document`) return route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
    throw new Error(`Unexpected browser fixture API ${method} ${url.pathname}`);
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/#assessment/${assessmentId}`);
  await page.locator(".app-shell").waitFor();
  return { context, page, t, setFailSave: () => { failSave = true; }, setState: (value: DisplayState) => { state = value; }, retries: () => retries };
}

async function noOverflow(page: Page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "Page must not scroll horizontally");
}
async function capture(page: Page, file: string) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  await page.screenshot({ path: path.join(output, file), fullPage: true, animations: "disabled" });
}
async function progress(page: Page, position: number, total: number, answered: number) {
  await page.waitForFunction(expected => {
    const node = document.querySelector<HTMLElement>('[data-testid="garden-survey-progress"]');
    return !!node && Number(node.dataset.position) === expected.position && Number(node.dataset.total) === expected.total && Number(node.dataset.answered) === expected.answered;
  }, { position, total, answered });
}
async function choice(page: Page, name: string, value: number) {
  const input = page.locator(`.survey-questions [data-name="${name}"] input[value="${value}"]`);
  await input.locator("xpath=ancestor::label[1]").click();
  assert.equal(await input.isChecked(), true);
}

try {
  for (const locale of ["zh-CN", "zh-HK"] as const) for (const mobile of [false, true]) {
    const label = `${locale}-${mobile ? "mobile" : "desktop"}`;
    const f = await fixture(locale, mobile);
    await check(`${label}: intro, draft resume, optional skip and chapter`, async () => {
      await f.page.locator(".survey-assent-panel input[type=checkbox]").waitFor();
      await noOverflow(f.page);
      await capture(f.page, `${label}-intro.png`);
      await f.page.locator(".survey-assent-panel input[type=checkbox]").focus();
      await f.page.keyboard.press("Space");
      assert.equal(await f.page.locator(".survey-assent-panel input[type=checkbox]").isChecked(), true);
      await progress(f.page, 2, 4, 1);
      assert.match(await f.page.getByTestId("garden-survey-progress").innerText(), /学习与日常|學習與日常/);
      await f.page.getByRole("button", { name: f.t("nextQuestion"), exact: true }).focus();
      await f.page.keyboard.press("Enter");
      await progress(f.page, 3, 4, 1);
      assert.match(await f.page.getByTestId("garden-survey-progress").innerText(), /关系和沟通|關係和溝通/);
    });
    await check(`${label}: visible denominator and truthful failed-save feedback`, async () => {
      f.setFailSave();
      await choice(f.page, "gate", 1);
      await progress(f.page, 3, 5, 2);
      await f.page.locator(".survey-save-status").getByText(f.t("saveFailed"), { exact: true }).waitFor();
      assert.equal(await f.page.locator(".survey-save-status").getByText(f.t("savedDraft"), { exact: true }).count(), 0);
      await capture(f.page, `${label}-save-failed.png`);
      await f.page.locator(".survey-save-status").getByRole("button").click();
      await f.page.locator(".survey-save-status").getByText(f.t("savedDraft"), { exact: true }).waitFor();
      await choice(f.page, "gate", 0);
      await progress(f.page, 3, 4, 2);
      await f.page.getByRole("button", { name: f.t("previousQuestion"), exact: true }).click();
      await progress(f.page, 2, 4, 2);
      await f.page.getByRole("button", { name: f.t("previousQuestion"), exact: true }).click();
      await progress(f.page, 1, 4, 2);
      await choice(f.page, "first", -1);
      await progress(f.page, 1, 4, 2);
      await noOverflow(f.page);
      await capture(f.page, `${label}-progress.png`);
    });
    await check(`${label}: optional empty answer permits explicit submission`, async () => {
      await f.page.locator(".nova-nav-submit").click();
      await f.page.locator('[data-testid="submission-state"][data-state="waiting"]').waitFor();
      assert.match(await f.page.getByTestId("submission-state").innerText(), /等待三方|等候三方/);
      await noOverflow(f.page);
      await capture(f.page, `${label}-waiting.png`);
    });
    await f.context.close();
  }

  for (const locale of ["zh-CN", "zh-HK"] as const) {
    const updating = await fixture(locale, true, "waiting");
    await check(`${locale}: workspace updates advance the open submission panel`, async () => {
      await updating.page.locator('[data-testid="submission-state"][data-state="waiting"]').waitFor();
      for (const next of ["consent", "reporting", "failed", "ready"] as const) {
        updating.setState(next);
        // Foreground refresh deliberately deduplicates focus events within one second.
        await new Promise(resolve => setTimeout(resolve, 1100));
        await updating.page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await updating.page.locator(`[data-testid="submission-state"][data-state="${next}"]`).waitFor();
      }
    });
    await updating.context.close();
    for (const state of ["consent", "reporting", "failed", "ready"] as const) {
      const f = await fixture(locale, true, state);
      await check(`${locale}: parent ${state} state`, async () => {
        await f.page.locator(`[data-testid="submission-state"][data-state="${state}"]`).waitFor();
        await noOverflow(f.page);
        assert.doesNotMatch(await f.page.getByTestId("submission-state").innerText(), /\d+\s*%/);
        await capture(f.page, `${locale}-${state}.png`);
        if (state === "failed") {
          await f.page.getByRole("button", { name: f.t("retryReport"), exact: true }).click();
          await f.page.locator('[data-testid="submission-state"][data-state="reporting"]').waitFor();
          assert.equal(f.retries(), 1);
        }
        if (state === "ready") {
          await f.page.getByRole("button", { name: f.t("viewReport"), exact: true }).click();
          const frame = f.page.frameLocator(".report-frame");
          await frame.locator("#frozen-original").waitFor();
          assert.equal(await frame.locator(".garden-report-art").count(), 0);
          assert.match(await frame.locator("body").innerText(), /FROZEN_ORIGINAL_DOCUMENT/);
          await noOverflow(f.page);
        }
      });
      await f.context.close();
    }
    for (const role of ["student", "teacher"] as const) {
      const f = await fixture(locale, true, "consent", role, true);
      await check(`${locale}: ${role} own submission and prominent safety`, async () => {
        await f.page.locator('[data-testid="submission-state"][data-state="submitted"]').waitFor();
        await f.page.locator(".safety-guidance").waitFor();
        assert.equal(await f.page.getByRole("button", { name: f.t("viewReport"), exact: true }).count(), 0);
        assert.equal(await f.page.getByRole("button", { name: f.t("retryReport"), exact: true }).count(), 0);
        assert.ok(!(await f.page.getByTestId("submission-state").innerText()).includes(f.t("reportNeedsParentConsentNote")));
        await noOverflow(f.page);
        await capture(f.page, `${locale}-${role}-safety.png`);
      });
      await f.context.close();
    }
  }
  assert.deepEqual(errors, [], "No uncaught browser errors");
} finally {
  await writeFile(path.join(output, "results.json"), JSON.stringify({ syntheticApiFixtures: true, realBrowser: true, backendIntegration: false, checks, errors }, null, 2));
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser.close();
}
