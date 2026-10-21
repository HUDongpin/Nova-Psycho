import { describe, expect, it } from "vitest";
import { registerTriadTrial, type TriadMigrationClient } from "../scripts/migrations/20261021-triad-trial";
import { childScale, childScaleStaffNotes, parentScale, parentScaleStaffNotes, parentScaleV1, teacherScale, teacherScaleStaffNotes } from "../src/domain/triad-scales";
import { triadAdvice, triadTemplate } from "../src/lib/triad";
import type { ScaleDefinition } from "../src/domain/types";

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const targets = [childScaleStaffNotes, parentScaleStaffNotes, teacherScaleStaffNotes];
const targetIds = targets.map(scale => `${scale.id}@${scale.version}`);
const row = (scale: ScaleDefinition, status = "active"): Record<string, unknown> => ({ id: `${scale.id}@${scale.version}`, scale_id: scale.id, version: scale.version, status, definition: json(scale), created_at: "2026-10-16T00:00:00.000Z" });

function database() {
  let rows = [childScale, parentScaleV1, parentScale, teacherScale].map(scale => row(scale));
  let saved: Record<string, unknown>[] = [];
  const state = {
    marker: [{ singleton: true, region: "HK", mode: "service" }] as Record<string, unknown>[],
    content: { advice: json(triadAdvice), template: json(triadTemplate) } as Record<string, unknown>,
    lock: true, failInsert: 0, corruptOriginal: false,
    statements: [] as { sql: string; values: unknown[] }[],
    get rows() { return rows; },
  };
  const client: TriadMigrationClient = { async query(sql, values = []) {
    state.statements.push({ sql, values });
    if (sql.startsWith("BEGIN")) saved = json(rows);
    if (sql === "ROLLBACK") rows = saved;
    if (sql.includes("FROM public.deployment_settings")) return { rows: state.marker };
    if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ acquired: state.lock }] };
    if (sql.includes("FROM public.content_versions")) {
      const content = state.content[String(values[0])];
      return { rows: content ? [{ id: `content-${values[0]}`, version: "1.0.0", content }] : [] };
    }
    if (sql.startsWith("INSERT INTO public.scales")) {
      const inserts = state.statements.filter(item => item.sql.startsWith("INSERT INTO public.scales")).length;
      if (state.failInsert === inserts) throw new Error("Synthetic insert failure");
      rows.push({ id: values[0], scale_id: values[1], version: values[2], definition: JSON.parse(String(values[3])), status: "active", created_at: "2026-10-21T00:00:00.000Z" });
      if (state.corruptOriginal) rows[0].status = "retired";
    }
    if (sql === "SELECT * FROM public.scales ORDER BY id") return { rows: json([...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))) };
    return { rows: [] };
  } };
  return { state, client };
}

describe("bounded non-clinical triad content migration", () => {
  it("defaults to a read-only plan without inserting, locking or changing existing records", async () => {
    const { state, client } = database();
    const original = json(state.rows);
    const result = await registerTriadTrial(client);
    expect(result).toMatchObject({ mode: "dry-run", insertedIds: [], missingIds: targetIds, alreadyPresentIds: [], existingVersionsPreserved: true });
    expect(state.rows).toEqual(original);
    expect(state.statements[0].sql).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(state.statements.some(item => /INSERT|UPDATE|DELETE|LOCK TABLE|pg_try_advisory/.test(item.sql))).toBe(false);
    expect(state.statements.at(-1)?.sql).toBe("COMMIT");
  });

  it("adds only the three exact defaults and preserves every original row and validation flag", async () => {
    const { state, client } = database();
    state.rows[0].status = "retired";
    const original = json(state.rows);
    const source = json(targets);
    const result = await registerTriadTrial(client, true);
    expect(result.insertedIds).toEqual(targetIds);
    expect(state.rows.slice(0, original.length)).toEqual(original);
    expect(state.rows.slice(original.length).map(item => item.definition)).toEqual(source);
    expect(state.rows.slice(original.length).every(item => (item.definition as ScaleDefinition).norm.validated === false)).toBe(true);
    expect(json(targets)).toEqual(source);
    expect(state.statements.filter(item => /^(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)/.test(item.sql)).map(item => item.sql)).toEqual(Array(3).fill("INSERT INTO public.scales(id,scale_id,version,definition,status) VALUES($1,$2,$3,$4,'active')"));
    const lockIndex = state.statements.findIndex(item => item.sql.includes("pg_try_advisory_xact_lock"));
    expect(state.statements[lockIndex + 1].sql).toBe("LOCK TABLE public.scales IN SHARE ROW EXCLUSIVE MODE");
    expect(state.statements.some(item => item.sql === "SET LOCAL lock_timeout = '5s'")).toBe(true);
    expect(state.statements.some(item => item.sql === "SET LOCAL statement_timeout = '15s'")).toBe(true);
  });

  it("is idempotent and keeps previously inserted timestamps", async () => {
    const { state, client } = database();
    await registerTriadTrial(client, true);
    const original = json(state.rows);
    state.statements.length = 0;
    expect(await registerTriadTrial(client, true)).toMatchObject({ insertedIds: [], alreadyPresentIds: targetIds });
    expect(state.rows).toEqual(original);
    expect(state.statements.some(item => item.sql.startsWith("INSERT"))).toBe(false);
  });

  it.each([[], [{ singleton: true, region: "CN", mode: "service" }], [{ singleton: true, region: "HK", mode: "demo" }], [{ singleton: false, region: "HK", mode: "service" }], [{ singleton: true, region: "HK", mode: "service" }, { singleton: true, region: "HK", mode: "service" }]].map(marker => ({ marker })))("refuses an incorrect deployment marker %#", async ({ marker }) => {
    const { state, client } = database(); state.marker = marker;
    await expect(registerTriadTrial(client, true)).rejects.toThrow("HK/service");
    expect(state.statements.at(-1)?.sql).toBe("ROLLBACK");
    expect(state.statements.some(item => item.sql.startsWith("INSERT"))).toBe(false);
  });

  it.each(["retired", "content", "identity"])("refuses a conflicting existing target %s", async conflict => {
    const { state, client } = database();
    const existing = row(targets[0]);
    if (conflict === "retired") existing.status = "retired";
    if (conflict === "content") (existing.definition as ScaleDefinition).norm.validated = true;
    if (conflict === "identity") existing.scale_id = "other-child";
    state.rows.push(existing);
    const original = json(state.rows);
    await expect(registerTriadTrial(client, true)).rejects.toThrow("conflicting content or status");
    expect(state.rows).toEqual(original);
    expect(state.statements.at(-1)?.sql).toBe("ROLLBACK");
  });

  it.each(["advice", "template"])("refuses missing or invalid %s content before insertion", async kind => {
    for (const content of [undefined, {}]) {
      const { state, client } = database(); state.content[kind] = content;
      await expect(registerTriadTrial(client, true)).rejects.toThrow(`Growth-triad ${kind} content`);
      expect(state.statements.some(item => item.sql.startsWith("INSERT"))).toBe(false);
      expect(state.statements.at(-1)?.sql).toBe("ROLLBACK");
    }
  });

  it("refuses concurrent content work without acquiring a table lock", async () => {
    const { state, client } = database(); state.lock = false;
    await expect(registerTriadTrial(client, true)).rejects.toThrow("Another content operation is active");
    expect(state.statements.some(item => item.sql.startsWith("LOCK TABLE"))).toBe(false);
    expect(state.statements.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("rolls back already inserted rows if a later insert fails", async () => {
    const { state, client } = database(); const original = json(state.rows); state.failInsert = 2;
    await expect(registerTriadTrial(client, true)).rejects.toThrow("Synthetic insert failure");
    expect(state.rows).toEqual(original);
    expect(state.statements.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("rolls back if any original row changes during insertion", async () => {
    const { state, client } = database(); const original = json(state.rows); state.corruptOriginal = true;
    await expect(registerTriadTrial(client, true)).rejects.toThrow("Existing questionnaire versions changed");
    expect(state.rows).toEqual(original);
    expect(state.statements.at(-1)?.sql).toBe("ROLLBACK");
  });
});
