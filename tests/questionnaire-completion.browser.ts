import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
import { parentScale } from "../src/domain/triad-scales";
import { answerVisible } from "../src/domain/scoring";
import type { StoredAnswer } from "../src/domain/types";

const phase = process.env.NOVA_COMPLETION_PHASE ?? "fixed";
assert.ok(["baseline", "fixed"].includes(phase));
const base = process.env.NOVA_COMPLETION_BASE_URL ?? "http://127.0.0.1:3218";
assert.ok(["http://127.0.0.1:3218", "http://127.0.0.1:3219", "http://127.0.0.1:3228", "http://127.0.0.1:3229", "http://127.0.0.1:3238", "http://127.0.0.1:3239"].includes(base));
const mobile = process.env.NOVA_COMPLETION_MOBILE === "true";
const locale = base.endsWith("3219") || base.endsWith("3229") || base.endsWith("3239") ? "zh-HK" : "zh-CN";
const run = process.env.NOVA_COMPLETION_RUN ?? "";
assert.ok(/^[a-z0-9-]*$/.test(run));
const output = `work/questionnaire-completion-ab-20261015/browser/${phase}-${locale}-${mobile ? "mobile" : "desktop"}${run ? `-${run}` : ""}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const checks: { name: string; passed: boolean; detail?: string }[] = [];
const errors: string[] = [];
const contexts: BrowserContext[] = [];
const fixtures: { familyId: string; assessmentId: string }[] = [];
const sentinel = "SYNTHETIC_PRIVATE_COMPLETION_TEXT";

function completeAnswers(): Record<string, StoredAnswer> {
  const answers: Record<string, StoredAnswer> = {};
  for (const item of parentScale.items) {
    if (!answerVisible(answers, item)) continue;
    answers[item.id] = item.kind === "text" ? sentinel : item.kind === "multi"
      ? [item.id === "q22" ? 7 : item.choices[0].value]
      : item.gate ?? (item.id === "p_age" ? 12 : item.choices.find(choice => !item.excludeValues?.includes(choice.value))!.value);
  }
  return answers;
}

async function check(name: string, action: () => Promise<void>) {
  try { await action(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, passed: false, detail: String(error) }); throw error; }
}

async function until(predicate: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.fail(message);
}

async function fixture(answers: Record<string, StoredAnswer>) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 1000 }, isMobile: mobile, hasTouch: mobile });
  contexts.push(context);
  context.setDefaultTimeout(15000);
  await context.addInitScript(value => localStorage.setItem("nova-locale", value), locale);
  await context.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const api = async (path: string, method = "GET", data?: unknown) => {
    assert.ok(path.startsWith("/api/"));
    return context.request.fetch(base + path, { method, headers: { Origin: base }, ...(data === undefined ? {} : { data }) });
  };
  const initial = await (await api("/api/session")).json();
  assert.equal(initial.mode, "demo");
  const registered = await api("/api/triad/parent", "POST", {
    parentName: "合成核查家长", username: `completion_${randomBytes(8).toString("hex")}`, password: randomBytes(24).toString("base64url"),
    relationship: "母亲", childName: "合成核查孩子", birthDate: `${new Date().getUTCFullYear() - 12}-01-01`, grade: "初中", assessment: true, sensitiveData: true, parentReport: true,
  });
  assert.equal(registered.status(), 201, "Synthetic parent registration must succeed on the isolated local server");
  const created = await registered.json();
  const workspace = await (await api("/api/workspace")).json();
  const assessment = workspace.assessments.find((a: { familyId: string; respondentRole: string }) => a.familyId === created.familyId && a.respondentRole === "parent");
  assert.ok(assessment);
  const path = `/api/assessments/${assessment.id}`;
  const initialRecord = await (await api(path)).json();
  const saved = await api(path, "PATCH", { answers, acknowledged: true, revision: initialRecord.draftRevision });
  assert.equal(saved.status(), 200);
  const { revision } = await saved.json();
  fixtures.push({ familyId: created.familyId, assessmentId: assessment.id });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  const open = async () => {
    await page.goto(`${base}/#assessment/${assessment.id}`);
    await page.locator(".survey-assent-panel input[type=checkbox]").check();
    await page.locator(".nova-nav-submit").waitFor({ state: "visible" });
  };
  const record = async () => (await api(path)).json();
  return { context, page, api, path, revision, open, record };
}

async function currentQuestion(page: Page): Promise<string | null> {
  return page.locator(".survey-questions [data-name]:visible").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-name")).find(Boolean) ?? null);
}

async function assertFocus(page: Page, id: string) {
  await until(() => page.evaluate(target => {
    const active = document.activeElement;
    return !!active && (active.closest("[data-name]")?.getAttribute("data-name") === target || active.getAttribute("name") === target);
  }, id), `Keyboard focus must move into ${id}`);
}

async function choose(page: Page, id: string, value: number) {
  const input = page.locator(`.survey-questions [data-name="${id}"] input[type=radio][value="${value}"]`);
  await input.locator("xpath=ancestor::label[1]").click();
  assert.equal(await input.isChecked(), true, "Clicking the visible choice label must select its radio control");
}

try {
  const answers = { ...completeAnswers(), q14_1: -1, q14_2: -1 };
  const f = await fixture(answers);
  await check("real API distinguishes complete answers with insufficient coverage without leaking text", async () => {
    const response = await f.api(`${f.path}/submit`, "POST", { answers, acknowledged: true, revision: f.revision });
    assert.equal(response.status(), 422);
    const result = await response.json();
    assert.equal(result.code, "INCOMPLETE_TRIAD");
    assert.ok(!JSON.stringify(result).includes(sentinel));
    if (phase === "baseline") assert.equal(result.completionIssues, undefined);
    else {
      assert.ok(!result.completionIssues.some((issue: { kind: string }) => issue.kind === "required_missing"));
      const coverage = result.completionIssues.find((issue: { dimensionKey: string }) => issue.dimensionKey === "q14");
      assert.deepEqual({ answered: coverage.answered, required: coverage.required, total: coverage.total }, { answered: 4, required: 5, total: 6 });
      assert.deepEqual(coverage.excludedItemIds, ["q14_1", "q14_2"]);
    }
    assert.deepEqual((await f.record()).draftAnswers, answers);
  });
  await f.open();
  await f.page.locator(".nova-nav-submit").click();
  if (phase === "baseline") {
    await check("baseline reproduces generic non-actionable submission error", async () => {
      await f.page.locator(".survey-submit-panel .error-notice").waitFor();
      const text = await f.page.locator(".survey-submit-panel").innerText();
      assert.match(text, /有效回答不足/);
      assert.equal(await f.page.getByTestId("completion-summary").count(), 0);
      await f.page.screenshot({ path: `${output}/generic-error.png`, fullPage: true });
    });
  } else {
    const summary = f.page.getByTestId("completion-summary");
    await check("filled but insufficient answers get an actionable coverage explanation", async () => {
      await summary.waitFor();
      assert.equal(await summary.locator('[data-completion-kind="required_missing"]').count(), 0);
      assert.equal(await summary.locator('[data-completion-kind="insufficient_coverage"]').count(), 1);
      assert.match(await summary.innerText(), /4\s*\/\s*6|4.*6/);
      assert.match(await summary.innerText(), /保持.*真實|保持.*真实/);
      await f.page.screenshot({ path: `${output}/coverage-summary.png`, fullPage: true });
    });
    await check("coverage links focus the actual question without changing NA answers", async () => {
      await summary.locator('[data-question-id="q14_1"]').first().click();
      await until(async () => await currentQuestion(f.page) === "q14_1", "Coverage link must open q14_1");
      await assertFocus(f.page, "q14_1");
      assert.equal(await f.page.locator('.survey-questions [data-name="q14_1"] input[value="-1"]').isChecked(), true);
      assert.deepEqual((await f.record()).draftAnswers, answers);
      await f.page.screenshot({ path: `${output}/coverage-question-focus.png`, fullPage: true });
    });
    await check("language remount keeps coverage feedback and genuine excluded answers", async () => {
      await f.page.getByRole("button", { name: locale === "zh-CN" ? "繁" : "简", exact: true }).click();
      // Wait for the new locale's runner, not the old runner's checked checkbox.
      await f.page.getByRole("heading", { name: locale === "zh-CN" ? "作答前，請了解" : "作答前，请了解", exact: true }).waitFor();
      await f.page.locator(".survey-assent-panel input[type=checkbox]").check();
      await summary.waitFor();
      assert.equal(await summary.locator('[data-completion-kind="insufficient_coverage"]').count(), 1);
      await summary.locator('[data-question-id="q14_1"]').first().click();
      await assertFocus(f.page, "q14_1");
      assert.equal(await f.page.locator('.survey-questions [data-name="q14_1"] input[value="-1"]').isChecked(), true);
    });
    await check("reviewing other questions and refreshing preserves saved NA values", async () => {
      await summary.locator('[data-question-id="q14_2"]').first().click();
      await assertFocus(f.page, "q14_2");
      await f.page.reload();
      await f.page.locator(".survey-assent-panel input[type=checkbox]").check();
      await f.page.locator(".nova-nav-submit").click();
      await summary.waitFor();
      assert.deepEqual((await f.record()).draftAnswers, answers);
    });

    const mixed: Record<string, StoredAnswer> = { ...completeAnswers(), q14_2: -1, q14_3: -1, q24_1: -1, q24_2: -1, q24_3: -1 };
    delete mixed.q14_1; delete mixed.p_worry;
    const m = await fixture(mixed);
    await m.open();
    await m.page.locator(".nova-nav-submit").click();
    const list = m.page.getByTestId("completion-summary");
    await check("one attempt lists all missing items and multiple insufficient groups", async () => {
      await list.waitFor();
      assert.equal(await list.locator('[data-completion-kind="required_missing"]').count(), 2);
      assert.equal(await list.locator('[data-completion-kind="insufficient_coverage"]').count(), 2);
      assert.equal(await list.locator('[data-question-id="q23"]').count(), 0, "Hidden safety follow-up must not be missing");
      await m.page.screenshot({ path: `${output}/mixed-summary.png`, fullPage: true });
    });
    await check("correcting a missing answer updates the list and retains excluded answers", async () => {
      await list.locator('[data-completion-kind="required_missing"] [data-question-id="q14_1"]').click();
      await assertFocus(m.page, "q14_1");
      await choose(m.page, "q14_1", 3);
      await until(async () => await list.locator('[data-completion-kind="required_missing"]').count() === 1, "Resolved required item must disappear");
      await list.locator('[data-question-id="q14_2"]').first().click();
      await assertFocus(m.page, "q14_2");
      await new Promise(resolve => setTimeout(resolve, 5300));
      assert.equal(await currentQuestion(m.page), "q14_2", "Error navigation must cancel auto-advance");
      assert.equal(await m.page.locator('.survey-questions [data-name="q14_2"] input[value="-1"]').isChecked(), true);
      await until(async () => (await m.record()).draftAnswers.q14_1 === 3, "Corrected answer must be autosaved");
      const saved = (await m.record()).draftAnswers;
      assert.equal(saved.q14_2, -1); assert.equal(saved.q14_3, -1);
    });
    await check("text correction removes only its own missing entry", async () => {
      await list.locator('[data-question-id="p_worry"]').first().click();
      await assertFocus(m.page, "p_worry");
      await m.page.locator('.survey-questions [data-name="p_worry"] textarea').fill(sentinel);
      await until(async () => await list.locator('[data-completion-kind="required_missing"]').count() === 0, "Text correction must clear only the missing item");
      assert.equal(await list.locator('[data-completion-kind="insufficient_coverage"]').count(), 2);
    });
    await check("conditional safety follow-up is located by its live visible ordinal", async () => {
      const conditional: Record<string, StoredAnswer> = { ...completeAnswers(), q22: [1] };
      delete conditional.q23;
      const c = await fixture(conditional);
      await c.open();
      await c.page.locator(".nova-nav-submit").click();
      const missing = c.page.getByTestId("completion-summary");
      await missing.waitFor();
      assert.equal(await missing.locator('[data-completion-kind="required_missing"]').count(), 1);
      const link = missing.locator('[data-question-id="q23"]');
      assert.match(await link.innerText(), /66/);
      await link.click();
      await assertFocus(c.page, "q23");
      assert.equal(await currentQuestion(c.page), "q23");
      await c.page.screenshot({ path: `${output}/conditional-question.png`, fullPage: true });
    });
    await check("sufficient coverage submits with remaining genuine NA untouched", async () => {
      const sufficient = { ...completeAnswers(), q14_1: -1 };
      const s = await fixture(sufficient);
      await s.open();
      const accepted = s.page.waitForResponse(response => response.url().includes(`${s.path}/submit`) && response.request().method() === "POST");
      await s.page.locator(".nova-nav-submit").click();
      assert.equal((await accepted).status(), 200);
      await until(async () => (await s.record()).status !== "pending", "Task must submit without changing the remaining NA answer");
    });
    await check("unauthenticated requests receive no completion metadata", async () => {
      const anonymous = await browser.newContext(); contexts.push(anonymous);
      const denied = await anonymous.request.get(base + f.path);
      assert.ok([401, 403].includes(denied.status()));
      const body = await denied.json();
      assert.equal(body.completionRules, undefined); assert.equal(body.completionIssues, undefined);
    });
  }
  assert.deepEqual(errors, [], "No uncaught browser errors");
} catch (error) {
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : "Completion browser verification failed");
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify({ phase, locale, mobile, evidence: "real loopback API and PostgreSQL; synthetic data; no mocked application responses", checks, errors, fixtures, passed: !process.exitCode }, null, 2));
  for (const context of contexts) await context.close();
  await browser.close();
}
