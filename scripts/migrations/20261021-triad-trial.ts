import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import { childScaleStaffNotes, legacyTriadScaleIds, parentScaleStaffNotes, teacherScaleStaffNotes } from "../../src/domain/triad-scales";
import { ensureAdviceReferences, parseAdvice, parseStoredScale, parseTemplate } from "../../src/domain/validation";

export interface TriadMigrationClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const expectedIds = ["growth-child@1.3.0", "growth-parent@1.3.0", "growth-teacher@1.2.0"];
const scalesSql = "SELECT * FROM public.scales ORDER BY id";

export async function registerTriadTrial(client: TriadMigrationClient, apply = false) {
  const definitions = [childScaleStaffNotes, parentScaleStaffNotes, teacherScaleStaffNotes].map(scale => parseStoredScale(scale));
  const ids = definitions.map(scale => `${scale.id}@${scale.version}`);
  if (!isDeepStrictEqual(ids, expectedIds) || !isDeepStrictEqual(Object.values(legacyTriadScaleIds).sort(), [...expectedIds].sort()) || definitions.some(scale => scale.bundle !== "growth-triad" || scale.norm.validated !== false)) {
    throw new Error("This migration requires the frozen unvalidated triad trial versions");
  }
  const canonical = definitions.map(scale => JSON.parse(JSON.stringify(scale)));
  await client.query(apply ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SET LOCAL search_path = pg_catalog, public");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
    const marker = await client.query("SELECT singleton,region,mode FROM public.deployment_settings");
    if (marker.rows.length !== 1 || marker.rows[0].singleton !== true || marker.rows[0].region !== "HK" || marker.rows[0].mode !== "service") {
      throw new Error("Expected exactly one initialized HK/service deployment marker");
    }
    if (apply) {
      const lock = await client.query("SELECT pg_try_advisory_xact_lock(742681, 1) AS acquired");
      if (lock.rows[0]?.acquired !== true) throw new Error("Another content operation is active; retry after it completes");
      await client.query("LOCK TABLE public.scales IN SHARE ROW EXCLUSIVE MODE");
    }
    const existing = await client.query(scalesSql);
    const existingIds = new Set(existing.rows.map(row => row.id));
    const missingIds: string[] = [];
    const alreadyPresentIds: string[] = [];
    for (const [index, scale] of definitions.entries()) {
      const row = existing.rows.find(row => row.id === ids[index]);
      if (row && (row.status !== "active" || row.scale_id !== scale.id || row.version !== scale.version || !isDeepStrictEqual(row.definition, canonical[index]))) {
        throw new Error(`Target questionnaire ${ids[index]} has conflicting content or status`);
      }
      (row ? alreadyPresentIds : missingIds).push(ids[index]);
    }
    const contentVersions: Record<string, string> = {};
    for (const kind of ["advice", "template"] as const) {
      const result = await client.query("SELECT id,version,content FROM public.content_versions WHERE kind=$1 AND library_key=$2 ORDER BY created_at DESC,id DESC LIMIT 1", [kind, "growth-triad"]);
      if (result.rows.length !== 1) throw new Error(`Growth-triad ${kind} content is missing`);
      const row = result.rows[0];
      try {
        if (kind === "advice") {
          const advice = parseAdvice(row.content);
          for (const scale of definitions) ensureAdviceReferences(scale, advice);
        } else parseTemplate(row.content);
      } catch {
        throw new Error(`Growth-triad ${kind} content does not support the trial questionnaires`);
      }
      contentVersions[kind] = String(row.version);
    }
    if (apply) {
      for (const [index, scale] of definitions.entries()) {
        if (!existingIds.has(ids[index])) {
          await client.query("INSERT INTO public.scales(id,scale_id,version,definition,status) VALUES($1,$2,$3,$4,'active')", [ids[index], scale.id, scale.version, JSON.stringify(canonical[index])]);
        }
      }
    }
    const after = await client.query(scalesSql);
    if (!isDeepStrictEqual(after.rows.filter(row => existingIds.has(row.id)), existing.rows) || after.rows.length !== existing.rows.length + (apply ? missingIds.length : 0)) {
      throw new Error("Existing questionnaire versions changed during migration");
    }
    if (apply) {
      for (const [index, scale] of definitions.entries()) {
        const row = after.rows.find(row => row.id === ids[index]);
        if (row?.status !== "active" || row.scale_id !== scale.id || row.version !== scale.version || !isDeepStrictEqual(row.definition, canonical[index])) {
          throw new Error(`Target questionnaire ${ids[index]} failed verification`);
        }
      }
    }
    await client.query("COMMIT");
    return { mode: apply ? "apply" : "dry-run", insertedIds: apply ? missingIds : [], missingIds, alreadyPresentIds, existingVersionsPreserved: true, contentVersions };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--apply")) throw new Error("Usage: 20261021-triad-trial.ts [--apply]");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
  client.on("error", () => {});
  try {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
    await client.connect();
    console.log(JSON.stringify(await registerTriadTrial(client, args[0] === "--apply")));
  } catch {
    console.error("Triad trial migration failed; no success is claimed. Verify the target, existing versions and growth-triad content before retrying.");
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}
