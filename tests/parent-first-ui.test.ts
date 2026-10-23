// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Assessment, Family, Report, Workspace } from "../src/components/api";
import { SubmissionPanel } from "../src/components/documents";
import { reportsNewestFirst, WorkspaceReportUpdates } from "../src/components/staged-reports";
import { AssessmentList, FamilyView, ReportCards } from "../src/components/workspace-views";
import { hasGeneratingReports } from "../src/components/report-refresh";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const family: Family = { id: "family", familyName: "合成家庭", childName: "合成孩子", age: 13, birthDate: "2013-01-01", grade: "S2", region: "CN", guardianLabel: "合成家长", assignedTo: "staff", canInviteMembers: true, createdAt: "2026-01-01", consent: true, members: [], reportWorkflow: "parent_first_v1", activeRoundId: "round", canStartStaffObservation: true };
const assessment: Assessment = { id: "parent-response", familyId: family.id, childName: family.childName, respondentId: "parent", respondentName: "合成家长", respondentRole: "parent", scaleVersionId: "scale", scaleTitle: "家长问卷", status: "submitted", phase: "reporting", createdAt: "2026-10-22", submittedAt: "2026-10-23", reportId: "v1", canRespond: false, canRetryReport: false, roundId: "round" };
const report = (version: number): Report => ({ id: `v${version}`, familyId: family.id, childName: family.childName, title: `合成报告版本${version}`, respondentRole: "parent", scaleTitle: "家庭支持", createdAt: `2026-10-${20 + version}T12:00:00Z`, generationMode: "template", risk: false, demo: true, dimensions: [], assessmentId: assessment.id, comparison: { available: false }, revision: { roundId: "round", version, sourceAssessmentIds: [assessment.id], sourceRoles: version > 1 ? ["parent", "student"] : ["parent"], generatedAt: `2026-10-${20 + version}T12:00:00Z` } });
const job = { id: "job-3", familyId: family.id, roundId: "round", version: 3, sourceRoles: ["parent", "student", "teacher"] as ("parent" | "student" | "teacher")[], state: "running" as const, reportId: null, canRetry: false };
const workspace = (): Workspace => ({ user: { id: "staff", name: "合成工作人员", role: "staff", region: "CN" }, region: "CN", mode: "demo", families: [family], assessments: [assessment], reports: [report(1), report(2)], reportJobs: [job], scales: [], goals: [], observations: [], staff: [], contentVersions: [], alerts: [], staffNotes: [], summary: {} });
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; vi.unstubAllGlobals(); document.body.replaceChildren(); });
function familyView(value = workspace(), locale: "zh-CN" | "zh-HK" = "zh-CN", props = {}) { return createElement(FamilyView, { family: value.families[0], workspace: value, locale, navigate: () => undefined, openForm: () => undefined, onRefresh: async () => undefined, openPrivacy: () => undefined, ...props }); }
async function mount(value = workspace()) { const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); const navigate = vi.fn(), onRefresh = vi.fn(async () => undefined); await act(async () => root!.render(familyView(value, "zh-CN", { navigate, onRefresh }))); return { host, navigate, onRefresh }; }

describe("parent-first report UI", () => {
  it("orders logical versions even when another family's report lies between their completion dates",()=>{
    const low={...report(1),createdAt:"2026-10-23T12:00:00Z"};
    const other={...report(1),id:"other-family",familyId:"other",revision:{...report(1).revision!,roundId:"other-round"},createdAt:"2026-10-22T12:00:00Z"};
    const high={...report(3),createdAt:"2026-10-21T12:00:00Z"};
    const ordered=reportsNewestFirst([low,other,high]);
    expect(ordered.find(item=>item.familyId===family.id)?.id).toBe("v3");
    expect(ordered.filter(item=>item.familyId===family.id).map(item=>item.id)).toEqual(["v3","v1"]);
  });
  it("keeps the submitted parent response complete while a later report runs and the previous report remains usable", () => {
    const html = renderToStaticMarkup(createElement(AssessmentList, { assessments: [assessment], locale: "zh-CN", navigate: () => undefined }));
    expect(html).toContain("已完成提交"); expect(html).toContain("查看报告");
    expect(html).not.toContain("等待三方"); expect(html).not.toContain("报告生成中");
  });
  it("orders newest revision first and labels sources and report versions", () => {
    const html = renderToStaticMarkup(createElement(ReportCards, { reports: [report(1), report(2)], locale: "zh-CN", navigate: () => undefined }));
    expect(html.indexOf("合成报告版本2")).toBeLessThan(html.indexOf("合成报告版本1"));
    expect(html).toContain("最新报告"); expect(html).toContain("第 2 版"); expect(html).toContain("历史版本"); expect(html).toContain("来源：家长、学生");
  });
  it("separates optional follow-ups and the pending update from published history", () => {
    const html = renderToStaticMarkup(familyView());
    expect(html).toContain("家庭进度"); expect(html).toContain("学生补充"); expect(html).toContain("TOPE 工作人员观察");
    expect(html).toContain("第 3 版报告正在生成"); expect(html).toContain("上一版报告仍可查看");
    expect(html).toContain("历史版本"); expect(html).toContain("无需现在完成所有问卷");
    expect(html).not.toContain("三份都交齐后");
  });
  it("polls a new report job even when every assessment is already submitted with a published report", () => {
    expect(hasGeneratingReports([assessment], [job])).toBe(true);
    expect(hasGeneratingReports([assessment], [{ ...job, state: "failed" }])).toBe(false);
  });
  it("starts the authorized staff's observation without a teacher account and prevents duplicate clicks", async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn((_url: string) => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal("fetch", fetch);
    const { host, navigate, onRefresh } = await mount();
    const button = host.querySelector<HTMLButtonElement>('[data-testid="start-staff-observation"]')!;
    expect(button).not.toBeNull();
    await act(async () => { button.click(); button.click(); }); expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("/api/families/family/staff-observation?locale=zh-CN");
    await act(async () => resolve(new Response(JSON.stringify({ id: "staff-assessment" }), { status: 201 })));
    expect(onRefresh).toHaveBeenCalledOnce(); expect(navigate).toHaveBeenCalledWith({ page: "assessment", id: "staff-assessment" });
  });
  it("withholds observation action without server capability or for a parent", () => {
    for (const variant of [ { ...workspace(), families: [{ ...family, canStartStaffObservation: false }] }, { ...workspace(), user: { ...workspace().user, role: "parent" as const } } ]) expect(renderToStaticMarkup(familyView(variant))).not.toContain('data-testid="start-staff-observation"');
  });
  it("retries the failed version job while keeping the prior report accessible", async () => {
    const value = workspace(); value.reportJobs = [{ ...job, state: "failed", canRetry: true }];
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ id: job.id, status: "queued" }), { status: 200 })); vi.stubGlobal("fetch", fetch);
    const { host, onRefresh } = await mount(value);
    expect(host.textContent).toContain("第 3 版报告生成失败"); expect(host.textContent).toContain("上一版报告仍可查看");
    const button = host.querySelector<HTMLButtonElement>('[data-testid="retry-report-job"]')!;
    await act(async () => button.click());
    expect(fetch.mock.calls[0][0]).toBe("/api/report-jobs/job-3/retry?locale=zh-CN"); expect(onRefresh).toHaveBeenCalledOnce();
  });
  it("shows the latest job on a submitted screen without replacing the prior report action", () => {
    const html = renderToStaticMarkup(createElement(SubmissionPanel, { locale: "zh-CN", region: "CN", role: "parent", phase: "reporting", status: "submitted", reportId: "v2", reportJob: job, onRefresh: async () => undefined, onViewReport: () => undefined, onBack: () => undefined }));
    expect(html).toContain("已完成提交"); expect(html).toContain("第 3 版报告正在生成"); expect(html).toContain("查看报告"); expect(html).toContain("上一版报告仍可查看");
  });
  it("only shows the latest job for each round on the reports page and withholds staff retry from parents", () => {
    const value = workspace(); value.user.role = "parent"; value.reportJobs = [{ ...job, id: "old-failed", version: 2, state: "failed", canRetry: true }, { ...job, state: "failed", canRetry: true }];
    const html = renderToStaticMarkup(createElement(WorkspaceReportUpdates, { workspace: value, locale: "zh-CN", onRefresh: async () => undefined }));
    expect(html).toContain("第 3 版报告生成失败"); expect(html).not.toContain("第 2 版报告生成失败"); expect(html).not.toContain('data-testid="retry-report-job"');
  });
  it("keeps a failed earlier revision recoverable by staff after the newest report succeeds",()=>{
    const value=workspace();value.reportJobs=[{...job,id:"failed-first",version:1,state:"failed",canRetry:true},{...job,state:"done",reportId:"v3"}];
    const reportsPage=renderToStaticMarkup(createElement(WorkspaceReportUpdates,{workspace:value,locale:"zh-CN",onRefresh:async()=>undefined}));
    const familyPage=renderToStaticMarkup(familyView(value));
    for(const html of [reportsPage,familyPage]){expect(html).toContain("第 1 版报告生成失败");expect(html).toContain('data-testid="retry-report-job"');}
  });
  it("provides traditional labels and retains legacy three-party waiting", () => {
    expect(renderToStaticMarkup(familyView(workspace(), "zh-HK"))).toContain("第 3 版報告正在產生");
    const old = { ...assessment, status: "queued" as const, phase: "waiting" as const, reportId: null, roundId: undefined };
    expect(renderToStaticMarkup(createElement(AssessmentList, { assessments: [old], locale: "zh-CN", navigate: () => undefined }))).toContain("等待三方填写齐全");
  });
});
