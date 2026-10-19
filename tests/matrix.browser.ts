import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, firefox, webkit, type Browser, type Page, type BrowserContextOptions } from "playwright";
import { childScale, parentScale, teacherScale } from "../src/domain/triad-scales";
import { surveyDefinition } from "../src/domain/survey";
import { privacyNotice } from "../src/lib/privacy";

const base = process.env.NOVA_MATRIX_BASE_URL || "http://127.0.0.1:3198";
assert.ok(["http://127.0.0.1:3197", "http://127.0.0.1:3198"].includes(base));
const engine = process.env.NOVA_TEST_BROWSER || "chrome";
assert.ok(["chrome", "firefox", "webkit", "mobile-chrome"].includes(engine));
const phase = process.env.NOVA_MATRIX_PHASE || "fixed";
assert.ok(["baseline", "fixed"].includes(phase));
const output = `work/qa/remaining-matrix/${process.env.NOVA_MATRIX_FILTER?.includes("finalreview") ? (process.env.NOVA_REVIEW_BASELINE ? "finalreview-baseline" : "finalreview-fixed") : base.endsWith(":3197") ? "development" : phase}/${engine}`;
await mkdir(output, { recursive: true });
const browser: Browser = engine === "firefox" ? await firefox.launch({ headless: true, ...(process.env.NOVA_TEST_EXECUTABLE ? { executablePath: process.env.NOVA_TEST_EXECUTABLE } : {}) })
  : engine === "webkit" ? await webkit.launch({ headless: true, ...(process.env.NOVA_TEST_EXECUTABLE ? { executablePath: process.env.NOVA_TEST_EXECUTABLE } : {}) })
  : await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
type Role = "parent" | "student" | "teacher";
const names = { parent: "我是家長", student: "我是學生", teacher: "我是老師" };
const scales = { parent: parentScale, student: childScale, teacher: teacherScale };
const results: { id: string; name: string; passed: boolean; detail?: string }[] = [];
const errors: string[] = [];
async function fixture(initialRole: Role | null = null) {
  const options: BrowserContextOptions = engine === "mobile-chrome" ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : { viewport: { width: 1280, height: 1000 } };
  const context = await browser.newContext(options);
  context.setDefaultTimeout(10000);
  await context.addInitScript(() => localStorage.setItem("nova-locale", "zh-HK"));
  const state = { role: initialRole, loginRole: "parent" as Role, sessionError: false, loginFailure: "" as "" | "network" | "server", joinFailure: false, denied: false, hold: null as Promise<void> | null, calls: [] as { path: string; method: string }[], answers: {} as Record<string, number>, revision: 0 };
  const user = () => state.role ? { id: "synthetic-" + state.role, name: "Synthetic " + state.role, role: state.role, region: "HK" } : null;
  const assessment = () => ({ id: "synthetic-task", familyId: "synthetic-family", childName: "Synthetic child", respondentId: user()?.id, respondentName: user()?.name, respondentRole: state.role, scaleVersionId: scales[state.role || "student"].id, scaleTitle: scales[state.role || "student"].title["zh-HK"], status: "pending", createdAt: "2026-10-08T00:00:00Z", reportId: null, canRespond: true, canRetryReport: false });
  await context.route("**/*", async route => {
    const url = new URL(route.request().url()), path = url.pathname, method = route.request().method();
    if (url.origin !== base) return route.abort();
    if (!path.startsWith("/api/")) return route.continue();
    state.calls.push({ path, method });
    if (path === "/api/session") return route.fulfill(state.sessionError ? { status: 503, json: { error: "合成服务暂时不可用", code: "INTERNAL_ERROR" } } : { json: { user: user(), region: "HK", mode: "service", demoAccounts: [], siblingUrl: null } });
    if (path === "/api/privacy") return route.fulfill({ json: privacyNotice("HK", "zh-HK", "SG") });
    if (path === "/api/auth/login") {
      if (state.hold) await state.hold;
      if (state.loginFailure === "network") return route.abort();
      if (state.loginFailure === "server") return route.fulfill({ status: 503, json: { error: "合成服务暂时不可用", code: "INTERNAL_ERROR" } });
      state.role = state.loginRole; return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/triad/join") {
      if (state.hold) await state.hold;
      if (state.joinFailure) return route.fulfill({ status: 503, json: { error: "合成服务暂时不可用", code: "INTERNAL_ERROR" } });
      state.role = route.request().postDataJSON().role; return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/workspace") return route.fulfill({ json: { user: user(), region: "HK", mode: "service", families: [], assessments: [assessment()], reports: [], scales: [], goals: [], observations: [], staff: [], contentVersions: [], alerts: [], staffNotes: [], summary: {} } });
    if (path === "/api/assessments/synthetic-task") {
      if (state.denied) return route.fulfill({ status: 404, json: { error: "未找到该记录。", code: "NOT_FOUND" } });
      if (method === "PATCH") {
        const body = route.request().postDataJSON();
        assert.equal(body.acknowledged, true); state.answers = body.answers; state.revision++;
        return route.fulfill({ json: { ok: true, revision: state.revision } });
      }
      const role = state.role || "student", scale = scales[role];
      return route.fulfill({ json: { id: "synthetic-task", status: "pending", childName: "Synthetic child", scaleTitle: scale.title["zh-HK"], demo: false, description: scale.description["zh-HK"], surveyJson: surveyDefinition(scale, role, "zh-HK"), draftAnswers: state.answers, draftRevision: state.revision, consentRequired: false } });
    }
    if (path === "/api/recovery" || path === "/api/invite") return route.fulfill({ status: 404, json: { error: "链接已失效。", code: "INVALID_TOKEN" } });
    return route.fulfill({ status: 404, json: { error: "未找到该记录。", code: "NOT_FOUND" } });
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  return { context, page, state };
}
async function workspaceReady(page: Page) {
  await page.locator(".app-shell").waitFor();
  if (engine === "mobile-chrome") {
    await page.locator(".mobile-menu").click();
    await page.getByRole("button", { name: "登出", exact: true }).waitFor();
    await page.locator(".mobile-close").click();
  } else await page.getByRole("button", { name: "登出", exact: true }).waitFor();
}
async function check(id: string, name: string, action: () => Promise<void>) {
  if (process.env.NOVA_MATRIX_FILTER && !name.includes(process.env.NOVA_MATRIX_FILTER)) return;
  try { await action(); results.push({ id, name, passed: true }); }
  catch (error) { results.push({ id, name, passed: false, detail: String(error) }); }
  console.log(`${id} ${name}: ${results.at(-1)!.passed ? "PASS" : "FAIL"}`);
}
try {
  for (const role of ["parent", "student", "teacher"] as const) await check("P08", `valid-login-${role}-workspace`, async () => {
    const f = await fixture(); f.state.loginRole = role;
    try {
      await f.page.goto(base); await f.page.locator("input[name=username]").fill("synthetic-login");
      await f.page.locator("input[name=password]").fill("synthetic-local-password");
      await f.page.getByRole("button", { name: "登入", exact: true }).click();
      await workspaceReady(f.page);
      assert.equal(f.state.calls.filter(call => call.path === "/api/auth/login").length, 1);
      if (role !== "parent") { assert.equal(new URL(f.page.url()).hash, "#assessments"); assert.equal(await f.page.locator('a[href="#reports"]').count(), 0); }
      else assert.equal(new URL(f.page.url()).hash, "");
    } finally { await f.context.close(); }
  });
  for (const role of ["student", "teacher"] as const) await check(role === "student" ? "P36" : "P42", `${role}-join-opens-correct-questionnaire`, async () => {
    const f = await fixture();
    try {
      await f.page.goto(base); await f.page.getByRole("button", { name: new RegExp(names[role]) }).click();
      for (const [key, value] of Object.entries({ code: "TOPE-A2B3C4D5", name: "Synthetic " + role, username: "synthetic-" + role, password: "synthetic-local-password" })) await f.page.locator(`input[name=${key}]`).fill(value);
      await f.page.locator('form:visible button[type="submit"], form:visible button.primary').click();
      await workspaceReady(f.page);
      await f.page.goto(base + "/#assessment/synthetic-task");
      await f.page.locator(".survey-assent-panel input").waitFor();
      assert.equal(await f.page.locator(".survey-questions").evaluate(element => (element as HTMLFieldSetElement).disabled), true);
      assert.equal(f.state.calls.filter(call => call.method === "PATCH").length, 0);
      await f.page.locator(".survey-assent-panel input").check();
      await f.page.waitForFunction(() => !document.querySelector<HTMLFieldSetElement>(".survey-questions")?.disabled);
      assert.ok((await f.page.locator(".survey-questions").innerText()).includes(scales[role].items[0].label["zh-HK"]));
      assert.equal(f.state.role, role);
    } finally { await f.context.close(); }
  });
  await check("P26", "password-native-11-12-256-257-limits", async () => {
    const f = await fixture();
    try {
      await f.page.goto(base); await f.page.getByRole("button", { name: /我是學生/ }).click();
      const input = f.page.locator("input[name=password]");
      for (const size of [11, 12, 256]) {
        await input.fill("x".repeat(size));
        assert.equal(await input.evaluate(element => (element as HTMLInputElement).checkValidity()), size !== 11);
      }
      await input.press("End"); await input.pressSequentially("y");
      assert.equal((await input.inputValue()).length, 256);
      assert.equal(f.state.calls.filter(call => call.method !== "GET").length, 0);
    } finally { await f.context.close(); }
  });
  await check("P49", "network-server-retry-without-duplicate-login", async () => {
    const f = await fixture(); let release!: () => void;
    try {
      await f.page.goto(base); await f.page.locator("input[name=username]").fill("synthetic-retry"); await f.page.locator("input[name=password]").fill("synthetic-local-password");
      for (const failure of ["network", "server"] as const) {
        f.state.loginFailure = failure;
        await f.page.getByRole("button", { name: "登入", exact: true }).click();
        await f.page.locator(".error-notice").waitFor();
        assert.equal(await f.page.locator("input[name=username]").inputValue(), "synthetic-retry");
      }
      f.state.loginFailure = ""; f.state.hold = new Promise<void>(resolve => { release = resolve; });
      const requested = f.page.waitForRequest(request => new URL(request.url()).pathname === "/api/auth/login");
      await f.page.getByRole("button", { name: "登入", exact: true }).click(); await requested;
      assert.equal(await f.page.locator("form button.primary").isDisabled(), true);
      await f.page.keyboard.press("Enter"); await f.page.keyboard.press("Enter");
      assert.equal(f.state.calls.filter(call => call.path === "/api/auth/login").length, 3);
      release(); await workspaceReady(f.page);
    } finally { release?.(); await f.context.close(); }
  });
  await check("P49", "session-load-retry", async () => {
    const f = await fixture(); f.state.sessionError = true;
    try {
      await f.page.goto(base); await f.page.locator(".error-notice").waitFor();
      f.state.sessionError = false; await f.page.getByRole("button", { name: /重新載入|重新载入/, exact: true }).click();
      await f.page.getByRole("button", { name: /我是家長/ }).waitFor();
    } finally { await f.context.close(); }
  });
  await check("P49", "registration-failure-retains-input-and-single-pending-submit", async () => {
    const f = await fixture(); let release!: () => void;
    try {
      await f.page.goto(base); await f.page.getByRole("button", { name: /我是學生/ }).click();
      for (const [key, value] of Object.entries({ code: "TOPE-A2B3C4D5", name: "Synthetic student", username: "synthetic-student", password: "synthetic-local-password" })) await f.page.locator(`input[name=${key}]`).fill(value);
      f.state.joinFailure = true; await f.page.locator("form:visible button.primary").click(); await f.page.locator(".error-notice").waitFor();
      assert.equal(await f.page.locator("input[name=code]").inputValue(), "TOPE-A2B3C4D5");
      f.state.joinFailure = false; f.state.hold = new Promise<void>(resolve => { release = resolve; });
      const requested = f.page.waitForRequest(request => new URL(request.url()).pathname === "/api/triad/join");
      await f.page.locator("form:visible button.primary").click(); await requested;
      await f.page.keyboard.press("Enter"); await f.page.keyboard.press("Enter");
      assert.equal(f.state.calls.filter(call => call.path === "/api/triad/join").length, 2);
      release(); await workspaceReady(f.page);
    } finally { release?.(); await f.context.close(); }
  });
  await check("P48", "questionnaire-draft-reload-with-stateful-mocked-service", async () => {
    const f = await fixture("student");
    try {
      await f.page.goto(base + "/#assessment/synthetic-task"); await f.page.locator(".survey-assent-panel input").check();
      const saved = f.page.waitForResponse(response => response.request().method() === "PATCH");
      void saved.catch(() => undefined);
      await f.page.locator(".survey-questions label:has(input[type=radio])").first().click(); await saved;
      assert.equal(Object.keys(f.state.answers).length, 1);
      await f.page.reload(); await f.page.locator(".survey-assent-panel input").check();
      await f.page.getByRole("button", { name: "上一題", exact: true }).click();
      assert.equal(await f.page.locator(".survey-questions input[type=radio]:checked").count(), 1);
      assert.equal(f.state.revision, 1);
    } finally { await f.context.close(); }
  });
  await check("P50", "protected-deeplink-survives-login-and-denial-is-visible", async () => {
    const f = await fixture(); f.state.loginRole = "student";
    try {
      await f.page.goto(base + "/#assessment/synthetic-task");
      await f.page.locator("input[name=username]").fill("synthetic-student"); await f.page.locator("input[name=password]").fill("synthetic-local-password");
      await f.page.getByRole("button", { name: "登入", exact: true }).click(); await f.page.locator(".survey-assent-panel").waitFor();
      assert.equal(new URL(f.page.url()).hash, "#assessment/synthetic-task");
      f.state.denied = true; await f.page.reload(); await f.page.locator(".draft-access-blocked").waitFor();
      assert.equal(await f.page.locator(".survey-questions").count(), 0);
    } finally { await f.context.close(); }
  });
  await check("P50", "unknown-and-malformed-routes", async () => {
    const f = await fixture("parent");
    try {
      await f.page.goto(base + "/#unknown-matrix-route");
      await f.page.locator(".empty-state").waitFor();
      await f.page.locator(".empty-state button").click(); assert.equal(new URL(f.page.url()).hash, "#dashboard");
      await f.page.goto(base + "/#assessment/%E0%A4%A"); await workspaceReady(f.page);
      assert.equal(await f.page.locator(".survey-questions").count(), 0);
      const response = await f.page.goto(base + "/matrix-page-does-not-exist"); assert.equal(response?.status(), 404);
    } finally { await f.context.close(); }
  });
  for (const path of ["invite", "recover"]) await check("P50", `${path}-missing-and-expired-token`, async () => {
    const f = await fixture();
    try {
      await f.page.goto(`${base}/${path}`); await f.page.locator(".error-notice").waitFor();
      assert.equal(await f.page.locator("form").count(), 0);
      assert.equal(f.state.calls.filter(call => call.path === `/api/${path === "recover" ? "recovery" : "invite"}`).length, 0);
      const requested = f.page.waitForRequest(request => new URL(request.url()).pathname === `/api/${path === "recover" ? "recovery" : "invite"}`);
      void requested.catch(() => undefined);
      await f.page.goto(`${base}/${path}#token=${"a".repeat(64)}`); await requested; await f.page.locator(".error-notice").waitFor();
      assert.equal(new URL(f.page.url()).hash, ""); assert.equal(await f.page.locator("form").count(), 0);
    } finally { await f.context.close(); }
  });
  if (phase !== "baseline") for (const path of ["invite", "recover"]) await check("P50", `${path}-new-token-clears-old-form-and-stale-request`, async () => {
    const f = await fixture();
    const apiPath = path === "recover" ? "recovery" : "invite";
    const header = path === "recover" ? "x-recovery-token" : "x-invitation-token";
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    try {
      await f.page.route(`**/api/${apiPath}?*`, async route => {
        const next = route.request().headers()[header]?.startsWith("b");
        if (next) await pending;
        await route.fulfill({ json: path === "recover"
          ? { name: next ? "Synthetic new user" : "Synthetic old user", username: "synthetic-user", role: "student", region: "HK", expiresAt: "2026-10-10T00:00:00Z" }
          : { familyName: next ? "Synthetic new family" : "Synthetic old family", role: "student", region: "HK", expiresAt: "2026-10-10T00:00:00Z" } });
      });
      await f.page.goto(`${base}/${path}#token=${"a".repeat(64)}`);
      await f.page.locator("form").waitFor(); assert.equal(new URL(f.page.url()).hash, "");
      await f.page.locator("input[name=password]").fill("synthetic-old-password");
      const requested = f.page.waitForRequest(request => request.headers()[header]?.startsWith("b") === true); void requested.catch(() => undefined);
      await f.page.goto(`${base}/${path}#token=${"b".repeat(64)}`); await requested;
      await f.page.locator("form").waitFor({ state: "detached" });
      assert.equal(new URL(f.page.url()).hash, "");
      release(); await f.page.locator("form").waitFor();
      assert.equal(await f.page.locator("input[name=password]").inputValue(), "");
      assert.match(await f.page.locator(".invite-summary").innerText(), /Synthetic new/);
    } finally { release(); await f.context.close(); }
  });
  if (phase !== "baseline") for (const path of ["invite", "recover"]) for (const status of [200, 503]) await check("P49/P50", `${path}-old-token-submit-${status}-cannot-replace-new-link`, async () => {
    const f = await fixture();
    const apiPath = path === "recover" ? "recovery" : "invite";
    const header = path === "recover" ? "x-recovery-token" : "x-invitation-token";
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    try {
      await f.page.route(`**/api/${apiPath}?*`, async route => {
        if (route.request().method() === "POST") { await pending; return route.fulfill({ status, json: status === 200 ? { ok: true } : { error: "Synthetic old-link failure" } }); }
        const next = route.request().headers()[header]?.startsWith("b");
        return route.fulfill({ json: path === "recover"
          ? { name: next ? "Synthetic new user" : "Synthetic old user", username: "synthetic-user", role: "student", region: "HK", expiresAt: "2026-10-10T00:00:00Z" }
          : { familyName: next ? "Synthetic new family" : "Synthetic old family", role: "student", region: "HK", expiresAt: "2026-10-10T00:00:00Z" } });
      });
      await f.page.goto(`${base}/${path}#token=${"a".repeat(64)}`); await f.page.locator("form").waitFor();
      for (const [key, value] of Object.entries(path === "invite" ? { name: "Synthetic user", username: "synthetic-old", password: "synthetic-local-password" } : { password: "synthetic-local-password", confirm: "synthetic-local-password" })) await f.page.locator(`input[name=${key}]`).fill(value);
      const submitted = f.page.waitForRequest(request => request.method() === "POST"); void submitted.catch(() => undefined);
      await f.page.locator("form button.primary").click(); await submitted;
      await f.page.goto(`${base}/${path}#token=${"b".repeat(64)}`);
      await f.page.locator(".invite-summary").filter({ hasText: "Synthetic new" }).waitFor();
      release(); await f.page.waitForLoadState("networkidle");
      assert.equal(new URL(f.page.url()).pathname, `/${path}`);
      assert.equal(await f.page.locator("form").count(), 1);
      assert.match(await f.page.locator(".invite-summary").innerText(), /Synthetic new/);
      assert.equal(await f.page.locator(".error-notice").count(), 0);
    } finally { release(); await f.context.close(); }
  });
  await check("P47", "responsive-policy-keyboard-and-history-smoke", async () => {
    const f = await fixture();
    try {
      await f.page.goto(base); await f.page.getByRole("button", { name: /我是家長/ }).click();
      await f.page.locator("input[name=parentName]").fill("Synthetic responsive draft");
      const policy = f.page.getByRole("button", { name: "私隱與知情同意", exact: true });
      await policy.focus(); await f.page.keyboard.press("Enter"); await f.page.waitForFunction(() => document.querySelector("dialog")?.open);
      await f.page.keyboard.press("Escape"); await f.page.getByRole("dialog").waitFor({ state: "detached" });
      assert.equal(await policy.evaluate(element => document.activeElement === element), true);
      await f.page.goBack(); await f.page.getByRole("heading", { name: "選擇你的入口", exact: true }).waitFor();
      await f.page.goForward(); assert.equal(await f.page.locator("form:visible input[name=parentName]").inputValue(), "Synthetic responsive draft");
      assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await f.page.screenshot({ path: `${output}/responsive.png`, fullPage: true });
    } finally { await f.context.close(); }
  });
  await check("history/drafts", "finalreview-history-ownership-and-password-clearing", async () => {
    const f = await fixture();
    try {
      await f.page.goto(base); await f.page.getByRole("button", { name: /我是家長/ }).waitFor();
      await f.page.evaluate(() => history.replaceState({ ...history.state, unrelatedOwner: { id: 7 } }, ""));
      await f.page.getByRole("button", { name: /我是家長/ }).click();
      await f.page.locator("input[name=parentName]").fill("Synthetic isolated parent");
      await f.page.locator("input[name=password]").fill("synthetic-private-password");
      assert.deepEqual(await f.page.evaluate(() => history.state.unrelatedOwner), { id: 7 });
      await f.page.goBack(); await f.page.getByRole("heading", { name: "選擇你的入口", exact: true }).waitFor();
      await f.page.waitForFunction(() => [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')].every(input => input.value === ""));
      assert.deepEqual(await f.page.evaluate(() => history.state.unrelatedOwner), { id: 7 });
      await f.page.goForward(); await f.page.getByRole("heading", { name: "我是家長", exact: true }).waitFor();
      assert.equal(await f.page.locator("form:visible input[name=parentName]").inputValue(), "Synthetic isolated parent");
      assert.equal(await f.page.locator("form:visible input[name=password]").inputValue(), "");
      await f.page.goBack(); await f.page.getByRole("button", { name: /我是學生/ }).click();
      assert.equal(await f.page.locator("form:visible input[name=name]").inputValue(), "");
      const state = await f.page.evaluate(() => JSON.stringify({ history: history.state, local: { ...localStorage }, session: { ...sessionStorage } }));
      assert.doesNotMatch(state, /Synthetic isolated parent|synthetic-private-password/);
    } finally { await f.context.close(); }
  });
  await check("focus/history", "finalreview-modal-back-unmount-focus", async () => {
    const f = await fixture();
    try {
      await f.page.goto(base); await f.page.getByRole("button", { name: /我是家長/ }).click();
      const policy = f.page.getByRole("button", { name: "私隱與知情同意", exact: true });
      await policy.focus(); await f.page.keyboard.press("Enter"); await f.page.waitForFunction(() => document.querySelector("dialog")?.open);
      await f.page.goBack(); await f.page.getByRole("heading", { name: "選擇你的入口", exact: true }).waitFor();
      await f.page.getByRole("dialog").waitFor({ state: "detached" });
      assert.equal(await f.page.locator(".entry-door-parent").evaluate(element => document.activeElement === element), true);
    } finally { await f.context.close(); }
  });
  await check("focus", "finalreview-fast-dialog-close-reopen-with-late-response", async () => {
    const f = await fixture(); let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    try {
      await f.page.route("**/api/privacy?*", async route => { await pending; await route.fulfill({ json: privacyNotice("HK", "zh-HK", "SG") }).catch(() => undefined); });
      await f.page.goto(base); const policy = f.page.getByRole("button", { name: "私隱與知情同意", exact: true });
      for (let count = 0; count < 3; count++) {
        await policy.focus(); await f.page.keyboard.press("Enter"); await f.page.waitForFunction(() => document.querySelector("dialog")?.open);
        if (count === 2) { release(); await f.page.getByRole("dialog").getByText(/新加坡/).waitFor(); }
        await f.page.keyboard.press("Escape"); await f.page.getByRole("dialog").waitFor({ state: "detached" });
        assert.equal(await policy.evaluate(element => document.activeElement === element), true);
      }
    } finally { release(); await f.context.close(); }
  });
  await check("locale", "finalreview-inflight-error-after-roundtrip-locale", async () => {
    const f = await fixture(); let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    try {
      await f.page.route("**/api/auth/login?*", async route => { await pending; await route.fulfill({ status: 401, json: { error: "賬號或密碼不正確。", code: "INVALID_CREDENTIALS" } }); });
      await f.page.goto(base); await f.page.locator("input[name=username]").fill("synthetic-invalid"); await f.page.locator("input[name=password]").fill("synthetic-password");
      const request = f.page.waitForRequest(request => new URL(request.url()).pathname === "/api/auth/login"); void request.catch(() => undefined);
      await f.page.getByRole("button", { name: "登入", exact: true }).click(); await request;
      for (const name of ["简", "繁", "简"]) await f.page.getByRole("button", { name, exact: true }).click();
      release(); await f.page.locator(".error-notice").waitFor();
      assert.match(await f.page.locator(".error-notice").innerText(), /账号或密码不正确/);
      await f.page.getByRole("button", { name: "繁", exact: true }).click();
      assert.match(await f.page.locator(".error-notice").innerText(), /密碼不正確/);
    } finally { release(); await f.context.close(); }
  });
  for (const path of ["invite", "recover"]) await check("reused links", `finalreview-${path}-same-token-revalidates`, async () => {
    const f = await fixture(); const apiPath = path === "recover" ? "recovery" : "invite"; let expired = false;
    try {
      await f.page.route(`**/api/${apiPath}?*`, route => route.fulfill(expired ? { status: 410, json: { error: "链接已使用。", code: "INVALID_TOKEN" } } : { json: path === "recover" ? { name: "Synthetic account", username: "synthetic-account", role: "student", region: "HK", expiresAt: "2026-10-10T00:00:00Z" } : { familyName: "Synthetic family", role: "student", region: "HK", expiresAt: "2026-10-10T00:00:00Z" } }));
      await f.page.goto(`${base}/${path}#token=${"a".repeat(64)}`); await f.page.locator("form").waitFor();
      expired = true;
      const requested = f.page.waitForRequest(request => new URL(request.url()).pathname === `/api/${apiPath}`); void requested.catch(() => undefined);
      await f.page.goto(`${base}/${path}#token=${"a".repeat(64)}`); await requested;
      await f.page.locator(".error-notice").waitFor(); assert.equal(await f.page.locator("form").count(), 0);
      assert.equal(new URL(f.page.url()).hash, "");
    } finally { await f.context.close(); }
  });
  for (const path of ["invite", "recover"]) await check("async reads", `finalreview-${path}-late-read-cannot-replace-new-token`, async () => {
    const f = await fixture(); const apiPath = path === "recover" ? "recovery" : "invite", header = path === "recover" ? "x-recovery-token" : "x-invitation-token";
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
    try {
      await f.page.route(`**/api/${apiPath}?*`, async route => {
        const old = route.request().headers()[header]?.startsWith("a"); if (old) await pending;
        await route.fulfill({ json: path === "recover" ? { name: old ? "Synthetic old" : "Synthetic latest", username: "synthetic-account", role: "student", region: "HK", expiresAt: "2026-10-10T00:00:00Z" } : { familyName: old ? "Synthetic old" : "Synthetic latest", role: "student", region: "HK", expiresAt: "2026-10-10T00:00:00Z" } }).catch(() => undefined);
      });
      const requested = f.page.waitForRequest(request => new URL(request.url()).pathname === `/api/${apiPath}`); void requested.catch(() => undefined);
      await f.page.goto(`${base}/${path}#token=${"a".repeat(64)}`); await requested;
      await f.page.goto(`${base}/${path}#token=${"b".repeat(64)}`); await f.page.locator(".invite-summary").filter({ hasText: "Synthetic latest" }).waitFor();
      release(); await f.page.waitForLoadState("networkidle");
      assert.match(await f.page.locator(".invite-summary").innerText(), /Synthetic latest/);
    } finally { release(); await f.context.close(); }
  });
  if (process.env.NOVA_REVIEW_HARNESS === "1") for (const path of ["invite", "recover"]) await check("unmount", `finalreview-${path}-unmounted-submit-cannot-redirect-host`, async () => {
    const f = await fixture(); const apiPath = path === "recover" ? "recovery" : "invite";
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
    try {
      await f.page.route(`**/api/${apiPath}?*`, async route => {
        if (route.request().method() === "POST") { await pending; return route.fulfill({ json: { ok: true } }); }
        return route.fulfill({ json: path === "recover" ? { name: "Synthetic account", username: "synthetic-account", role: "student", region: "HK", expiresAt: "2026-10-10T00:00:00Z" } : { familyName: "Synthetic family", role: "student", region: "HK", expiresAt: "2026-10-10T00:00:00Z" } });
      });
      await f.page.goto(`${base}/review-harness?view=${path}#token=${"a".repeat(64)}`); await f.page.locator("form").waitFor();
      for (const [name, value] of Object.entries(path === "invite" ? { name: "Synthetic user", username: "synthetic-user", password: "synthetic-password" } : { password: "synthetic-password", confirm: "synthetic-password" })) await f.page.locator(`input[name=${name}]`).fill(value);
      const submitted = f.page.waitForRequest(request => request.method() === "POST"); void submitted.catch(() => undefined);
      await f.page.locator("form button.primary").click(); await submitted;
      await f.page.locator("#review-unmount").click(); await f.page.locator("form").waitFor({ state: "detached" });
      release(); await f.page.waitForLoadState("networkidle");
      assert.equal(new URL(f.page.url()).pathname, "/review-harness");
      assert.equal(await f.page.locator("#review-sentinel").isVisible(), true);
      assert.equal(await f.page.locator(".error-notice").count(), 0);
    } finally { release(); await f.context.close(); }
  });
} finally {
  const version = browser.version(); await browser.close();
  const passed = results.every(result => result.passed) && errors.length === 0;
  await writeFile(`${output}/results.json`, JSON.stringify({ engine, version, passed, evidenceLevel: "real browser, intercepted synthetic APIs; mobile-chrome is device emulation; webkit is not Safari app; no screen reader", results, errors }, null, 2));
  console.log(JSON.stringify({ engine, version, passed, checks: results.length, failed: results.filter(result => !result.passed), errors }));
  if (!passed) process.exitCode = 1;
}
