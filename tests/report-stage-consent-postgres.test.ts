import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor, AssessmentSnapshot } from "../src/domain/types";
import { demoAdvice, demoScale, demoTemplate } from "../src/domain/demo";
import { scoreAssessment } from "../src/domain/scoring";
import { noticeVersion } from "../src/lib/privacy";
import { assertThrowawayDatabase, assertThrowawayTarget } from "../scripts/test-database-guard";

vi.mock("../src/lib/pdf", () => ({ renderPdf: vi.fn() }));
vi.mock("../src/domain/narrative", () => ({ selectNarrative: vi.fn() }));

import { renderPdf } from "../src/lib/pdf";
import { selectNarrative } from "../src/domain/narrative";
import { closeDatabase, pool } from "../src/lib/db";
import { recordConsent } from "../src/lib/families";
import { processReportJob } from "../src/lib/worker";
import { prepareDatabase } from "../scripts/setup";

const raceUrl = process.env.NOVA_REPORT_STAGE_RACE_URL;
const selection = { selectedAdviceIds: ["listen"], generationMode: "template" as const, fallbackReason: "ai_disabled", aiModel: null };
const pdf = Buffer.from("%PDF-1.4 synthetic race fixture");
const answers = { q1: 1, q2: 2, q3: 1, q4: 2, q5: 1, q6: 2, q7: 1, q8: 2, q9: 0 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe.skipIf(!raceUrl)("PostgreSQL report stage consent races", () => {
  const families: string[] = [], users: string[] = [];
  let familyId: string, jobId: string, parent: Actor;

  beforeAll(async () => {
    assertThrowawayTarget({ mode: "demo", databaseUrl: raceUrl!, aiEnabled: false });
    if (!/^\/nova_consent_race(?:_test_[a-z0-9_]+)?$/.test(new URL(raceUrl!).pathname)) throw new Error("Use a dedicated nova_consent_race test database");
    vi.stubEnv("DATABASE_URL", raceUrl!); vi.stubEnv("NOVA_REGION", "CN"); vi.stubEnv("NOVA_MODE", "demo");
    vi.stubEnv("NOVA_AI_ENABLED", "false"); vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3199");
    vi.stubEnv("NOVA_REPORT_STORAGE", "database"); vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
    vi.stubEnv("NOVA_WORKER_MODE", "continuous"); vi.stubEnv("VERCEL", "0");
    await assertThrowawayDatabase();
    await prepareDatabase();
  }, 20_000);

  beforeEach(async () => {
    vi.mocked(selectNarrative).mockReset().mockResolvedValue(selection);
    vi.mocked(renderPdf).mockReset().mockResolvedValue(pdf);
    familyId = randomUUID(); jobId = randomUUID();
    parent = { id: randomUUID(), name: "Synthetic race guardian", role: "parent", region: "CN" };
    const assessmentId = randomUUID(), submittedAt = new Date().toISOString();
    const snapshot: AssessmentSnapshot = {
      scale: demoScale, advice: { id: "synthetic-advice", version: "1.0.0", content: demoAdvice }, template: { id: "synthetic-template", version: "1.0.0", content: demoTemplate },
      score: scoreAssessment(demoScale, answers, { age: 12, region: "CN", role: "parent" }),
      childName: "Synthetic race child", grade: "S2", submittedAt, aiConsented: true,
    };
    await pool().query("INSERT INTO users(id,region,name,role,demo) VALUES($1,'CN',$2,'parent',true)", [parent.id, parent.name]);
    users.push(parent.id);
    await pool().query("INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label) VALUES($1,'CN','Synthetic race family','Synthetic race child','2014-01-01','S2','Synthetic guardian')", [familyId]);
    families.push(familyId);
    await pool().query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,'parent')", [familyId, parent.id]);
    for (const scope of ["assessment", "sensitive_data", "parent_report", "ai_processing"]) {
      await pool().query("INSERT INTO consents(id,family_id,actor_id,guardian_name,method,reference,notice_version,scopes) VALUES($1,$2,$3,'Synthetic guardian','synthetic','SYNTHETIC-STAGE-RACE',$4,$5)", [randomUUID(), familyId, parent.id, noticeVersion, JSON.stringify([scope])]);
    }
    await pool().query("INSERT INTO assessments(id,family_id,region,respondent_id,respondent_role,scale_version_id,locale,status,answers,snapshot,submitted_at) VALUES($1,$2,'CN',$3,'parent',$4,'zh-CN','queued',$5,$6,$7)", [assessmentId, familyId, parent.id, `${demoScale.id}@${demoScale.version}`, JSON.stringify(answers), JSON.stringify(snapshot), submittedAt]);
    await pool().query("INSERT INTO report_jobs(id,assessment_id) VALUES($1,$2)", [jobId, assessmentId]);
  });

  afterAll(async () => {
    try {
      if (families.length) await pool().query("DELETE FROM families WHERE id=ANY($1::uuid[])", [families]);
      if (users.length) await pool().query("DELETE FROM users WHERE id=ANY($1::uuid[])", [users]);
    } finally { await closeDatabase(); vi.unstubAllEnvs(); }
  });

  const withdraw = (scope: "parent_report" | "ai_processing" = "parent_report") => recordConsent(parent, familyId, { action: "withdraw", scope, guardianName: "Synthetic guardian" });
  async function waitForLock(sqlPart: string) {
    await expect.poll(async () => {
      const waiting = await pool().query<{ query: string }>("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND state='active'");
      return waiting.rows.some(row => row.query.includes(sqlPart));
    }, { timeout: 5000, interval: 20 }).toBe(true);
  }
  async function expectPaused() {
    expect((await pool().query("SELECT state,attempts,claim_token FROM report_jobs WHERE id=$1", [jobId])).rows[0]).toEqual({ state: "paused", attempts: 0, claim_token: null });
    expect((await pool().query("SELECT id FROM reports WHERE family_id=$1", [familyId])).rows).toEqual([]);
    expect((await pool().query("SELECT file_key FROM report_files WHERE family_id=$1", [familyId])).rows).toEqual([]);
  }

  it("honors a withdrawal queued ahead of narrative admission on the family row", async () => {
    const holder = await pool().connect();
    let open = false;
    let revoking: Promise<unknown> | undefined, running: ReturnType<typeof processReportJob> | undefined;
    try {
      await holder.query("BEGIN"); open = true;
      await holder.query("SELECT id FROM families WHERE id=$1 FOR UPDATE", [familyId]);
      revoking = withdraw();
      await waitForLock("FROM families f WHERE f.id=$1");
      running = processReportJob(jobId);
      await waitForLock("SELECT id FROM families WHERE id=$1 AND region=$2 FOR SHARE");
      expect(selectNarrative).not.toHaveBeenCalled();
      await holder.query("COMMIT"); open = false;
      await revoking;
      await expect(running).resolves.toEqual({ status: "paused" });
      expect(selectNarrative).not.toHaveBeenCalled(); expect(renderPdf).not.toHaveBeenCalled();
      await expectPaused();
    } finally {
      if (open) await holder.query("ROLLBACK");
      holder.release();
      await Promise.allSettled([revoking, running].filter(Boolean));
    }
  }, 10_000);

  it("allows withdrawal to commit while narrative is in flight and never starts its PDF", async () => {
    const entered = deferred<void>(), finish = deferred<typeof selection>();
    vi.mocked(selectNarrative).mockImplementation(() => { entered.resolve(); return finish.promise; });
    let settled = false;
    const running = processReportJob(jobId).then(result => { settled = true; return result; });
    try {
      await entered.promise;
      await withdraw();
      expect(settled).toBe(false);
      expect(renderPdf).not.toHaveBeenCalled();
      finish.resolve(selection);
      await expect(running).resolves.toEqual({ status: "paused" });
      expect(renderPdf).not.toHaveBeenCalled();
      await expectPaused();
    } finally { finish.resolve(selection); await running; }
  });

  it.each([1, 2])("withdrawal during locale %s blocks further rendering and publication", async locale => {
    const entered = deferred<void>(), finish = deferred<Buffer>();
    let renders = 0, settled = false;
    vi.mocked(renderPdf).mockImplementation(() => {
      renders += 1;
      if (renders !== locale) return Promise.resolve(pdf);
      entered.resolve();
      return finish.promise;
    });
    const running = processReportJob(jobId).then(result => { settled = true; return result; });
    try {
      await entered.promise;
      await withdraw();
      expect(settled).toBe(false);
      finish.resolve(pdf);
      await expect(running).resolves.toEqual({ status: "paused" });
      expect(renderPdf).toHaveBeenCalledTimes(locale);
      await expectPaused();
    } finally { finish.resolve(pdf); await running; }
  });

  it("keeps AI consent independent and passes its current value into the admitted narrative", async () => {
    await withdraw("ai_processing");
    await expect(processReportJob(jobId)).resolves.toEqual({ status: "published" });
    expect(selectNarrative).toHaveBeenCalledWith(expect.objectContaining({ aiConsented: false }), expect.objectContaining({ enabled: false }));
    expect(renderPdf).toHaveBeenCalledTimes(2);
    expect((await pool().query("SELECT file_key FROM report_files WHERE family_id=$1", [familyId])).rows).toHaveLength(2);
  });
});
