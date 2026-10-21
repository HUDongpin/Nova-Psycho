import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor, AssessmentSnapshot, ReportPayload } from "../src/domain/types";
import { demoTemplate } from "../src/domain/demo";
import { triadAdvice } from "../src/domain/triad-advice";
import { childScaleStaffNotes, parentScaleStaffNotes, teacherScaleStaffNotes } from "../src/domain/triad-scales";
import { previewAnswers } from "../src/domain/triad-report";
import { scoreAssessment } from "../src/domain/scoring";
import { noticeVersion } from "../src/lib/privacy";
import { assertThrowawayDatabase, assertThrowawayTarget } from "../scripts/test-database-guard";

vi.mock("../src/lib/pdf", () => ({ renderPdf: vi.fn() }));
import { renderPdf } from "../src/lib/pdf";
import { closeDatabase, pool } from "../src/lib/db";
import { recordConsent } from "../src/lib/families";
import { processReportJob } from "../src/lib/worker";
import { prepareDatabase } from "../scripts/setup";

const raceUrl = process.env.NOVA_TRIAD_AI_STAGE_RACE_URL;
const pdf = Buffer.from("%PDF-1.4 synthetic triad race fixture");
const provider = vi.fn<typeof fetch>();
const network = vi.fn<typeof fetch>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function orderedResponse(init?: RequestInit) {
  const envelope = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
  const input = JSON.parse(envelope.messages[1].content) as { advice: { id: string }[] };
  expect(input.advice.length).toBeGreaterThan(1);
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ adviceIds: input.advice.map(block => block.id).reverse() }) } }] }));
}

describe.skipIf(!raceUrl)("PostgreSQL triad AI stage admission", () => {
  const families: string[] = [], users: string[] = [];
  let familyId: string, jobId: string, parent: Actor;

  beforeAll(async () => {
    assertThrowawayTarget({ mode: "demo", databaseUrl: raceUrl!, aiEnabled: false });
    if (!/^\/nova_consent_race_test_triad_ai(?:_[a-z0-9_]+)?$/.test(new URL(raceUrl!).pathname)) throw new Error("Use a dedicated nova_consent_race_test_triad_ai database");
    const env = {
      DATABASE_URL: raceUrl!, NOVA_REGION: "CN", NOVA_MODE: "demo", NOVA_AUTH_PROVIDER: "local",
      NOVA_AI_ENABLED: "false", NOVA_TRIAD_AI_ENABLED: "false", NOVA_PUBLIC_URL: "http://127.0.0.1:3199",
      NOVA_REPORT_STORAGE: "database", NOVA_REPORT_KEY: "0".repeat(64), NOVA_WORKER_MODE: "continuous", VERCEL: "0"
    };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    await assertThrowawayDatabase();
    await prepareDatabase();
    vi.stubGlobal("fetch", network);
    network.mockImplementation(async () => { throw new Error("Synthetic test forbids external requests"); });
  }, 20_000);

  beforeEach(async () => {
    const env = {
      NOVA_AI_ENABLED: "true", NOVA_TRIAD_AI_ENABLED: "true",
      NOVA_AI_BASE_URL: "https://llm-synthetic.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      NOVA_AI_API_KEY: "synthetic-key-no-provider-access", NOVA_AI_MODEL: "synthetic-triad-ordering", NOVA_AI_DEPLOYMENT_SCOPE: "CN"
    };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    provider.mockReset().mockImplementation(async (_input, init) => orderedResponse(init));
    network.mockClear();
    vi.mocked(renderPdf).mockReset().mockResolvedValue(pdf);
    familyId = randomUUID(); jobId = randomUUID();
    parent = { id: randomUUID(), name: "Synthetic triad guardian", role: "parent", region: "CN" };
    const roundId = randomUUID(), submittedAt = new Date().toISOString(), sourceIds: string[] = [];
    await pool().query("INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label) VALUES($1,'CN','Synthetic race family','Synthetic race child','2014-01-01','S2','Synthetic guardian')", [familyId]);
    families.push(familyId);
    await pool().query("INSERT INTO triad_rounds(id,family_id,region) VALUES($1,$2,'CN')", [roundId, familyId]);
    for (const scale of [childScaleStaffNotes, parentScaleStaffNotes, teacherScaleStaffNotes]) {
      const role = scale.roles[0], userId = role === "parent" ? parent.id : randomUUID(), assessmentId = randomUUID();
      const answers = previewAnswers(scale, "calm");
      const snapshot: AssessmentSnapshot = {
        scale, advice: { id: "synthetic-triad-advice", version: "1.0.0", content: triadAdvice },
        template: { id: "synthetic-template", version: "1.0.0", content: demoTemplate },
        score: scoreAssessment(scale, answers, { age: 12, region: "CN", role }),
        childName: "Synthetic race child", grade: "S2", submittedAt, aiConsented: true
      };
      await pool().query("INSERT INTO users(id,region,name,role,demo) VALUES($1,'CN','Synthetic race member',$2,true)", [userId, role]);
      users.push(userId);
      await pool().query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,$3)", [familyId, userId, role]);
      await pool().query("INSERT INTO assessments(id,family_id,region,respondent_id,respondent_role,scale_version_id,locale,status,answers,snapshot,submitted_at,triad_round_id) VALUES($1,$2,'CN',$3,$4,$5,'zh-CN','queued',$6,$7,$8,$9)", [assessmentId, familyId, userId, role, `${scale.id}@${scale.version}`, JSON.stringify(answers), JSON.stringify(snapshot), submittedAt, roundId]);
      sourceIds.push(assessmentId);
    }
    for (const scope of ["assessment", "sensitive_data", "parent_report", "ai_processing"]) {
      await pool().query("INSERT INTO consents(id,family_id,actor_id,guardian_name,method,reference,notice_version,scopes) VALUES($1,$2,$3,'Synthetic guardian','synthetic','SYNTHETIC-TRIAD-STAGE-RACE',$4,$5)", [randomUUID(), familyId, parent.id, noticeVersion, JSON.stringify([scope])]);
    }
    await pool().query("INSERT INTO report_jobs(id,assessment_id,source_assessment_ids) VALUES($1,$2,$3)", [jobId, sourceIds[1], sourceIds]);
  });

  afterAll(async () => {
    try {
      if (families.length) await pool().query("DELETE FROM families WHERE id=ANY($1::uuid[])", [families]);
      if (users.length) await pool().query("DELETE FROM users WHERE id=ANY($1::uuid[])", [users]);
    } finally { await closeDatabase(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); }
  });

  const consent = (action: "grant" | "withdraw", scope: "parent_report" | "ai_processing") => recordConsent(parent, familyId, { action, scope, guardianName: "Synthetic guardian" });
  const run = () => processReportJob(jobId, { narrativeFetcher: provider });
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
  async function expireClaim(client: PoolClient | ReturnType<typeof pool>) {
    await client.query("UPDATE report_jobs SET lease_until=clock_timestamp()+interval '100 milliseconds' WHERE id=$1", [jobId]);
    await expect.poll(async () => (await client.query("SELECT lease_until<=clock_timestamp() AS expired FROM report_jobs WHERE id=$1", [jobId])).rows[0].expired,
      { timeout: 2000, interval: 20 }).toBe(true);
  }

  it.each(["parent_report", "ai_processing"] as const)("honors %s withdrawal queued ahead of triad inference", async scope => {
    const holder = await pool().connect();
    let open = false, revoking: Promise<unknown> | undefined, running: ReturnType<typeof run> | undefined;
    try {
      await holder.query("BEGIN"); open = true;
      await holder.query("SELECT id FROM families WHERE id=$1 FOR UPDATE", [familyId]);
      revoking = consent("withdraw", scope);
      await waitForLock("FROM families f WHERE f.id=$1");
      running = run();
      await waitForLock("SELECT id FROM families WHERE id=$1 AND region=$2 FOR SHARE");
      expect(provider).not.toHaveBeenCalled();
      await holder.query("COMMIT"); open = false;
      await revoking;
      await expect(running).resolves.toEqual({ status: scope === "parent_report" ? "paused" : "published" });
      expect(provider).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
      if (scope === "parent_report") { expect(renderPdf).not.toHaveBeenCalled(); await expectPaused(); }
      else {
        const report = (await pool().query<{ payload: ReportPayload }>("SELECT payload FROM reports WHERE family_id=$1", [familyId])).rows[0];
        expect(report.payload).toMatchObject({ generationMode: "template", fallbackReason: "no_ai_consent" });
        expect(renderPdf).toHaveBeenCalledTimes(2);
      }
    } finally {
      if (open) await holder.query("ROLLBACK");
      holder.release();
      await Promise.allSettled([revoking, running].filter(Boolean));
    }
  }, 10_000);

  it("releases admission locks while triad inference waits and pauses before its first PDF", async () => {
    const entered = deferred<void>(), finish = deferred<Response>();
    let answer: Response | undefined, settled = false;
    provider.mockImplementation((_input, init) => { answer = orderedResponse(init); entered.resolve(); return finish.promise; });
    const running = run().then(result => { settled = true; return result; });
    try {
      await entered.promise;
      await consent("withdraw", "parent_report");
      expect(settled).toBe(false); expect(renderPdf).not.toHaveBeenCalled();
      finish.resolve(answer!);
      await expect(running).resolves.toEqual({ status: "paused" });
      expect(provider).toHaveBeenCalledTimes(1); expect(network).not.toHaveBeenCalled();
      expect(renderPdf).not.toHaveBeenCalled(); await expectPaused();
    } finally { finish.resolve(answer!); await running; }
  });

  it("discards triad AI ordering after withdrawal and regrant during inference", async () => {
    const entered = deferred<void>(), finish = deferred<Response>();
    let answer: Response | undefined;
    provider.mockImplementation((_input, init) => { answer = orderedResponse(init); entered.resolve(); return finish.promise; });
    const running = run();
    try {
      await entered.promise;
      await consent("withdraw", "ai_processing");
      await consent("grant", "ai_processing");
      finish.resolve(answer!);
      await expect(running).resolves.toEqual({ status: "published" });
      const report = (await pool().query<{ payload: ReportPayload }>("SELECT payload FROM reports WHERE family_id=$1", [familyId])).rows[0];
      expect(report.payload).toMatchObject({ generationMode: "template", aiModel: null, fallbackReason: "ai_consent_changed" });
      expect(report.payload.triad?.comparisons).toHaveLength(3);
      expect(provider).toHaveBeenCalledTimes(1); expect(network).not.toHaveBeenCalled(); expect(renderPdf).toHaveBeenCalledTimes(2);
    } finally { finish.resolve(answer!); await running; }
  });

  it.each(["family", "claim"] as const)("refuses triad inference after its lease expires waiting for the %s lock", async waitingFor => {
    const familyHolder = await pool().connect(), claimHolder = await pool().connect();
    let familyOpen = false, claimOpen = false, running: ReturnType<typeof run> | undefined;
    try {
      await familyHolder.query("BEGIN"); familyOpen = true;
      await familyHolder.query("SELECT id FROM families WHERE id=$1 FOR UPDATE", [familyId]);
      running = run();
      await waitForLock("SELECT id FROM families WHERE id=$1 AND region=$2 FOR SHARE");
      if (waitingFor === "claim") {
        await claimHolder.query("BEGIN"); claimOpen = true;
        await claimHolder.query("SELECT id FROM report_jobs WHERE id=$1 FOR UPDATE", [jobId]);
        await familyHolder.query("COMMIT"); familyOpen = false;
        await waitForLock("claim_token=$2 AND state='running'");
        await expireClaim(claimHolder);
        await claimHolder.query("COMMIT"); claimOpen = false;
      } else {
        await expireClaim(pool());
        await familyHolder.query("COMMIT"); familyOpen = false;
      }
      await expect(running).resolves.toMatchObject({ status: "retry_at" });
      expect(provider).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled(); expect(renderPdf).not.toHaveBeenCalled();
      expect((await pool().query("SELECT id FROM reports WHERE family_id=$1", [familyId])).rows).toEqual([]);
    } finally {
      if (familyOpen) await familyHolder.query("ROLLBACK");
      if (claimOpen) await claimHolder.query("ROLLBACK");
      familyHolder.release(); claimHolder.release(); await running;
    }
  }, 10_000);
});
