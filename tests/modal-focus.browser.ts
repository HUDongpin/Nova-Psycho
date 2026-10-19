import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { privacyNotice } from "../src/lib/privacy";

const base = process.env.NOVA_BROWSER_BASE_URL || "http://127.0.0.1:3197";
const url = new URL(base);
assert.ok(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname));
const phase = process.env.NOVA_REVIEW_PHASE || "fixed";
assert.ok(["baseline", "fixed"].includes(phase));
const output = `work/qa/modal-focus/${phase}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.NOVA_CHROMIUM_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const results: { name: string; passed: boolean; error?: string }[] = [];
try {
  for (const authProvider of ["local", "clerk"] as const) for (const close of ["Escape", "button"] as const) for (const delivery of ["loaded", "pending"] as const) {
    const name = `${authProvider}-${close}-${delivery}`;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const context = await browser.newContext();
    context.setDefaultTimeout(10000);
    context.setDefaultNavigationTimeout(30000);
    await context.addInitScript(() => localStorage.setItem("nova-locale", "zh-HK"));
    await context.route("**/*", async route => {
      const request = new URL(route.request().url());
      if (request.origin !== base) return route.abort();
      if (!request.pathname.startsWith("/api/")) return route.continue();
      if (request.pathname === "/api/session") return route.fulfill({ json: { user: null, region: "HK", mode: "service", demoAccounts: [], siblingUrl: null, authProvider, identityState: "signed_out" } });
      if (request.pathname === "/api/privacy") {
        if (delivery === "pending") await pending;
        return route.fulfill({ json: privacyNotice("HK", "zh-HK", "SG") }).catch(() => undefined);
      }
      return route.fulfill({ status: 404, json: { error: "Synthetic missing route", code: "NOT_FOUND" } });
    });
    const page = await context.newPage();
    try {
      await page.goto(base);
      const opener = page.getByRole("button", { name: "私隱與知情同意", exact: true });
      await opener.focus(); await opener.press("Enter");
      await page.waitForFunction(() => document.querySelector("dialog")?.open);
      const dialog = page.getByRole("dialog");
      await dialog.locator(delivery === "pending" ? ".loading-state" : ".privacy-content").waitFor();
      assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true);
      if (close === "Escape") await page.keyboard.press("Escape");
      else await dialog.getByRole("button", { name: "關閉", exact: true }).press("Enter");
      await dialog.waitFor({ state: "detached" });
      assert.equal(await opener.evaluate(element => element === document.activeElement), true, "Focus must return to the privacy opener");
      results.push({ name, passed: true });
    } catch (error) { results.push({ name, passed: false, error: String(error) }); }
    finally { release(); await context.close(); }
    console.log(`${results.at(-1)!.passed ? "PASS" : "FAIL"} ${name}`);
  }
  for (const locale of ["zh-CN", "zh-HK"] as const) for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) for (const clicks of [1, 2]) {
    const name = `${locale}-${viewport.width}-${clicks === 1 ? "single" : "double"}-open-delayed-policy`;
    const context = await browser.newContext({ viewport });
    context.setDefaultTimeout(10000);
    context.setDefaultNavigationTimeout(30000);
    await context.addInitScript(value => localStorage.setItem("nova-locale", value), locale);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const unexpectedRequests: string[] = [];
    await context.route("**/*", async route => {
      const request = route.request(), target = new URL(request.url());
      if (target.origin !== base) return route.abort();
      if (!target.pathname.startsWith("/api/")) return route.continue();
      if (request.method() !== "GET") unexpectedRequests.push(`${request.method()} ${target.pathname}`);
      if (target.pathname === "/api/session") return route.fulfill({ json: { user: null, region: "HK", mode: "service", demoAccounts: [], siblingUrl: null, authProvider: "clerk", identityState: "signed_out" } });
      if (target.pathname === "/api/privacy") {
        await pending;
        return route.fulfill({ json: privacyNotice("HK", locale, "SG", "clerk") }).catch(() => undefined);
      }
      unexpectedRequests.push(target.pathname);
      return route.fulfill({ status: 404, json: { error: "Synthetic missing route", code: "NOT_FOUND" } });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto(base);
      const opener = page.getByRole("button", { name: locale === "zh-HK" ? "私隱與知情同意" : "隐私与知情同意", exact: true });
      await opener.waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Entry must fit the viewport");
      await opener.click({ clickCount: clicks });
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("status").waitFor();
      await dialog.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
      const close = dialog.getByRole("button", { name: locale === "zh-HK" ? "關閉" : "关闭", exact: true });
      const before = await close.boundingBox();
      assert.ok(before);
      await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
      if (clicks === 1) await page.screenshot({ path: `${output}/${locale}-${viewport.width}-loading.png` });
      release();
      await dialog.locator(".privacy-content").waitFor();
      const after = await close.boundingBox();
      assert.ok(after);
      const bounds = await dialog.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height);
      assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true, "Policy must not overflow horizontally");
      if (clicks === 1) await page.screenshot({ path: `${output}/${locale}-${viewport.width}-loaded.png` });
      await writeFile(`${output}/${name}-position.json`, JSON.stringify({ before, after }, null, 2));
      await page.mouse.click(before.x + before.width / 2, before.y + before.height / 2);
      assert.equal(await dialog.count(), 0, "A pointer aimed at Close while loading must still close after policy arrives");
      assert.ok(Math.abs(after.x - before.x) <= 1 && Math.abs(after.y - before.y) <= 1, `Close moved from (${before.x}, ${before.y}) to (${after.x}, ${after.y})`);
      assert.equal(await opener.evaluate(element => element === document.activeElement), true, "Pointer dismissal must restore opener focus");
      assert.deepEqual(errors, []);
      assert.deepEqual(unexpectedRequests, []);
      results.push({ name, passed: true });
    } catch (error) { results.push({ name, passed: false, error: String(error) }); }
    finally { release(); await context.close(); }
    console.log(`${results.at(-1)!.passed ? "PASS" : "FAIL"} ${name}${results.at(-1)!.error ? `: ${results.at(-1)!.error}` : ""}`);
  }
} finally {
  await browser.close();
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
}
if (results.some(result => !result.passed)) process.exitCode = 1;
