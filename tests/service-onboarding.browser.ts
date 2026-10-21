import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type APIResponse, type BrowserContext, type Page } from "playwright";
import { childScaleStaffNotes, parentScaleStaffNotes, teacherScaleStaffNotes } from "../src/domain/triad-scales";
import { previewAnswers } from "../src/domain/triad-report";
import type { RespondentRole } from "../src/domain/types";

const base = process.env.NOVA_SERVICE_ONBOARDING_BASE_URL;
assert.ok(base, "Set an owned local service-mode URL");
const url = new URL(base);
assert.ok(["localhost", "127.0.0.1"].includes(url.hostname) && url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash);
const output = path.resolve(process.env.NOVA_SERVICE_ONBOARDING_OUTPUT ?? "work/qa/nonclinical-onboarding/browser");
assert.ok(output.startsWith(path.resolve("work") + path.sep));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.NOVA_CHROMIUM_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const results: { scenario: string; passed: boolean }[] = [];
const pageErrors: string[] = [];
async function fixture(locale: "zh-CN" | "zh-HK", width: number) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, ignoreHTTPSErrors: true });
  context.setDefaultTimeout(15000);
  await context.addInitScript(value => localStorage.setItem("nova-locale", value), locale);
  const page = await context.newPage();
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(base!);
  const session = await (await context.request.get(`${base}/api/session`)).json();
  assert.equal(session.mode, "service");
  assert.equal(session.authProvider, "local");
  return { context, page };
}
async function account(page: Page, role: "parent" | "student" | "teacher", code?: string) {
  await page.getByRole("button", { name: role === "parent" ? /我是家[长長]/ : role === "student" ? /我是[学學]生/ : /我是老[师師]/ }).click();
  await page.locator("input[name=name]").fill(`合成${role}`);
  await page.locator("input[name=username]").fill(`synthetic_${role}_${randomBytes(6).toString("hex")}`);
  await page.locator("input[name=password]").fill(randomBytes(24).toString("base64url"));
  if (code) await page.locator("input[name=code]").fill(code);
  const endpoint = role === "student" ? "/api/triad/join" : "/api/auth/register";
  const pending = page.waitForResponse(r => new URL(r.url()).pathname === endpoint);
  await page.locator("form:visible button[type=submit], form:visible button.button.primary").last().click();
  assert.equal((await pending).status(), 201);
  await page.locator(".workspace-body").waitFor();
}
async function workspace(context: BrowserContext) {
  const response = await context.request.get(`${base}/api/workspace`);
  assert.equal(response.status(), 200);
  return response.json();
}
async function post(context: BrowserContext, endpoint: string, data: unknown) {
  return context.request.post(`${base}${endpoint}`, { headers: { Origin: url.origin }, data });
}
try {
  for (const [locale, width] of [["zh-HK", 390], ["zh-CN", 1280]] as const) {
    const parent = await fixture(locale, width);
    const teacher = await fixture(locale, width);
    const student = await fixture(locale, width);
    try {
      await account(parent.page, "parent");
      const form = parent.page.locator(".family-entry form");
      await form.locator("input[name=childName]").fill("合成測試孩子");
      await form.locator("input[name=birthDate]").fill("2014-06-20");
      await form.locator("select[name=grade]").selectOption("初中");
      await form.locator("input[name=assessment]").check();
      await form.locator("input[name=sensitiveData]").check();
      assert.equal(await form.locator("input[name=parentReport]").isChecked(), false);
      const pending = parent.page.waitForResponse(r => new URL(r.url()).pathname === "/api/triad/family");
      await form.getByRole("button", { name: /填[写寫]家庭情[况況]/ }).click();
      const response = await pending;
      assert.equal(response.status(), 201);
      const family = await response.json();
      const request = response.request().postDataJSON();
      await parent.page.locator(".join-code").waitFor();
      assert.equal(await parent.page.locator(".join-code").innerText(), family.joinCode);
      await parent.page.evaluate(() => window.scrollTo(0, 0));
      await parent.page.screenshot({ path: path.join(output, `after-parent-${locale}.png`), fullPage: false });
      const repeated = await post(parent.context, "/api/triad/family", request);
      assert.equal(repeated.status(), 201);
      assert.equal((await repeated.json()).familyId, family.familyId);
      const mismatch = await post(parent.context, "/api/triad/family", { ...request, parentReport: true });
      assert.equal(mismatch.status(), 409);
      assert.equal((await mismatch.json()).code, "CONSENT_CHOICE_CONFLICT");
      await parent.page.reload();
      let data = await workspace(parent.context);
      assert.equal(data.families.length, 1);
      assert.equal(data.assessments.length, 1);
      assert.equal(data.reports.length, 0);
      assert.equal(data.families[0].consents.parentReport, false);
      await account(teacher.page, "teacher");
      await teacher.page.locator(".family-entry input[name=code]").fill(family.joinCode);
      const joined = teacher.page.waitForResponse(r => new URL(r.url()).pathname === "/api/triad/join");
      await teacher.page.locator(".family-entry").getByRole("button", { name: "加入家庭", exact: true }).click();
      assert.equal((await joined).status(), 201);
      await teacher.page.locator(".success-notice").waitFor();
      const replay = await post(teacher.context, "/api/triad/join", { code: family.joinCode });
      assert.equal(replay.status(), 200);
      const replayBody = await replay.json();
      assert.equal(replayBody.alreadyMember, true);
      assert.equal(typeof replayBody.assessmentId, "string");
      await account(student.page, "student", family.joinCode);
      await student.page.reload();
      for (const context of [teacher.context, student.context]) {
        data = await workspace(context);
        assert.equal(data.families.length, 1);
        assert.equal(data.families[0].id, family.familyId);
        assert.equal(data.assessments.length, 1);
        assert.equal(data.assessments[0].canRespond, true);
        assert.equal(data.assessments[0].responseBlockedReason, undefined);
        assert.equal(data.reports.length, 0);
      }
      data = await workspace(parent.context);
      assert.deepEqual(data.families[0].members.map((m: { role: string }) => m.role).sort(), ["parent", "student", "teacher"]);
      assert.equal(data.assessments.length, 3);
      const tasks = Object.fromEntries(data.assessments.map((task: { respondentRole: string; id: string }) => [task.respondentRole, task.id])) as Record<RespondentRole, string>;
      await student.page.goto(`${base}/#assessment/${tasks.student}`);
      await student.page.locator(".draft-access-blocked").waitFor({ state: "detached" });
      await student.page.getByRole("checkbox").first().waitFor();
      await student.page.getByRole("checkbox").first().check();
      await student.page.locator(".sd-root-modern, .sd-root").first().waitFor();
      await student.page.screenshot({ path: path.join(output, `after-student-${locale}.png`), fullPage: false });
      const overflow = await student.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      assert.equal(overflow, false);
      await student.page.goto(`${base}/#assessments`);
      const definitions = { parent: parentScaleStaffNotes, student: childScaleStaffNotes, teacher: teacherScaleStaffNotes };
      for (const [role, f] of [["parent", parent], ["student", student], ["teacher", teacher]] as const) {
        const definition = structuredClone(definitions[role]);
        for (const item of definition.items) if (item.id === "c_age" || item.id === "p_age") item.choices = item.choices.filter(choice => choice.value === 12);
        const answers = previewAnswers(definition, "calm");
        for (const key of Object.keys(answers)) if (typeof answers[key] === "string") answers[key] = "Synthetic local test response";
        const endpoint = `/api/assessments/${tasks[role]}`;
        const detail = await (await f.context.request.get(`${base}${endpoint}`)).json();
        assert.equal(detail.demo, true);
        assert.equal(detail.responseBlockedReason, undefined);
        assert.equal(detail.syntheticTest, undefined, "Ordinary accounts do not use the synthetic allowlist");
        await f.page.goto(`${base}/#assessment/${tasks[role]}`);
        await f.page.locator(".survey-assent-panel input[type=checkbox]").check();
        assert.match(await f.page.locator(".page-title").innerText(), /非[临臨]床[试試]用/);
        let answered = 0;
        let resumed = false;
        for (let step = 0; step < 250; step++) {
          const question = f.page.locator(".sd-question[data-name]:visible").first();
          await question.waitFor();
          const name = await question.getAttribute("data-name");
          assert.ok(name);
          const value = answers[name];
          const textarea = question.locator("textarea");
          if (await textarea.count()) {
            if (typeof value === "string") await textarea.fill(value);
          } else if (value !== undefined) {
            for (const choice of Array.isArray(value) ? value : [value]) {
              const input = question.locator(`input[value="${choice}"]`);
              if (!(await input.isChecked())) await input.locator("..").click();
              assert.equal(await input.isChecked(), true);
            }
          }
          answered++;
          if (!resumed && answered >= 3) {
            await f.page.waitForFunction(() => /已/.test(document.querySelector(".survey-save-status")?.textContent ?? ""));
            const saved = await (await f.context.request.get(`${base}${endpoint}`)).json();
            assert.ok(Object.keys(saved.draftAnswers).length >= 3, "Browser answers are saved to the server");
            await f.page.reload();
            await f.page.locator(".survey-assent-panel input[type=checkbox]").check();
            const restored = await (await f.context.request.get(`${base}${endpoint}`)).json();
            assert.deepEqual(restored.draftAnswers, saved.draftAnswers, "Reload preserves the draft");
            resumed = true;
            continue;
          }
          const next = f.page.getByRole("button", { name: /^下一[题題]$/ });
          if (!(await next.isVisible())) break;
          await next.click();
          await f.page.waitForFunction(previous => {
            const visible = Array.from(document.querySelectorAll(".sd-question[data-name]")).find(element => (element as HTMLElement).offsetHeight > 0);
            return visible?.getAttribute("data-name") !== previous;
          }, name);
          assert.ok(step < 249, "Question navigation must reach the final question");
        }
        assert.ok(resumed, "Each role saves and resumes a draft through the browser");
        const pendingSubmit = f.page.waitForResponse(r => new URL(r.url()).pathname === `${endpoint}/submit`);
        await f.page.getByRole("button", { name: /[确確][认認]提交/ }).click();
        const submitted = await pendingSubmit;
        assert.equal(submitted.status(), 200);
        assert.equal((await submitted.json()).status, "queued");
        console.log(`PASS ${locale} ${role}: ${answered} visible questions; browser draft, reload, submission`);
      }
      assert.equal((await workspace(parent.context)).reports.length, 0, "Optional parent-report consent stays effective");
      const consent = await post(parent.context, `/api/families/${family.familyId}/consent`, { action: "grant", scope: "parent_report", guardianName: "合成parent" });
      assert.equal(consent.status(), 200);
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        data = await workspace(parent.context);
        if (data.reports.length) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      assert.equal(data.reports.length, 1, "Worker automatically publishes the combined report");
      assert.equal(data.reports[0].generationMode, "template");
      assert.equal(data.reports[0].demo, true);
      const reportId = data.reports[0].id;
      for (const language of ["zh-CN", "zh-HK"] as const) {
        const document: APIResponse = await parent.context.request.get(`${base}/api/reports/${reportId}/document?locale=${language}`);
        assert.equal(document.status(), 200);
        const html = await document.text();
        assert.match(html, /不是诊断|不是診斷/);
        assert.match(html, /尚无经过验证的临床常模|尚無經過驗證的臨床常模/);
        assert.match(html, /非临床试用报告|非臨床試用報告/);
        assert.doesNotMatch(html, /虚构题目与合成数据|虛構題目與合成資料/);
        const pdf: APIResponse = await parent.context.request.get(`${base}/api/reports/${reportId}/pdf?locale=${language}`);
        assert.equal(pdf.status(), 200);
        const bytes = await pdf.body();
        assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
        await writeFile(path.join(output, `service-report-${locale}-${language}.pdf`), bytes);
      }
      for (const context of [student.context, teacher.context]) {
        assert.equal((await context.request.get(`${base}/api/reports/${reportId}/pdf?locale=${locale}`)).status(), 403);
      }
      results.push({ scenario: `${locale} ${width}px: browser registration, family joining, all three questionnaires, saved draft reload and submission; automatic private bilingual report; consent and role enforcement`, passed: true });
      console.log(`PASS ${results.at(-1)!.scenario}`);
    } finally {
      await Promise.all([parent.context.close(), teacher.context.close(), student.context.close()]);
    }
  }
  assert.deepEqual(pageErrors, []);
} finally {
  await browser.close();
  await writeFile(path.join(output, "service-browser-results.json"), JSON.stringify({ passed: results.length === 2 && pageErrors.length === 0, syntheticOnly: true, mode: "service", aiEnabled: false, results, pageErrors }, null, 2));
}
