import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { parentScale } from "../src/domain/triad-scales";

const region = process.env.NOVA_REGION;
const base = process.env.NOVA_PUBLIC_URL!;
assert.ok(region === "CN" || region === "HK");
assert.equal(base, region === "CN" ? "http://127.0.0.1:3140" : "http://127.0.0.1:3141");
assert.equal(process.env.NOVA_MODE, "demo");
assert.equal(process.env.NOVA_AI_ENABLED, "false");
const baseline = process.argv.includes("--baseline");
const root = path.resolve("work/qa/draft-fixes-20261008/typing");
const out = path.resolve(process.env.NOVA_DRAFT_TEST_OUTPUT || path.join(root, `${region}-${baseline ? "baseline" : "fixed"}`));
assert.ok(out === root || out.startsWith(root + path.sep));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const checks: unknown[] = [], errors: string[] = [];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function call(context: BrowserContext, endpoint: string, data?: unknown, method = data === undefined ? "GET" : "POST") {
  const response = await context.request.fetch(base + endpoint, { method, headers: { Origin: base }, ...(data === undefined ? {} : { data }) });
  assert.ok(response.ok(), `${method} ${endpoint}: ${response.status()}`);
  return response.json();
}
async function fixture(singleLineLegacyRecord = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const started = await call(context, "/api/triad/parent", {
    parentName: "合成文字草稿家长", username: "text-draft-" + randomUUID(), password: randomUUID() + "aA9",
    relationship: "母亲", childName: "合成文字孩子", birthDate: "2014-01-01", grade: "小学四至六年级", accepted: true,
  });
  const workspace = await call(context, "/api/workspace"), id = workspace.assessments.find((a: { familyId: string }) => a.familyId === started.familyId).id;
  const prefill: Record<string, unknown> = {};
  for (const item of parentScale.items) {
    if (item.id === "p_worry") break;
    prefill[item.id] = item.gate ?? (item.kind === "multi" ? [item.choices[0].value] : item.choices[0].value);
  }
  await call(context, `/api/assessments/${id}`, { answers: prefill, acknowledged: true, revision: 0 }, "PATCH");
  const page = await context.newPage();
  if (singleLineLegacyRecord) await page.route(`**/api/assessments/${id}?*`, async route => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch(), record = await response.json();
    record.surveyJson.textUpdateMode = "onBlur";
    const changeType = (elements: Record<string, unknown>[]) => {
      for (const element of elements) {
        if (element.name === "p_worry") element.type = "text";
        if (Array.isArray(element.elements)) changeType(element.elements);
      }
    };
    for (const surveyPage of record.surveyJson.pages) changeType(surveyPage.elements);
    await route.fulfill({ response, json: record });
  });
  page.on("pageerror", error => errors.push(error.name + ": " + error.message));
  const patches: { at: number; status: number }[] = [];
  page.on("response", response => {
    if (new URL(response.url()).pathname === `/api/assessments/${id}` && response.request().method() === "PATCH") patches.push({ at: Date.now(), status: response.status() });
  });
  await page.goto(base + "/#assessment/" + id);
  await page.locator(".survey-assent-panel input").check();
  const text = page.locator(singleLineLegacyRecord ? ".survey-questions input[type=text]" : ".survey-questions textarea");
  await text.waitFor();
  return { context, page, id, text, patches, record: () => call(context, `/api/assessments/${id}`), pattern: `**/api/assessments/${id}?*` };
}
const guardActive = (page: Page) => page.evaluate(() => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
});
const saved = (page: Page) => page.locator(".survey-save-status span").filter({ hasText: /^草稿已保存$|^草稿已儲存$/ }).waitFor();
async function cancelReload(page: Page) {
  const dialogPromise = page.waitForEvent("dialog");
  let dismissed = false;
  const navigation = page.reload({ waitUntil: "commit", timeout: 2000 }).catch(error => {
    if (!dismissed || !(String(error).includes("ERR_ABORTED") || error.name === "TimeoutError")) throw error;
  });
  const dialog = await dialogPromise;
  assert.equal(dialog.type(), "beforeunload");
  dismissed = true;
  await dialog.dismiss();
  await navigation;
}

try {
  {
    const f = await fixture(), value = "合成文字：保持输入框焦点时也需要保存。";
    await f.text.fill(value);
    if (baseline) {
      await delay(1100);
      assert.equal(await f.text.evaluate(element => document.activeElement === element), true);
      assert.equal(await guardActive(f.page), false);
      assert.equal((await f.record()).draftAnswers.p_worry, undefined);
      assert.equal(f.patches.length, 0);
      await f.page.screenshot({ path: path.join(out, "text-before-reload.png") });
      let dialogs = 0; f.page.on("dialog", async dialog => { dialogs++; await dialog.accept(); });
      await f.page.reload(); await f.page.locator(".survey-assent-panel input").check();
      assert.equal(await f.text.inputValue(), ""); assert.equal(dialogs, 0);
      checks.push({ case: "baseline-unblurred-text-loss", patches: 0, unloadDialogs: dialogs, textLost: true });
    } else {
      await f.page.waitForResponse(response => new URL(response.url()).pathname === `/api/assessments/${f.id}` && response.request().method() === "PATCH");
      await saved(f.page);
      assert.equal(await f.text.evaluate(element => document.activeElement === element), true);
      assert.equal((await f.record()).draftAnswers.p_worry, value);
      assert.equal(await guardActive(f.page), false);
      await f.page.screenshot({ path: path.join(out, "text-saved-with-focus.png") });
      checks.push({ case: "typing-saves-without-blur", focusedAfterSave: true, savedTextMatches: true, unnecessaryUnloadGuard: false });
    }
    await f.context.close();
  }
  if (!baseline) {
    {
      const f = await fixture(true), value = "合成旧版单行文字";
      const persisted = f.page.waitForResponse(response => new URL(response.url()).pathname === `/api/assessments/${f.id}` && response.request().method() === "PATCH");
      await f.text.fill(value); assert.equal(await guardActive(f.page), true); assert.equal((await persisted).status(), 200); await saved(f.page);
      assert.equal(await f.text.evaluate(element => document.activeElement === element), true); assert.equal((await f.record()).draftAnswers.p_worry, value);
      checks.push({ case: "legacy-record-single-line-text", responseFixture: "text question with root onBlur", runtimeModeOverrideWorks: true, savedWhileFocused: true });
      await f.context.close();
    }
    {
      const f = await fixture(), began = Date.now();
      await f.text.fill("合成文字：保存等待期间刷新应先确认。");
      assert.equal(await guardActive(f.page), true);
      const guardedAtMs = Date.now() - began;
      assert.ok(guardedAtMs < 700); assert.equal(f.patches.length, 0);
      await cancelReload(f.page); await saved(f.page);
      assert.equal((await f.record()).draftAnswers.p_worry, await f.text.inputValue());
      checks.push({ case: "reload-before-debounce", guardedAtMs, patchResponsesBeforeReload: 0, reloadCancelled: true, savedAfterCancellation: true });
      await f.context.close();
    }
    {
      const f = await fixture(), value = "合成文字：网络恢复后保留全部输入。";
      await f.page.route(f.pattern, route => route.request().method() === "PATCH" ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "合成临时故障", code: "TEST_SAVE_FAILURE" }) }) : route.continue());
      await f.text.fill(value); const retry = f.page.getByRole("button", { name: /保存草稿|儲存草稿/, exact: true }); await retry.waitFor();
      assert.equal(await f.text.inputValue(), value); assert.equal(await guardActive(f.page), true);
      await f.page.screenshot({ path: path.join(out, "failed-text-retained.png") });
      await f.page.unroute(f.pattern); await retry.click(); await saved(f.page);
      assert.equal((await f.record()).draftAnswers.p_worry, value); assert.equal(await guardActive(f.page), false);
      checks.push({ case: "failed-save-and-retry", failedStatus: 503, inputRetained: true, guardWhileFailed: true, recoveredTextMatches: true });
      await f.context.close();
    }
    {
      const f = await fixture();
      const initialSave = f.page.waitForResponse(response => new URL(response.url()).pathname === `/api/assessments/${f.id}` && response.request().method() === "PATCH");
      await f.text.fill("合成文字：随后删除。"); assert.equal((await initialSave).status(), 200); await saved(f.page);
      const deletion = f.page.waitForResponse(response => new URL(response.url()).pathname === `/api/assessments/${f.id}` && response.request().method() === "PATCH");
      await f.text.fill(""); assert.equal(await guardActive(f.page), true); assert.equal((await deletion).status(), 200); await saved(f.page);
      assert.equal((await f.record()).draftAnswers.p_worry, undefined); assert.equal(await guardActive(f.page), false);
      checks.push({ case: "clear-saved-text", emptyValueSavedAsMissing: true, status: 200, noPermanentDirtyState: true });
      await f.context.close();
    }
    {
      const f = await fixture(), value = "合成文字：返回任务列表时立即保存。", began = Date.now();
      const flushed = f.page.waitForResponse(response => new URL(response.url()).pathname === `/api/assessments/${f.id}` && response.request().method() === "PATCH");
      await f.text.fill(value); await f.page.locator(".back-link").click(); await f.page.locator(".assessment-list").waitFor();
      await f.page.waitForFunction(() => !document.querySelector(".survey-container"));
      assert.equal((await flushed).status(), 200);
      assert.equal((await f.record()).draftAnswers.p_worry, value); assert.equal(f.patches.length, 1);
      const flushedAtMs = f.patches[0].at - began; assert.ok(flushedAtMs < 700);
      checks.push({ case: "navigation-flush", flushedAtMs, savedBeforeDebounce: true, textMatches: true });
      await f.context.close();
    }
    {
      const f = await fixture(), value = "合成文字：简繁切换保持输入。";
      const nextLocale = region === "HK" ? "zh-CN" : "zh-HK";
      const reloaded = f.page.waitForResponse(response => new URL(response.url()).pathname === `/api/assessments/${f.id}` && response.request().method() === "GET" && new URL(response.url()).searchParams.get("locale") === nextLocale);
      await f.text.fill(value); await f.page.getByRole("button", { name: region === "HK" ? "简" : "繁", exact: true }).click();
      assert.equal((await reloaded).status(), 200);
      await f.page.locator(".survey-assent-panel input").waitFor(); await f.page.locator(".survey-assent-panel input").check();
      assert.equal((await f.record()).draftAnswers.p_worry, value);
      await f.page.getByRole("button", { name: /上一题|上一題/, exact: true }).click();
      assert.equal(await f.text.inputValue(), value); assert.equal(await f.page.locator(".draft-conflict").count(), 0);
      checks.push({ case: "locale-remount", savedTextMatches: true, visibleTextMatches: true, conflicts: 0 });
      await f.context.close();
    }
    {
      const f = await fixture(); await f.text.click();
      const events: { type: string; composing: boolean }[] = [];
      await f.page.exposeFunction("recordTextComposition", (event: { type: string; composing: boolean }) => events.push(event));
      await f.text.evaluate(element => {
        for (const type of ["compositionstart", "compositionupdate", "compositionend", "input"]) element.addEventListener(type, event => {
          void (window as unknown as { recordTextComposition: (data: unknown) => Promise<void> }).recordTextComposition({ type: event.type, composing: event instanceof InputEvent && event.isComposing });
        });
      });
      const cdp = await f.context.newCDPSession(f.page), began = Date.now();
      await cdp.send("Input.imeSetComposition", { text: "ni", selectionStart: 2, selectionEnd: 2 });
      assert.equal(await guardActive(f.page), true); const guardedAtMs = Date.now() - began; assert.ok(guardedAtMs < 700);
      await cdp.send("Input.imeSetComposition", { text: "nihao", selectionStart: 5, selectionEnd: 5 });
      await cdp.send("Input.insertText", { text: "你好" });
      assert.equal(await f.text.inputValue(), "你好"); await saved(f.page);
      assert.equal((await f.record()).draftAnswers.p_worry, "你好");
      assert.equal(await f.text.evaluate(element => document.activeElement === element), true);
      assert.ok(events.some(event => event.type === "input" && event.composing)); assert.ok(events.some(event => event.type === "compositionend"));
      checks.push({ case: "chinese-ime-composition", nativeCompositionEvents: true, guardedAtMs, committedTextMatches: true, focusRetained: true });
      await cdp.detach(); await f.context.close();
    }
  }
  assert.deepEqual(errors, []);
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
} finally {
  await writeFile(path.join(out, "results.json"), JSON.stringify({ passed: errors.length === 0, baseline, region, checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: errors.length === 0, baseline, region, checks, errors }));
  await browser.close();
}
