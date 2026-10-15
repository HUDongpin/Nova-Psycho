import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.NOVA_BROWSER_BASE_URL || "http://127.0.0.1:3197";
const url = new URL(base);
assert.ok(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname));
const phase = process.env.NOVA_REVIEW_PHASE || "fixed";
assert.ok(["baseline", "fixed"].includes(phase));
const output = `work/qa/account-revocation/${phase}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.NOVA_CHROMIUM_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const results: { name: string; passed: boolean; error?: string }[] = [];
try {
  for (const endpoint of ["workspace", "session"] as const) for (const code of ["ACCOUNT_REVOKED", "ROLE_DENIED"] as const) {
    const name = `${endpoint}-${code}`;
    const context = await browser.newContext();
    context.setDefaultTimeout(10000);
    await context.addInitScript(() => localStorage.setItem("nova-locale", "zh-HK"));
    const page = await context.newPage();
    let rejected = false, errorRequests = 0;
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const user = { id: "synthetic-parent", name: "Synthetic private parent", role: "parent", region: "HK" };
    await context.route("**/*", async route => {
      const request = new URL(route.request().url());
      if (request.origin !== base) return route.abort();
      if (!request.pathname.startsWith("/api/")) return route.continue();
      if (rejected && request.pathname === `/api/${endpoint}`) {
        errorRequests++;
        return route.fulfill({ status: 403, json: { error: code, code } });
      }
      if (request.pathname === "/api/session") return route.fulfill({ json: { user, region: "HK", mode: "service", demoAccounts: [], siblingUrl: null, authProvider: "clerk", identityState: "ready" } });
      if (request.pathname === "/api/workspace") return route.fulfill({ json: { user, region: "HK", mode: "service", families: [], assessments: [], reports: [], scales: [], goals: [], observations: [], staff: [], contentVersions: [], alerts: [], staffNotes: [], summary: {} } });
      return route.fulfill({ status: 404, json: { error: "Synthetic missing route", code: "NOT_FOUND" } });
    });
    try {
      await page.goto(base);
      await page.locator(".app-shell").waitFor();
      assert.ok((await page.locator(".app-shell").innerText()).includes(user.name));
      rejected = true;
      if (endpoint === "workspace") await page.locator(".refresh-button").click();
      else await page.evaluate(() => window.dispatchEvent(new Event("nova-identity-change")));
      if (code === "ACCOUNT_REVOKED") {
        await page.locator(".app-shell").waitFor({ state: "detached" });
        assert.equal(await page.locator(".app-shell").count(), 0, "Revocation must remove the private workspace");
        assert.equal((await page.locator("body").innerText()).includes(user.name), false);
      } else {
        await page.getByRole("alert").filter({ hasText: code }).first().waitFor();
        // A permission denial on an ordinary workspace read preserves its owner.
        // An identity-change event has already invalidated that owner, regardless
        // of why the subsequent session verification fails.
        assert.equal(await page.locator(".app-shell").count(), endpoint === "session" ? 0 : 1, "Unverified identity changes must remain private; ordinary workspace denials preserve the verified owner");
      }
      assert.ok(errorRequests > 0);
      assert.deepEqual(errors, []);
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: String(error) });
      await page.screenshot({ path: `${output}/${name}.png` });
    } finally { await context.close(); }
    console.log(`${results.at(-1)!.passed ? "PASS" : "FAIL"} ${name}${results.at(-1)!.error ? `: ${results.at(-1)!.error}` : ""}`);
  }
  for (const code of ["ACCOUNT_REVOKED", "ROLE_DENIED"] as const) {
    const name = `autosave-${code}`;
    const context = await browser.newContext();
    context.setDefaultTimeout(10000);
    await context.addInitScript(() => localStorage.setItem("nova-locale", "zh-HK"));
    const user = { id: "synthetic-student", name: "Synthetic private student", role: "student", region: "HK" };
    let saves = 0;
    await context.route("**/*", async route => {
      const request = new URL(route.request().url());
      if (request.origin !== base) return route.abort();
      if (!request.pathname.startsWith("/api/")) return route.continue();
      if (request.pathname === "/api/session") return route.fulfill({ json: { user, region: "HK", mode: "service", demoAccounts: [], siblingUrl: null, authProvider: "clerk", identityState: "ready" } });
      if (request.pathname === "/api/workspace") return route.fulfill({ json: { user, region: "HK", mode: "service", families: [], assessments: [], reports: [], scales: [], goals: [], observations: [], staff: [], contentVersions: [], alerts: [], staffNotes: [], summary: {} } });
      if (request.pathname === "/api/assessments/synthetic-draft") {
        if (route.request().method() === "PATCH") { saves++; return route.fulfill({ status: 403, json: { error: code, code } }); }
        return route.fulfill({ json: { id: "synthetic-draft", status: "pending", childName: "Synthetic private child", scaleTitle: "Synthetic survey", demo: true, description: "Synthetic only", surveyJson: { pages: [{ name: "p", elements: [{ type: "radiogroup", name: "q1", title: "Synthetic question", choices: [{ value: 1, text: "Synthetic answer" }], isRequired: true }] }] }, draftAnswers: {}, draftRevision: 0, consentRequired: false } });
      }
      return route.fulfill({ status: 404, json: { error: "Synthetic missing route", code: "NOT_FOUND" } });
    });
    const page = await context.newPage();
    try {
      await page.goto(base + "/#assessment/synthetic-draft");
      await page.locator(".survey-assent-panel input").check();
      await page.getByText("Synthetic answer", { exact: true }).click();
      if (code === "ACCOUNT_REVOKED") {
        await page.locator(".app-shell").waitFor({ state: "detached" });
        assert.equal((await page.locator("body").innerText()).includes(user.name), false);
        assert.equal(await page.locator(".draft-recovery-notice").count(), 1, "Retain the suspended unsaved draft for its owner");
      } else {
        await page.getByRole("alert").filter({ hasText: code }).first().waitFor();
        assert.equal(await page.locator(".app-shell").count(), 1);
      }
      assert.equal(saves, 1);
      results.push({ name, passed: true });
    } catch (error) { results.push({ name, passed: false, error: String(error) }); }
    finally { await context.close(); }
    console.log(`${results.at(-1)!.passed ? "PASS" : "FAIL"} ${name}${results.at(-1)!.error ? `: ${results.at(-1)!.error}` : ""}`);
  }
} finally {
  await browser.close();
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
}
if (results.some(result => !result.passed)) process.exitCode = 1;
