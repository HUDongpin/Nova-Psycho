import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "playwright";

const base = process.env.NOVA_AUTH_REVIEW_URL ?? "http://localhost:3342";
assert.ok(new URL(base).protocol === "http:" && ["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const output = path.resolve(process.env.NOVA_AUTH_REVIEW_OUTPUT ?? "work/auth-redesign-20261021/browser");
assert.ok(output.startsWith(path.resolve("work") + path.sep));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.NOVA_CHROMIUM_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const checks: { name: string; passed: boolean; error?: string }[] = [];
const metrics: unknown[] = [];
async function check(name: string, run: () => Promise<void>) {
  try { await run(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, passed: false, error: error instanceof Error ? error.message : "Failed" }); throw error; }
}
async function layout(page: Page, width: number) {
  // Responsive srcset selection happens after a viewport layout, so wait for the new candidate.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>("main figure img");
    return image?.complete && image.naturalWidth > 0;
  });
  const result = await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>(".login-card")!;
    const figure = document.querySelector<HTMLElement>("main figure")!;
    const panel = document.querySelector<HTMLElement>("[data-auth-panel]")!;
    const visual = document.querySelector<HTMLElement>("[data-auth-visual]")!;
    const form = document.querySelector<HTMLElement>("[data-auth-form]")!;
    const input = [...card.querySelectorAll<HTMLInputElement>("input")].find(element => element.getBoundingClientRect().height > 0 && !element.hidden);
    const rect = card.getBoundingClientRect(), image = figure.getBoundingClientRect();
    return { width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, card: { x: rect.x, y: rect.y, width: rect.width, bottom: rect.bottom }, panel: panel.getBoundingClientRect().toJSON(), visual: visual.getBoundingClientRect().toJSON(), form: form.getBoundingClientRect().toJSON(), cardBorder: getComputedStyle(card).borderTopWidth, image: { y: image.y, x: image.x }, titleSize: getComputedStyle(card.querySelector("h1,h2")!).fontSize, input: input ? { fontSize: getComputedStyle(input).fontSize, border: getComputedStyle(input).borderColor, height: input.getBoundingClientRect().height } : null };
  });
  assert.equal(result.overflow, false, "No horizontal overflow");
  assert.ok(result.card.x >= 16 && result.card.x + result.card.width <= width - 16, "Card keeps viewport gutters");
  if (width < 960) assert.ok(result.image.y >= result.card.bottom, "Mobile form precedes the companion image");
  else {
    assert.ok(Math.abs(result.visual.y - result.form.y) < 1, "Desktop columns share a top edge");
    assert.ok(Math.abs(result.visual.bottom - result.form.bottom) < 1, "Desktop columns share a bottom edge");
    assert.ok(Math.abs(result.visual.right - result.form.x) < 1, "No disconnected gap between the illustration and form");
    assert.ok(Math.abs(result.visual.width / (result.panel.width - 2) - 0.56) < 0.01, "Approved 56/44 split");
    assert.equal(result.cardBorder, "0px", "The form has no nested card border");
  }
  if (result.input) { assert.equal(result.input.fontSize, "16px"); assert.ok(result.input.height >= 48); }
  metrics.push({ url: new URL(page.url()).pathname, ...result });
}

try {
  for (const locale of ["zh-CN", "zh-HK"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    await context.addInitScript(value => localStorage.setItem("nova-locale", value), locale);
    const page = await context.newPage();
    for (const route of ["/", "/sign-in", "/sign-up"]) {
      await page.goto(base + route, { waitUntil: "domcontentloaded" });
      await page.locator(route === "/" ? ".test-account-login summary" : ".cl-formFieldInput:visible").first().waitFor();
      if (route !== "/") await page.locator("[data-clerk-dev-mode-notice]").waitFor();
      for (const width of [1547, 1440, 1024, 768, 390, 320]) {
        await check(`${locale} ${route} ${width}px`, async () => {
          await page.setViewportSize({ width, height: width === 1547 ? 1016 : width < 768 ? 844 : 1000 });
          await page.locator('main figure img').evaluate(async image => { await (image as HTMLImageElement).decode(); });
          await layout(page, width);
          assert.equal(await page.locator("html").getAttribute("lang"), locale);
          if (route === "/") {
            assert.equal(await page.locator('.test-account-login input[name="username"]').isVisible(), false);
            assert.equal(await page.locator('.login-card > h2').innerText(), locale === "zh-HK" ? "歡迎來到 TopE" : "欢迎来到 TopE");
          } else assert.ok(await page.getByRole("link", { name: "Clerk logo" }).isVisible(), "Required Clerk branding stays visible");
          await page.screenshot({ path: path.join(output, `${route === "/" ? "home" : route.slice(1)}-${locale}-${width}.png`), fullPage: true, animations: "disabled" });
        });
      }
    }
    await check(`${locale} keyboard disclosure, privacy and 200% text`, async () => {
      await page.goto(base, { waitUntil: "domcontentloaded" });
      const summary = page.locator(".test-account-login summary"); await summary.waitFor();
      await summary.focus(); await page.keyboard.press("Enter");
      assert.equal(await page.locator(".test-account-login").getAttribute("open"), "");
      assert.equal(await page.locator('.test-account-login input[name="username"]').isVisible(), true);
      await page.keyboard.press("Tab");
      assert.equal(await page.locator('input[name="username"]').evaluate(element => element === document.activeElement), true);
      await page.locator(".login-privacy").click(); await page.locator("dialog .privacy-content").waitFor();
      await page.keyboard.press("Escape"); await page.locator("dialog").waitFor({ state: "detached" });
      assert.equal(await page.locator(".login-privacy").evaluate(element => element === document.activeElement), true);
      await page.setViewportSize({ width: 768, height: 900 });
      // Chromium zoom-equivalent layout at half a 1536px viewport; also exercise 200% root text.
      await page.addStyleTag({ content: "html { font-size: 200%; }" });
      await layout(page, 768);
      await page.screenshot({ path: path.join(output, `expanded-zoom-${locale}.png`), fullPage: true });
    });
    await check(`${locale} expanded test login grows the shared desktop panel`, async () => {
      await page.goto(base, { waitUntil: "domcontentloaded" }); await page.setViewportSize({ width: 1440, height: 1000 });
      await page.locator(".test-account-login summary").waitFor();
      const before = await page.locator("[data-auth-panel]").boundingBox();
      await page.locator(".test-account-login summary").click();
      await layout(page, 1440);
      const after = await page.locator("[data-auth-panel]").boundingBox();
      assert.ok(after!.height > before!.height, "Expanded fields must grow the panel instead of being clipped");
      assert.ok(await page.locator('.test-account-login input[name="password"]').isVisible());
      await page.screenshot({ path: path.join(output, `expanded-desktop-${locale}.png`), fullPage: true });
    });
    await check(`${locale} mobile-to-desktop artwork loads without losing alignment`, async () => {
      for (const width of [390, 1547]) {
        await page.setViewportSize({ width, height: width === 1547 ? 1016 : 844 });
        await layout(page, width);
      }
      await page.screenshot({ path: path.join(output, `resized-desktop-${locale}.png`), fullPage: true });
    });
    await context.close();
  }

  const accountFile = process.env.NOVA_AUTH_TEST_CREDENTIALS;
  assert.ok(accountFile, "A task-owned synthetic account file is required for the real test-login check");
  assert.ok(path.resolve(accountFile).startsWith(path.resolve("work") + path.sep));
  const credentials = JSON.parse(await readFile(accountFile, "utf8")) as { username: string; password: string };
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  await context.addInitScript(() => localStorage.setItem("nova-locale", "zh-CN"));
  const page = await context.newPage();
  await check("test account: error, pending, success, reload and transition to email", async () => {
    await page.goto(base, { waitUntil: "domcontentloaded" }); await page.locator(".test-account-login summary").click();
    await page.locator('input[name="username"]').fill(credentials.username);
    await page.locator('input[name="password"]').fill("synthetic-incorrect-password");
    await page.locator(".test-account-login button.primary").click();
    await page.locator('.test-account-login [role="alert"]').waitFor();
    assert.equal(await page.locator(".test-account-login").getAttribute("open"), "");
    await page.screenshot({ path: path.join(output, "test-login-error.png"), fullPage: true });
    let release!: () => void, started!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { started = resolve; });
    await page.route("**/api/auth/test-login*", async route => { started(); await pending; await route.continue(); });
    await page.locator('input[name="password"]').fill(credentials.password);
    await page.locator(".test-account-login button.primary").click(); await reached;
    try {
      assert.equal(await page.locator(".test-account-login button.primary").isDisabled(), true);
      assert.equal(await page.locator('input[name="password"]').isDisabled(), true);
    } finally { release(); }
    await page.locator(".login-card").waitFor({ state: "detached" });
    await page.reload(); await page.locator(".family-entry").waitFor();
    const session = await (await context.request.get(base + "/api/session")).json();
    assert.equal(session.sessionMethod, "test"); assert.equal(session.user.role, "teacher");
    await page.goto(base + "/sign-in", { waitUntil: "domcontentloaded" }); await page.locator(".cl-formFieldInput:visible").first().waitFor();
    const after = await (await context.request.get(base + "/api/session")).json();
    assert.equal(after.user, null, "Opening email auth ends the test session");
    await page.goto(base, { waitUntil: "domcontentloaded" }); await page.locator(".test-account-login summary").waitFor();
    assert.equal(await page.locator('.test-account-login input[name="username"]').isVisible(), false);
  });
  await check("pending invitation retains its return link", async () => {
    await page.evaluate(() => sessionStorage.setItem("nova-pending-invitation", JSON.stringify({ token: "synthetic-ui-invitation", expiresAt: Date.now() + 60_000 })));
    await page.goto(base + "/sign-up", { waitUntil: "domcontentloaded" }); await page.locator(".cl-formFieldInput:visible").first().waitFor();
    assert.equal(await page.getByRole("link", { name: "返回家庭邀请" }).getAttribute("href"), "/invite");
  });
  await context.close();
} finally {
  await browser.close();
  await writeFile(path.join(output, "results.json"), JSON.stringify({ scope: "Local application, isolated synthetic database, real Clerk development forms; pending request alone delayed for disabled-state assertion", passed: checks.every(check => check.passed), checks, metrics }, null, 2));
}
