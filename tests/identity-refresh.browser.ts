import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.NOVA_BROWSER_BASE_URL || "http://127.0.0.1:3197";
assert.ok(["http://127.0.0.1:3197", "http://127.0.0.1:3198"].includes(base));
const phase = process.env.NOVA_REVIEW_PHASE || "green";
assert.ok(["red", "green", "production"].includes(phase));
const output = `work/qa/review-pass3/identity/${phase}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.NOVA_CHROMIUM_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const results: { name: string; passed: boolean; error?: string }[] = [];
try {
  for (const scenario of ["changed-account", "read-failure", "dirty-same-owner", "dirty-different-owner"] as const) {
    const context = await browser.newContext(); context.setDefaultTimeout(5000);
    await context.addInitScript(() => localStorage.setItem("nova-locale", "zh-HK"));
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    const dirty = scenario.startsWith("dirty");
    const userA = { id: "synthetic-owner-a", name: "Synthetic private account A", role: dirty ? "student" : "parent", region: "HK" };
    const userB = { ...userA, id: "synthetic-owner-b", name: "Synthetic current account B" };
    let user = userA, waiting = false, failed = false, sessionReads = 0, writes = 0, revision = 0;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const record = { id: "synthetic-assessment", status: "pending", childName: "Synthetic private child", scaleTitle: "Synthetic survey", demo: true, description: "Synthetic only", surveyJson: { pages: [{ name: "p", elements: [{ type: "radiogroup", name: "q1", title: "Synthetic question", choices: [{ value: 1, text: "Synthetic retained answer" }, { value: 2, text: "Synthetic alternative" }], isRequired: true }] }] }, draftAnswers: {}, draftRevision: 0, consentRequired: false };
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (url.pathname === "/api/session") {
        sessionReads++;
        if (waiting) await pending;
        if (failed) return route.fulfill({ status: 503, json: { error: "Synthetic identity unavailable" } });
        return route.fulfill({ json: { user, region: "HK", mode: "service", demoAccounts: [], siblingUrl: null, authProvider: "clerk", identityState: "ready" } });
      }
      if (url.pathname === "/api/workspace") return route.fulfill({ json: { user, region: "HK", mode: "service", families: [], assessments: [], reports: [], scales: [], goals: [], observations: [], staff: [], contentVersions: [], alerts: [], staffNotes: [], summary: {} } });
      if (url.pathname === "/api/assessments/synthetic-assessment") {
        if (request.method() === "PATCH") { writes++; revision++; return route.fulfill({ json: { ok: true, revision } }); }
        return route.fulfill({ json: { ...record, draftRevision: revision } });
      }
      if (request.method() !== "GET") writes++;
      return route.fulfill({ status: 404, json: { error: "Synthetic missing endpoint" } });
    });
    try {
      await page.goto(base + (dirty ? "/#assessment/synthetic-assessment" : "/"), { timeout: 30000 });
      await page.getByText(userA.name, { exact: true }).waitFor();
      if (dirty) {
        await page.locator(".survey-assent-panel input").check();
        await page.getByText("Synthetic retained answer", { exact: true }).click();
      }
      waiting = true;
      const before = sessionReads;
      await page.evaluate(() => window.dispatchEvent(new Event("nova-identity-change")));
      const deadline = Date.now() + 5000;
      while (sessionReads === before) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 20)); }
      assert.equal(await page.locator(".app-shell").count(), 0, "An identity transition must immediately hide the previous private workspace");
      assert.doesNotMatch(await page.locator("body").innerText(), /Synthetic private account A|Synthetic private child/);
      if (dirty) { await page.waitForTimeout(750); assert.equal(writes, 0, "Pending identity verification must pause autosave"); }
      failed = scenario === "read-failure";
      if (scenario === "changed-account" || scenario === "dirty-different-owner") user = userB;
      release(); waiting = false;
      if (failed) {
        await page.getByRole("alert").filter({ hasText: "Synthetic identity unavailable" }).waitFor();
        assert.equal(await page.locator(".app-shell").count(), 0);
        failed = false; user = userB;
        await page.getByRole("button", { name: "重新載入", exact: true }).click();
      }
      if (scenario === "dirty-different-owner") {
        await page.locator(".draft-account-mismatch").waitFor();
        assert.equal(await page.locator(".app-shell").count(), 0);
        assert.equal(writes, 0);
      } else {
        await page.getByText(user.name, { exact: true }).waitFor();
        if (dirty) {
          const choice = page.locator('input[type="radio"][value="1"]');
          await choice.waitFor({ state: "attached" });
          assert.equal(await choice.isChecked(), true, "Same-owner verification must preserve the unsaved answer");
        } else assert.doesNotMatch(await page.locator(".app-shell").innerText(), /Synthetic private account A/);
      }
      assert.deepEqual(errors, []); results.push({ name: scenario, passed: true });
    } catch (error) { results.push({ name: scenario, passed: false, error: String(error) }); }
    finally { release(); await context.close(); }
    console.log(`${results.at(-1)!.passed ? "PASS" : "FAIL"} ${scenario}${results.at(-1)!.error ? `: ${results.at(-1)!.error}` : ""}`);
  }
} finally {
  await browser.close(); await writeFile(`${output}/results.json`, JSON.stringify({ passed: results.every(result => result.passed), results }, null, 2));
}
if (results.some(result => !result.passed)) process.exitCode = 1;
