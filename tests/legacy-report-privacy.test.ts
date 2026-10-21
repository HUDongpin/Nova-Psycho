import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/auth", async original => ({ ...await original<typeof import("../src/lib/auth")>(), requireActor: vi.fn(), audit: vi.fn() }));
vi.mock("../src/lib/storage", () => ({ readPrivatePdf: vi.fn() }));

import { ReportCards } from "../src/components/workspace-views";
import type { Report } from "../src/components/api";
import { GET } from "../src/app/api/[...path]/route";
import { demoAdvice, demoScale, demoTemplate } from "../src/domain/demo";
import { reportHtml } from "../src/domain/report-html";
import { scoreAssessment } from "../src/domain/scoring";
import { composeTriad, previewAnswers, type TriadSource } from "../src/domain/triad-report";
import { parentScaleSafety, teacherScaleSafety } from "../src/domain/triad-scales";
import type { Actor, Locale, ReportPayload, ScaleDefinition } from "../src/domain/types";
import { requireActor } from "../src/lib/auth";
import { query } from "../src/lib/db";
import { reportFor, reportSummary } from "../src/lib/reports";
import { readPrivatePdf } from "../src/lib/storage";

const REPORT_ID = "11111111-2222-4333-8444-555555555555";
const FAMILY_ID = "22222222-3333-4444-8555-666666666666";
const SENTINEL = "SYNTHETIC_SERVICE_TEAM_PRIVATE";
const KEPT = "SYNTHETIC_PARENT_REPORT_TEXT";
const submittedAt = "2026-10-21T03:00:00.000Z";
const actor: Actor = { id: "99999999-8888-4777-8666-555555555555", name: "Synthetic parent", role: "parent", region: "CN" };

function source(scale: ScaleDefinition): TriadSource {
  const answers = previewAnswers(scale);
  for (const item of scale.items) if (["q32", "q33", "q34", "q35", "q36", "q37", "q38", "t23"].includes(item.id)) answers[item.id] = `${SENTINEL}_${item.id}`;
  if (scale.roles[0] === "parent") answers.p_worry = KEPT;
  return { role: scale.roles[0], scale, answers, score: scoreAssessment(scale, answers, { age: 12, region: "CN", role: scale.roles[0] }), submittedAt };
}

function payload(): ReportPayload {
  const sources = [source(parentScaleSafety), source(teacherScaleSafety)];
  return { scale: parentScaleSafety, score: sources[0].score, advice: { id: "synthetic-advice", version: "1.0.0", content: demoAdvice }, template: { id: "synthetic-template", version: "1.0.0", content: demoTemplate }, childName: "合成测试孩子", grade: "初中", submittedAt, aiConsented: false, selectedAdviceIds: [], generationMode: "template", fallbackReason: "triad_combined", aiModel: null, comparison: { available: false }, triad: composeTriad(sources) };
}

function reportRow() {
  const p = payload();
  delete (p.triad as { parentAudienceVersion?: number }).parentAudienceVersion;
  return { id: REPORT_ID, family_id: FAMILY_ID, assessment_id: REPORT_ID, region: "CN", payload: p, pdf_keys: { "zh-CN": "old.zh-CN.pdf.enc", "zh-HK": "old.zh-HK.pdf.enc" }, html_documents: { "zh-CN": `<html>${SENTINEL}</html>`, "zh-HK": `<html>${SENTINEL}</html>` }, created_at: new Date(submittedAt) };
}
let row = reportRow();
let familyAllowed = true;
let reportConsent = true;

beforeEach(() => {
  vi.stubEnv("NOVA_REGION", "CN"); vi.stubEnv("NOVA_MODE", "demo");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR", "work/test-private"); vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
  vi.clearAllMocks(); row = reportRow(); familyAllowed = true; reportConsent = true;
  vi.mocked(requireActor).mockResolvedValue(actor);
  vi.mocked(readPrivatePdf).mockResolvedValue(Buffer.from(`%PDF ${SENTINEL}`));
  vi.mocked(query).mockImplementation((async (sql: string) => {
    if (sql.includes("FROM reports WHERE id=$1")) return [row];
    if (sql.includes("FROM families f WHERE f.id=$1")) return familyAllowed ? [{ id: FAMILY_ID, region: "CN" }] : [];
    if (sql.includes("AS scopes FROM consents WHERE family_id=$1")) return reportConsent ? [{ scopes: ["parent_report"] }] : [];
    return [];
  }) as typeof query);
});
afterEach(() => vi.unstubAllEnvs());

describe("legacy service-team writing", () => {
  it("keeps frozen answers and scoring while excluding legacy team writing from new parent documents", () => {
    const sources = [source(parentScaleSafety), source(teacherScaleSafety)];
    const frozen = JSON.stringify(sources);
    const triad = composeTriad(sources);
    expect(JSON.stringify(triad)).not.toContain(SENTINEL);
    expect(JSON.stringify(triad)).toContain(KEPT);
    expect(triad).toHaveProperty("parentAudienceVersion", 1);
    expect(JSON.stringify(sources)).toBe(frozen);
    for (const locale of ["zh-CN", "zh-HK"] as Locale[]) {
      const html = reportHtml({ ...payload(), triad }, locale);
      expect(html).not.toContain(SENTINEL);
      expect(html).toContain(KEPT);
    }
  });

  it("labels a historical repair that omits all previously stored writing", () => {
    const repaired = payload();
    Object.assign(repaired.triad!, { words: [], legacyWritingOmitted: true });
    for (const locale of ["zh-CN", "zh-HK"] as Locale[]) {
      const html = reportHtml(repaired, locale);
      expect(html.includes(locale === "zh-CN" ? "文字回答已隐藏" : "文字回答已隱藏")).toBe(true);
      expect(html.includes(SENTINEL)).toBe(false);
      expect(html.includes(KEPT)).toBe(false);
    }
  });

  it.each(["", "/document", "/pdf"])("blocks historical stored content at the %s report endpoint", async suffix => {
    for (const locale of ["zh-CN", "zh-HK"] as Locale[]) {
      const response = await GET(new Request(`http://127.0.0.1:3100/api/reports/${REPORT_ID}${suffix}?locale=${locale}`), { params: Promise.resolve({ path: ["reports", REPORT_ID, ...suffix.split("/").filter(Boolean)] }) });
      expect(response.status).toBe(409);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body.code).toBe("REPORT_PRIVACY_REFRESH_REQUIRED");
      expect(body.error).toContain(locale === "zh-CN" ? "隐私" : "私隱");
      expect(JSON.stringify(body)).not.toContain(SENTINEL);
    }
    expect(readPrivatePdf).not.toHaveBeenCalled();
  });

  it("blocks unmarked historical reports even when their payload words are empty but stored HTML is not", async () => {
    row.payload.triad!.words = [];
    await expect(reportFor(actor, REPORT_ID)).rejects.toMatchObject({ code: "REPORT_PRIVACY_REFRESH_REQUIRED" });
  });

  it.each([undefined, null])("holds a legacy triad source when its composed report is %s", async missing => {
    row.payload.triad = missing as never;
    for (const suffix of ["", "/document", "/pdf"]) {
      const response = await GET(new Request(`http://127.0.0.1:3100/api/reports/${REPORT_ID}${suffix}`), { params: Promise.resolve({ path: ["reports", REPORT_ID, ...suffix.split("/").filter(Boolean)] }) });
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("REPORT_PRIVACY_REFRESH_REQUIRED");
    }
    expect(readPrivatePdf).not.toHaveBeenCalled();
    for (const locale of ["zh-CN", "zh-HK"] as Locale[]) {
      const summary = reportSummary(row, locale);
      expect(summary).toMatchObject({ combined: true, privacyRefreshRequired: true, title: locale === "zh-CN" ? "孩子的成长了解" : "孩子的成長了解" });
      expect(JSON.stringify(summary).includes(SENTINEL)).toBe(false);
    }
  });

  it("keeps safe summaries available and indicates why the document is unavailable", () => {
    const summary = reportSummary(row, "zh-CN");
    expect(summary).toHaveProperty("privacyRefreshRequired", true);
    expect(JSON.stringify(summary)).not.toContain(SENTINEL);
  });

  it.each(["zh-CN", "zh-HK"] as Locale[])("shows a privacy notice instead of a ready report link in %s", locale => {
    const summary = { ...reportSummary(row, locale), privacyRefreshRequired: true } as Report;
    const html = renderToStaticMarkup(createElement(ReportCards, { reports: [summary], locale, navigate: () => undefined }));
    expect(html.includes(locale === "zh-CN" ? "隐私" : "私隱")).toBe(true);
    expect(html.includes(locale === "zh-CN" ? "查看报告" : "查看報告")).toBe(false);
    expect(html.includes(SENTINEL)).toBe(false);
  });

  it("serves newly generated audience-safe reports", async () => {
    row.payload = payload();
    row.html_documents = { "zh-CN": reportHtml(row.payload, "zh-CN"), "zh-HK": reportHtml(row.payload, "zh-HK") };
    await expect(reportFor(actor, REPORT_ID)).resolves.toMatchObject({ id: REPORT_ID });
    expect(reportSummary(row, "zh-CN")).toHaveProperty("privacyRefreshRequired", false);
  });

  it("preserves non-triad report availability", async () => {
    delete row.payload.triad;
    row.payload.scale = demoScale;
    await expect(reportFor(actor, REPORT_ID)).resolves.toMatchObject({ id: REPORT_ID });
  });

  it.each(["family", "consent"])("checks %s before revealing a historical privacy hold", async boundary => {
    if (boundary === "family") familyAllowed = false;
    else reportConsent = false;
    await expect(reportFor(actor, REPORT_ID)).rejects.toMatchObject({ code: boundary === "family" ? "NOT_FOUND" : "GUARDIAN_CONSENT_REQUIRED" });
  });
});
