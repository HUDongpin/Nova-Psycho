import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Route } from "playwright";
import type { Session } from "../src/components/api";

const base = process.env.NOVA_BROWSER_BASE_URL || "http://127.0.0.1:3197";
assert.ok(["http://127.0.0.1:3197", "http://127.0.0.1:3198"].includes(base));
const phase = process.env.NOVA_REVIEW_PHASE || "green";
assert.ok(["red", "green", "production"].includes(phase));
const output = `work/qa/review-pass2/invite/${phase}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.NOVA_CHROMIUM_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const results: { name: string; passed: boolean; error?: string }[] = [];
function session(name: string): Session {
  return { user: { id: name, name, role: "teacher", region: "HK" }, region: "HK", mode: "service", demoAccounts: [], siblingUrl: null, authProvider: "clerk", identityState: "ready" };
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function fixture(initial = session("Synthetic account A"), initialGate?: ReturnType<typeof gate>) {
  const context = await browser.newContext();
  context.setDefaultTimeout(5000);
  await context.addInitScript(() => localStorage.setItem("nova-locale", "zh-HK"));
  const state = { requests: 0, writes: 0, pending: 0, errors: [] as string[], mutate: async (route: Route) => { await route.fulfill({ status: 409, json: { error: "Synthetic mutation blocked", code: "CONFLICT" } }); }, read: async (route: Route) => {
    if (initialGate) await initialGate.promise;
    await route.fulfill({ json: initial });
  } };
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (route.request().method() !== "GET") { state.writes++; return state.mutate(route); }
    if (url.pathname === "/api/session") {
      state.requests++; state.pending++;
      try { await state.read(route); } finally { state.pending--; }
      return;
    }
    if (url.pathname === "/api/invite") return route.fulfill({ json: { familyName: "Synthetic invitation family", role: "teacher", region: "HK", expiresAt: "2030-01-01T00:00:00Z" } });
    return route.fulfill({ status: 404, json: { error: "Synthetic missing endpoint" } });
  });
  const page = await context.newPage();
  page.on("pageerror", error => state.errors.push(error.message));
  await page.goto(base + "/invite#token=synthetic-invitation-token", { timeout: 30000 });
  return { context, page, state };
}
async function until(test: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!test()) { assert.ok(Date.now() < deadline, "Controlled request did not complete"); await new Promise(resolve => setTimeout(resolve, 20)); }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function change(f: Fixture) {
  const count = f.state.requests;
  await f.page.evaluate(() => window.dispatchEvent(new Event("nova-identity-change")));
  await until(() => f.state.requests > count);
}
async function settled(f: Fixture) {
  await until(() => f.state.pending === 0);
  // Let the delivered fetch JSON and React render settle after the controlled responses.
  await f.page.waitForTimeout(100);
}
async function check(name: string, run: () => Promise<void>) {
  try { await run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); }
  console.log(`${results.at(-1)!.passed ? "PASS" : "FAIL"} ${name}${results.at(-1)!.error ? `: ${results.at(-1)!.error}` : ""}`);
}
try {
  await check("initial-session-cannot-overwrite-newer-identity", async () => {
    const pending = gate(), f = await fixture(session("Synthetic account A"), pending);
    try {
      await until(() => f.state.requests > 0);
      f.state.read = async route => { await route.fulfill({ json: session("Synthetic account B") }); };
      await change(f);
      pending.release(); await settled(f);
      assert.match(await f.page.locator(".invite-card").innerText(), /Synthetic account B/);
      assert.doesNotMatch(await f.page.locator(".invite-card").innerText(), /Synthetic account A/);
      assert.equal(f.state.writes, 0); assert.deepEqual(f.state.errors, []);
    } finally { pending.release(); await f.context.close(); }
  });
  await check("older-identity-refresh-cannot-overwrite-latest", async () => {
    const pending = gate(), f = await fixture();
    try {
      await f.page.getByText(/Synthetic account A/).waitFor();
      f.state.read = async route => { await pending.promise; await route.fulfill({ json: session("Synthetic account B") }); };
      await change(f);
      f.state.read = async route => { await route.fulfill({ json: session("Synthetic account C") }); };
      await change(f);
      await f.page.getByText(/Synthetic account C/).waitFor();
      pending.release(); await settled(f);
      assert.match(await f.page.locator(".invite-card").innerText(), /Synthetic account C/);
      assert.doesNotMatch(await f.page.locator(".invite-card").innerText(), /Synthetic account [AB]/);
      assert.equal(f.state.writes, 0); assert.deepEqual(f.state.errors, []);
    } finally { pending.release(); await f.context.close(); }
  });
  await check("identity-refresh-blocks-stale-acceptance-and-failure-can-retry", async () => {
    const pending = gate(), f = await fixture();
    try {
      await f.page.getByText(/Synthetic account A/).waitFor();
      f.state.read = async route => { await pending.promise; await route.fulfill({ status: 503, json: { error: "Synthetic session unavailable" } }); };
      await change(f);
      const accept = f.page.getByRole("button", { name: "接受家庭邀請", exact: true });
      assert.ok(await accept.count() === 0 || await accept.isDisabled(), "Identity refresh must block acceptance under the stale displayed account");
      assert.doesNotMatch(await f.page.locator(".invite-card").innerText(), /Synthetic account A/);
      pending.release(); await settled(f);
      await f.page.getByRole("alert").filter({ hasText: "Synthetic session unavailable" }).waitFor();
      assert.equal(await accept.count(), 0);
      f.state.read = async route => { await route.fulfill({ json: session("Synthetic account B") }); };
      await f.page.getByRole("button", { name: "重新載入", exact: true }).click();
      await f.page.getByText(/Synthetic account B/).waitFor();
      assert.equal(await accept.isEnabled(), true);
      assert.equal(f.state.writes, 0); assert.deepEqual(f.state.errors, []);
    } finally { pending.release(); await f.context.close(); }
  });
  await check("previous-identity-acceptance-cannot-redirect-current-account", async () => {
    const pending = gate(), f = await fixture();
    try {
      await f.page.getByText(/Synthetic account A/).waitFor();
      f.state.mutate = async route => { await pending.promise; await route.fulfill({ json: { ok: true } }); };
      await f.page.getByRole("button", { name: "接受家庭邀請", exact: true }).click();
      await until(() => f.state.writes === 1);
      f.state.read = async route => { await route.fulfill({ json: session("Synthetic account B") }); };
      await change(f); await f.page.getByText(/Synthetic account B/).waitFor();
      const response = f.page.waitForResponse(response => response.request().method() === "POST");
      pending.release(); await response; await settled(f);
      assert.equal(new URL(f.page.url()).pathname, "/invite");
      assert.match(await f.page.locator(".invite-card").innerText(), /Synthetic account B/);
      assert.ok(await f.page.evaluate(() => sessionStorage.getItem("nova-pending-invitation")));
      assert.equal(f.state.writes, 1); assert.deepEqual(f.state.errors, []);
    } finally { pending.release(); await f.context.close(); }
  });
  await check("current-identity-acceptance-clears-token-and-navigates", async () => {
    const f = await fixture();
    try {
      await f.page.getByText(/Synthetic account A/).waitFor();
      f.state.mutate = async route => {
        assert.deepEqual(route.request().postDataJSON(), { token: "synthetic-invitation-token" });
        await route.fulfill({ json: { ok: true } });
      };
      await f.page.getByRole("button", { name: "接受家庭邀請", exact: true }).click();
      await f.page.waitForURL(base + "/");
      assert.equal(await f.page.evaluate(() => sessionStorage.getItem("nova-pending-invitation")), null);
      assert.equal(f.state.writes, 1); assert.deepEqual(f.state.errors, []);
    } finally { await f.context.close(); }
  });
} finally {
  await browser.close();
  await writeFile(`${output}/results.json`, JSON.stringify({ passed: results.every(result => result.passed), results }, null, 2));
}
if (results.some(result => !result.passed)) process.exitCode = 1;
