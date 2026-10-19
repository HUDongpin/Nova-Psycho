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
  for (const authProvider of ["local", "clerk"] as const) for (const close of ["Escape", "button"] as const) {
    const name = `${authProvider}-${close}`;
    const context = await browser.newContext();
    context.setDefaultTimeout(10000);
    await context.addInitScript(() => localStorage.setItem("nova-locale", "zh-HK"));
    await context.route("**/*", async route => {
      const request = new URL(route.request().url());
      if (request.origin !== base) return route.abort();
      if (!request.pathname.startsWith("/api/")) return route.continue();
      if (request.pathname === "/api/session") return route.fulfill({ json: { user: null, region: "HK", mode: "service", demoAccounts: [], siblingUrl: null, authProvider, identityState: "signed_out" } });
      if (request.pathname === "/api/privacy") return route.fulfill({ json: privacyNotice("HK", "zh-HK", "SG") });
      return route.fulfill({ status: 404, json: { error: "Synthetic missing route", code: "NOT_FOUND" } });
    });
    const page = await context.newPage();
    try {
      await page.goto(base);
      const opener = page.getByRole("button", { name: "私隱與知情同意", exact: true });
      await opener.focus(); await opener.press("Enter");
      await page.waitForFunction(() => document.querySelector("dialog")?.open);
      const dialog = page.getByRole("dialog");
      assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true);
      if (close === "Escape") await page.keyboard.press("Escape");
      else await dialog.getByRole("button", { name: "關閉", exact: true }).press("Enter");
      await dialog.waitFor({ state: "detached" });
      assert.equal(await opener.evaluate(element => element === document.activeElement), true, "Focus must return to the privacy opener");
      results.push({ name, passed: true });
    } catch (error) { results.push({ name, passed: false, error: String(error) }); }
    finally { await context.close(); }
    console.log(`${results.at(-1)!.passed ? "PASS" : "FAIL"} ${name}`);
  }
} finally {
  await browser.close();
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
}
if (results.some(result => !result.passed)) process.exitCode = 1;
