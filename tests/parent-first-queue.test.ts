import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/config", () => ({ getConfig: () => ({ region: "HK", mode: "demo" }), isDemoMode: () => true }));
import { queueTriadReport } from "../src/lib/triad";

const parent = { id: "10000000-0000-4000-8000-000000000001", respondent_role: "parent" };
const child = { id: "10000000-0000-4000-8000-000000000002", respondent_role: "student" };
const teacher = { id: "10000000-0000-4000-8000-000000000003", respondent_role: "teacher" };
const family = "20000000-0000-4000-8000-000000000001", round = "30000000-0000-4000-8000-000000000001";
function database(workflow = "parent_first_v1") {
  const state = { sources: [parent], consent: true, jobs: [] as { sourceIds: string[]; version: number }[] };
  const sql = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes("FROM triad_rounds")) return { rows: [{ id: round, report_workflow: workflow }] };
    if (sql.includes("FROM assessments")) return { rows: state.sources };
    if (sql.includes("FROM consents")) return { rows: [{ scopes: state.consent ? ["parent_report"] : [] }] };
    if (sql.includes("MAX(report_version)")) return { rows: [{ version: state.jobs.length + 1 }] };
    if (sql.startsWith("INSERT INTO report_jobs")) {
      const sourceIds = values[2] as string[];
      const existing = state.jobs.find(job => JSON.stringify(job.sourceIds) === JSON.stringify(sourceIds));
      if (!existing) state.jobs.push({ sourceIds, version: Number(values[4] ?? 1) });
      return { rows: existing ? [] : [{ id: values[0] }] };
    }
    return { rows: [] };
  });
  return { state, client: { query: sql } as unknown as PoolClient };
}
describe("parent-first report admission", () => {
  it("queues the parent alone, then each distinct source set, without rewriting a prior version", async () => {
    const { state, client } = database();
    await queueTriadReport(client, family, round);
    expect(state.jobs).toEqual([{ sourceIds: [parent.id], version: 1 }]);
    state.sources = [parent, child];
    await queueTriadReport(client, family, round);
    await queueTriadReport(client, family, round);
    state.sources = [parent, child, teacher];
    await queueTriadReport(client, family, round);
    expect(state.jobs).toEqual([
      { sourceIds: [parent.id], version: 1 },
      { sourceIds: [parent.id, child.id], version: 2 },
      { sourceIds: [parent.id, child.id, teacher.id], version: 3 }
    ]);
  });
  it("still requires parent consent and a submitted parent", async () => {
    const { state, client } = database();
    state.consent = false;
    await queueTriadReport(client, family, round);
    expect(state.jobs).toHaveLength(0);
    state.consent = true; state.sources = [child, teacher];
    await queueTriadReport(client, family, round);
    expect(state.jobs).toHaveLength(0);
  });
  it("preserves the full-triad gate for an existing round", async () => {
    const { state, client } = database("legacy_triad");
    await queueTriadReport(client, family, round);
    expect(state.jobs).toHaveLength(0);
    state.sources = [parent, child, teacher];
    await queueTriadReport(client, family, round);
    expect(state.jobs).toHaveLength(1);
  });
});
