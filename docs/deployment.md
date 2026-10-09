# Deployment and operations

## Deployment modes

| Environment | Web/API | Reports | Private PDFs |
| --- | --- | --- | --- |
| Vercel + Neon | Next.js functions | Vercel Queue, one job per invocation | AES-GCM encrypted `bytea` rows in PostgreSQL |
| Local or regional Docker | Next.js standalone server | Continuous worker container | Encrypted files in a shared private volume |

The Vercel path needs no permanent worker, separate PDF bucket, or public PDF URL. Both report languages and the published report commit in one database transaction. Family deletion cascades to the encrypted PDF rows. Authentication, family permissions, region checks, and deterministic scoring remain server-side. Reports publish automatically without per-report human approval; AI can remain disabled.

This document specifies the deployment contract. Local tests, PostgreSQL checks, and builds do not prove that the cloud queue, cron, database, or complete website workflow has passed acceptance.

## Vercel + Neon configuration

Use a fresh service database. `deployment_settings` binds the database to `NOVA_REGION` and `NOVA_MODE`; changing an environment variable cannot convert a demo database into a service database. Do not copy local demo accounts, reports, or family records to production.

Configure these production environment variables through secret input. Keep any local initialization file outside version control with mode `0600`.

| Variable | Value or requirement |
| --- | --- |
| `NOVA_MODE` | `service` |
| `NOVA_REGION` | `HK` for the TopE Hong Kong product partition |
| `NOVA_DATA_REGION` | `SG` for the approved Singapore database and encrypted PDF storage |
| `NOVA_PUBLIC_URL` | `https://www.tope.hk` |
| `DATABASE_URL` | Neon pooled PostgreSQL connection string, with TLS |
| `NOVA_REPORT_STORAGE` | `database` |
| `NOVA_WORKER_MODE` | `queue` |
| `NOVA_QUEUE_REGION` | `hkg1`, matching the currently committed Vercel function region |
| `NOVA_REPORT_KEY` | Independent 32-byte random key encoded as 64 hexadecimal characters |
| `CRON_SECRET` | Random secret of at least 32 characters |
| `NOVA_AI_ENABLED` | `false` for initial deployment and synthetic verification |
| `NOVA_DIST_DIR` | `.next` |

`NOVA_REPORT_DIR` is unused and not required in database mode. `VERCEL` is provided by the platform; configuration rejects filesystem storage or continuous workers there. `next.config.ts` uses the Vercel adapter on Vercel and preserves standalone output for Docker.

**Approved deployment choice (2026-10-08):** the owner authorized Singapore Neon through the existing Launch installation, with exactly one primary compute, fixed at `0.25 CU` (minimum and maximum), and scale-to-zero after five minutes of inactivity. Set `NOVA_DATA_REGION=SG` and verify that the served privacy notice accurately describes database and encrypted report storage in Singapore and request handling through Vercel. `NOVA_REGION=HK`, a Hong Kong domain, or a Hong Kong function does not make a Singapore database Hong Kong-resident. This authorization is not evidence that provisioning or cloud acceptance has completed. See the [official Neon region list](https://neon.com/docs/introduction/regions).

Attach both `www.tope.hk` and `tope.hk` to the same Vercel project, with the apex redirecting to `www.tope.hk`. Writes require the exact `NOVA_PUBLIC_URL` origin, and session cookies are host-only. The domain owner handles nameserver changes.

## Initialization and release sequence

1. Use the approved Singapore Launch configuration: one primary compute, `0.25 CU` minimum and maximum, five-minute scale-to-zero, and no additional compute or read replica. Obtain access to the intended Neon project and Vercel project. Preserve production/preview separation; do not point an unreviewed preview at the production database.
2. Create the fresh service database. Prepare a restricted initialization environment file with the variables above, using Neon's **direct** connection URL for schema and administrative commands. Put the pooled URL in Vercel runtime configuration.
3. Apply the schema once before enabling user traffic:

   ```sh
   node --env-file=/secure/nova-init.env --import tsx scripts/setup.ts
   ```

   The command is idempotent for an owned database of the same region and classification. Service mode creates no demo users. It initializes the three operator-intake questionnaires and their narrative content; those questionnaires explicitly have no clinical norm and are not independently validated clinical instruments. Registration no longer runs schema changes or seeds instruments.

4. Supply `NOVA_NEW_USER_USERNAME`, `NOVA_NEW_USER_NAME`, `NOVA_NEW_USER_ROLE` (`admin` or `staff`), and `NOVA_NEW_USER_PASSWORD` through a restricted environment file or secret manager, then run:

   ```sh
   node --env-file=/secure/nova-admin-init.env --import tsx scripts/create-user.ts
   ```

   Do not put passwords in command arguments, shell history, logs, or committed files. Remove bootstrap-only variables from the runtime environment after creating the account.

5. Apply the committed `vercel.json`. The queue consumer is `src/app/api/queues/report/route.ts`, with the private `queue/v2beta` trigger on topic `nova-report`, concurrency `1`, at most `8` deliveries, memory `2048` MB, and a `240`-second duration. The recovery cron calls `/api/cron/report-recovery` daily at `00:00 UTC` (`08:00 Hong Kong time`) and requires `CRON_SECRET`. Do not replace the private trigger with a public worker URL.
6. Build and inspect deployment file traces before upload. No `work/`, `.env*`, `.git/`, or `.vercel/` private metadata may be included. The queue function must include the packaged Chromium binaries and both CJK fonts. A successful build alone is not this check.
7. Verify the deployed domain redirect, login and refresh, three-party synthetic submission, automatic publication, authorized downloads of both PDF languages, failure/retry, deletion, and unauthorized access rejection. Inspect the rendered PDFs for Chinese glyphs and layout. Verify that the queue consumer has no public URL and that the cron is registered and authenticated. Report cloud acceptance separately from local verification.

Neon and queue connection details stay out of AI payloads and ordinary logs. Keep AI disabled during these deployment checks; do not send real family data to a live provider to test the application.

## Queue execution and recovery

Submitting the final required questionnaire creates a durable SQL job. The API awaits a queue publish containing only `{jobId, region}`. The consumer claims that specific regional job, renders both PDFs, and publishes under the existing family lock and claim token. Duplicate or stale deliveries cannot publish twice or claim a different job. A report has at most three render attempts, including attempts interrupted by a crash.

If publishing to the queue fails after the assessment commits, the accepted submission remains saved. One bounded `after()` retry follows; the SQL job remains available for recovery. The daily cron dispatches at most 25 due or expired jobs, with a bounded execution window. A rare dispatch gap with no later activity can wait until that daily sweep. `after()` is not a durable queue replacement and shares the route's time limit. See [Next.js `after`](https://nextjs.org/docs/app/api-reference/functions/after) and [Vercel Queue delivery semantics](https://vercel.com/docs/queues/concepts).

Failed jobs remain visible to staff. `POST /api/assessments/:id/retry-report` revalidates authority, family existence, consent, and immutable triad sources before a fresh delivery. This is operational recovery, not human approval of individual reports. Do not reset job state directly to bypass those checks.

PDFs in database mode are limited to 4 MiB each so authenticated downloads stay below the platform response-body limit. The files use the existing `NOVA1` AES-GCM envelope; a missing or changed report key makes them unreadable. The private queue message retains only job identity, not answers, names, free text, or report content. Vercel documents that queue failover does not provide strict single-region residency, so do not make a stronger residency claim. See [function limits](https://vercel.com/docs/functions/limitations) and [queue regions](https://vercel.com/docs/queues/concepts#regions-and-data-residency).

## Keeping idle costs low

The existing Vercel Neon installation was checked on 2026-10-08 and uses `Launch_v3` across its resources. The owner approved using that installation for TopE with one fixed `0.25 CU` Singapore compute and five-minute scale-to-zero. It is a usage-billed Launch resource, not a separate free database. Provisioning settings and the complete cloud workflow still require live verification.

- Keep Neon's scale-to-zero enabled with the smallest suitable compute and a deliberate maximum. Verify the actual account's free allowance or spending controls instead of assuming a particular bill.
- Do not run the continuous worker against Neon in queue mode. There is no five-second heartbeat or permanent queue polling process.
- Use `/api/liveness` for routine availability monitoring. `/api/health` deliberately queries the database and is for explicit readiness checks; frequent external probes can keep Neon awake.
- Browser status refreshes are bounded and pause when hidden. A family waiting for another respondent must not cause endless database polling. Returning to the tab or using refresh retrieves current status; report execution does not depend on an open browser.
- The daily recovery sweep can wake an idle database once a day. Actual user activity, PDF downloads, administrative checks, backup jobs, and other connected projects can also keep it active.
- Database-backed PDFs consume the database storage allowance. Monitor their total bytes and retention; avoid repeated large exports or backup branches that exhaust free storage or transfer allowances. Switch storage backends only through a verified migration, not by changing one variable on a database containing reports.

Neon normally suspends after inactivity; its documentation specifically advises reducing unnecessary queries and background jobs. [Neon compute guidance](https://neon.com/docs/manage/endpoints/). Vercel Queues is usage-priced by API operation, and consumer compute is billed separately. Current documentation lists one million included queue operations on Hobby and usage-based operations on Pro; concurrency-limited deliveries count extra operation units. Account eligibility, credits, regional pricing, storage, and actual traffic determine the bill. No fixed monthly server is required, but this is not a zero-cost guarantee. [Queue pricing](https://vercel.com/docs/queues/pricing).

## Operations and backup

`GET /api/ops/status` is administrator-only. Queue mode reports `idle`, `processing`, `backlog`, or `failed`; idle is healthy without a worker heartbeat. Investigate `failed_jobs`, `expired_leases`, and `queue_backlog`. Continuous mode additionally reports the worker heartbeat and its stale/never-started warnings. A health response alone never proves report publication or PDF rendering.

Database mode includes encrypted `report_files` in PostgreSQL backups. Back up the report key separately under appropriate secret controls, and verify a restore in an isolated database before relying on it. Family deletion removes live database rows immediately; backup retention is a separate operational policy. The existing filesystem archive backup command rejects database mode. Do not use a filesystem restore manifest for a Neon database or claim that the local file-archive restore drill verifies cloud recovery.

### Filesystem backup and restore (Docker only)

These instructions apply only to `NOVA_REPORT_STORAGE=filesystem`. Back up PostgreSQL, the private report files and the report key independently for each region, on restricted and encrypted backup media in that region. The key is backed up separately under its own controls and must not be mixed into public code packages. Before changing a key, design an old-file migration or key-versioning strategy; replacing a key directly makes existing PDFs undecryptable.

#### Taking a filesystem backup

```sh
npm run backup:cn
npm run backup:hk
```

This writes `work/backups/<REGION>/<timestamp>/` (override with `NOVA_BACKUP_DIR`) containing a `pg_dump` custom-format dump, an archive of the **report files referenced by that dump**, and a `manifest.json` holding sizes, SHA-256 checksums, per-table row counts taken from the same snapshot, the region and mode, and a **fingerprint** of the report key.

Consistency guarantees:

- The backup takes an exclusive PostgreSQL advisory session lock (`807001, 1`) before opening a `REPEATABLE READ READ ONLY` transaction, then exports that snapshot with `pg_export_snapshot()` and passes it to `pg_dump --snapshot`. Manifest row counts and `reports.pdf_keys` are read from the same transaction, which stays open through dump and file copy.
- Worker deletion, orphan cleanup and failed-render cleanup all take the matching shared transaction lock inside `removePrivatePdf`. They wait until the backup has copied the referenced files, then resume. Report generation itself is not locked.
- The archive contains exactly those referenced files, not whatever happens to sit in the live report directory. A missing referenced file fails the backup rather than recording success. Stray or later-written files are left on disk; unpublished jobs can regenerate after restore, and deletion of an already-absent file stays idempotent.
- The exclusive lock is acquired with `lock_timeout = 60s`. If a deletion or another backup still holds it after that, this backup fails instead of claiming a consistent copy. Expect deletions to pause for the duration of dump-plus-copy, typically seconds, longer on a large region.

The report key itself is never included. The fingerprint exists so that a restore can detect a mismatched key, which would otherwise produce silently unreadable PDFs.

The dump contains answer and snapshot data in plaintext. Set `NOVA_BACKUP_KEY` (64 hex characters) to encrypt both archives with AES-256-GCM; without it the command warns loudly and protection rests entirely on the storage medium. Files are written `0600` inside a `0700` directory. The database password is passed through the environment rather than as a command argument, so it does not appear in the process table.

A backup is refused if `pg_restore --list` reports no table data, so an empty or failed dump is never recorded as a valid backup. Private staging directories and plaintext dumps are removed if encryption or a later step fails.

#### Restoring a filesystem deployment

Restore into a new, isolated, same-region environment. The script never writes to the database named by `DATABASE_URL`; the target is supplied explicitly and must be empty.

```sh
createdb -h 127.0.0.1 -p 55431 -U nova nova_restore_drill

NOVA_RESTORE_DATABASE_URL=postgresql://nova:PASSWORD@127.0.0.1:55431/nova_restore_drill \
NOVA_RESTORE_REPORT_DIR=/secure/nova-drill-reports \
NOVA_BACKUP_KEY=<the key the backup was taken with> \
node scripts/run-region.mjs CN restore work/backups/CN/<timestamp>
```

Add `--verify-only` to check the checksums and the key fingerprint without restoring anything.

The restore refuses to proceed when any of the following holds. Each refusal is deliberate:

- the target URL equals `DATABASE_URL`, so a live environment cannot be overwritten
- the backup's region does not match `NOVA_RESTORE_REGION`
- the checksums do not match, so a damaged archive is never applied
- `NOVA_REPORT_KEY` does not match the manifest fingerprint
- the target database already contains tables in the `public` schema
- the target report directory is not empty

After restoring it verifies the region, the mode, every known per-table row count, the report file count, and **each `reports.pdf_keys` filename against the restored directory**. A matching total file count is not enough: a missing referenced PDF fails the drill. Manifest table names are matched against an allowlist; unknown names are not interpolated into SQL. Stop the report worker before restoring and start it afterwards: it is also the service that completes physical deletion. Switch service traffic only after that verification.

A restore drill was run against the local CN environment on 2026-09-15. Seventeen tables and twelve report files were restored into a throwaway database; every row count matched the manifest, and all twelve restored report files decrypted back to valid PDFs with the report key. The live database was not modified, and the drill database was dropped afterwards.

## Local and regional Docker

The defaults remain `NOVA_REPORT_STORAGE=filesystem` and `NOVA_WORKER_MODE=continuous`. Docker requires `NOVA_REPORT_DIR=/var/lib/nova/reports`, a region-specific database and report key, and a private shared report volume. Do not set `VERCEL=1`. Use the appropriate public HTTPS origin for service mode; demo mode remains loopback-only.

```sh
NOVA_ENV_FILE=/secure/nova-cn.env docker compose --env-file /secure/nova-cn.env -f deploy/compose.yml config --quiet
NOVA_ENV_FILE=/secure/nova-cn.env docker compose --env-file /secure/nova-cn.env -f deploy/compose.yml up -d
```

Compose builds separate web and worker targets, runs schema setup first, and keeps the database off public host ports. The web target runs the standalone `server.js`; the worker has Chromium and CJK fonts and handles generation, queued file deletion, and orphan cleanup. Apply the same separation for a Hong Kong deployment on an actual Hong Kong host. Local ports or region variables alone do not prove geographic residency.

AI provider configuration and synthetic conformance checks are documented in [AI regional verification](ai-regional-verification.md). Enabling a live provider requires the appropriate regional credentials, current consent, and verification of the provider's actual processing/storage scope. Clinical instruments, normative claims, and real-data acceptance remain separate from technical deployment.

## Clerk rollout for an existing TopE database

The email-authentication release uses a separate Clerk production instance for `https://www.tope.hk`, with required email verification and the existing password/code sign-in methods. Configure only the production environment with matching `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...`, `CLERK_SECRET_KEY=sk_live_...`, `NOVA_AUTH_PROVIDER=clerk`, `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in` and `NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up`. Keep `NOVA_PUBLIC_URL=https://www.tope.hk`. Omit the optional `NOVA_CLERK_ISSUER` unless it exactly matches the hostname encoded by the production publishable key. Do not reuse development keys or make preview deployments use the production database.

Verify the production Clerk DNS records and both certificates before release. Preserve the apex-to-www redirect. The authentication frontend, account portal and mail records are additional CNAMEs; they do not replace the website records. Clerk authentication data is US-hosted; the login pages and version-3 privacy notice distinguish this from the Singapore family database and encrypted report storage. Existing guardian consent records are retained with their original notice versions. See [Clerk's residency statement](https://clerk.com/security).

For an already initialized `HK/service` database, create and verify a provider-side recovery snapshot in the existing Singapore project before applying [the bounded registration migration](../scripts/migrations/20261009-tope-clerk-auth.sql). Do not run `scripts/setup.ts` for this release. The migration only permits nullable usernames, adds identity/revocation tables, and adds family request and invitation acceptance columns. It has a transaction, target guard, advisory lock, short lock timeout and post-DDL assertions. It does not seed instruments, modify passwords or roles, remove sessions, or rewrite reports. Compare all existing rows' original fields before and after the migration and verify that the runtime role can access the new tables.

Switching authentication modes retires the old local-cookie login path. Existing users, including administrators, should first verify their email through the production Clerk instance, then use **Link existing account** and prove the original Nova username and password. This retains the original Nova UUID, role and family access. They must not create a new parent/teacher profile before linking; an already-bound identity is intentionally rejected. New email users have no family access until Nova authorizes enrollment.

After release, verify the canonical HTTPS sign-up/sign-in pages, real mailbox delivery, legacy administrator linking, a teacher's independent empty workspace, family-code errors, authorized family joining, sign-out, recovery and permission failures. Use only explicitly authorized test identities and synthetic family data. A local-mode standalone build is not production Clerk acceptance.

For rollback, keep the additive schema. A previous local-auth deployment cannot serve newly created Clerk-only accounts, and an old family-deletion implementation may remove independent accounts. Once new Clerk identities exist, prefer a corrective deployment retaining the current authentication/data contract; do not drop new tables or restore a whole database over subsequent user activity as a routine code rollback.
