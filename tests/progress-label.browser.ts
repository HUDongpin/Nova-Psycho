import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { teacherScale } from "../src/domain/triad-scales";
import { surveyDefinition } from "../src/domain/survey";

const base = "http://127.0.0.1:3198";
const phase = process.env.NOVA_PROGRESS_PHASE || "baseline";
assert.ok(["baseline", "fixed"].includes(phase));
const out = `work/progress-label/${phase}`;
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
await context.addInitScript(() => localStorage.setItem("nova-locale", "zh-HK"));
const answers = Object.fromEntries(teacherScale.items.slice(0, 8).map(item => [item.id, item.id === "t8_1" ? 2 : item.kind === "multi" ? [item.choices[0].value] : item.choices[0].value]));
const user = { id: "synthetic-teacher", name: "Synthetic teacher", role: "teacher", region: "HK" };
let writes = 0;
await context.route("**/*", async route => {
  const url = new URL(route.request().url());
  if (url.origin !== base) return route.abort();
  if (!url.pathname.startsWith("/api/")) return route.continue();
  if (route.request().method() !== "GET") { writes++; return route.fulfill({ status: 503, json: { error: "No writes in navigation regression", code: "SYNTHETIC" } }); }
  if (url.pathname === "/api/session") return route.fulfill({ json: { user, region: "HK", mode: "service", demoAccounts: [], siblingUrl: null } });
  if (url.pathname === "/api/workspace") return route.fulfill({ json: { user, region: "HK", mode: "service", families: [], assessments: [], reports: [], scales: [], goals: [], observations: [], staff: [], contentVersions: [], alerts: [], staffNotes: [], summary: {} } });
  if (url.pathname === "/api/assessments/synthetic-progress") return route.fulfill({ json: { id: "synthetic-progress", status: "pending", childName: "Synthetic child", scaleTitle: teacherScale.title["zh-HK"], demo: false, description: teacherScale.description["zh-HK"], surveyJson: surveyDefinition(teacherScale, "teacher", "zh-HK"), draftAnswers: answers, draftRevision: 8, consentRequired: false } });
  return route.fulfill({ status: 404, json: { error: "Synthetic missing route", code: "NOT_FOUND" } });
});
const page = await context.newPage(); page.setDefaultTimeout(10000);
const errors: string[] = [], steps: unknown[] = [];
page.on("pageerror", error => errors.push(error.message));
async function capture(step: string) {
  const content = await page.locator(".survey-questions").innerText();
  const progress = await page.locator(".survey-questions").getByText(/第 \d+\/63 題/).allTextContents();
  const question = await page.locator(".survey-questions [data-name]:visible").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-name")));
  const checked = await page.locator('.survey-questions input[type="radio"]:checked').evaluateAll(nodes => nodes.map(node => ({ value: (node as HTMLInputElement).value, name: (node as HTMLInputElement).name })));
  const state = { step, progress, question, checked, content: content.slice(0, 1800) }; steps.push(state);
  await page.screenshot({ path: `${out}/${step}.png`, fullPage: true });
  return state;
}
try {
  await page.goto(base + "/#assessment/synthetic-progress");
  await page.locator(".survey-assent-panel input").check();
  await page.getByRole("button", { name: "上一題", exact: true }).waitFor();
  const restored = await capture("restored-q9");
  assert.ok(restored.content.includes("學生會嘗試不止一種策略解決學習任務"));
  assert.ok(restored.progress.includes("第 9/63 題"));
  await page.getByRole("button", { name: "上一題", exact: true }).click();
  const previous = await capture("previous-q8");
  assert.ok(previous.content.includes("學生能判斷自己是否理解"));
  assert.ok(previous.checked.some(input => input.value === "2"));
  assert.ok(previous.progress.includes("第 8/63 題"), JSON.stringify(previous));
  await page.getByRole("button", { name: "下一題", exact: true }).click();
  assert.ok((await capture("next-q9")).progress.includes("第 9/63 題"));
  assert.equal(writes, 0);
} catch (error) { steps.push({ failure: String(error) }); process.exitCode = 1; }
finally {
  const result = { phase, browser: browser.version(), passed: !process.exitCode && errors.length === 0, steps, errors, writes, evidence: "local production UI; real teacher scale, synthetic saved answers, all APIs mocked" };
  await writeFile(`${out}/results.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  await context.close(); await browser.close();
}
