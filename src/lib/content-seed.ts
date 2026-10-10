import { randomUUID } from "node:crypto";
import type { AdviceLibrary, ReportTemplate } from "../domain/types";
import { query } from "./db";

// Separate from the general library administrators publish. Submissions for the
// growth triad read this key; currentContent keeps returning library_key IS NULL.
export const TRIAD_LIBRARY_KEY = "growth-triad";

export function contentCanonical(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      const source = input as Record<string, unknown>;
      return Object.fromEntries(Object.keys(source).sort().map(key => [key, normalize(source[key])]));
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

export function nextContentPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return "1.0.0";
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export type SeededContentResult = "inserted" | "unchanged" | "kept_staff";

// Insert a missing seeded library, or a new immutable version when the seed text changed.
// A latest row whose origin is not seed was published for this key by staff: leave it in place.
// Rows with no library key are never read or written here.
export async function upsertSeededContent(kind: "advice" | "template", libraryKey: string, content: AdviceLibrary | ReportTemplate): Promise<SeededContentResult> {
  const rows = await query<{ id: string; version: string; content: unknown; origin: string }>("SELECT id,version,content,origin FROM content_versions WHERE kind=$1 AND library_key=$2 ORDER BY created_at DESC,id DESC LIMIT 1", [kind, libraryKey]);
  const latest = rows[0];
  if (latest && contentCanonical(latest.content) === contentCanonical(content)) return "unchanged";
  if (latest && latest.origin !== "seed") return "kept_staff";
  const version = latest ? nextContentPatch(latest.version) : "1.0.0";
  await query("INSERT INTO content_versions(id,kind,version,content,library_key,origin) VALUES($1,$2,$3,$4,$5,'seed') ON CONFLICT (kind, library_key, version) WHERE library_key IS NOT NULL DO NOTHING", [randomUUID(), kind, version, JSON.stringify(content), libraryKey]);
  return "inserted";
}
