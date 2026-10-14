import pg from "pg";
import { getConfig } from "../src/lib/config";
import { pool } from "../src/lib/db";

// Read-only gate for scripts that create rows. Checks that do not need the
// database run first. A SELECT may follow; DDL and DML must not.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
// libpq query parameters that replace the URL's server. `?host=` wins over the
// authority, and `service` can load a host from pg_service.conf.
const RETARGET_PARAMETERS = new Set(["host", "hostaddr", "port", "service"]);

export class TestDatabaseRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestDatabaseRefused";
  }
}

export type ThrowawayClassification = "initialize" | "ready";

type DeploymentRow = { region: string; mode: string | null };
type SqlClient = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

function connectionUrl(databaseUrl: string): URL {
  let url: URL;
  try { url = new URL(databaseUrl); }
  catch { throw new TestDatabaseRefused("DATABASE_URL is not a URL"); }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") throw new TestDatabaseRefused("DATABASE_URL must be a PostgreSQL URL");
  return url;
}

function isLocalSocket(host: string): boolean {
  return host.startsWith("/") && !host.split("/").includes("..");
}

// The host node-postgres will dial, including query-parameter overrides and PGHOST.
// connectionParameters is runtime state; the published Client type does not list it.
export function effectiveDatabaseHost(databaseUrl: string): string {
  const client = new pg.Client(databaseUrl) as pg.Client & { connectionParameters: { host?: string | null } };
  return client.connectionParameters.host ?? "";
}

export function assertThrowawayTarget(input: { mode: "demo" | "service"; databaseUrl: string; aiEnabled: boolean }): void {
  const url = connectionUrl(input.databaseUrl);
  for (const key of url.searchParams.keys()) {
    if (RETARGET_PARAMETERS.has(key.toLowerCase())) throw new TestDatabaseRefused(`Refusing connection parameter ${key}; it can retarget the database`);
  }
  const host = effectiveDatabaseHost(input.databaseUrl);
  if (!LOOPBACK_HOSTS.has(host) && !isLocalSocket(host)) throw new TestDatabaseRefused(`Refusing database host ${host || "(none)"}; only a loopback host or local socket is allowed`);
  if (input.mode !== "demo") throw new TestDatabaseRefused("Refusing because NOVA_MODE is not demo");
  if (input.aiEnabled) throw new TestDatabaseRefused("Refusing because AI is enabled");
}

export function classifyThrowawayDatabase(publicTables: string[], deployment: DeploymentRow | null, region: string): ThrowawayClassification {
  if (publicTables.length === 0) return "initialize";
  if (!deployment) throw new TestDatabaseRefused("Refusing a non-empty database with no demo classification");
  if (deployment.mode !== "demo") throw new TestDatabaseRefused("Refusing a database that is not classified demo");
  if (deployment.region !== region) throw new TestDatabaseRefused("Refusing a demo database for a different region");
  return "ready";
}

export async function assertThrowawayDatabase(client?: SqlClient): Promise<ThrowawayClassification> {
  const config = getConfig();
  assertThrowawayTarget({ mode: config.mode, databaseUrl: config.databaseUrl, aiEnabled: config.ai.enabled });
  const db = client ?? pool();
  const tables = await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  const names = tables.rows.map(row => String(row.tablename));
  const deployment = names.includes("deployment_settings")
    ? (await db.query("SELECT region, mode FROM deployment_settings WHERE singleton=true")).rows[0] as DeploymentRow | undefined
    : undefined;
  return classifyThrowawayDatabase(names, deployment ? { region: String(deployment.region), mode: deployment.mode ?? null } : null, config.region);
}
