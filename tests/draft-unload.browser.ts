import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";

const base = process.env.NOVA_PUBLIC_URL!;
assert.ok(["http://127.0.0.1:3120", "http://127.0.0.1:3121"].includes(base));
assert.equal(process.env.NOVA_AI_ENABLED, "false");
assert.equal(process.env.NOVA_MODE, "demo");
const baseline = process.argv.includes("--baseline");
const out = path.resolve(`work/qa/refresh-draft-20261008/draft-unload-${baseline ? "baseline" : "fixed"}-${process.env.NOVA_REGION}-${Date.now()}`);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const checks: unknown[] = [], errors: string[] = [];
async function context() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  return context;
}
async function call(context: BrowserContext, endpoint: string, data?: unknown, method = data === undefined ? "GET" : "POST") {
  const response = await context.request.fetch(base + endpoint, { method, headers: { Origin: base }, ...(data === undefined ? {} : { data }) });
  assert.ok(response.ok(), `${method} ${endpoint} ${response.status()}`);
  return response.json();
}
const staff = await context();
const initial = await call(staff, "/api/session");
assert.equal(initial.mode, "demo");
await call(staff, "/api/auth/demo", { accountId: initial.demoAccounts.find((account: { role: string }) => account.role === "admin").id });
async function fixture() {
  const family = await call(staff, "/api/families", { familyName: "合成草稿离页家庭", childName: "合成孩子", birthDate: `${new Date().getUTCFullYear() - 7}-01-01`, grade: "小学二年级", guardianLabel: "合成家长" });
  await call(staff, `/api/families/${family.id}/consent`, { accepted: true, guardianName: "合成家长", reference: "local-synthetic-fixture" });
  const invitation = await call(staff, `/api/families/${family.id}/invites`, { role: "parent" });
  const contextForParent = await context();
  const token = new URLSearchParams(new URL(invitation.url).hash.slice(1)).get("token");
  const username = "unload-" + randomUUID(), password = randomUUID() + "aA9";
  await call(contextForParent, "/api/invite", { token, name: "合成草稿家长", username, password });
  const user = (await call(contextForParent, "/api/session")).user;
  const assessment = await call(staff, "/api/assessments", { familyId: family.id, respondentId: user.id, scaleVersionId: "nova-family-demo@1.0.0", locale: "zh-CN" });
  const page = await contextForParent.newPage();
  page.on("pageerror", error => errors.push(error.name));
  await page.goto(base + "/#assessment/" + assessment.id);
  await page.locator(".survey-assent-panel input").check();
  return { page, context: contextForParent, id: assessment.id, familyId: family.id, respondentId: user.id, pattern: `**/api/assessments/${assessment.id}?*`, login: () => call(contextForParent, "/api/auth/login", { username, password }) };
}
async function choose(page: Page) {
  await page.locator(".survey-questions label").filter({ has: page.locator("input[type=radio]") }).first().click();
}
const saveButton = (page: Page) => page.getByRole("button", { name: /保存草稿|儲存草稿/, exact: true });
const logoutButton = (page: Page) => page.locator(".sidebar").getByRole("button", { name: /退出登录|登出/, exact: true });
async function reopen(page: Page) {
  await page.locator(".assessment-list").getByRole("button", { name: /开始作答|開始作答/ }).click();
  await page.locator(".survey-assent-panel input").waitFor();
}
async function guardActive(page: Page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}
async function cancelUnload(page: Page, operation: "reload" | "close") {
  const originalUrl = page.url();
  const dialogPromise = page.waitForEvent("dialog");
  let dismissed = false;
  const navigation = (operation === "reload" ? page.reload({ waitUntil: "commit", timeout: 2000 }) : page.close({ runBeforeUnload: true })).catch(error => {
    if (!dismissed || operation !== "reload" || !(String(error).includes("ERR_ABORTED") || error.name === "TimeoutError")) throw error;
  });
  const dialog = await dialogPromise;
  assert.equal(dialog.type(), "beforeunload");
  dismissed = true;
  await dialog.dismiss();
  await navigation;
  assert.equal(page.isClosed(), false);
  assert.equal(page.url(), originalUrl);
}

try {
  {
    const fixtureValue = await fixture(), { page, id, pattern } = fixtureValue;
    let patchAttempts = 0;
    await page.route(pattern, async route => {
      if (route.request().method() !== "PATCH") return route.continue();
      patchAttempts++;
      await route.abort("failed");
    });
    await choose(page);
    await saveButton(page).waitFor();
    assert.equal(await guardActive(page), true);
    await page.locator(".back-link").click();
    await page.locator(".assessment-list").waitFor();
    await page.waitForFunction(() => !document.querySelector(".survey-container"));
    assert.deepEqual((await call(fixtureValue.context, `/api/assessments/${id}`)).draftAnswers, {});
    const guardedOnList = await guardActive(page);
    await page.screenshot({ path: path.join(out, "failed-draft-on-list.png") });
    if (baseline) {
      assert.equal(guardedOnList, false);
      await page.unroute(pattern);
      let dialogs = 0;
      page.on("dialog", async dialog => { dialogs++; await dialog.accept(); });
      await page.reload();
      await page.locator(".assessment-list").waitFor();
      await reopen(page);
      assert.equal(await page.locator(".survey-questions input[type=radio]:checked").count(), 0);
      assert.deepEqual((await call(fixtureValue.context, `/api/assessments/${id}`)).draftAnswers, {});
      assert.equal(dialogs, 0);
      checks.push({ case: "baseline-failed-draft-list-reload", guardedInQuestionnaire: true, guardedOnList, dialogs, answerLost: true, patchAttempts });
    } else {
      assert.equal(guardedOnList, true);
      await page.unroute(pattern);
      await cancelUnload(page, "reload");
      await cancelUnload(page, "close");
      await reopen(page);
      await page.locator(".survey-assent-panel input").check();
      const saved = await call(fixtureValue.context, `/api/assessments/${id}`);
      assert.equal(saved.draftAnswers.q1, 0);
      assert.equal(saved.draftRevision, 1);
      assert.equal(await guardActive(page), false);
      await page.locator(".back-link").click();
      assert.equal(await guardActive(page), false);
      let dialogsAfterSave = 0;
      page.on("dialog", async dialog => { dialogsAfterSave++; await dialog.accept(); });
      await page.reload();
      await page.locator(".assessment-list").waitFor();
      assert.equal(dialogsAfterSave, 0);
      assert.equal((await call(fixtureValue.context, `/api/assessments/${id}`)).draftAnswers.q1, 0);
      checks.push({ case: "failed-draft-list-reload-and-close", guardedOnList, cancelledReloadAndClose: true, savedAfterReentry: true, dialogsAfterSave, patchAttempts });
    }
    await fixtureValue.context.close();
  }
  if (!baseline) {
    {
      const fixtureValue = await fixture(), { page, id, pattern } = fixtureValue;
      const example = await call(staff, "/api/scales/example");
      const extraScale = await call(staff, "/api/scales", { definition: { ...example, id: "draft-unload-" + randomUUID(), title: { "zh-CN": "合成第二份演示问卷", "zh-HK": "合成第二份示範問卷" } } });
      const second = await call(staff, "/api/assessments", { familyId: fixtureValue.familyId, respondentId: fixtureValue.respondentId, scaleVersionId: extraScale.id, locale: "zh-CN" });
      await page.route(pattern, route => route.request().method() === "PATCH" ? route.abort("failed") : route.continue());
      await choose(page);
      await saveButton(page).waitFor();
      await page.locator(".back-link").click();
      await page.locator(".refresh-button").click();
      await page.locator(".assessment-row").filter({ hasText: "合成第二份" }).getByRole("button").click();
      await page.locator(".survey-assent-panel input").waitFor();
      assert.deepEqual((await call(fixtureValue.context, `/api/assessments/${second.id}`)).draftAnswers, {});
      assert.equal(await guardActive(page), true);
      await cancelUnload(page, "reload");
      await page.locator(".back-link").click();
      await page.unroute(pattern);
      await page.locator(".assessment-row").filter({ hasText: /家庭沟通与日常感受|家庭溝通與日常感受/ }).getByRole("button").click();
      await page.locator(".survey-assent-panel input").waitFor();
      assert.equal((await call(fixtureValue.context, `/api/assessments/${id}`)).draftAnswers.q1, 0);
      assert.equal(await guardActive(page), false);
      checks.push({ case: "dirty-cached-draft-protects-clean-active-questionnaire", cancelledReload: true, clearWhenAllSaved: true });
      await fixtureValue.context.close();
    }
    {
      const fixtureValue = await fixture(), { page, id } = fixtureValue;
      await call(fixtureValue.context, `/api/assessments/${id}`, { answers: { q1: 2 }, acknowledged: true, revision: 0 }, "PATCH");
      await choose(page);
      await page.locator(".draft-conflict").waitFor();
      await page.locator(".back-link").click();
      await page.locator(".assessment-list").waitFor();
      assert.equal(await guardActive(page), true);
      await cancelUnload(page, "reload");
      await reopen(page);
      await page.locator(".draft-conflict").waitFor();
      await page.getByRole("button", { name: /重新载入最新草稿|重新載入最新草稿/ }).click();
      await page.locator(".draft-conflict").waitFor({ state: "detached" });
      await page.locator(".survey-assent-panel input").waitFor();
      assert.equal(await guardActive(page), false);
      assert.equal((await call(fixtureValue.context, `/api/assessments/${id}`)).draftAnswers.q1, 2);
      await logoutButton(page).click();
      await page.getByRole("heading", { name: /登录工作空间|登入工作空間/ }).waitFor();
      assert.equal(await guardActive(page), false);
      checks.push({ case: "conflict-retained-on-list-until-explicit-reload", cancelledReload: true, clearAfterDiscard: true, clearAfterLogout: true });
      await fixtureValue.context.close();
    }
    {
      const fixtureValue = await fixture(), { page, id, pattern } = fixtureValue;
      await page.route(pattern, route => route.request().method() === "PATCH" ? route.abort("failed") : route.continue());
      await choose(page);
      await saveButton(page).waitFor();
      await page.locator(".back-link").click();
      await page.locator(".assessment-list").waitFor();
      await logoutButton(page).click();
      await page.getByText(/已保留登录状态|已保留登入狀態/).waitFor();
      assert.ok((await call(fixtureValue.context, "/api/session")).user);
      assert.equal(await guardActive(page), true);
      await page.unroute(pattern);
      await page.locator(".survey-assent-panel input").check();
      await saveButton(page).click();
      await page.locator(".survey-save-status").getByText(/草稿已保存|草稿已儲存/).waitFor();
      assert.equal(await guardActive(page), false);
      await logoutButton(page).click();
      await page.getByRole("heading", { name: /登录工作空间|登入工作空間/ }).waitFor();
      assert.equal(await guardActive(page), false);
      await fixtureValue.login();
      assert.equal((await call(fixtureValue.context, `/api/assessments/${id}`)).draftAnswers.q1, 0);
      checks.push({ case: "failed-logout-stays-guarded-then-manual-save-clears", retainedLogin: true, clearAfterRetry: true, clearAfterLogout: true });
      await fixtureValue.context.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, baseline, checks, evidence: out }));
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
  console.error(JSON.stringify({ passed: false, baseline, checks, errors, evidence: out }));
  process.exitCode = 1;
} finally {
  await writeFile(path.join(out, "results.json"), JSON.stringify({ passed: !errors.length, baseline, checks, errors }, null, 2));
  await browser.close();
}
