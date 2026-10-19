import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
import { Model } from "survey-core";
import { parentScale } from "../src/domain/triad-scales";
import { answerVisible } from "../src/domain/scoring";
import type { StoredAnswer } from "../src/domain/types";
import type { SurveyRecord } from "../src/components/api";

const phase = process.env.NOVA_PRESENTATION_PHASE ?? "fixed";
const base = process.env.NOVA_PRESENTATION_BASE_URL ?? "http://127.0.0.1:3228";
const run = process.env.NOVA_PRESENTATION_RUN ?? "first";
assert.ok(["baseline", "fixed"].includes(phase));
assert.ok(["http://127.0.0.1:3228", "http://127.0.0.1:3229", "http://127.0.0.1:3238", "http://127.0.0.1:3239"].includes(base));
assert.match(run, /^[a-z0-9-]+$/);
const hk = base.endsWith("3229") || base.endsWith("3239"), locale = hk ? "zh-HK" : "zh-CN";
const mobile = process.env.NOVA_PRESENTATION_MOBILE === "true";
const output = `work/questionnaire-presentation-c-20261015/browser/${phase}-${locale}-${mobile ? "mobile" : "desktop"}-${run}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const contexts: BrowserContext[] = [];
const checks: { name: string; passed: boolean; detail?: string }[] = [];
const errors: string[] = [];
const fixtures: { familyId: string; assessmentId: string }[] = [];

async function check(name: string, action: () => Promise<void>) {
  try { await action(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, passed: false, detail: String(error) }); throw error; }
}

async function until(test: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await test()) return;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  assert.fail(message);
}

function answersBefore(targetId: string): Record<string, StoredAnswer> {
  const answers: Record<string, StoredAnswer> = {};
  for (const item of parentScale.items) {
    if (item.id === targetId) break;
    if (!answerVisible(answers, item)) continue;
    answers[item.id] = item.kind === "text" ? "SYNTHETIC_STAGE_C_NOTE" : item.kind === "multi"
      ? [item.id === "q22" ? 7 : item.choices[0].value]
      : item.gate ?? (item.id === "p_age" ? 12 : item.choices.find(choice => !item.excludeValues?.includes(choice.value))!.value);
  }
  return answers;
}

async function fixture(targetId: string) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 1000 }, isMobile: mobile, hasTouch: mobile });
  contexts.push(context);
  context.setDefaultTimeout(15000);
  await context.addInitScript(value => localStorage.setItem("nova-locale", value), locale);
  await context.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const api = async (path: string, method = "GET", data?: unknown) => context.request.fetch(base + path, { method, headers: { Origin: base }, ...(data === undefined ? {} : { data }) });
  const session = await (await api("/api/session")).json();
  assert.equal(session.mode, "demo"); assert.equal(session.region, hk ? "HK" : "CN");
  const register = await api("/api/triad/parent", "POST", { parentName: "合成展示家长", childName: "合成展示孩子", username: `presentation_${randomBytes(8).toString("hex")}`, password: randomBytes(24).toString("base64url"), relationship: "母亲", birthDate: `${new Date().getUTCFullYear() - 12}-01-01`, grade: "初中", assessment: true, sensitiveData: true, parentReport: true });
  assert.equal(register.status(), 201);
  const created = await register.json();
  const workspace = await (await api("/api/workspace")).json();
  const task = workspace.assessments.find((a: { familyId: string; respondentRole: string }) => a.familyId === created.familyId && a.respondentRole === "parent");
  assert.ok(task);
  const path = `/api/assessments/${task.id}`;
  const initial = await (await api(path)).json();
  const answers = answersBefore(targetId);
  const saved = await api(path, "PATCH", { acknowledged: true, revision: initial.draftRevision, answers });
  assert.equal(saved.status(), 200);
  fixtures.push({ familyId: created.familyId, assessmentId: task.id });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  const record = async (): Promise<SurveyRecord> => (await api(`${path}?locale=${locale}`)).json();
  const open = async (acknowledge = true) => {
    await page.goto(`${base}/#assessment/${task.id}`);
    await page.locator(".survey-assent-panel input[type=checkbox]").waitFor();
    if (acknowledge) await page.locator(".survey-assent-panel input[type=checkbox]").check();
    await until(async () => await currentQuestion(page) === targetId, `Saved draft must resume at ${targetId}`);
  };
  return { context, page, api, record, open, answers, path };
}

async function currentQuestion(page: Page): Promise<string | null> {
  return page.locator(".survey-questions [data-name]:visible").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-name")).find(Boolean) ?? null);
}

async function choose(page: Page, id: string, value: number, type = "radio") {
  const input = page.locator(`.survey-questions [data-name="${id}"] input[type="${type}"][value="${value}"]`);
  await input.locator("xpath=ancestor::label[1]").click();
  assert.equal(await input.isChecked(), true);
}

async function waitBeyondAdvance() { await new Promise(resolve => setTimeout(resolve, 5300)); }

try {
  const f = await fixture("q14_1");
  await check("dashboard wording is rendered in the selected language", async () => {
    await f.page.goto(base + "/#dashboard");
    const title = phase === "baseline" ? hk ? "接下來，做一點小事" : "接下来，做一点小事" : hk ? "接下來，往前一小步" : "接下来，往前一小步";
    await f.page.getByRole("heading", { name: title, exact: true }).waitFor();
    await f.page.screenshot({ path: `${output}/dashboard.png`, fullPage: true });
  });
  await check("question wording, choices, required flags and limits remain unchanged", async () => {
    const record = await f.record(), model = new Model(record.surveyJson);
    const mainItems = parentScale.items.filter(item => !item.supplementFor);
    assert.equal(model.getAllQuestions().length, mainItems.length);
    for (const item of mainItems) {
      const question = model.getQuestionByName(item.id);
      assert.equal(question.title, item.label[locale], item.id);
      assert.equal(question.isRequired, item.required, item.id);
      const json = question.toJSON();
      if (item.kind !== "text") {
        assert.deepEqual(json.choices, item.choices.map(choice => ({ value: choice.value, text: choice.label[locale] })), item.id);
        if (item.maxChoices) assert.equal(json.maxSelectedChoices, item.maxChoices, item.id);
      }
    }
    if (phase === "baseline") {
      assert.equal(model.getQuestionByName("q20_1").description, "");
      assert.equal(model.getQuestionByName("q22").description, "");
    } else {
      assert.match(model.getQuestionByName("q20_1").description, /孩子.*四周/);
      assert.match(model.getQuestionByName("q24_1").description, /您自己/);
      assert.match(model.getQuestionByName("q30").title, hk ? /過去兩週/ : /过去两周/);
      assert.match(model.getQuestionByName("p_focus").description, /3/);
    }
    model.dispose();
  });
  await f.open(false);
  if (phase === "baseline") {
    await check("baseline lacks the notice summary and controlled negative emphasis", async () => {
      assert.equal(await f.page.getByTestId("survey-notice-summary").count(), 0);
      assert.equal(await f.page.locator('.survey-questions [data-name="q14_1"] strong').count(), 0);
      await f.page.locator(".survey-assent-panel input[type=checkbox]").check();
      await choose(f.page, "q14_1", 3);
      await f.page.locator(".survey-assent-panel .assent-link").click();
      await f.page.getByRole("dialog").waitFor();
      await waitBeyondAdvance();
      assert.equal(await currentQuestion(f.page), "q14_2", "Baseline timer advances behind the privacy dialog");
      await f.page.screenshot({ path: `${output}/privacy-timer-baseline.png`, fullPage: true });
    });
  } else {
    const checkbox = f.page.locator(".survey-assent-panel input[type=checkbox]");
    const fullNotice = f.page.getByTestId("survey-notice-open");
    await check("notice summary and explicit confirmation have no reading timer or automatic agreement", async () => {
      await f.page.getByTestId("survey-notice-summary").waitFor();
      assert.equal(await checkbox.isChecked(), false);
      assert.equal(await checkbox.isEnabled(), true, "No mandatory opened/read-time gate");
      assert.equal(await checkbox.locator("xpath=ancestor::label[1]").locator("button").count(), 0);
      await fullNotice.focus(); await fullNotice.press("Enter");
      const dialog = f.page.getByRole("dialog");
      await dialog.waitFor();
      await dialog.getByText(/nova-privacy-/).waitFor();
      assert.equal(await checkbox.isChecked(), false);
      await f.page.keyboard.press("Escape");
      await until(async () => await dialog.count() === 0, "Escape must dismiss privacy");
      assert.equal(await fullNotice.evaluate(element => element === document.activeElement), true);
      assert.equal(await checkbox.isChecked(), false);
      await checkbox.check();
      assert.equal(await checkbox.isChecked(), true);
      await f.page.getByTestId("survey-notice-summary").screenshot({ path: `${output}/notice-summary.png` });
    });
    await check("only the complete negative phrase is emphasized and the plain title is unchanged", async () => {
      const question = f.page.locator('.survey-questions [data-name="q14_1"]');
      const strong = question.locator("strong");
      assert.equal(await strong.count(), 1);
      assert.equal(await strong.innerText(), hk ? "不需要反覆催促" : "不需要反复催促");
      assert.ok((await question.innerText()).includes(parentScale.items.find(item => item.id === "q14_1")!.label[locale]));
      await question.screenshot({ path: `${output}/negative-emphasis.png` });
    });
    await check("questionnaire notice pauses navigation while saving the current answer", async () => {
      await choose(f.page, "q14_1", 3);
      await f.page.locator(".survey-advance-track").waitFor();
      await fullNotice.click();
      await f.page.getByRole("dialog").waitFor();
      await waitBeyondAdvance();
      assert.equal(await currentQuestion(f.page), "q14_1");
      assert.equal(await f.page.locator(".survey-advance-track").count(), 0);
      await until(async () => (await f.record()).draftAnswers.q14_1 === 3, "Notice must not stop authorized autosaving");
      await f.page.getByRole("dialog").getByRole("button", { name: hk ? "關閉" : "关闭", exact: true }).click();
      await until(async () => await f.page.getByRole("dialog").count() === 0, "Close button must dismiss privacy");
      assert.equal(await fullNotice.evaluate(element => element === document.activeElement), true);
      await waitBeyondAdvance();
      assert.equal(await currentQuestion(f.page), "q14_1", "Closing must not resume the old timer");
      assert.equal(await checkbox.isChecked(), true);
    });
    await check("footer privacy entry also cancels navigation and restores keyboard focus", async () => {
      await choose(f.page, "q14_1", 4);
      const footer = f.page.locator(".workspace-footer button");
      await footer.focus(); await footer.press("Enter");
      await f.page.getByRole("dialog").waitFor();
      await waitBeyondAdvance();
      assert.equal(await currentQuestion(f.page), "q14_1");
      await f.page.keyboard.press("Escape");
      await until(async () => await f.page.getByRole("dialog").count() === 0, "Footer dialog must dismiss");
      assert.equal(await footer.evaluate(element => element === document.activeElement), true);
      assert.equal(await checkbox.isChecked(), true);
    });
    await check("privacy loading failure and retry keep agreement and navigation stable", async () => {
      let unavailable = true;
      await f.context.route("**/api/privacy*", route => unavailable ? route.fulfill({ status: 503, json: { error: "Synthetic notice loading failure", code: "SYNTHETIC_NOTICE_FAILURE" } }) : route.fallback());
      await choose(f.page, "q14_1", 2);
      await fullNotice.click();
      const dialog = f.page.getByRole("dialog");
      await dialog.getByRole("alert").waitFor();
      await waitBeyondAdvance();
      assert.equal(await currentQuestion(f.page), "q14_1");
      unavailable = false;
      await dialog.getByRole("button", { name: hk ? "重新載入" : "重新载入", exact: true }).click();
      await dialog.getByText(/nova-privacy-/).waitFor();
      assert.equal(await checkbox.isChecked(), true);
      await f.page.keyboard.press("Escape");
      await until(async () => await dialog.count() === 0, "Retried notice must close");
      assert.equal(await fullNotice.evaluate(element => element === document.activeElement), true);
    });
    await check("a new answer after closing can still advance normally", async () => {
      await choose(f.page, "q14_1", 5);
      await until(async () => await currentQuestion(f.page) === "q14_2", "A fresh choice must retain ordinary auto-advance");
      await until(async () => (await f.record()).draftAnswers.q14_1 === 5, "Final choice must persist");
    });
    await check("four-week child questions carry an explicit subject cue", async () => {
      const s = await fixture("q20_1"); await s.open();
      const question = s.page.locator('.survey-questions [data-name="q20_1"]');
      await question.getByText(hk ? "以下請回答孩子過去四周的情況。" : "以下请回答孩子过去四周的情况。", { exact: true }).waitFor();
      assert.ok((await question.innerText()).includes(parentScale.items.find(item => item.id === "q20_1")!.label[locale]));
      await question.screenshot({ path: `${output}/child-subject.png` });
    });
    await check("parent subject guidance preserves the explicit two-week question window", async () => {
      const p = await fixture("q30"); await p.open();
      const question = p.page.locator('.survey-questions [data-name="q30"]');
      await question.getByText(hk ? "以下請回答您自己的情況。" : "以下请回答您自己的情况。", { exact: true }).waitFor();
      assert.match(await question.innerText(), hk ? /過去兩週/ : /过去两周/);
      await question.screenshot({ path: `${output}/parent-subject.png` });
    });
    await check("multi-select guidance states and enforces the existing three-choice limit", async () => {
      const m = await fixture("p_focus"); await m.open();
      const question = m.page.locator('.survey-questions [data-name="p_focus"]');
      assert.match(await question.innerText(), hk ? /可多選.*3/ : /可多选.*3/);
      for (const value of [1, 2, 3]) await choose(m.page, "p_focus", value, "checkbox");
      assert.equal(await question.locator('input[type=checkbox]:checked').count(), 3);
      assert.equal(await question.locator('input[type=checkbox][value="4"]').isDisabled(), true);
      await waitBeyondAdvance();
      assert.equal(await currentQuestion(m.page), "p_focus");
      await question.screenshot({ path: `${output}/multi-select-limit.png` });
    });
    await check("language switching and refresh retain answers with localized emphasis", async () => {
      await f.page.getByRole("button", { name: hk ? "简" : "繁", exact: true }).click();
      await f.page.locator(".survey-assent-panel input[type=checkbox]").check();
      await f.page.locator(".sd-navigation__prev-btn").click();
      await until(async () => await currentQuestion(f.page) === "q14_1", "Previous question must return to the saved choice");
      assert.equal(await f.page.locator('.survey-questions [data-name="q14_1"] strong').innerText(), hk ? "不需要反复催促" : "不需要反覆催促");
      assert.equal(await f.page.locator('.survey-questions [data-name="q14_1"] input[value="5"]').isChecked(), true);
      await f.page.reload();
      await f.page.locator(".survey-assent-panel input[type=checkbox]").check();
      await until(async () => await currentQuestion(f.page) === "q14_2", "Refresh must resume at the first unanswered question");
      assert.equal((await f.record()).draftAnswers.q14_1, 5);
    });
  }
  assert.deepEqual(errors, [], "No uncaught browser errors");
} catch (error) {
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : "Presentation browser verification failed");
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify({ phase, locale, mobile, checks, errors, fixtures, passed: !process.exitCode, evidence: "real loopback APIs and PostgreSQL; synthetic inputs; only the labelled privacy-loading-failure case injects a 503 response" }, null, 2));
  for (const context of contexts) await context.close();
  await browser.close();
}
