import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Locator } from "playwright";
import type { Family, Locale, User } from "../src/components/api";
import { privacyNotice } from "../src/lib/privacy";

// The former --baseline mode characterized the retired single /triad/parent
// screen by expecting missing accessibility/translation fixes. It cannot test
// today's account-then-family contract. Keep the original harness in review
// evidence; all current runs use the same positive regression expectations.
if (process.argv.includes("--baseline")) {
  console.error("Historical --baseline mode is retired: the UI no longer uses the legacy /api/triad/parent route. Run without --baseline to test the current two-stage flow; the original harness is preserved in work/qa/onboarding-refresh/onboarding.browser.original.ts.");
  process.exit(2);
}
const base = process.env.NOVA_BROWSER_BASE_URL || "http://127.0.0.1:3197";
assert.ok(["http://127.0.0.1:3197", "http://127.0.0.1:3198"].includes(base));
const output = `work/qa/onboarding-refresh/${base.endsWith(":3198") ? "production-build" : "current"}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.NOVA_CHROMIUM_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const results: { name: string; passed: boolean; detail?: string }[] = [];
const errors: string[] = [];
type Write = { path: string; body: Record<string, unknown> };
async function fixture(locale: Locale = "zh-HK", authProvider: "local" | "clerk" = "local") {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  context.setDefaultTimeout(10000);
  await context.addInitScript(value => localStorage.setItem("nova-locale", value), locale);
  const state = { user: null as User | null, families: [] as Family[], familySuccess: false, writes: [] as Write[] };
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (request.method() !== "GET") state.writes.push({ path: url.pathname, body: request.postDataJSON() as Record<string, unknown> });
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: state.user, region: "HK", mode: "service", demoAccounts: [], siblingUrl: null, authProvider, identityState: state.user ? "ready" : authProvider === "clerk" ? "profile_required" : "signed_out" } });
    if (url.pathname === "/api/privacy") return route.fulfill({ json: privacyNotice("HK", url.searchParams.get("locale") === "zh-HK" ? "zh-HK" : "zh-CN", "SG", authProvider) });
    if (url.pathname === "/api/auth/login") return route.fulfill({ status: 401, json: { error: "账号或密码不正确。", code: "INVALID_CREDENTIALS" } });
    if (url.pathname === "/api/auth/register" || url.pathname === "/api/auth/profile") {
      const input = request.postDataJSON();
      state.user = { id: "synthetic-parent", name: input.name, role: input.role, region: "HK" };
      return route.fulfill({ status: 201, json: { user: state.user } });
    }
    if (url.pathname === "/api/workspace") return route.fulfill({ json: { user: state.user, region: "HK", mode: "service", families: state.families, assessments: [], reports: [], scales: [], goals: [], observations: [], staff: [], contentVersions: [], alerts: [], staffNotes: [], summary: {} } });
    if (url.pathname === "/api/triad/family" && state.familySuccess) {
      const input = request.postDataJSON();
      state.families = [{ id: "synthetic-family", familyName: "Synthetic family", childName: input.childName, birthDate: input.birthDate, age: 12, grade: input.grade, region: "HK", guardianLabel: input.relationship, assignedTo: null, canInviteMembers: false, createdAt: "2026-01-01T00:00:00Z", consent: true, members: [state.user!], joinCode: "TOPE-A2B3C4D5" }];
      return route.fulfill({ status: 201, json: { userId: state.user!.id, familyId: "synthetic-family", joinCode: "TOPE-A2B3C4D5" } });
    }
    // Unknown mutations, including retired /triad/parent, never reach a server.
    return route.fulfill({ status: 422, json: { error: "输入不符合要求，请检查必填项和格式。", code: "VALIDATION_FAILED" } });
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base);
  await page.getByRole("button", { name: /我是家[长長]/ }).waitFor();
  return { context, page, state, writes: () => state.writes.length };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function registerParent(f: Fixture, authProvider: "local" | "clerk" = "local") {
  await f.page.getByRole("button", { name: /我是家長/ }).click();
  const form = f.page.locator("form:visible");
  await form.locator("input[name=name]").fill("合成家長");
  if (authProvider === "local") {
    await form.locator("input[name=username]").fill("synthetic-signup");
    await form.locator("input[name=password]").fill("synthetic-local-password");
  }
  await form.getByRole("button", { name: "建立帳號", exact: true }).click();
  await f.page.locator(".family-entry form").waitFor();
  assert.equal(new URL(f.page.url()).hash, "");
  return f.page.locator(".family-entry form");
}
async function closePrivacy(f: Fixture, opener: Locator, close: "Escape" | "button", keyboard = false) {
  const dialog = f.page.getByRole("dialog");
  await f.page.waitForFunction(() => document.querySelector("dialog")?.open);
  await dialog.getByText(/新加坡/).waitFor();
  if (close === "Escape") await f.page.keyboard.press("Escape");
  else if (keyboard) await dialog.getByRole("button", { name: "關閉", exact: true }).press("Enter");
  else await dialog.getByRole("button", { name: "關閉", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await opener.evaluate(element => element === document.activeElement), true);
}
async function check(name: string, fn: () => Promise<void>) {
  console.log(`RUN ${name}`);
  try { await fn(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, detail: String(error) }); }
  const result = results.at(-1)!;
  console.log(`${result.passed ? "PASS" : "FAIL"} ${name}${result.detail ? `: ${result.detail}` : ""}`);
}
try {
  await check("parent-policy-access-preserves-draft-and-consent", async () => {
    const f = await fixture();
    try {
      await f.page.getByRole("button", { name: /我是家長/ }).click();
      const account = f.page.locator("form:visible");
      await account.locator("input[name=name]").fill("合成家長");
      await account.locator("input[name=username]").fill("synthetic-signup");
      await account.locator("input[name=password]").fill("synthetic-local-password");
      const accountPolicy = account.getByRole("button", { name: "私隱與知情同意", exact: true });
      await accountPolicy.focus(); await accountPolicy.press("Enter");
      await closePrivacy(f, accountPolicy, "button");
      assert.equal(await account.locator("input[name=name]").inputValue(), "合成家長");
      assert.equal(await account.locator("input[name=username]").inputValue(), "synthetic-signup");
      assert.equal(await account.locator("input[name=password]").inputValue(), "synthetic-local-password");
      assert.equal(await account.getByRole("checkbox").count(), 0, "Guardian consent belongs to family enrollment, not standalone account creation");
      assert.equal(f.writes(), 0);
      await account.getByRole("button", { name: "建立帳號", exact: true }).click();
      const family = f.page.locator(".family-entry form"); await family.waitFor();
      await family.locator("input[name=childName]").fill("合成孩子");
      await family.locator("input[name=birthDate]").fill("2014-01-01");
      const policy = family.getByRole("button", { name: "私隱與知情同意", exact: true });
      for (const accepted of [false, true]) {
        if (accepted) await family.getByRole("checkbox").check();
        await policy.focus(); await policy.press("Enter");
        await closePrivacy(f, policy, accepted ? "Escape" : "button");
        assert.equal(await family.getByRole("checkbox").isChecked(), accepted);
        assert.equal(await family.locator("input[name=childName]").inputValue(), "合成孩子");
        assert.equal(await family.locator("input[name=birthDate]").inputValue(), "2014-01-01");
        assert.equal(await family.locator("select[name=relationship]").inputValue(), "母亲");
        assert.equal(await family.locator("select[name=grade]").inputValue(), "小学四至六年级");
        assert.equal(f.writes(), 1, "Only account creation may write while the policy is opened and closed");
      }
      await f.page.screenshot({ path: `${output}/parent-policy.png` });
    } finally { await f.context.close(); }
  });
  for (const close of ["Escape", "button"] as const) await check(`keyboard-dialog-focus-${close}`, async () => {
    const f = await fixture();
    try {
      const opener = f.page.getByRole("button", { name: "私隱與知情同意", exact: true });
      await opener.focus(); await opener.press("Enter");
      const dialog = f.page.getByRole("dialog"); await dialog.waitFor();
      await f.page.waitForFunction(() => document.querySelector("dialog")?.open);
      assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true);
      await f.page.locator(".locale-control button").first().evaluate(element => element.focus());
      assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true);
      for (const key of ["Tab", "Shift+Tab", "Tab"]) {
        await f.page.keyboard.press(key);
        // Native dialog tab cycling may put focus on BODY at its boundary;
        // preserve the original assertion that no outside control gains focus.
        assert.equal(await dialog.evaluate(element => document.activeElement === document.body || element.contains(document.activeElement)), true);
      }
      await closePrivacy(f, opener, close, true);
      assert.equal(f.writes(), 0);
    } finally { await f.context.close(); }
  });
  await check("traditional-options-and-policy", async () => {
    const f = await fixture();
    try {
      const family = await registerParent(f);
      const labels = await family.locator("select option").allTextContents();
      assert.equal(labels.some(label => /亲|顾|学|级/.test(label)), false);
      assert.equal(/报告|撤销/.test(JSON.stringify(privacyNotice("HK", "zh-HK", "SG"))), false);
      assert.equal(await family.locator("select[name=relationship]").inputValue(), "母亲");
      assert.equal(await family.locator("select[name=grade]").inputValue(), "小学四至六年级");
      await f.page.getByRole("button", { name: "简", exact: true }).click();
      assert.ok((await family.locator("select option").allTextContents()).includes("母亲"));
      assert.equal(await family.locator("select[name=relationship]").inputValue(), "母亲");
      assert.equal(await family.locator("select[name=grade]").inputValue(), "小学四至六年级");
      assert.equal(f.writes(), 1);
    } finally { await f.context.close(); }
  });
  await check("existing-login-error-switches-language-without-resubmitting", async () => {
    const f = await fixture("zh-CN");
    try {
      await f.page.locator("input[name=username]").fill("synthetic-invalid-user");
      await f.page.locator("input[name=password]").fill("synthetic-invalid-password");
      await f.page.getByRole("button", { name: "登录", exact: true }).click();
      await f.page.locator(".error-notice").waitFor();
      assert.match(await f.page.locator(".error-notice").innerText(), /账号或密码不正确/);
      await f.page.getByRole("button", { name: "繁", exact: true }).click();
      assert.doesNotMatch(await f.page.locator(".error-notice").innerText(), /账号|密码/);
      assert.match(await f.page.locator(".error-notice").innerText(), /賬號|帳號/);
      await f.page.getByRole("button", { name: "简", exact: true }).click();
      assert.match(await f.page.locator(".error-notice").innerText(), /账号或密码不正确/);
      assert.equal(f.writes(), 1);
    } finally { await f.context.close(); }
  });
  for (const [role, name] of [["parent", "我是家長"], ["student", "我是學生"], ["teacher", "我是老師"]] as const) await check(`${role}-history-and-memory-only-draft`, async () => {
    const f = await fixture();
    try {
      await f.page.getByRole("button", { name: new RegExp(name) }).click();
      assert.equal(new URL(f.page.url()).hash, `#onboarding/${role}`);
      const form = f.page.locator("form:visible");
      await form.locator("input[name=name]").fill("合成暫存姓名");
      await form.locator("input[name=username]").fill("synthetic-draft-user");
      await form.locator("input[name=password]").fill("synthetic-only-password");
      await f.page.goBack();
      await f.page.getByRole("heading", { name: "選擇你的入口", exact: true }).waitFor();
      assert.equal(new URL(f.page.url()).origin, base);
      await f.page.goForward();
      await f.page.getByRole("heading", { name, exact: true }).waitFor();
      assert.equal(await form.locator("input[name=name]").inputValue(), "合成暫存姓名");
      assert.equal(await form.locator("input[name=username]").inputValue(), "synthetic-draft-user");
      assert.equal(await form.locator("input[name=password]").inputValue(), "");
      const storage = await f.page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, state: history.state }));
      assert.doesNotMatch(storage, /合成暫存姓名|synthetic-draft-user|synthetic-only-password/);
      await form.getByRole("button", { name: "返回", exact: true }).click();
      await f.page.getByRole("heading", { name: "選擇你的入口", exact: true }).waitFor();
      await f.page.getByRole("button", { name: new RegExp(name) }).click();
      assert.equal(await form.locator("input[name=username]").inputValue(), "synthetic-draft-user");
      assert.equal(await form.locator("input[name=password]").inputValue(), "");
      assert.equal(f.writes(), 0);
    } finally { await f.context.close(); }
  });
  await check("direct-role-url-back-and-reload", async () => {
    const f = await fixture();
    try {
      await f.page.goto(base + "/#onboarding/teacher");
      await f.page.getByRole("heading", { name: "我是老師", exact: true }).waitFor();
      await f.page.locator("form:visible input[name=username]").fill("synthetic-reload-draft");
      await f.page.locator("form:visible input[name=password]").fill("synthetic-reload-password");
      await f.page.reload();
      await f.page.getByRole("heading", { name: "我是老師", exact: true }).waitFor();
      assert.equal(await f.page.locator("form:visible input[name=username]").inputValue(), "");
      assert.equal(await f.page.locator("form:visible input[name=password]").inputValue(), "");
      await f.page.getByRole("button", { name: "返回", exact: true }).click();
      await f.page.getByRole("heading", { name: "選擇你的入口", exact: true }).waitFor();
      assert.equal(new URL(f.page.url()).origin, base);
    } finally { await f.context.close(); }
  });
  await check("role-drafts-stay-separate-without-persisting-passwords", async () => {
    const f = await fixture();
    try {
      for (const [role, name] of [["parent", "我是家長"], ["student", "我是學生"], ["teacher", "我是老師"]] as const) {
        await f.page.getByRole("button", { name: new RegExp(name) }).click();
        const form = f.page.locator("form:visible");
        assert.equal(await form.locator("input[name=username]").inputValue(), "");
        await form.locator("input[name=username]").fill(`synthetic-${role}-draft`);
        await form.locator("input[name=password]").fill("synthetic-private-password");
        await form.getByRole("button", { name: "返回", exact: true }).click();
        await f.page.getByRole("heading", { name: "選擇你的入口", exact: true }).waitFor();
      }
      await f.page.getByRole("button", { name: /我是家長/ }).click();
      assert.equal(await f.page.locator("form:visible input[name=username]").inputValue(), "synthetic-parent-draft");
      assert.equal(await f.page.locator("form:visible input[name=password]").inputValue(), "");
      assert.equal(await f.page.locator("form:visible").count(), 1);
      const storage = await f.page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, state: history.state }));
      assert.doesNotMatch(storage, /synthetic-(parent|student|teacher)-draft|synthetic-private-password/);
      assert.equal(f.writes(), 0);
    } finally { await f.context.close(); }
  });
  await check("pending-login-error-uses-current-locale", async () => {
    const f = await fixture("zh-CN");
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    try {
      await f.page.route("**/api/auth/login?*", async route => {
        f.state.writes.push({ path: "/api/auth/login", body: route.request().postDataJSON() });
        await pending;
        await route.fulfill({ status: 401, json: { error: "账号或密码不正确。", code: "INVALID_CREDENTIALS" } });
      });
      await f.page.locator("input[name=username]").fill("synthetic-invalid");
      await f.page.locator("input[name=password]").fill("synthetic-invalid-password");
      const requested = f.page.waitForRequest(request => new URL(request.url()).pathname === "/api/auth/login");
      await f.page.getByRole("button", { name: "登录", exact: true }).click(); await requested;
      await f.page.getByRole("button", { name: "繁", exact: true }).click();
      release();
      await f.page.locator(".error-notice").waitFor();
      assert.match(await f.page.locator(".error-notice").innerText(), /密碼不正確/);
      assert.equal(f.writes(), 1);
    } finally { release(); await f.context.close(); }
  });
  await check("policy-load-failure-retry-preserves-draft", async () => {
    const f = await fixture(); let attempts = 0; let failing = true;
    try {
      const family = await registerParent(f);
      await family.locator("input[name=childName]").fill("合成政策重試");
      await f.page.route("**/api/privacy?*", route => { attempts++; return failing
        ? route.fulfill({ status: 503, json: { error: "服务暂时未能响应，请重试。" } })
        : route.fulfill({ json: privacyNotice("HK", "zh-HK", "SG") }); });
      const policy = family.getByRole("button", { name: "私隱與知情同意", exact: true });
      await policy.click();
      await f.page.getByRole("button", { name: "重新載入", exact: true }).waitFor();
      failing = false;
      await f.page.getByRole("button", { name: "重新載入", exact: true }).click();
      await closePrivacy(f, policy, "Escape");
      assert.equal(await family.locator("input[name=childName]").inputValue(), "合成政策重試");
      assert.equal(await family.getByRole("checkbox").isChecked(), false);
      assert.ok(attempts >= 2); assert.equal(f.writes(), 1);
    } finally { await f.context.close(); }
  });
  for (const authProvider of ["local", "clerk"] as const) await check(authProvider === "local" ? "synthetic-parent-submit-keeps-contract-and-clears-onboarding" : "synthetic-clerk-profile-then-family-contract", async () => {
    const f = await fixture("zh-HK", authProvider);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    try {
      const family = await registerParent(f, authProvider);
      assert.equal(f.writes(), 1);
      const accountWrite = f.state.writes[0];
      assert.deepEqual(accountWrite, { path: authProvider === "local" ? "/api/auth/register" : "/api/auth/profile", body: { name: "合成家長", role: "parent", ...(authProvider === "local" ? { username: "synthetic-signup", password: "synthetic-local-password" } : {}) } });
      assert.equal(await f.page.locator("input[name=password]").count(), 0);
      assert.equal(await f.page.locator("input[name=name]").count(), 0);
      await family.locator("input[name=childName]").fill("合成孩子");
      await family.locator("input[name=birthDate]").fill("2014-01-01");
      const submit = family.getByRole("button", { name: "填寫家庭情況", exact: true });
      await submit.click();
      assert.equal(f.writes(), 1, "Missing guardian consent must block family enrollment");
      await family.getByRole("checkbox").check();
      f.state.familySuccess = true;
      let familyRequests = 0;
      await f.page.route("**/api/triad/family?*", async route => { familyRequests++; await pending; await route.fallback(); });
      const requested = f.page.waitForRequest(request => new URL(request.url()).pathname === "/api/triad/family");
      await submit.click(); await requested;
      assert.equal(await submit.isDisabled(), true);
      // A second native submit event while busy must not issue another request.
      await family.dispatchEvent("submit", { bubbles: true, cancelable: true });
      release();
      await f.page.getByText("TOPE-A2B3C4D5", { exact: true }).waitFor();
      assert.equal(familyRequests, 1, "Only one family request may be sent while submission is pending");
      assert.equal(f.writes(), 2, "Exactly one account/profile request and one family request");
      const input = f.state.writes[1].body;
      assert.match(String(input.requestId), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert.deepEqual(input, { requestId: input.requestId, relationship: "母亲", childName: "合成孩子", birthDate: "2014-01-01", grade: "小学四至六年级", accepted: true });
      assert.equal(f.state.writes.some(write => write.path === "/api/triad/parent"), false);
      await f.page.locator(".family-entry").getByRole("button", { name: "關閉", exact: true }).click();
      await f.page.getByRole("button", { name: "登出", exact: true }).waitFor();
      assert.equal(new URL(f.page.url()).hash, "");
      assert.equal(await f.page.locator("input[name=password], input[name=name], input[name=parentName]").count(), 0);
      assert.equal(await f.page.locator(".family-entry form").count(), 0);
      const storage = await f.page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, state: history.state }));
      assert.doesNotMatch(storage, /synthetic-signup|synthetic-local-password|合成家長|合成孩子/);
    } finally { release(); await f.context.close(); }
  });
} finally {
  await browser.close();
  const passed = results.every(result => result.passed) && errors.length === 0;
  await writeFile(`${output}/results.json`, JSON.stringify({ historicalBaselineMode: "retired", contract: "account/profile then family enrollment", passed, results, errors }, null, 2));
  console.log(JSON.stringify({ passed, checks: results.length, results, errors }));
  if (!passed) process.exitCode = 1;
}
