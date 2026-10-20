import { randomUUID } from "node:crypto";
import { contentCanonical, TRIAD_LIBRARY_KEY } from "../../src/lib/content-seed";
import { triadAdvice, triadTemplate } from "../../src/lib/triad";

type Client = { query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

// Run only after verifying the target and recovery point. The caller owns the
// transaction so the original-record checks and these inserts commit together.
export async function ensureSyntheticTriadContent(client: Client) {
  await client.query("SELECT pg_advisory_xact_lock(742681,1)");
  const results: { kind: string; inserted: boolean }[] = [];
  for (const [kind, content] of [["advice", triadAdvice], ["template", triadTemplate]] as const) {
    const current = await client.query("SELECT id,content FROM content_versions WHERE kind=$1 AND library_key=$2 ORDER BY created_at DESC,id DESC LIMIT 1", [kind, TRIAD_LIBRARY_KEY]);
    if (current.rows[0]) {
      if (contentCanonical(current.rows[0].content) !== contentCanonical(content)) throw new Error("Existing triad content differs; review before changing it");
      results.push({ kind, inserted: false });
      continue;
    }
    await client.query("INSERT INTO content_versions(id,kind,version,content,library_key,origin) VALUES($1,$2,'1.0.0',$3,$4,'seed')", [randomUUID(), kind, JSON.stringify(content), TRIAD_LIBRARY_KEY]);
    results.push({ kind, inserted: true });
  }
  return results;
}
