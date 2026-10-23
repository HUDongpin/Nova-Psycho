import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { AssessmentSnapshot, ReportPayload, RespondentRole } from "../src/domain/types";
import { demoAdvice, demoScale, demoTemplate } from "../src/domain/demo";
import { childScale, parentScale, teacherScale, stagedChildScale, stagedParentScale, topeStaffScale } from "../src/domain/triad-scales";
import { previewAnswers } from "../src/domain/triad-report";
import { scoreAssessment } from "../src/domain/scoring";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/pdf", () => ({ renderPdf: vi.fn(async () => Buffer.from("%PDF synthetic")), closePdfBrowser: vi.fn() }));
vi.mock("../src/lib/storage", () => ({ writePrivatePdf: vi.fn(), removePrivatePdf: vi.fn(async () => "done"), listPrivatePdfKeys: vi.fn(), cleanAbandonedPrivatePdfTemps: vi.fn() }));
vi.mock("../src/domain/narrative", async importOriginal => ({ ...await importOriginal<typeof import("../src/domain/narrative")>(), selectNarrative: vi.fn() }));
import { query, transaction } from "../src/lib/db";
import { renderPdf } from "../src/lib/pdf";
import { writePrivatePdf } from "../src/lib/storage";
import { selectNarrative } from "../src/domain/narrative";
import { processReportJob } from "../src/lib/worker";
import { reportHtml } from "../src/domain/report-html";

const familyId = "11111111-1111-4111-8111-111111111111";
const roundId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const roles = ["student", "parent", "teacher"] as const;
const userIds = roles.map((_, i) => `44444444-4444-4444-8444-44444444444${i}`);
type Source = { id: string; family_id: string; region: string; triad_round_id: string | null; respondent_role: RespondentRole; respondent_id: string; respondent_context?:string; snapshot: AssessmentSnapshot; answers: Record<string, unknown>; submitted_at: string; scale_version_id: string };
let sources: Source[];
let members: Record<string, unknown>[];
let published: ReportPayload | undefined;
let failureCode: string | undefined;
let publicationCalls: string[];
let membershipChangedAtPublish: boolean;
let sourceChangedAtPublish: boolean;
let observationAuthor:Record<string,unknown>|undefined;
let observationRevokedAtPublish:boolean;

function snapshotFor(scale: typeof childScale, role: RespondentRole): AssessmentSnapshot {
  const answers = previewAnswers(scale);
  return { scale, score: scoreAssessment(scale, answers, { age: 12, region: "HK", role }), childName: "Synthetic child", grade: "Synthetic grade", submittedAt: "2026-10-20T00:00:00.000Z", aiConsented: true, advice: { id: "a", version: "1", content: demoAdvice }, template: { id: "t", version: "1", content: demoTemplate } };
}
function sourceRows() {
  return [childScale, parentScale, teacherScale].map((scale, index) => ({
    id: `55555555-5555-4555-8555-55555555555${index}`, family_id: familyId, region: "HK",
    triad_round_id: roundId, respondent_role: roles[index], respondent_id: userIds[index],
    snapshot: snapshotFor(scale, roles[index]), answers: previewAnswers(scale), submitted_at: "2026-10-20T00:00:00.000Z", scale_version_id: `${scale.id}@${scale.version}`,
  }));
}
function configure(single = false, staged = false) {
  vi.mocked(query).mockImplementation((async (sql: string) => {
    if (sql.includes("WITH candidate AS")) return [{ id: jobId, assessment_id: sources[1].id, attempts: 1, source_assessment_ids: single ? null : sources.map(row => row.id),...(staged?{report_version:3,triad_round_id:roundId}:{}) }];
    if (sql.includes("SELECT * FROM assessments WHERE id=")) return [sources[1]];
    if (sql.includes("FROM families f JOIN memberships")) return members;
    if (sql.includes("FROM families f JOIN users")) return observationAuthor?[observationAuthor]:[];
    if (sql.startsWith("SELECT report_workflow")) return [{report_workflow:"parent_first_v1",created_at:"2026-10-20T00:00:00.000Z"}];
    if (sql.includes("SELECT id,respondent_role,answers")) return sources;
    return [];
  }) as never);
  vi.mocked(transaction).mockImplementation((async (fn: (client: unknown) => Promise<unknown>) => fn({ query: async (sql: string, values: unknown[]) => {
    publicationCalls.push(sql);
    if (sql.includes("FROM families f JOIN memberships")) return { rows: membershipChangedAtPublish ? members.slice(0, 2) : members };
    if (sql.includes("FROM families f JOIN users")) return {rows:observationAuthor&&!observationRevokedAtPublish?[observationAuthor]:[]};
    if (sql.includes("FROM assessments") && sql.includes("FOR SHARE")) {
      const current = single ? [sources[1]] : sources;
      return { rows: sourceChangedAtPublish ? current.map((row, index) => index === 0 ? { ...row, respondent_id: "ordinary" } : row) : current };
    }
    if (sql.includes("AS scopes FROM consents")) return { rows: [{ scopes: ["parent_report"] }] };
    if (sql.includes("INSERT INTO reports")) published = JSON.parse(String(values[staged?4:3]));
    if (sql.includes("UPDATE report_jobs SET state=$1")) failureCode = String(values[3]);
    return { rows: [{ id: "locked", assessment_id: sources[1].id }] };
  } })) as never);
}

beforeEach(() => {
  vi.stubEnv("NOVA_REGION", "HK"); vi.stubEnv("NOVA_MODE", "service");
  vi.stubEnv("NOVA_AUTH_PROVIDER", "clerk");
  vi.stubEnv("NOVA_TEST_ACCOUNT_USERNAMES", "test.student,test.parent,test.teacher");
  vi.stubEnv("NOVA_SYNTHETIC_TEST_FAMILY_IDS", familyId);
  vi.stubEnv("NOVA_PUBLIC_URL", "https://synthetic.example.invalid");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64)); vi.stubEnv("NOVA_REPORT_STORAGE", "database");
  vi.stubEnv("NOVA_AI_ENABLED", "true"); vi.stubEnv("NOVA_AI_BASE_URL", "https://api.deepseek.com");
  vi.stubEnv("NOVA_AI_API_KEY", "synthetic-key"); vi.stubEnv("NOVA_AI_MODEL", "deepseek-flash"); vi.stubEnv("NOVA_AI_DEPLOYMENT_SCOPE", "HK");
  sources = sourceRows();
  members = roles.map((role, index) => ({ id: userIds[index], role, user_role: role, username: `test.${role}`, region: "HK", family_region: "HK", disabled: false, demo: false, has_password: true }));
  published = undefined; failureCode = undefined; publicationCalls = []; membershipChangedAtPublish = false; sourceChangedAtPublish = false;
  observationAuthor=undefined;observationRevokedAtPublish=false;
  vi.mocked(query).mockReset(); vi.mocked(transaction).mockReset(); vi.mocked(renderPdf).mockReset().mockResolvedValue(Buffer.from("%PDF synthetic")); vi.mocked(writePrivatePdf).mockClear(); vi.mocked(selectNarrative).mockReset();
  configure();
});
afterEach(() => vi.unstubAllEnvs());

describe("designated synthetic family worker", () => {
  function stagedSources(){
    vi.stubEnv("NOVA_TEST_ACCOUNT_USERNAMES","test.student,test.parent,test.teacher,test.staff");
    sources=[stagedChildScale,stagedParentScale,topeStaffScale].map((scale,index)=>({...sources[index],snapshot:{...snapshotFor(scale,roles[index]),syntheticTest:true},scale_version_id:`${scale.id}@${scale.version}`,answers:previewAnswers(scale),...(index===2?{respondent_id:"test-staff-id",respondent_context:"tope_staff"}:{})}));
    observationAuthor={id:"test-staff-id",assigned_to:"test-staff-id",user_role:"staff",username:"test.staff",region:"HK",family_region:"HK",disabled:false,demo:false,has_password:true};
    configure(false,true);
  }
  it("publishes a staged synthetic report with an explicitly allowlisted assigned staff observer",async()=>{
    stagedSources();
    await expect(processReportJob(jobId)).resolves.toEqual({status:"published"});
    expect(published).toMatchObject({syntheticTest:true,revision:{version:3},generationMode:"template"});
    expect(selectNarrative).not.toHaveBeenCalled();
  });
  it("rechecks synthetic observer eligibility under the publication lock",async()=>{
    stagedSources();observationRevokedAtPublish=true;
    await expect(processReportJob(jobId)).resolves.toEqual({status:"terminal"});
    expect(renderPdf).toHaveBeenCalledTimes(2);expect(published).toBeUndefined();expect(failureCode).toBe("SYNTHETIC_TEST_SCOPE_REQUIRED");
  });
  it("does not treat an ordinary assigned staff account as a synthetic source",async()=>{
    stagedSources();observationAuthor!.username="ordinary.staff";
    await expect(processReportJob(jobId)).resolves.toEqual({status:"terminal"});
    expect(renderPdf).not.toHaveBeenCalled();expect(published).toBeUndefined();
  });
  it("publishes the pinned legacy triad without changing norms or invoking AI", async () => {
    await expect(processReportJob(jobId)).resolves.toEqual({ status: "published" });
    expect(published).toMatchObject({ syntheticTest: true, aiConsented: false, generationMode: "template", aiModel: null, score: { demo: true } });
    expect(published!.scale.norm.validated).toBe(false);
    expect(sources.every(source => source.snapshot.syntheticTest === undefined)).toBe(true);
    expect(selectNarrative).not.toHaveBeenCalled();
    expect(writePrivatePdf).toHaveBeenCalledTimes(2);
    expect(publicationCalls.some(sql => sql.includes("FROM families f JOIN memberships") && sql.includes("FOR SHARE"))).toBe(true);
    expect(publicationCalls.some(sql => sql.includes("FROM assessments") && sql.includes("FOR SHARE"))).toBe(true);
    for (const locale of ["zh-CN", "zh-HK"] as const) expect(reportHtml(published!, locale)).toContain(locale === "zh-CN" ? "线上合成测试报告" : "線上合成測試報告");
  });
  it("uses deterministic advice for synthetic single-scale jobs even when AI is enabled and consented", async () => {
    sources[1] = { ...sources[1], triad_round_id: null, snapshot: snapshotFor(demoScale, "parent"), answers: previewAnswers(demoScale) };
    configure(true);
    await expect(processReportJob(jobId)).resolves.toEqual({ status: "published" });
    expect(published).toMatchObject({ syntheticTest: true, aiConsented: false, generationMode: "template", aiModel: null, fallbackReason: "synthetic_test" });
    expect(published!.selectedAdviceIds.length).toBeGreaterThan(0);
    expect(selectNarrative).not.toHaveBeenCalled();
    for (const locale of ["zh-CN", "zh-HK"] as const) expect(reportHtml(published!, locale)).toContain(locale === "zh-CN" ? "线上合成测试报告" : "線上合成測試報告");
  });
  it.each(["config", "ordinary_member", "disabled_member", "wrong_region"] as const)("keeps marked synthetic snapshots blocked when %s invalidates the family", async reason => {
    sources[1].snapshot.syntheticTest = true;
    if (reason === "config") vi.stubEnv("NOVA_SYNTHETIC_TEST_FAMILY_IDS", "");
    if (reason === "ordinary_member") members[2].username = "ordinary.teacher";
    if (reason === "disabled_member") members[2].disabled = true;
    if (reason === "wrong_region") members[2].region = "CN";
    await expect(processReportJob(jobId)).resolves.toEqual({ status: "terminal" });
    expect(published).toBeUndefined(); expect(renderPdf).not.toHaveBeenCalled(); expect(selectNarrative).not.toHaveBeenCalled();
    expect(failureCode).toBe("SYNTHETIC_TEST_SCOPE_REQUIRED");
  });
  it.each(["respondent", "role"] as const)("refuses pinned sources with a mismatched %s", async change => {
    if (change === "respondent") sources[2].respondent_id = "ordinary";
    else sources[2].respondent_id = userIds[0];
    await expect(processReportJob(jobId)).resolves.toEqual({ status: "terminal" });
    expect(published).toBeUndefined(); expect(renderPdf).not.toHaveBeenCalled();
  });
  it("does not trust a synthetic marker when the family is not configured", async () => {
    vi.stubEnv("NOVA_SYNTHETIC_TEST_FAMILY_IDS", "");
    sources[1].snapshot.syntheticTest = true;
    await expect(processReportJob(jobId)).resolves.toEqual({ status: "terminal" });
    expect(published).toBeUndefined(); expect(selectNarrative).not.toHaveBeenCalled();
  });
  it("revalidates current membership under the publication lock", async () => {
    membershipChangedAtPublish = true;
    await expect(processReportJob(jobId)).resolves.toEqual({ status: "terminal" });
    expect(renderPdf).toHaveBeenCalledTimes(2);
    expect(published).toBeUndefined(); expect(writePrivatePdf).not.toHaveBeenCalled();
    expect(failureCode).toBe("SYNTHETIC_TEST_SCOPE_REQUIRED");
  });
  it("rejects source identity changes before publication", async () => {
    sourceChangedAtPublish = true;
    await expect(processReportJob(jobId)).resolves.toEqual({ status: "terminal" });
    expect(renderPdf).toHaveBeenCalledTimes(2);
    expect(published).toBeUndefined(); expect(writePrivatePdf).not.toHaveBeenCalled();
    expect(failureCode).toBe("SYNTHETIC_TEST_SCOPE_REQUIRED");
  });
  it("honors removal of the configured synthetic family before publication", async () => {
    vi.mocked(renderPdf).mockImplementation(async () => {
      vi.stubEnv("NOVA_SYNTHETIC_TEST_FAMILY_IDS", "");
      return Buffer.from("%PDF synthetic");
    });
    await expect(processReportJob(jobId)).resolves.toEqual({ status: "terminal" });
    expect(published).toBeUndefined(); expect(writePrivatePdf).not.toHaveBeenCalled();
    expect(failureCode).toBe("SYNTHETIC_TEST_SCOPE_REQUIRED");
  });
  it("does not accept a source from an unconfigured family", async () => {
    sources[1].family_id = "99999999-9999-4999-8999-999999999999";
    sources[1].snapshot.syntheticTest = true;
    await expect(processReportJob(jobId)).resolves.toEqual({ status: "terminal" });
    expect(published).toBeUndefined(); expect(renderPdf).not.toHaveBeenCalled();
  });
  it("requires the source lookup and locked recheck to use the pinned family, region and round", async () => {
    await expect(processReportJob(jobId)).resolves.toEqual({ status: "published" });
    const lookup = vi.mocked(query).mock.calls.find(([sql]) => sql.includes("SELECT id,respondent_role,answers"));
    expect(lookup?.[1]).toEqual([sources.map(source => source.id), familyId, "HK", roundId]);
    expect(publicationCalls.some(sql => sql.includes("triad_round_id IS NOT DISTINCT FROM $4::uuid") && sql.includes("family_id=$2 AND region=$3") && sql.includes("FOR SHARE"))).toBe(true);
  });
});
