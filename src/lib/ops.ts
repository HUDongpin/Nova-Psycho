import { getConfig } from "./config";
import { query } from "./db";

// Operational view of the report pipeline. docs/deployment.md asks operators to watch
// the ready/running/failed counts, the oldest wait time and whether the report process
// is actually running. A bare health probe cannot answer the last one: an empty queue
// looks identical whether or not anything is listening to it.

export interface OpsStatus {
  region: "CN" | "HK";
  mode: "demo" | "service";
  checkedAt: string;
  jobs: { ready: number; running: number; done: number; failed: number };
  oldestReadySeconds: number | null;
  expiredLeases: number;
  worker: { alive: boolean; workerId: string | null; heartbeatAgeSeconds: number | null; uptimeSeconds: number | null; cycles: number | null };
  warnings: string[];
}

// The worker heartbeats every 5 seconds, so 60 leaves ample room for a slow cycle.
const WORKER_STALE_SECONDS = 60;
const BACKLOG_SECONDS = 300;

export async function opsStatus(): Promise<OpsStatus> {
  const config = getConfig();

  const jobRows = await query<{ ready: number; running: number; done: number; failed: number; oldest_ready_seconds: number | null; expired_leases: number }>(
    `SELECT count(*) FILTER (WHERE state='ready')::int AS ready,
            count(*) FILTER (WHERE state='running')::int AS running,
            count(*) FILTER (WHERE state='done')::int AS done,
            count(*) FILTER (WHERE state='failed')::int AS failed,
            EXTRACT(EPOCH FROM (now()-min(available_at) FILTER (WHERE state='ready')))::float8 AS oldest_ready_seconds,
            count(*) FILTER (WHERE state='running' AND lease_until<now())::int AS expired_leases
     FROM report_jobs`
  );
  const jobs = jobRows[0] ?? { ready: 0, running: 0, done: 0, failed: 0, oldest_ready_seconds: null, expired_leases: 0 };

  const heartbeatRows = await query<{ worker_id: string; heartbeat_age_seconds: number; uptime_seconds: number; cycles: string | number }>(
    `SELECT worker_id,
            EXTRACT(EPOCH FROM (now()-heartbeat_at))::float8 AS heartbeat_age_seconds,
            EXTRACT(EPOCH FROM (now()-started_at))::float8 AS uptime_seconds,
            cycles
     FROM worker_heartbeats WHERE region=$1`,
    [config.region]
  );
  const beat = heartbeatRows[0];
  const heartbeatAge = beat ? Math.round(beat.heartbeat_age_seconds) : null;
  const alive = heartbeatAge !== null && heartbeatAge <= WORKER_STALE_SECONDS;

  const warnings: string[] = [];
  if (!beat) warnings.push("worker_never_started");
  else if (!alive) warnings.push("worker_stale");
  if (jobs.failed > 0) warnings.push("failed_jobs");
  if (jobs.expired_leases > 0) warnings.push("expired_leases");
  if (jobs.oldest_ready_seconds !== null && jobs.oldest_ready_seconds > BACKLOG_SECONDS) warnings.push("queue_backlog");

  return {
    region: config.region,
    mode: config.mode,
    checkedAt: new Date().toISOString(),
    jobs: { ready: jobs.ready, running: jobs.running, done: jobs.done, failed: jobs.failed },
    oldestReadySeconds: jobs.oldest_ready_seconds === null ? null : Math.round(jobs.oldest_ready_seconds),
    expiredLeases: jobs.expired_leases,
    worker: {
      alive,
      workerId: beat ? beat.worker_id : null,
      heartbeatAgeSeconds: heartbeatAge,
      uptimeSeconds: beat ? Math.round(beat.uptime_seconds) : null,
      cycles: beat ? Number(beat.cycles) : null
    },
    warnings
  };
}
