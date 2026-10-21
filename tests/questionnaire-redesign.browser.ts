import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import { Model } from "survey-core";
import type { Locale, Region, Role, SurveyRecord, Workspace } from "../src/components/api";
import { copy } from "../src/components/copy";
import { completionRules } from "../src/domain/completion";
import { surveyDefinition } from "../src/domain/survey";
import { titleEmphasis } from "../src/domain/survey-presentation";
import { surveySupplements } from "../src/domain/survey-supplements";
import { childScaleStaffNotes, parentScaleStaffNotes, teacherScaleStaffNotes } from "../src/domain/triad-scales";
import type { RespondentRole, ScaleDefinition } from "../src/domain/types";

/**
 * Local UI regression, using the real application and SurveyJS renderer with
 * context-local synthetic API fixtures. No backend/AI/production acceptance.
 *
 * NOVA_QUESTIONNAIRE_CN_URL=http://127.0.0.1:3241 \
 * NOVA_QUESTIONNAIRE_HK_URL=http://127.0.0.1:3242 \
 * node_modules/.bin/tsx tests/questionnaire-redesign.browser.ts
 */
const origins: Record<Region, string> = {
  CN: process.env.NOVA_QUESTIONNAIRE_CN_URL ?? "http://127.0.0.1:3241",
  HK: process.env.NOVA_QUESTIONNAIRE_HK_URL ?? "http://127.0.0.1:3242",
};
for (const base of Object.values(origins)) {
  const url = new URL(base);
  assert.ok(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname), "Only local HTTP app origins are allowed");
  assert.equal(base, url.origin, "Use an origin without path, credentials, query or trailing slash");
}
const output = path.resolve(process.env.NOVA_QUESTIONNAIRE_OUTPUT_DIR ?? "work/questionnaire-b-20261022/browser-regression");
const work = path.resolve("work");
assert.ok(output.startsWith(work + path.sep), "Browser evidence must stay below work/");
await mkdir(output, { recursive: true });
assert.ok((await realpath(output)).startsWith((await realpath(work)) + path.sep), "Evidence path must not escape work/ through a symlink");

const browser = await chromium.launch({ headless: true, executablePath: process.env.NOVA_CHROMIUM_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const startedAt = new Date().toISOString();
const checks: { name: string; passed: boolean; detail?: string }[] = [];
const browserErrors: string[] = [];
const fixtureErrors: string[] = [];
const blockedOrigins: string[] = [];
const layoutEvidence: unknown[] = [];
const contexts = new Set<BrowserContext>();
const assessmentId = "22222222-2222-4222-8222-222222222222";
const familyId = "33333333-3333-4333-8333-333333333333";
const profiles = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
  narrow: { width: 320, height: 800 },
  zoom200Equivalent: { width: 720, height: 450 },
} as const;
type Profile = keyof typeof profiles;
type Answers = SurveyRecord["draftAnswers"];
type FixtureOptions = { locale: Locale; profile?: Profile; role?: RespondentRole; scale?: ScaleDefinition; answers?: Answers };
type PatchOutcome = "ok" | "fail" | "conflict" | "unauthenticated";
const scales: Record<RespondentRole, ScaleDefinition> = { parent: parentScaleStaffNotes, student: childScaleStaffNotes, teacher: teacherScaleStaffNotes };

function controlledDefinition(locale: Locale): Pick<SurveyRecord, "surveyJson" | "supplements" | "scaleTitle" | "description"> {
  const hk = locale === "zh-HK";
  return {
    scaleTitle: hk ? "合成問卷互動檢查" : "合成问卷交互检查",
    description: "",
    supplements: [{ itemId: "first_other", parentId: "first", label: hk ? "其他安排（選填）" : "其他安排（选填）", anyOf: [1], maxLength: 2000 }],
    surveyJson: { clearInvisibleValues: "onHidden", pages: [
      { name: "learning", title: hk ? "學習與日常" : "学习与日常", elements: [
        // Intentionally no noAutoAdvance flag: the redesigned flow must keep all
        // ordinary single-choice answers in place, including legacy definitions.
        { type: "radiogroup", name: "first", title: hk ? "最近的學習安排" : "最近的学习安排", isRequired: true, choices: [{ value: 0, text: hk ? "沒有" : "没有" }, { value: 1, text: hk ? "有時" : "有时" }, { value: -1, text: hk ? "不瞭解或不適用" : "不了解或不适用" }] },
        { type: "comment", name: "optional", title: hk ? "想補充的話（選答）" : "想补充的话（选答）", rows: 3 },
      ] },
      { name: "relationship", title: hk ? "關係和溝通" : "关系和沟通", elements: [
        { type: "checkbox", name: "multi", title: hk ? "方便的方式（最多兩項）" : "方便的方式（最多两项）", isRequired: true, maxSelectedChoices: 2, choices: [{ value: 1, text: hk ? "一起閱讀" : "一起阅读" }, { value: 2, text: "一起散步" }, { value: 3, text: hk ? "一起畫畫" : "一起画画" }, { value: -1, text: hk ? "以上均不適用" : "以上均不适用", isExclusive: true }] },
        { type: "radiogroup", name: "gate", title: hk ? "是否需要描述情境" : "是否需要描述情境", isRequired: true, choices: [{ value: 0, text: "不需要" }, { value: 1, text: "需要" }] },
        { type: "comment", name: "detail", title: hk ? "情境說明" : "情境说明", isRequired: true, visibleIf: "{gate} = 1", rows: 3 },
      ] },
      { name: "closing", title: hk ? "其他補充" : "其他补充", elements: [
        { type: "comment", name: "narrative", title: hk ? "用自己的話說明" : "用自己的话说明", isRequired: true, rows: 4 },
        { type: "comment", name: "last", title: hk ? "最後補充（選答）" : "最后补充（选答）", rows: 3 },
      ] },
    ] },
  };
}

async function fixture(options: FixtureOptions) {
  const { locale, scale } = options;
  const region: Region = locale === "zh-HK" ? "HK" : "CN";
  const base = origins[region];
  const role: Role = options.role ?? "parent";
  const profile = options.profile ?? "desktop";
  const mobile = profile === "mobile" || profile === "narrow";
  const user = { id: "11111111-1111-4111-8111-111111111111", name: "合成界面使用者", role, region };
  let answers: Answers = structuredClone(options.answers ?? {});
  let revision = 4;
  let submitted = false;
  let patchAttempts = 0;
  let patchSuccesses = 0;
  let submitAttempts = 0;
  let loginAttempts = 0;
  let detailReads = 0;
  let authenticated = true;
  let nextPatch: PatchOutcome = "ok";
  let heldPatch: { promise: Promise<void>; release: () => void; outcome: PatchOutcome } | undefined;
  const definition = (language: Locale) => scale ? {
    scaleTitle: scale.title[language], description: scale.description[language],
    surveyJson: surveyDefinition(scale, role as RespondentRole, language, { age: 12 }),
    completionRules: completionRules(scale, 12), titleEmphasis: titleEmphasis(scale, role as RespondentRole, language), supplements: surveySupplements(scale, language),
  } : controlledDefinition(language);
  const record = (language: Locale): SurveyRecord => ({
    id: assessmentId, status: submitted ? "queued" : "pending", phase: submitted ? "waiting" : null,
    childName: "合成孩子", demo: false, consentRequired: false, draftAnswers: structuredClone(answers), draftRevision: revision,
    ...definition(language),
  });
  const workspace = (language: Locale): Workspace => ({
    user, region, mode: "demo", families: [], goals: [], observations: [], scales: [], staff: [], contentVersions: [], alerts: [], staffNotes: [], reports: [],
    assessments: [{ id: assessmentId, familyId, childName: "合成孩子", respondentId: user.id, respondentName: user.name, respondentRole: role,
      scaleVersionId: scale ? `${scale.id}@${scale.version}` : "synthetic-browser@1.0.0", scaleTitle: definition(language).scaleTitle,
      status: submitted ? "queued" : "pending", phase: submitted ? "waiting" : null, createdAt: "2026-10-22T00:00:00Z", reportId: null, canRespond: !submitted, canRetryReport: false }],
    summary: { families: 0, pendingAssessments: submitted ? 0 : 1, publishedReports: 0, activeGoals: 0, riskReports: 0 },
  });
  const context = await browser.newContext({ viewport: profiles[profile], isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce", serviceWorkers: "block" });
  contexts.add(context);
  context.setDefaultTimeout(12000);
  await context.addInitScript(value => localStorage.setItem("nova-locale", value), locale);
  // One route owns the origin check AND API fixtures, so a later API handler
  // cannot accidentally admit an off-origin /api/ URL. No real API falls through.
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) { blockedOrigins.push(url.origin); await route.abort(); return; }
    if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
    const method = route.request().method();
    const language: Locale = url.searchParams.get("locale") === "zh-HK" ? "zh-HK" : "zh-CN";
    try {
      if (url.pathname === "/api/session" && method === "GET") {
        await route.fulfill({ json: { user: authenticated ? user : null, region, mode: "demo", demoAccounts: [user], siblingUrl: null, authProvider: "local", identityState: authenticated ? "ready" : "signed_out" } }); return;
      }
      if (url.pathname === "/api/auth/demo" && method === "POST") {
        assert.equal(route.request().postDataJSON().accountId, user.id, "Recovery must sign in the same synthetic owner");
        loginAttempts++; authenticated = true; await route.fulfill({ json: { user } }); return;
      }
      if (!authenticated && url.pathname !== "/api/privacy") {
        await route.fulfill({ status: 401, json: { code: "UNAUTHENTICATED", error: "Synthetic session expired" } }); return;
      }
      if (url.pathname === "/api/workspace" && method === "GET") { await route.fulfill({ json: workspace(language) }); return; }
      if (url.pathname === "/api/privacy" && method === "GET") {
        await route.fulfill({ json: { version: "synthetic-browser-only", title: language === "zh-HK" ? "填寫須知" : "填写须知", sections: [{ title: "合成使用说明", body: "此内容只供本地浏览器回归检查。" }] } }); return;
      }
      if (url.pathname === `/api/assessments/${assessmentId}` && method === "GET") { detailReads++; await route.fulfill({ json: record(language) }); return; }
      if (url.pathname === `/api/assessments/${assessmentId}` && method === "PATCH") {
        patchAttempts++;
        const body = route.request().postDataJSON() as { answers: Answers; revision: number; acknowledged: boolean };
        assert.equal(body.acknowledged, true, "A draft write must carry explicit acknowledgement");
        const held = heldPatch; heldPatch = undefined;
        const outcome = held?.outcome ?? nextPatch; nextPatch = "ok";
        if (held) await held.promise;
        if (outcome === "fail") { await route.fulfill({ status: 500, json: { code: "SYNTHETIC_SAVE_FAILURE", error: "合成保存失败，请重试。" } }); return; }
        if (outcome === "unauthenticated") {
          authenticated = false;
          await route.fulfill({ status: 401, json: { code: "UNAUTHENTICATED", error: "Synthetic session expired" } }); return;
        }
        if (outcome === "conflict") {
          answers = { first: -1 }; revision += 10;
          await route.fulfill({ status: 409, json: { code: "DRAFT_CONFLICT", error: "合成草稿已有较新版本。" } }); return;
        }
        assert.equal(body.revision, revision, "The UI must use the latest acknowledged revision");
        answers = structuredClone(body.answers); revision++; patchSuccesses++;
        await route.fulfill({ json: { id: assessmentId, ok: true, revision } }); return;
      }
      if (url.pathname === `/api/assessments/${assessmentId}/submit` && method === "POST") {
        submitAttempts++;
        const body = route.request().postDataJSON() as { answers: Answers; revision: number; acknowledged: boolean };
        assert.equal(body.acknowledged, true); assert.equal(body.revision, revision, "Submission must follow the acknowledged save");
        assert.ok(JSON.stringify(body.answers) === JSON.stringify(answers), "Submission must match the saved synthetic draft");
        submitted = true;
        await route.fulfill({ json: { id: assessmentId, status: "queued", phase: "waiting", reportId: null, safetyGuidance: false } }); return;
      }
      fixtureErrors.push(`Unexpected fixture route: ${method} ${url.pathname}`);
      await route.fulfill({ status: 404, json: { code: "SYNTHETIC_UNEXPECTED_ROUTE", error: "Unconfigured local fixture request" } });
    } catch (error) {
      fixtureErrors.push(error instanceof Error ? error.message : "Unknown fixture contract failure");
      await route.fulfill({ status: 500, json: { code: "SYNTHETIC_CONTRACT_FAILURE", error: "Synthetic fixture contract failed" } });
    }
  });
  await context.routeWebSocket("**/*", socket => {
    const url = new URL(socket.url());
    if (url.host === new URL(base).host && url.protocol === "ws:") socket.connectToServer();
    else { blockedOrigins.push(url.origin); socket.close(); }
  });
  const page = await context.newPage();
  page.on("pageerror", error => browserErrors.push(error.message));
  await page.goto(`${base}/#assessment/${assessmentId}`);
  await page.locator('.survey-container[data-stage="intro"]').waitFor();
  return {
    context, page, locale, region, profile, t: copy(locale), definition,
    counts: () => ({ patchAttempts, patchSuccesses, submitAttempts, loginAttempts, detailReads, revision }),
    answer: (id: string) => answers[id], hasAnswer: (id: string) => Object.hasOwn(answers, id),
    failNextSave: () => { nextPatch = "fail"; }, conflictNextSave: () => { nextPatch = "conflict"; },
    expireNextSave: () => { nextPatch = "unauthenticated"; },
    holdNextSave: (outcome: PatchOutcome = "ok") => {
      assert.equal(heldPatch, undefined, "Only one response may be held at a time");
      let release!: () => void;
      const promise = new Promise<void>(resolve => { release = resolve; });
      heldPatch = { promise, release, outcome };
      return release;
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function until(predicate: () => Promise<boolean> | boolean, message: string) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 70));
  }
  assert.fail(message);
}
async function check(name: string, action: () => Promise<void>) {
  try { await action(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    checks.push({ name, passed: false, detail }); console.error(`FAIL ${name}: ${detail}`); throw error;
  }
}
async function scenario(name: string, options: FixtureOptions, action: (f: Fixture) => Promise<void>) {
  let f: Fixture | undefined;
  const startCount = checks.length;
  try { f = await fixture(options); await action(f); }
  catch (error) {
    if (checks.length === startCount || checks.at(-1)?.passed) checks.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) });
    if (f) await f.page.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: true, animations: "disabled", mask: [f.page.locator(".draft-conflict textarea")] }).catch(() => undefined);
  } finally { if (f) { await f.context.close(); contexts.delete(f.context); } }
}
function question(page: Page, id: string) { return page.locator(`.survey-questions [data-name="${id}"]:visible`); }
function choiceInput(page: Page, id: string, value: number) { return question(page, id).locator(`input[value="${value}"]`); }
async function choose(page: Page, id: string, value: number) {
  const input = choiceInput(page, id, value);
  await input.locator("xpath=ancestor::label[1]").click();
  assert.equal(await input.isChecked(), true, `${id}: chosen option must be selected`);
}
async function stage(page: Page, value: "intro" | "answering" | "review") { await page.locator(`.survey-container[data-stage="${value}"]`).waitFor(); }
async function current(page: Page, id: string) {
  await question(page, id).waitFor();
  assert.equal(await page.locator(".survey-questions [data-name]:visible").count(), 1, "Only the current main question is visible");
}
async function progress(page: Page, position: number, total: number, answered: number) {
  await page.waitForFunction(expected => {
    const node = document.querySelector<HTMLElement>('[data-testid="survey-progress"]');
    return node?.dataset.position === String(expected.position) && node.dataset.total === String(expected.total) && node.dataset.answered === String(expected.answered);
  }, { position, total, answered });
}
async function saved(page: Page) { await page.locator('.survey-save-status[data-status="saved"]').waitFor(); }
async function focused(locator: Locator) { await until(() => locator.evaluate(element => element === document.activeElement), "Expected element must hold keyboard focus"); }
async function focusInQuestion(page: Page, id: string) {
  await until(() => question(page, id).evaluate(element => element.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "")), `${id}: chapter/review jump must focus its actual input`);
}
async function tabTo(page: Page, locator: Locator) {
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press("Tab");
    if (await locator.evaluate(element => element === document.activeElement)) return;
  }
  assert.fail("Tab navigation did not reach the intended action");
}
async function start(f: Fixture, keyboard = false) {
  const checkbox = f.page.locator(".survey-assent-panel input[type=checkbox]");
  if (keyboard) { await checkbox.focus(); await f.page.keyboard.press("Space"); }
  else await checkbox.check();
  assert.equal(await checkbox.isChecked(), true);
  await stage(f.page, "intro");
  assert.equal(await f.page.getByTestId("survey-submit").count(), 0);
  if (keyboard) { await tabTo(f.page, f.page.getByTestId("survey-start")); await f.page.keyboard.press("Enter"); }
  else await f.page.getByTestId("survey-start").click();
  await stage(f.page, "answering");
}
async function capture(page: Page, name: string, fullPage = false) {
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage, animations: "disabled", mask: [page.locator(".draft-conflict textarea")] });
}
async function noOverflow(page: Page, label: string) {
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  layoutEvidence.push({ label, ...dimensions });
  assert.ok(dimensions.document <= dimensions.viewport + 1 && dimensions.body <= dimensions.viewport + 1, `${label}: horizontal overflow (${dimensions.document}/${dimensions.body} > ${dimensions.viewport})`);
}
async function firstVisible(page: Page, id: string, label: string) {
  await current(page, id);
  const geometry = await question(page, id).evaluate(element => {
    const input = element.querySelector("input, textarea, select");
    const boxes = [element.querySelector(".sd-question__title"), input?.closest("label") ?? input, element].map(node => {
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
    });
    return { viewport: { width: innerWidth, height: innerHeight }, title: boxes[0], control: boxes[1], question: boxes[2] };
  });
  layoutEvidence.push({ label, ...geometry });
  assert.ok(geometry.title && geometry.title.bottom > 0 && geometry.title.top < geometry.viewport.height, `${label}: first question title must intersect the visible viewport`);
  assert.ok(geometry.control && geometry.control.bottom > 0 && geometry.control.top < geometry.viewport.height, `${label}: an actual first-question control must intersect the visible viewport`);
}
async function expandReview(page: Page) {
  const closed = page.locator('section[aria-labelledby="survey-review-heading"] details:not([open]) > summary');
  while (await closed.count()) await closed.first().click();
}
async function review(page: Page) {
  await page.getByTestId("survey-review").click(); await stage(page, "review"); await focused(page.locator("#survey-review-heading"));
}

try {
  for (const locale of ["zh-CN", "zh-HK"] as const) for (const role of ["parent", "student", "teacher"] as const) for (const profile of ["desktop", "mobile"] as const) {
    const name = `${locale}-${role}-${profile}`, scale = scales[role];
    await scenario(name, { locale, role, profile, scale }, async f => {
      const model = new Model(surveyDefinition(scale, role, locale, { age: 12 }));
      try {
        const items = scale.items.filter(item => !item.supplementFor && (item.visibleFromAge === undefined || item.visibleFromAge <= 12));
        await check(`${name}: canonical definition and separate introduction`, async () => {
          assert.equal(model.getAllQuestions().length, items.length);
          for (const item of items) {
            const q = model.getQuestionByName(item.id);
            assert.equal(q.title, (role !== "student" && item.observerLabel ? item.observerLabel : item.label)[locale], `${item.id}: canonical title`);
            assert.equal(q.isRequired, item.required, `${item.id}: required flag`);
            if (item.kind === "text") assert.equal(q.toJSON().maxLength, 2000);
            else {
              assert.deepEqual(q.toJSON().choices, item.choices.map(choice => ({ value: choice.value, text: choice.label[locale], ...(choice.exclusive ? { isExclusive: true } : {}) })), `${item.id}: canonical option values/text/exclusivity`);
              if (item.maxChoices) assert.equal(q.toJSON().maxSelectedChoices, item.maxChoices, `${item.id}: selection limit`);
            }
          }
          assert.equal(await f.page.getByTestId("survey-start").isDisabled(), true);
          assert.equal(await f.page.locator(".survey-questions").isVisible(), false);
          assert.equal(await f.page.locator('[data-testid="questionnaire-screen"] h1').innerText(), scale.title[locale]);
          await noOverflow(f.page, `${name}-intro`); await capture(f.page, `${name}-intro`, true);
          await start(f);
        });
        await check(`${name}: real first question, localized options and visible controls`, async () => {
          const first = items[0], q = question(f.page, first.id);
          await firstVisible(f.page, first.id, `${name}-first`);
          assert.ok((await q.innerText()).includes(model.getQuestionByName(first.id).title));
          for (const choice of first.choices) {
            const input = choiceInput(f.page, first.id, choice.value);
            assert.equal(await input.count(), 1);
            assert.ok((await input.locator("xpath=ancestor::label[1]").innerText()).includes(choice.label[locale]));
          }
          assert.equal(await f.page.getByTestId("survey-submit").count(), 0);
          await noOverflow(f.page, `${name}-first`); await capture(f.page, `${name}-first`);
        });
        await check(`${name}: browser review preserves all visible canonical questions`, async () => {
          await review(f.page); await expandReview(f.page);
          const visible = model.getAllQuestions().filter(q => q.isVisibleInSurvey && q.hasInput);
          const rendered = await f.page.locator("[data-review-question-id]").evaluateAll(nodes => nodes.map(node => ({ id: node.getAttribute("data-review-question-id"), title: node.querySelector("span")?.textContent })));
          assert.deepEqual(rendered, visible.map((q, index) => ({ id: q.name, title: `${index + 1}. ${q.title}` })), "Rendered review must retain every visible canonical title in source order");
          assert.equal(await f.page.getByTestId("survey-submit").isDisabled(), true, "A blank real questionnaire must not be submit-ready");
          assert.equal(f.counts().submitAttempts, 0);
          await noOverflow(f.page, `${name}-review`); await capture(f.page, `${name}-review`);
        });
      } finally { model.dispose(); }
    });
  }

  for (const locale of ["zh-CN", "zh-HK"] as const) {
    const name = `${locale}-controlled`;
    await scenario(name, { locale }, async f => {
      await check(`${name}: Space, Tab and Enter require an explicit start; Next validates required input`, async () => {
        await start(f, true); await current(f.page, "first"); await progress(f.page, 1, 6, 0);
        await f.page.getByTestId("survey-next").focus(); await f.page.keyboard.press("Enter");
        await current(f.page, "first");
        await question(f.page, "first").locator(".sd-question__erbox").waitFor();
        assert.equal(f.counts().submitAttempts, 0);
      });
      await check(`${name}: radio arrow keys and a wait longer than five seconds do not advance`, async () => {
        await choiceInput(f.page, "first", 0).focus(); await f.page.keyboard.press("ArrowDown");
        assert.equal(await choiceInput(f.page, "first", 1).isChecked(), true);
        await f.page.keyboard.press("ArrowDown"); assert.equal(await choiceInput(f.page, "first", -1).isChecked(), true);
        await f.page.keyboard.press("ArrowUp"); assert.equal(await choiceInput(f.page, "first", 1).isChecked(), true);
        await f.page.waitForTimeout(5300);
        await current(f.page, "first"); await progress(f.page, 1, 6, 1); await saved(f.page);
        assert.equal(f.counts().submitAttempts, 0); assert.equal(await f.page.getByTestId("survey-submit").count(), 0);
      });
      await check(`${name}: supplementary detail is reviewed, uncounted and removed when hidden`, async () => {
        const supplement = f.page.locator('[data-supplement-id="first_other"] textarea');
        await supplement.fill("合成补充说明"); await saved(f.page);
        assert.equal(f.hasAnswer("first_other"), true); await progress(f.page, 1, 6, 1);
        await review(f.page); await expandReview(f.page);
        assert.equal(await f.page.locator('[data-review-supplement="first_other"] > span').innerText(), "合成补充说明");
        assert.equal(await f.page.locator("[data-review-question-id]").count(), 6);
        assert.equal(await f.page.getByTestId("survey-submit").isDisabled(), true);
        await capture(f.page, `${name}-review-supplement`);
        await f.page.locator('[data-review-question-id="first"]').click(); await focusInQuestion(f.page, "first");
        await choose(f.page, "first", 0);
        assert.equal(await f.page.locator('[data-supplement-id="first_other"]').count(), 0);
        await saved(f.page); assert.equal(f.hasAnswer("first_other"), false); await progress(f.page, 1, 6, 1);
      });
      await check(`${name}: optional skip, multi-select maximum and exclusive option`, async () => {
        await f.page.getByTestId("survey-next").click(); await current(f.page, "optional");
        await f.page.getByTestId("survey-next").click(); await current(f.page, "multi");
        await choose(f.page, "multi", 1); await choose(f.page, "multi", 2);
        assert.equal(await choiceInput(f.page, "multi", 3).isDisabled(), true, "A third ordinary selection must be unavailable at the maximum");
        await choiceInput(f.page, "multi", 1).locator("xpath=ancestor::label[1]").click();
        await choose(f.page, "multi", -1);
        assert.equal(await question(f.page, "multi").locator("input:checked").count(), 1);
        await choose(f.page, "multi", 2);
        assert.equal(await choiceInput(f.page, "multi", -1).isChecked(), false);
        assert.equal(await question(f.page, "multi").locator("input:checked").count(), 1);
        await progress(f.page, 3, 6, 2);
      });
      await check(`${name}: conditional required questions change totals and clear hidden answers`, async () => {
        await f.page.getByTestId("survey-next").click(); await current(f.page, "gate");
        await choose(f.page, "gate", 1); await progress(f.page, 4, 7, 3);
        await f.page.getByTestId("survey-next").click(); await current(f.page, "detail");
        await question(f.page, "detail").locator("textarea").fill("合成条件说明"); await saved(f.page);
        assert.equal(f.hasAnswer("detail"), true);
        await f.page.getByTestId("survey-previous").click(); await choose(f.page, "gate", 0);
        await progress(f.page, 4, 6, 3); await saved(f.page); assert.equal(f.hasAnswer("detail"), false);
        await f.page.getByTestId("survey-next").click(); await current(f.page, "narrative");
      });
      await check(`${name}: textarea Enter and composition events never navigate or submit`, async () => {
        const input = question(f.page, "narrative").locator("textarea");
        await input.fill("合成第一行"); await input.press("End"); await input.press("Enter"); await f.page.keyboard.insertText("合成第二行");
        assert.equal(await input.inputValue(), "合成第一行\n合成第二行");
        // Browser-dispatched composition events exercise handlers, not a real
        // operating-system Chinese IME or its candidate-selection UI.
        await input.dispatchEvent("compositionstart", { data: "" });
        await input.dispatchEvent("compositionupdate", { data: "合成" });
        await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, which: 229, isComposing: true, bubbles: true });
        await input.dispatchEvent("keyup", { key: "Enter", code: "Enter", keyCode: 229, which: 229, isComposing: true, bubbles: true });
        await input.dispatchEvent("compositionend", { data: "合成" });
        await current(f.page, "narrative"); assert.equal(f.counts().submitAttempts, 0);
        await progress(f.page, 5, 6, 4); await noOverflow(f.page, `${name}-textarea`);
      });
      await check(`${name}: last optional skip opens review; only explicit submit sends the request`, async () => {
        await f.page.getByTestId("survey-next").click(); await current(f.page, "last");
        await f.page.getByTestId("survey-next").focus(); await f.page.keyboard.press("Enter");
        await stage(f.page, "review"); await focused(f.page.locator("#survey-review-heading"));
        assert.equal(f.counts().submitAttempts, 0); assert.equal(await f.page.getByTestId("survey-submit").isEnabled(), true);
        assert.equal(await f.page.getByTestId("completion-summary").count(), 0); await progress(f.page, 6, 6, 4);
        await expandReview(f.page); assert.equal(await f.page.locator('[data-review-question-id="detail"]').count(), 0);
        assert.equal(await f.page.locator('[data-review-supplement="first_other"]').count(), 0);
        await capture(f.page, `${name}-ready`);
        await f.page.getByTestId("survey-submit").click();
        await f.page.locator('[data-testid="submission-state"][data-state="waiting"]').waitFor();
        assert.equal(f.counts().submitAttempts, 1); assert.equal(f.hasAnswer("optional"), false); assert.equal(f.hasAnswer("last"), false);
      });
    });

    const drawerName = `${locale}-mobile-chapters`;
    await scenario(drawerName, { locale, profile: "mobile", answers: { first: 0, optional: "合成已保存选答" } }, async f => {
      await start(f); await current(f.page, "multi");
      const opener = f.page.getByTestId("survey-chapters-open");
      const openDrawer = async () => { await opener.click(); await f.page.getByRole("dialog").waitFor(); };
      const selectChapter = async (id: string) => { await openDrawer(); await f.page.getByRole("dialog").locator(`[data-section-id="${id}"]`).click(); await f.page.getByRole("dialog").waitFor({ state: "hidden" }); };
      await check(`${drawerName}: Escape restores the opener and Tab cannot focus background controls`, async () => {
        await opener.focus(); await f.page.keyboard.press("Enter"); await f.page.getByRole("dialog").waitFor();
        for (let i = 0; i < 8; i++) {
          await f.page.keyboard.press("Tab");
          // Native dialog permits a Tab stop in browser chrome (activeElement
          // becomes body); application controls behind it must remain inert.
          assert.equal(await f.page.getByRole("dialog").evaluate(element => element.contains(document.activeElement) || document.activeElement === document.body), true, "Chapter dialog must prevent background application focus");
        }
        await noOverflow(f.page, `${drawerName}-open`); await capture(f.page, `${drawerName}-open`);
        await f.page.keyboard.press("Escape"); await f.page.getByRole("dialog").waitFor({ state: "hidden" }); await focused(opener);
      });
      await check(`${drawerName}: chapters target the first unanswered item, or the first when complete`, async () => {
        await selectChapter("learning"); await current(f.page, "first"); await focusInQuestion(f.page, "first");
        await selectChapter("relationship"); await current(f.page, "multi"); await focusInQuestion(f.page, "multi"); await choose(f.page, "multi", 2);
        await selectChapter("relationship"); await current(f.page, "gate"); await focusInQuestion(f.page, "gate"); await choose(f.page, "gate", 0);
        await selectChapter("relationship"); await current(f.page, "multi"); await focusInQuestion(f.page, "multi");
      });
      await check(`${drawerName}: review action focuses the review heading after the drawer closes`, async () => {
        await openDrawer(); await f.page.getByRole("dialog").getByRole("button", { name: locale === "zh-HK" ? "核對作答" : "核对作答", exact: true }).click();
        await f.page.getByRole("dialog").waitFor({ state: "hidden" }); await stage(f.page, "review"); await focused(f.page.locator("#survey-review-heading"));
        assert.equal(f.counts().submitAttempts, 0); await noOverflow(f.page, `${drawerName}-review`);
      });
    });

    const saveName = `${locale}-save-exit`;
    await scenario(saveName, { locale, profile: "mobile" }, async f => {
      await start(f);
      await check(`${saveName}: failed save is truthful and its retry persists the same answer`, async () => {
        f.failNextSave(); await choose(f.page, "first", 0);
        await f.page.locator('.survey-save-status[data-status="failed"]').waitFor();
        assert.equal(await f.page.locator(".survey-save-status").getByText(f.t("savedDraft"), { exact: true }).count(), 0);
        assert.equal(f.counts().patchSuccesses, 0); await capture(f.page, `${saveName}-failed`);
        await f.page.locator(".survey-save-status").getByRole("button").click(); await saved(f.page);
        assert.equal(f.answer("first"), 0); assert.equal(f.counts().patchAttempts, 2); assert.equal(f.counts().patchSuccesses, 1);
      });
      await check(`${saveName}: header return waits for saving and stays on failure`, async () => {
        const release = f.holdNextSave("fail");
        try {
          await choose(f.page, "first", -1); await f.page.getByTestId("survey-back").click();
          await until(() => f.counts().patchAttempts === 3, "Return must flush the unsaved draft");
          assert.equal(await f.page.getByTestId("survey-back").isDisabled(), true);
          assert.ok(f.page.url().endsWith(`#assessment/${assessmentId}`));
          assert.equal(await f.page.getByTestId("survey-next").isDisabled(), true);
        } finally { release(); }
        await f.page.locator('.survey-save-status[data-status="failed"]').waitFor();
        await until(() => f.page.getByTestId("survey-back").isEnabled(), "Failed return must become retryable");
        assert.ok(f.page.url().endsWith(`#assessment/${assessmentId}`));
        await f.page.getByTestId("survey-back").click(); await f.page.waitForURL("**/#assessments");
        assert.equal(f.answer("first"), -1); assert.equal(f.counts().patchSuccesses, 2);
      });
    });

    const conflictName = `${locale}-conflict`;
    await scenario(conflictName, { locale, profile: "mobile" }, async f => {
      await start(f);
      await check(`${conflictName}: 409 locks editing/navigation until latest draft reload`, async () => {
        f.conflictNextSave(); await choose(f.page, "first", 1);
        await f.page.locator(".draft-conflict").waitFor();
        assert.equal(await f.page.locator(".survey-questions").evaluate(element => element.hasAttribute("disabled")), true, "Conflict must disable the question fieldset");
        for (const id of ["survey-next", "survey-previous", "survey-review", "survey-chapters-open"]) assert.equal(await f.page.getByTestId(id).isDisabled(), true, `Conflict must disable ${id}`);
        const attempts = f.counts().patchAttempts;
        await f.page.waitForTimeout(1000); assert.equal(f.counts().patchAttempts, attempts, "Conflicting draft must not retry in the background");
        await capture(f.page, `${conflictName}-locked`);
        await f.page.getByRole("button", { name: f.t("reloadLatestDraft"), exact: true }).click();
        await stage(f.page, "intro"); assert.equal(await f.page.locator(".draft-conflict").count(), 0);
        await start(f); await current(f.page, "optional"); await f.page.getByTestId("survey-previous").click();
        await current(f.page, "first"); assert.equal(await choiceInput(f.page, "first", -1).isChecked(), true);
        assert.equal(f.counts().patchAttempts, attempts); await choose(f.page, "first", 0); await saved(f.page);
        assert.equal(f.answer("first"), 0); assert.equal(f.counts().revision, 15);
      });
    });

    const localeName = `${locale}-locale-remount`;
    await scenario(localeName, { locale, profile: "mobile" }, async f => {
      await check(`${localeName}: changing language preserves saved numeric and supplementary answers`, async () => {
        await start(f); await choose(f.page, "first", 1);
        await f.page.locator('[data-supplement-id="first_other"] textarea').fill("合成跨语言补充"); await saved(f.page);
        const reads = f.counts().detailReads, writes = f.counts().patchAttempts;
        const nextLocale: Locale = locale === "zh-CN" ? "zh-HK" : "zh-CN";
        await f.page.getByTestId("questionnaire-screen").getByRole("button", { name: nextLocale === "zh-HK" ? "繁" : "简", exact: true }).click();
        await until(() => f.counts().detailReads > reads, "Language switch must load localized survey metadata"); await stage(f.page, "intro");
        assert.equal(await f.page.locator('[data-testid="questionnaire-screen"] h1').innerText(), controlledDefinition(nextLocale).scaleTitle);
        await start(f); await current(f.page, "optional"); await f.page.getByTestId("survey-previous").click(); await current(f.page, "first");
        assert.equal(await choiceInput(f.page, "first", 1).isChecked(), true);
        assert.equal(await f.page.locator('[data-supplement-id="first_other"] textarea').inputValue(), "合成跨语言补充");
        assert.equal(f.counts().patchAttempts, writes, "Remounting saved data must not create a new write");
        await noOverflow(f.page, `${localeName}-restored`); await capture(f.page, `${localeName}-restored`);
      });
    });

    const recoveryName = `${locale}-session-recovery`;
    await scenario(recoveryName, { locale, profile: "mobile" }, async f => {
      await check(`${recoveryName}: 401 pauses writes, same-owner demo login restores the retained draft`, async () => {
        await start(f); f.expireNextSave(); await choose(f.page, "first", 1);
        await f.page.locator('[data-supplement-id="first_other"] textarea').fill("合成会话恢复补充");
        await f.page.locator(".draft-recovery-notice").waitFor();
        assert.equal(await f.page.getByTestId("questionnaire-screen").count(), 0);
        assert.equal(f.counts().patchSuccesses, 0);
        const writes = f.counts().patchAttempts;
        await f.page.waitForTimeout(1000); assert.equal(f.counts().patchAttempts, writes, "Expired session must pause background draft writes");
        await capture(f.page, `${recoveryName}-login`, true);
        await f.page.locator(".demo-account").getByText("合成界面使用者", { exact: true }).click();
        await stage(f.page, "intro"); assert.equal(f.counts().loginAttempts, 1);
        assert.equal(await f.page.getByTestId("survey-start").isDisabled(), true, "Restored questionnaire still requires its separate start action");
        await start(f); await current(f.page, "optional"); await f.page.getByTestId("survey-previous").click();
        await current(f.page, "first"); assert.equal(await choiceInput(f.page, "first", 1).isChecked(), true);
        assert.equal(await f.page.locator('[data-supplement-id="first_other"] textarea').inputValue(), "合成会话恢复补充");
        await saved(f.page); assert.equal(f.answer("first"), 1); assert.equal(f.hasAnswer("first_other"), true);
        await review(f.page); await expandReview(f.page);
        assert.equal(await f.page.locator('[data-review-supplement="first_other"] > span').innerText(), "合成会话恢复补充");
        assert.equal(f.counts().submitAttempts, 0); assert.equal(await f.page.getByTestId("survey-submit").isDisabled(), true);
        await noOverflow(f.page, `${recoveryName}-review`); await capture(f.page, `${recoveryName}-restored`);
      });
    });
  }

  for (const locale of ["zh-CN", "zh-HK"] as const) for (const profile of ["narrow", "zoom200Equivalent"] as const) {
    const name = `${locale}-${profile}`;
    await scenario(name, { locale, profile, scale: parentScaleStaffNotes }, async f => {
      await check(`${name}: introduction, real first question and review reflow without horizontal scrolling`, async () => {
        await noOverflow(f.page, `${name}-intro`); await capture(f.page, `${name}-intro`, true);
        await start(f); await firstVisible(f.page, "p_assent", `${name}-first`); await noOverflow(f.page, `${name}-first`); await capture(f.page, `${name}-first`);
        await review(f.page); await noOverflow(f.page, `${name}-review`); await capture(f.page, `${name}-review`);
      });
    });
  }
  await check("All fixtures: no uncaught browser errors or unconfigured API requests", async () => {
    assert.deepEqual(browserErrors, []); assert.deepEqual(fixtureErrors, []);
  });
} finally {
  const failed = checks.filter(check => !check.passed).length;
  const result = {
    passed: failed === 0 && checks.length > 0 && browserErrors.length === 0 && fixtureErrors.length === 0,
    startedAt, finishedAt: new Date().toISOString(), browser: browser.version(), origins, syntheticApiFixtures: true, realBrowser: true, backendIntegration: false,
    limitations: [
      "API writes and saved-draft reloads use context-local synthetic fixtures; this does not verify database, authentication, report generation, AI or production behavior.",
      "200% reflow uses a 720x450 CSS viewport equivalent to halving 1440x900; it does not exercise native browser zoom, pinch zoom or physical devices.",
      "IME coverage dispatches composition/Enter events in the real browser; it does not exercise an operating-system IME candidate window.",
      "Session recovery uses the local demo-login UI and mocked same-owner 401/re-login responses; live identity providers, Firefox, Safari and assistive-technology operation are not exercised.",
      "Real-scale browser parity covers all currently visible review titles and first-question options; every branch and response combination is not exhaustively rendered.",
    ],
    summary: { checks: checks.length, passed: checks.length - failed, failed }, checks, browserErrors, fixtureErrors,
    blockedOffOriginRequests: blockedOrigins.length, blockedOrigins: [...new Set(blockedOrigins)], layoutEvidence,
  };
  await writeFile(path.join(output, "results.json"), JSON.stringify(result, null, 2));
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser.close();
  console.log(JSON.stringify({ ...result.summary, ok: result.passed, output }));
  if (!result.passed) process.exitCode = 1;
}
