import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Locator } from "playwright";
import { privacyNotice } from "../src/lib/privacy";

const base = process.env.NOVA_BROWSER_BASE_URL || "http://127.0.0.1:3213";
const url = new URL(base);
assert.ok(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname));
const phase = process.env.NOVA_REVIEW_PHASE || "green";
assert.ok(["red", "green"].includes(phase));
const output = process.env.NOVA_REVIEW_OUTPUT || `work/qa/privacy-identity/${phase}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.NOVA_CHROMIUM_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const results: { name: string; passed: boolean; error?: string }[] = [];
try {
  for (const locale of ["zh-CN", "zh-HK"] as const) for (const mobile of [false, true]) {
    const name = `${locale}-${mobile ? "mobile" : "desktop"}`;
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile });
    context.setDefaultTimeout(10000);
    await context.addInitScript(value => { if (!localStorage.getItem("nova-locale")) localStorage.setItem("nova-locale", value); }, locale);
    const errors: string[] = [], writes: string[] = [];
    let waiting = false, privacyReads = 0;
    let release!: () => void, started!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const requested = new Promise<void>(resolve => { started = resolve; });
    await context.route("**/*", async route => {
      const request = route.request(), target = new URL(request.url());
      if (target.origin !== base) return route.abort();
      if (!target.pathname.startsWith("/api/")) return route.continue();
      if (request.method() !== "GET") writes.push(target.pathname);
      if (target.pathname === "/api/session") {
        if (waiting) { started(); await pending; }
        return route.fulfill({ json: { user: null, region: "HK", mode: "service", demoAccounts: [], siblingUrl: null, authProvider: "clerk", identityState: "signed_out", testAccountLoginEnabled: true } }).catch(() => undefined);
      }
      if (target.pathname === "/api/privacy") {
        privacyReads++;
        return route.fulfill({ json: privacyNotice("HK", target.searchParams.get("locale") === "zh-HK" ? "zh-HK" : "zh-CN", "SG", "clerk") });
      }
      return route.fulfill({ status: 404, json: { error: "Synthetic missing endpoint" } });
    });
    const page = await context.newPage();
    const activate = (locator: Locator) => mobile ? locator.tap() : locator.click();
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto(base);
      await page.locator(".test-account-login").waitFor();
      const other = locale === "zh-CN" ? "zh-HK" : "zh-CN";
      await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === "/api/session" && response.url().includes(other)), page.getByRole("button", { name: locale === "zh-CN" ? "繁" : "简", exact: true }).click()]);
      await page.reload(); await page.locator(".test-account-login").waitFor();
      assert.equal(await page.locator("html").getAttribute("lang"), other);
      await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === "/api/session" && response.url().includes(locale)), page.getByRole("button", { name: locale === "zh-CN" ? "简" : "繁", exact: true }).click()]);
      await activate(page.locator(".login-privacy"));
      await page.locator(".privacy-content").waitFor();
      const initialPrivacyReads = privacyReads;
      const dialog = await page.locator("dialog").elementHandle();
      waiting = true;
      await page.evaluate(() => window.dispatchEvent(new Event("nova-identity-change")));
      await requested;
      assert.equal(await page.locator("dialog[open]").count(), 1, "Public privacy must remain open while signed-out identity verification is pending");
      assert.equal(await page.locator(".test-account-login .button.primary").isDisabled(), true);
      await page.locator(".test-account-login form").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      assert.deepEqual(writes, []);
      await page.locator("dialog").evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
      await page.screenshot({ path: `${output}/${name}-pending.png`, fullPage: true });
      release(); waiting = false;
      await page.locator(".test-account-login .button.primary:not([disabled])").waitFor();
      await page.locator(".privacy-content").waitFor();
      assert.equal(await dialog!.evaluate(element => element.isConnected), true, "The same public dialog must remain mounted");
      assert.equal(privacyReads, initialPrivacyReads, "Identity verification must not remount/reload the public notice");
      await page.keyboard.press("Escape");
      await page.locator("dialog").waitFor({ state: "detached" });
      assert.equal(await page.locator(".login-privacy").evaluate(element => element === document.activeElement), true);
      await activate(page.locator(".login-privacy")); await page.locator(".privacy-content").waitFor();
      await activate(page.locator(".modal-header button")); await page.locator("dialog").waitFor({ state: "detached" });
      assert.equal(await page.locator(".login-privacy").evaluate(element => element === document.activeElement), true);
      assert.deepEqual(errors, []);
      results.push({ name, passed: true });
    } catch (error) {
      await page.screenshot({ path: `${output}/${name}-failed.png`, fullPage: true });
      results.push({ name, passed: false, error: String(error) });
    } finally { release(); await context.close(); }
    console.log(`${results.at(-1)!.passed ? "PASS" : "FAIL"} ${name}${results.at(-1)!.error ? `: ${results.at(-1)!.error}` : ""}`);
  }
} finally {
  await browser.close();
  await writeFile(`${output}/results.json`, JSON.stringify({ base, phase, scope: "Local browser UI with synthetic API responses and an injected identity-change event; no live Clerk provider or production mutation", passed: results.every(result => result.passed), results }, null, 2));
}
if (results.some(result => !result.passed)) process.exitCode = 1;
