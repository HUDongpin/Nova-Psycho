import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import pg, { type PoolClient } from "pg";
import { childScale, parentScale, parentScaleV1, teacherScale } from "../../src/domain/triad-scales";
import { parseScale } from "../../src/domain/validation";

const id = "growth-parent@1.1.0";
const canonical = (value: unknown): unknown => JSON.parse(JSON.stringify(parseScale(value)));

/** Adds one immutable content version without rewriting existing assignments. */
export async function registerParentQuestionnaire(client: Pick<PoolClient, "query">, apply = false) {
  if (`${parentScale.id}@${parentScale.version}` !== id) throw new Error("This migration requires the frozen parent 1.1.0 source");
  const definition = canonical(parentScale);
  await client.query(apply ? "BEGIN" : "BEGIN READ ONLY");
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
      const lock = await client.query("SELECT pg_try_advisory_xact_lock(807001, 16) AS acquired");
      if (!lock.rows[0].acquired) throw new Error("Another parent questionnaire migration is active");
      await client.query("LOCK TABLE public.scales IN SHARE ROW EXCLUSIVE MODE");
    }
    const existing = await client.query("SELECT id,scale_id,version,status,definition,created_at FROM public.scales ORDER BY id");
    for (const scale of [parentScaleV1, childScale, teacherScale]) {
      const row = existing.rows.find(row => row.id === `${scale.id}@${scale.version}`);
      if (!row || row.scale_id !== scale.id || row.version !== scale.version || !isDeepStrictEqual(row.definition, canonical(scale))) {
        throw new Error("Existing questionnaire definition does not match the expected release baseline");
      }
    }
    const current = existing.rows.find(row => row.id === id);
    if (current && (current.status !== "active" || current.scale_id !== parentScale.id || current.version !== parentScale.version || !isDeepStrictEqual(current.definition, definition))) {
      throw new Error("Parent 1.1.0 already exists with conflicting content or status");
    }
    if (apply && !current) {
      await client.query("INSERT INTO public.scales(id,scale_id,version,definition) VALUES($1,$2,$3,$4)", [id, parentScale.id, parentScale.version, JSON.stringify(definition)]);
    }
    const after = await client.query("SELECT id,scale_id,version,status,definition,created_at FROM public.scales ORDER BY id");
    if (!isDeepStrictEqual(after.rows.filter(row => row.id !== id), existing.rows.filter(row => row.id !== id))) {
      throw new Error("Existing questionnaire versions changed during migration");
    }
    if (apply) {
      const row = after.rows.find(row => row.id === id);
      if (row?.status !== "active" || !isDeepStrictEqual(row.definition, definition)) throw new Error("New questionnaire verification failed");
    }
    await client.query("COMMIT");
    return { id, applied: apply && !current, alreadyPresent: !!current, existingVersionsPreserved: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--apply")) throw new Error("Usage: 20261016-parent-questionnaire.ts [--apply]");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
  client.on("error", () => {});
  try {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
    await client.connect();
    console.log(JSON.stringify(await registerParentQuestionnaire(client, args[0] === "--apply")));
  } catch {
    console.error("Parent questionnaire migration failed; no success is claimed. Verify the target and content baseline before retrying.");
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}
