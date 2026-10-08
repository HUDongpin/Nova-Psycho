import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Route } from "playwright";
import type { Locale, OpsStatus, Workspace } from "../src/components/api";

const mode = process.argv[2] ?? "fixed";
assert.ok(mode === "baseline" || mode === "fixed" || mode === "ops");
const base = process.env.NOVA_PUBLIC_URL ?? "http://127.0.0.1:3190";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
assert.equal(process.env.NOVA_AI_ENABLED, "false");
const out = path.resolve(process.env.NOVA_BROWSER_OUTPUT_DIR ?? `work/qa/release-20261008/frontend-polling/${mode}`);
assert.ok(out.startsWith(path.resolve("work") + path.sep));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const errors: string[] = [];
const checks: { name: string; reads?: number; opsReads?: number }[] = [];
const settle = () => new Promise(resolve => setTimeout(resolve, 80));
type Phase = "waiting" | "reporting" | "published" | "settled";
const user = { id: "11111111-1111-4111-8111-111111111111", region: "CN" as const, role: "admin" as const, name: "合成轮询管理员" };
function workspace(phase: Phase): Workspace {
  return {
    user, region: "CN", mode: "demo", families: [], reports: [], goals: [], observations: [], scales: [], staff: [], contentVersions: [], alerts: [], staffNotes: [],
    assessments: phase === "settled" ? [] : [{ id: "22222222-2222-4222-8222-222222222222", familyId: "33333333-3333-4333-8333-333333333333", childName: "合成孩子", respondentId: user.id, respondentName: user.name, respondentRole: "parent", scaleVersionId: "synthetic@1.0.0", scaleTitle: "合成测试量表", status: phase === "published" ? "published" : "queued", phase: phase === "published" ? null : phase, createdAt: "2026-10-08T00:00:00.000Z", reportId: null, canRespond: false, canRetryReport: false }],
    summary: { families: 0, pendingAssessments: 0, publishedReports: phase === "published" ? 1 : 0, activeGoals: 0, riskReports: 0 },
  };
}
async function fixture(initial: Phase, hash = "dashboard", locale: Locale = "zh-CN") {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(value => localStorage.setItem("nova-locale", value), locale);
  await context.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  let phase = initial, reads = 0, opsReads = 0, loggedOut = false;
  let opsWorker: OpsStatus["worker"] = { mode: "continuous", state: "processing", alive: true, workerId: null, heartbeatAgeSeconds: 0, uptimeSeconds: 0, cycles: 0 };
  let intercept: ((route: Route, data: Workspace) => Promise<void>) | null = null;
  await context.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: loggedOut ? null : user, region: "CN", mode: "demo", demoAccounts: [], siblingUrl: null } });
    if (url.pathname === "/api/workspace") {
      reads++;
      const data = structuredClone(workspace(phase));
      if (intercept) return intercept(route, data);
      return route.fulfill({ json: data });
    }
    if (url.pathname === "/api/auth/logout") { loggedOut = true; return route.fulfill({ json: { ok: true } }); }
    if (url.pathname === "/api/ops/status") {
      opsReads++;
      return route.fulfill({ json: { region: "CN", mode: "demo", checkedAt: "2026-10-08T00:00:00.000Z", jobs: { ready: 0, running: 0, done: 0, failed: 0 }, oldestReadySeconds: null, expiredLeases: 0, worker: opsWorker, warnings: [] } });
    }
    throw new Error(`Unexpected API call: ${url.pathname}`);
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  const time = new Date("2026-10-08T12:00:00.000Z");
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
  await page.goto(`${base}/#${hash}`);
  await page.locator(".app-shell").waitFor();
  await settle();
  async function advance(ms: number) { await page.clock.runFor(ms); await settle(); }
  async function visibility(value: "visible" | "hidden") {
    await page.evaluate(state => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
      document.dispatchEvent(new Event("visibilitychange"));
      if (state === "visible") window.dispatchEvent(new Event("focus"));
    }, value);
    await settle();
  }
  function holdNext() {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    intercept = async (route, data) => { intercept = null; entered(); await held; data.user.name = "STALE_RESPONSE_MUST_NOT_WIN"; await route.fulfill({ json: data }).catch(() => undefined); };
    return { started, release };
  }
  return { context, page, advance, visibility, holdNext, setPhase: (next: Phase) => { phase = next; }, setOpsWorker: (next: OpsStatus["worker"]) => { opsWorker = next; }, reads: () => reads, opsReads: () => opsReads };
}

try {
  if (mode === "baseline") {
    const waiting = await fixture("waiting");
    for (let n = 0; n < 3; n++) await waiting.advance(3500);
    assert.equal(waiting.reads(), 4);
    checks.push({ name: "baseline_waiting_repeats_full_workspace_reads", reads: waiting.reads() });
    await waiting.context.close();
    const ops = await fixture("settled", "ops");
    const initialOps = ops.opsReads();
    await ops.advance(10_000); await ops.advance(10_000);
    assert.equal(ops.opsReads(), initialOps + 2);
    checks.push({ name: "baseline_ops_repeats_while_idle", opsReads: ops.opsReads() });
    await ops.context.close();
  } else if (mode === "ops") {
    for (const locale of ["zh-CN", "zh-HK"] as const) {
      const f = await fixture("settled", "ops", locale), language = locale === "zh-HK" ? 1 : 0;
      const labels = { idle: ["空闲", "閒置"], processing: ["正在生成报告", "正在產生報告"], backlog: ["等待处理", "等候處理"], failed: ["有报告生成失败", "有報告產生失敗"], unavailable: ["处理暂不可用", "處理暫時無法使用"] };
      for (const state of ["idle", "processing", "backlog", "failed", "unavailable"] as const) {
        f.setOpsWorker({ mode: "queue", state, alive: state === "idle" || state === "processing", workerId: null, heartbeatAgeSeconds: null, uptimeSeconds: null, cycles: null });
        await f.page.getByRole("button", { name: /^(刷新|重新整理)$/ }).last().click(); await settle();
        await f.page.getByText(labels[state][language], { exact: true }).waitFor();
        assert.equal(await f.page.getByText("心跳距今（秒）", { exact: true }).count(), 0);
        assert.equal(await f.page.getByText(language ? "程序標識" : "进程标识", { exact: true }).count(), 0);
        assert.equal(await f.page.getByText(language ? "未回應" : "未响应", { exact: true }).count(), 0);
        checks.push({ name: `queue_${state}_${locale}_accurate_without_continuous_heartbeat` });
      }
      f.setOpsWorker({ mode: "continuous", state: "unavailable", alive: false, workerId: null, heartbeatAgeSeconds: 600, uptimeSeconds: 1000, cycles: 12 });
      await f.page.getByRole("button", { name: /^(刷新|重新整理)$/ }).last().click(); await settle();
      await f.page.getByText(language ? "未回應" : "未响应", { exact: true }).waitFor();
      await f.page.getByText("心跳距今（秒）", { exact: true }).waitFor();
      checks.push({ name: `continuous_worker_status_preserved_${locale}` });
      await f.context.close();
    }
  } else {
    for (const phase of ["settled", "waiting"] as const) {
      const f = await fixture(phase);
      await f.advance(180_000);
      assert.equal(f.reads(), 1);
      await f.visibility("hidden"); await f.advance(180_000); assert.equal(f.reads(), 1);
      await f.visibility("visible"); assert.equal(f.reads(), 2, "Visibility + focus must refresh only once");
      await f.advance(180_000); assert.equal(f.reads(), 2);
      checks.push({ name: `${phase}_no_idle_poll_and_one_foreground_refresh`, reads: f.reads() });
      await f.context.close();
    }
    {
      const f = await fixture("reporting");
      for (const interval of [3500, 7000, 15_000, 30_000, 30_000, 30_000]) await f.advance(interval);
      assert.equal(f.reads(), 7, "Initial load plus six bounded automatic reads");
      await f.advance(300_000); assert.equal(f.reads(), 7);
      await f.page.locator(".topbar .refresh-button").click(); await settle(); assert.equal(f.reads(), 8);
      await f.advance(180_000); assert.equal(f.reads(), 8, "Manual refresh does not restart the automatic budget");
      checks.push({ name: "reporting_backoff_expires_manual_refresh_still_works", reads: f.reads() });
      await f.context.close();
    }
    {
      const f = await fixture("reporting");
      await f.visibility("hidden"); await f.advance(180_000); assert.equal(f.reads(), 1);
      await f.visibility("visible"); assert.equal(f.reads(), 2);
      await f.advance(180_000); assert.equal(f.reads(), 2, "Returning after the deadline must not restart automatic checks");
      checks.push({ name: "hidden_reporting_stops_and_preserves_wall_clock_deadline", reads: f.reads() });
      await f.context.close();
    }
    {
      const f = await fixture("reporting");
      await f.visibility("hidden"); await f.advance(10_000); assert.equal(f.reads(), 1);
      await f.visibility("visible"); assert.equal(f.reads(), 2);
      await f.advance(3500); assert.equal(f.reads(), 3, "Active reporting resumes within its existing budget");
      await f.page.goto("about:blank"); await f.advance(180_000); assert.equal(f.reads(), 3);
      checks.push({ name: "visible_reporting_resumes_and_unmount_stops", reads: f.reads() });
      await f.context.close();
    }
    {
      const f = await fixture("reporting");
      f.setPhase("published"); await f.advance(3500); assert.equal(f.reads(), 2);
      await f.advance(180_000); assert.equal(f.reads(), 2);
      checks.push({ name: "published_report_stops_automatic_checks", reads: f.reads() });
      await f.context.close();
    }
    {
      const f = await fixture("reporting"), held = f.holdNext();
      await f.advance(3500); await held.started;
      await f.page.locator(".topbar .refresh-button").click();
      await f.advance(20_000); assert.equal(f.reads(), 2, "Manual refresh joins an in-flight automatic request");
      await f.page.getByRole("button", { name: "繁", exact: true }).click(); await settle();
      assert.equal(f.reads(), 3);
      held.release(); await settle();
      assert.equal(await f.page.getByText("STALE_RESPONSE_MUST_NOT_WIN").count(), 0);
      checks.push({ name: "single_flight_and_old_locale_response_is_ignored", reads: f.reads() });
      await f.context.close();
    }
    {
      const f = await fixture("reporting"), held = f.holdNext();
      await f.advance(3500); await held.started;
      await f.page.getByRole("button", { name: "退出登录", exact: true }).click(); await settle();
      held.release(); await settle(); await f.advance(180_000);
      assert.equal(await f.page.locator(".app-shell").count(), 0); assert.equal(f.reads(), 2);
      checks.push({ name: "logout_rejects_late_response_and_stops_polling", reads: f.reads() });
      await f.context.close();
    }
    {
      const f = await fixture("settled", "ops");
      const initialOps = f.opsReads();
      await f.advance(180_000); assert.equal(f.opsReads(), initialOps);
      await f.page.getByRole("button", { name: "刷新", exact: true }).last().click(); await settle(); assert.equal(f.opsReads(), initialOps + 1);
      await f.advance(180_000); assert.equal(f.opsReads(), initialOps + 1);
      checks.push({ name: "ops_mount_and_manual_only", opsReads: f.opsReads() });
      await f.context.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ mode, passed: true, checks, errors }));
  await writeFile(path.join(out, "results.json"), JSON.stringify({ mode, passed: true, checks, errors }, null, 2));
} catch (error) {
  await writeFile(path.join(out, "results.json"), JSON.stringify({ mode, passed: false, checks, errors, error: error instanceof Error ? error.message : String(error) }, null, 2));
  throw error;
} finally { await browser.close(); }
