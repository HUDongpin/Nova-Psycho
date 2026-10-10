import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";

const mode = process.argv[2]?.replace(/^--/, "");
assert.ok(mode === "baseline" || mode === "fixed");
const base = process.env.NOVA_PUBLIC_URL;
assert.ok(base, "NOVA_PUBLIC_URL is required");
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname), "Use a local synthetic runtime");
assert.equal(process.env.NOVA_MODE, "demo");
assert.equal(process.env.NOVA_AI_ENABLED, "false");
const locale = process.env.NOVA_REGION === "HK" ? "zh-HK" : "zh-CN";
const out = path.resolve(process.env.NOVA_BROWSER_OUTPUT_DIR ?? `work/qa/refresh-draft-20261008/${mode}-${locale}/workspace-refresh`);
assert.ok(out.startsWith(path.resolve("work") + path.sep), "Evidence must remain under work/");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const evidence: { mode: string; locale: string; checks: unknown[]; browserErrors: string[]; passed: boolean; error?: string } = {
  mode, locale, checks: [], browserErrors: [], passed: false,
};
type Content = { id: string; version: string; content: { title: Record<string, string>; [key: string]: unknown } };
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const versionPrefix = Date.now();
let versionIndex = 0;

async function call<T>(context: BrowserContext, endpoint: string, data?: unknown): Promise<T> {
  const response = await context.request.fetch(`${base}${endpoint}`, {
    method: data === undefined ? "GET" : "POST",
    headers: { Origin: base! },
    ...(data === undefined ? {} : { data }),
  });
  assert.ok(response.ok(), `${endpoint} returned ${response.status()}`);
  return response.json();
}

async function refresh(page: Page) {
  const response = page.waitForResponse(value => new URL(value.url()).pathname === "/api/workspace");
  await page.locator(".topbar .refresh-button").click();
  assert.equal((await response).status(), 200);
  await page.locator(".topbar .refresh-button").waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".topbar .refresh-button")?.disabled);
}

async function selectTemplate(page: Page) {
  await page.locator(".tabs button").nth(1).click();
  await page.locator(".content-version-row").waitFor();
}

async function assertCurrent(page: Page, content: Content) {
  await page.waitForFunction(expected => document.querySelector(".content-version-row")?.textContent?.includes(expected), content.version);
  await page.waitForFunction(expected => document.querySelector(".version-panel")?.textContent?.includes(expected), content.version);
  assert.deepEqual(JSON.parse(await page.locator(".content-form textarea").inputValue()), content.content);
}

async function publish(context: BrowserContext, page: Page, kind = "template"): Promise<Content> {
  const current = await call<Content>(context, `/api/content/${kind}`);
  const version = `${versionPrefix}.0.${++versionIndex}`;
  const content = { ...current.content, title: { "zh-CN": `合成刷新模板 ${versionIndex}`, "zh-HK": `合成刷新範本 ${versionIndex}` } };
  await page.locator(".content-form input").fill(version);
  await page.locator(".content-form textarea").fill(JSON.stringify(content, null, 2));
  const response = page.waitForResponse(value => new URL(value.url()).pathname === `/api/content/${kind}` && value.request().method() === "POST");
  await page.locator(".content-form button[type=submit], .content-form button.primary").click();
  const saved = await response;
  assert.equal(saved.status(), 201);
  const { id } = await saved.json();
  const result = { id, version, content };
  await assertCurrent(page, result);
  return result;
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addInitScript(value => localStorage.setItem("nova-locale", value), locale);
  const session = await call<{ mode: string; demoAccounts: { id: string; role: string }[] }>(context, "/api/session");
  assert.equal(session.mode, "demo");
  await call(context, "/api/auth/demo", { accountId: session.demoAccounts.find(account => account.role === "admin")!.id });
  const contentPage = await context.newPage();
  const writer = await context.newPage();
  const auditPage = await context.newPage();
  for (const page of [contentPage, writer, auditPage]) page.on("pageerror", error => evidence.browserErrors.push(error.name));
  await contentPage.goto(`${base}/#content`);
  await selectTemplate(contentPage);
  await writer.goto(`${base}/#content`);
  await selectTemplate(writer);
  await auditPage.goto(`${base}/#audit`);
  await auditPage.locator("main section.panel .version-list").waitFor();
  const before = await call<Content>(context, "/api/content/template");
  const reads = { content: 0, audit: 0 };
  contentPage.on("request", request => { if (new URL(request.url()).pathname === "/api/content/template" && request.method() === "GET") reads.content++; });
  auditPage.on("request", request => { if (new URL(request.url()).pathname === "/api/audit") reads.audit++; });
  const latest = await publish(context, writer);
  assert.ok(!(await auditPage.locator("main").innerText()).includes(latest.id.slice(0, 8)));
  await refresh(contentPage);
  await refresh(auditPage);
  if (mode === "baseline") {
    await pause(350);
    assert.ok((await contentPage.locator(".version-panel").innerText()).includes(latest.version));
    assert.ok((await contentPage.locator(".content-version-row").innerText()).includes(before.version));
    assert.deepEqual(JSON.parse(await contentPage.locator(".content-form textarea").inputValue()), before.content);
    assert.ok(!(await auditPage.locator("main").innerText()).includes(latest.id.slice(0, 8)));
    assert.deepEqual(reads, { content: 0, audit: 0 });
    evidence.checks.push({ case: "header_refresh_stale_content_and_audit", sidebar: latest.version, editor: before.version, reads });
  } else {
    await assertCurrent(contentPage, latest);
    await auditPage.getByText(new RegExp(latest.id.slice(0, 8))).waitFor();
    assert.ok(reads.content > 0 && reads.audit > 0);
    evidence.checks.push({ case: "second_tab_save_header_refresh_updates_version_editor_and_audit", version: latest.version, reads: { ...reads } });

    let releaseOld!: () => void;
    let heldRead!: () => void;
    const held = new Promise<void>(resolve => { heldRead = resolve; });
    const release = new Promise<void>(resolve => { releaseOld = resolve; });
    let holdFirst = true;
    await contentPage.route("**/api/content/template?*", async route => {
      if (!holdFirst || route.request().method() !== "GET") { await route.continue(); return; }
      holdFirst = false;
      const response = await route.fetch();
      heldRead();
      await release;
      await route.fulfill({ response }).catch(() => undefined);
    });
    await refresh(contentPage);
    await held;
    const newer = await publish(context, writer);
    await refresh(contentPage);
    await assertCurrent(contentPage, newer);
    releaseOld();
    await pause(200);
    await assertCurrent(contentPage, newer);
    await contentPage.unroute("**/api/content/template?*");
    evidence.checks.push({ case: "delayed_previous_read_cannot_replace_latest_refresh", version: newer.version });

    const nextLocale = locale === "zh-CN" ? "zh-HK" : "zh-CN";
    const localized = contentPage.waitForRequest(request => new URL(request.url()).pathname === "/api/content/template" && new URL(request.url()).searchParams.get("locale") === nextLocale);
    await contentPage.getByRole("button", { name: nextLocale === "zh-HK" ? "繁" : "简", exact: true }).click();
    await localized;
    await assertCurrent(contentPage, newer);
    evidence.checks.push({ case: "locale_change_refetches_current_template", locale: nextLocale });

    let failContent = true;
    await contentPage.route("**/api/content/template?*", route => failContent ? route.fulfill({ status: 503, json: { error: "合成读取失败", code: "SYNTHETIC_READ_FAILURE" } }) : route.continue());
    await refresh(contentPage);
    await contentPage.getByText("合成读取失败", { exact: true }).waitFor();
    failContent = false;
    await contentPage.locator(".content-grid .error-notice button").click();
    await assertCurrent(contentPage, newer);
    await contentPage.unroute("**/api/content/template?*");
    evidence.checks.push({ case: "content_refresh_failure_retry_recovers" });

    let failAudit = true;
    await auditPage.route("**/api/audit?*", route => failAudit ? route.fulfill({ status: 503, json: { error: "合成审计读取失败", code: "SYNTHETIC_READ_FAILURE" } }) : route.continue());
    await refresh(auditPage);
    await auditPage.getByText("合成审计读取失败", { exact: true }).waitFor();
    failAudit = false;
    await auditPage.locator("section.panel .error-notice button").click();
    await auditPage.getByText(new RegExp(newer.id.slice(0, 8))).waitFor();
    await auditPage.unroute("**/api/audit?*");
    evidence.checks.push({ case: "audit_refresh_failure_retry_recovers" });

    let releasePost!: () => void;
    let postStarted!: () => void;
    const postHeld = new Promise<void>(resolve => { postStarted = resolve; });
    const postRelease = new Promise<void>(resolve => { releasePost = resolve; });
    let readsDuringSave = 0;
    await contentPage.route("**/api/content/template?*", async route => {
      if (route.request().method() === "POST") {
        postStarted();
        await postRelease;
        await route.continue();
      } else {
        readsDuringSave++;
        await route.continue();
      }
    });
    const concurrentVersion = `${versionPrefix}.0.${++versionIndex}`;
    const concurrentContent = { ...newer.content, title: { "zh-CN": "合成保存刷新并发模板", "zh-HK": "合成儲存重新整理併發範本" } };
    await contentPage.locator(".content-form input").fill(concurrentVersion);
    await contentPage.locator(".content-form textarea").fill(JSON.stringify(concurrentContent, null, 2));
    const postResponse = contentPage.waitForResponse(value => new URL(value.url()).pathname === "/api/content/template" && value.request().method() === "POST");
    await contentPage.locator(".content-form button.primary").click();
    await postHeld;
    await refresh(contentPage);
    await pause(150);
    const beforePostCompleted = readsDuringSave;
    releasePost();
    assert.equal((await postResponse).status(), 201);
    assert.equal(beforePostCompleted, 0, "Header refresh must wait for pending content save before reading");
    await contentPage.locator(".content-form textarea").waitFor();
    await contentPage.unroute("**/api/content/template?*");
    const storedConcurrent = await call<Content>(context, "/api/content/template");
    assert.equal(storedConcurrent.version, concurrentVersion);
    await assertCurrent(contentPage, storedConcurrent);
    await contentPage.locator(".content-form .success-notice").waitFor();
    assert.equal(readsDuringSave, 1);
    evidence.checks.push({ case: "refresh_waits_for_pending_save_then_reads_saved_version_editor", version: concurrentVersion, beforePostCompleted, afterPostCompleted: readsDuringSave });

    await contentPage.locator(".tabs button").first().click();
    await writer.locator(".tabs button").first().click();
    await contentPage.locator(".content-version-row").waitFor();
    await writer.locator(".content-version-row").waitFor();
    const advice = await publish(context, writer, "advice");
    await refresh(contentPage);
    await assertCurrent(contentPage, advice);
    assert.equal(await contentPage.locator(".tabs button").first().getAttribute("aria-pressed"), "true");
    evidence.checks.push({ case: "advice_refresh_retains_selected_kind_and_updates_editor", version: advice.version });
  }
  await contentPage.screenshot({ path: path.join(out, "content.png"), fullPage: true });
  await auditPage.screenshot({ path: path.join(out, "audit.png"), fullPage: true });
  assert.deepEqual(evidence.browserErrors, []);
  evidence.passed = true;
  console.log(JSON.stringify(evidence));
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify(evidence));
  process.exitCode = 1;
} finally {
  await writeFile(path.join(out, "results.json"), JSON.stringify(evidence, null, 2));
  await browser.close();
}
