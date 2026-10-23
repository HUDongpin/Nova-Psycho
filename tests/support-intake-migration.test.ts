import { describe, expect, it } from "vitest";
import { registerSupportIntake, type SupportIntakeMigrationClient } from "../scripts/migrations/20261023-support-intake";
import { childScaleStaffNotes, parentScaleStaffNotes, teacherScaleStaffNotes, childScaleSupportIntake, parentScaleSupportIntake, teacherScaleSupportIntake } from "../src/domain/triad-scales";
import { triadAdvice, triadTemplate } from "../src/lib/triad";
import type { ScaleDefinition } from "../src/domain/types";
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const targets = [childScaleSupportIntake, parentScaleSupportIntake, teacherScaleSupportIntake];
const ids = targets.map(scale => `${scale.id}@${scale.version}`);
const row = (scale: ScaleDefinition) => ({ id: `${scale.id}@${scale.version}`, scale_id: scale.id, version: scale.version, status: "active", definition: json(scale), created_at: "preserved" });
function database() {
  let rows = [childScaleStaffNotes, parentScaleStaffNotes, teacherScaleStaffNotes].map(row);
  let saved = json(rows);
  const state = { region: "HK", failInsert: 0, lock: true, statements: [] as string[], get rows() { return rows; } };
  const client: SupportIntakeMigrationClient = { async query(sql, values = []) {
    state.statements.push(sql);
    if (sql.startsWith("BEGIN")) saved = json(rows);
    if (sql === "ROLLBACK") rows = saved;
    if (sql.includes("FROM public.deployment_settings")) return { rows: [{ singleton: true, region: state.region, mode: "service" }] };
    if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ acquired: state.lock }] };
    if (sql.includes("FROM public.content_versions")) return { rows: [{ version: "1.0.0", content: values[0] === "advice" ? triadAdvice : triadTemplate }] };
    if (sql.startsWith("INSERT INTO public.scales")) {
      if (state.statements.filter(value => value.startsWith("INSERT")).length === state.failInsert) throw new Error("Synthetic insert failure");
      rows.push({ id: String(values[0]), scale_id: String(values[1]), version: String(values[2]), status: "active", definition: JSON.parse(String(values[3])), created_at: "new" });
    }
    if (sql === "SELECT * FROM public.scales ORDER BY id") return { rows: json([...rows].sort((a, b) => a.id.localeCompare(b.id))) };
    return { rows: [] };
  } };
  return { client, state };
}
describe("support-intake insert-only migration", () => {
  it("defaults to a read-only inventory of the three 2.0 definitions", async () => {
    const { client, state } = database(), before = json(state.rows);
    expect(await registerSupportIntake(client)).toMatchObject({ mode: "dry-run", missingIds: ids, insertedIds: [], existingVersionsPreserved: true });
    expect(state.rows).toEqual(before);
    expect(state.statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(state.statements.some(sql => /INSERT|UPDATE|DELETE|LOCK TABLE|pg_try_advisory/.test(sql))).toBe(false);
  });
  it.each(["CN", "HK"])("adds exact targets once in %s and preserves legacy rows", async region => {
    const { client, state } = database(); state.region = region;
    const before = json(state.rows);
    expect(await registerSupportIntake(client, true)).toMatchObject({ insertedIds: ids });
    expect(state.rows.slice(0, before.length)).toEqual(before);
    expect(state.rows.slice(before.length).map(value => value.definition)).toEqual(json(targets));
    const once = json(state.rows);
    expect(await registerSupportIntake(client, true)).toMatchObject({ insertedIds: [], alreadyPresentIds: ids });
    expect(state.rows).toEqual(once);
    expect(state.statements.some(sql => /^(UPDATE|DELETE|ALTER|CREATE|DROP)/.test(sql))).toBe(false);
  });
  it.each(["content", "status"])("rejects a conflicting %s before any insert", async conflict => {
    const { client, state } = database(), target = row(targets[2]);
    if (conflict === "content") target.definition.title["zh-CN"] = "changed";
    else target.status = "retired";
    state.rows.push(target);
    await expect(registerSupportIntake(client, true)).rejects.toThrow("conflicting content or status");
    expect(state.statements.some(sql => sql.startsWith("INSERT"))).toBe(false);
  });
  it("refuses to retire or repair a missing legacy registration implicitly", async () => {
    const { client, state } = database(); state.rows[0].status = "retired";
    await expect(registerSupportIntake(client, true)).rejects.toThrow("Legacy questionnaire");
    expect(state.statements.some(sql => /^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
  });
  it("rolls back all targets after a partial insert failure", async () => {
    const { client, state } = database(), before = json(state.rows); state.failInsert = 2;
    await expect(registerSupportIntake(client, true)).rejects.toThrow("Synthetic insert failure");
    expect(state.rows).toEqual(before);
    expect(state.statements.at(-1)).toBe("ROLLBACK");
  });
});
