import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "playwright";

// Real Chromium/SurveyJS rendering with synthetic, context-local API state.
// The keyboard obstruction and VisualViewport events are controlled geometry,
// not a native phone keyboard or evidence of iOS/Safari behavior.
const base = process.env.NOVA_KEYBOARD_URL ?? "http://127.0.0.1:3100";
assert.ok(new URL(base).protocol === "http:" && ["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const out = path.resolve(process.env.NOVA_KEYBOARD_OUTPUT ?? "work/keyboard-browser");
assert.ok(out.startsWith(path.resolve("work") + path.sep));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const results: { name: string; passed: boolean; evidence?: unknown; error?: string }[] = [];
const errors: string[] = [];
let page: Page | undefined;
async function check(name: string, run: () => Promise<unknown>) {
  try { const evidence = await run(); results.push({ name, passed: true, evidence }); console.log("PASS " + name); }
  catch (e) { results.push({ name, passed: false, error: e instanceof Error ? e.message : String(e) }); await page?.screenshot({ path: path.join(out, "failure.png"), fullPage: true }); throw e; }
}
try {
  for (const locale of ["zh-CN", "zh-HK"]) {
    const id = "22222222-2222-4222-8222-222222222222";
    const user = { id: "11111111-1111-4111-8111-111111111111", role: "parent", name: "合成键盘测试家长", region: "CN" };
    let answers: Record<string, unknown> = {}, revision = 0, submitted = 0;
    let failNextPatch = false, storyValue = "合成第一行\n合成第二行";
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
    context.setDefaultTimeout(12000);
    await context.addInitScript({ content: `(() => {
      localStorage.setItem("nova-locale", ${JSON.stringify(locale)});
      let height = null, offsetTop = 0, scale = 1;
      const viewport = new EventTarget();
      Object.defineProperties(viewport, {
        height: { get: () => height ?? innerHeight }, width: { get: () => innerWidth },
        offsetTop: { get: () => offsetTop }, offsetLeft: { get: () => 0 }, scale: { get: () => scale },
        pageTop: { get: () => scrollY + offsetTop }, pageLeft: { get: () => scrollX },
      });
      Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
      window.keyboardGeometry = (h, top = 0, zoom = 1) => {
        height = h; offsetTop = top; scale = zoom;
        let cover = document.querySelector("[data-keyboard-obstruction]");
        if (!cover) { cover = document.createElement("div"); cover.dataset.keyboardObstruction = "true"; cover.setAttribute("aria-hidden", "true"); document.body.append(cover); }
        const obstruction = h === null || zoom !== 1 ? 0 : Math.max(0, innerHeight - top - h);
        cover.textContent = "Simulated keyboard obstruction";
        cover.style.cssText = "position:fixed;z-index:99999;left:0;right:0;bottom:0;height:" + obstruction + "px;background:#c7cbd1;color:#32373d;text-align:center;padding-top:" + (obstruction ? 24 : 0) + "px;font:14px system-ui;box-sizing:border-box;pointer-events:" + (obstruction ? "auto" : "none") + ";overflow:hidden";
        viewport.dispatchEvent(new Event("resize")); viewport.dispatchEvent(new Event("scroll"));
      };
    })();` });
    const record = () => ({ id, status: submitted ? "queued" : "pending", phase: submitted ? "waiting" : null, childName: "合成孩子", scaleTitle: "合成键盘布局检查", demo: true, consentRequired: false, draftAnswers: answers, draftRevision: revision,
      supplements: [{ itemId: "detail", parentId: "choice", label: "合成补充（选填）", anyOf: [1], maxLength: 2000 }],
      surveyJson: { pages: [{ name: "section", title: "合成章节", elements: [
        { type: "comment", name: "story", title: "请用自己的话描述最近的一次学习经历", isRequired: true, rows: 4 },
        { type: "radiogroup", name: "choice", title: "需要补充吗", isRequired: true, choices: [{ value: 0, text: "不需要" }, { value: 1, text: "需要" }] },
        { type: "comment", name: "last", title: "最后想补充的话", isRequired: true, rows: 4 },
      ] }] } });
    const workspace = () => ({ user, region: "CN", mode: "demo", families: [], goals: [], observations: [], scales: [], staff: [], contentVersions: [], alerts: [], staffNotes: [], reports: [], assessments: [{ id, familyId: "33333333-3333-4333-8333-333333333333", childName: "合成孩子", respondentId: user.id, respondentName: user.name, respondentRole: "parent", scaleVersionId: "synthetic-keyboard@1.0.0", scaleTitle: "合成键盘布局检查", status: submitted ? "queued" : "pending", phase: submitted ? "waiting" : null, createdAt: "2026-10-22T00:00:00Z", reportId: null, canRespond: !submitted, canRetryReport: false }], summary: { families: 0, pendingAssessments: submitted ? 0 : 1, publishedReports: 0, activeGoals: 0, riskReports: 0 } });
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { await route.abort(); return; }
      if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
      if (url.pathname === "/api/session") { await route.fulfill({ json: { user, region: "CN", mode: "demo", authProvider: "local", identityState: "ready", demoAccounts: [] } }); return; }
      if (url.pathname === "/api/workspace") { await route.fulfill({ json: workspace() }); return; }
      if (url.pathname === `/api/assessments/${id}` && route.request().method() === "GET") { await route.fulfill({ json: record() }); return; }
      if (url.pathname === `/api/assessments/${id}` && route.request().method() === "PATCH") {
        if (failNextPatch) { failNextPatch = false; await route.fulfill({ status: 503, json: { code: "SYNTHETIC_SAVE_FAILURE", error: "合成保存失败，请重试。" } }); return; }
        const body = route.request().postDataJSON(); assert.equal(body.revision, revision); assert.equal(body.acknowledged, true); answers = body.answers; revision++; await route.fulfill({ json: { ok: true, revision } }); return;
      }
      if (url.pathname === `/api/assessments/${id}/submit`) { submitted++; await route.fulfill({ json: { id, status: "queued", phase: "waiting", safetyGuidance: false } }); return; }
      throw Error(`Unconfigured synthetic endpoint: ${url.pathname}`);
    });
    page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
    const p = page;
    const geometry = async (height: number | null, top = 0, scale = 1) => {
      await p.evaluate(({ height, top, scale }) => (window as unknown as { keyboardGeometry: (h: number | null, t: number, z: number) => void }).keyboardGeometry(height, top, scale), { height, top, scale });
      await p.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await p.waitForFunction(() => {
        const root = document.querySelector<HTMLElement>('.survey-container[data-keyboard-open="true"]');
        const actions = root?.querySelector("[data-survey-actions]");
        return !root || !actions || parseFloat(root.style.getPropertyValue("--survey-actions-height")) === actions.getBoundingClientRect().height;
      });
    };
    const ready = async () => { await p.locator(".survey-assent-panel input[type=checkbox]").check(); await p.getByTestId("survey-start").click(); await p.locator('.survey-container[data-stage="answering"]').waitFor(); };
    await p.goto(`${base}/#assessment/${id}`); await ready();
    await check(`${locale}: focused text, keyboard obstruction and navigation remain usable`, async () => {
      const text = p.locator('.survey-questions [data-name="story"] textarea'); await text.fill(storyValue);
      assert.ok(await text.evaluate(e => parseFloat(getComputedStyle(e).fontSize) >= 16));
      await geometry(460, 60);
      const measure = await p.evaluate(() => {
        const vv = visualViewport!, next = document.querySelector('[data-testid="survey-next"]')!, field = document.activeElement!;
        const n = next.getBoundingClientRect(), t = field.getBoundingClientRect();
        const control = (field.closest(".sd-comment") ?? field).getBoundingClientRect();
        return { layoutHeight: innerHeight, visibleTop: vv.offsetTop, visibleBottom: vv.offsetTop + vv.height, next: n.toJSON(), text: t.toJSON(), control: control.toJSON(), actionsTop: document.querySelector("[data-survey-actions]")!.getBoundingClientRect().top, nextHit: next.contains(document.elementFromPoint(n.x + n.width / 2, n.y + n.height / 2)) };
      });
      await writeFile(path.join(out, `${locale}-keyboard-geometry.json`), JSON.stringify(measure, null, 2));
      await p.screenshot({ path: path.join(out, `${locale}-keyboard-open.png`) });
      assert.ok(measure.next.bottom <= measure.visibleBottom && measure.nextHit, "Next must remain above the keyboard and receive a real pointer hit");
      assert.ok(measure.text.top >= measure.visibleTop && measure.text.bottom <= measure.next.top, "Focused textarea must remain visible above navigation");
      assert.ok(measure.control.bottom <= measure.actionsTop, "The visible input border must not be covered by the toolbar");
      assert.equal(await text.evaluate(e => e === document.activeElement), true);
      await p.locator('.survey-save-status[data-status="saved"]:visible').waitFor(); assert.equal(answers.story, storyValue);
      failNextPatch = true; storyValue += "（保存重试）"; await text.fill(storyValue);
      await p.locator('.survey-save-status[data-status="failed"]:visible').waitFor();
      const hit = await p.evaluate(() => {
        const next = document.querySelector('[data-testid="survey-next"]')!, n = next.getBoundingClientRect();
        const retry = [...document.querySelectorAll('.survey-save-status button')].find(e => e.checkVisibility())!.getBoundingClientRect();
        return { retryBottom: retry.bottom, nextTop: n.top, nextTopHit: next.contains(document.elementFromPoint(n.x + n.width / 2, n.y + 1)) };
      });
      assert.ok(hit.retryBottom <= hit.nextTop && hit.nextTopHit, "Save retry must not overlap or intercept the Next button");
      await p.screenshot({ path: path.join(out, `${locale}-save-retry-keyboard.png`) });
      await p.locator('.survey-save-status[data-status="failed"]:visible button').click();
      await p.locator('.survey-save-status[data-status="saved"]:visible').waitFor(); assert.equal(answers.story, storyValue);
      await p.getByTestId("survey-next").click(); await p.locator('.survey-questions [data-name="choice"]:visible').waitFor(); assert.equal(submitted, 0);
      await geometry(null); return measure;
    });
    await check(`${locale}: supplementary text, keyboard close, reload and explicit submission`, async () => {
      await p.locator('.survey-questions [data-name="choice"] input[value="1"]').locator("xpath=ancestor::label[1]").click();
      const supplement = p.locator('[data-supplement-id="detail"] textarea'); await supplement.fill("合成补充文字"); await geometry(420, 40);
      await p.locator('.survey-save-status[data-status="saved"]:visible').waitFor(); assert.equal(answers.detail, "合成补充文字");
      await geometry(350, 0, 2);
      assert.equal(await p.locator('.survey-container[data-keyboard-open="true"]').count(), 0, "Pinch zoom must not be treated as a keyboard");
      await geometry(null); await p.setViewportSize({ width: 844, height: 390 }); await geometry(220);
      const landscape = await p.evaluate(() => {
        const field = document.activeElement!.getBoundingClientRect(), button = document.querySelector('[data-testid="survey-next"]')!.getBoundingClientRect();
        return { textTop: field.top, textBottom: field.bottom, buttonTop: button.top, buttonBottom: button.bottom, bottom: visualViewport!.height + visualViewport!.offsetTop };
      });
      assert.ok(landscape.textTop >= 0 && landscape.textBottom <= landscape.buttonTop && landscape.buttonBottom <= landscape.bottom, "Landscape text and navigation must fit the reduced visible area");
      await p.screenshot({ path: path.join(out, `${locale}-landscape-keyboard.png`) });
      await geometry(null); await p.setViewportSize({ width: 390, height: 844 }); await geometry(null);
      assert.equal(await p.locator('.survey-container[data-keyboard-open="true"]').count(), 0);
      assert.equal(await p.locator(".survey-save-status").count(), 1, "Closing the keyboard removes its toolbar status and restores the normal layout");
      await geometry(null); await p.getByTestId("survey-back").click(); await p.getByTestId("questionnaire-screen").waitFor({ state: "detached" });
      await p.goto(`${base}/#assessment/${id}`); await ready(); const text = p.locator('.survey-questions [data-name="last"] textarea'); await text.fill("合成最后一题");
      await geometry(470); await p.getByTestId("survey-next").click(); await p.locator('.survey-container[data-stage="review"]').waitFor(); await geometry(null);
      assert.equal(submitted, 0); await p.getByTestId("survey-submit").click(); await p.getByTestId("submission-state").waitFor(); assert.equal(submitted, 1);
      assert.equal(answers.story, storyValue); assert.equal(answers.detail, "合成补充文字"); assert.equal(answers.last, "合成最后一题");
    });
    await context.close();
  }
  assert.deepEqual(errors, []);
} catch (e) { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
finally { await writeFile(path.join(out, "results.json"), JSON.stringify({ nativeKeyboard: false, syntheticGeometry: true, results, errors }, null, 2)); await browser.close(); }
