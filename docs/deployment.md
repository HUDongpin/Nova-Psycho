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

## Parent questionnaire 1.1.0 release

Before deploying code that defaults to `growth-parent@1.1.0`, register that immutable version in the existing TopE `HK/service` database. Run the bounded migration with the authorized restricted environment file:

```sh
node --env-file=/secure/nova-init.env --import tsx scripts/migrations/20261016-parent-questionnaire.ts
node --env-file=/secure/nova-init.env --import tsx scripts/migrations/20261016-parent-questionnaire.ts --apply
```

The first command checks the target and content without writing. The second adds only the missing `1.1.0` row in a transaction. It rejects a conflicting existing definition or retired version and preserves all previous questionnaire rows. Repeated application is safe. It does not run schema setup, rewrite existing assessments or publish reports. Existing parent tasks keep `1.0.0`; new tasks use `1.1.0`. Retain the new version if reverting application code because existing tasks may reference it.

## Queue execution and recovery

Completing the required submissions with effective parent-report consent creates a durable SQL job. A completed submission without that consent stays held, and granting consent queues or resumes the same report once. The API awaits a queue publish containing only `{jobId, region}`. The consumer claims that specific regional job, renders both PDFs, and publishes under the existing family lock and claim token. Duplicate or stale deliveries cannot publish twice or claim a different job. A report has at most three render attempts, including attempts interrupted by a crash.

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
- Worker deletion, orphan cleanup and failed-render cleanup try the matching shared transaction lock inside `removePrivatePdf`. A busy backup returns `busy` immediately: files and queued deletion tasks remain in place, and the current cleanup pass stops. The continuous worker can still generate reports and update its heartbeat. Cleanup retries on a later pass after the backup releases its lock; report generation itself is not locked.
- The archive contains exactly those referenced files, not whatever happens to sit in the live report directory. A missing referenced file fails the backup rather than recording success. Stray or later-written files are left on disk; unpublished jobs can regenerate after restore, and deletion of an already-absent file stays idempotent.
- The exclusive lock is acquired with `lock_timeout = 60s`. If a deletion or another backup still holds it after that, this backup fails instead of claiming a consistent copy. Physical deletion is deferred for the duration of dump-plus-copy; this does not hold the worker inside a lock wait. Other database or filesystem errors still fail explicitly.

The report key itself is never included. The fingerprint exists so that a restore can detect a mismatched key, which would otherwise produce silently unreadable PDFs.

The dump contains answer and snapshot data in plaintext. Set `NOVA_BACKUP_KEY` (64 hex characters) to encrypt both archives with AES-256-GCM; without it the command warns loudly and protection rests entirely on the storage medium. Files are written `0600` inside a `0700` directory. The database password is passed through the environment rather than as a command argument, so it does not appear in the process table.

A backup is refused if `pg_restore --list` reports no table data, so an empty or failed dump is never recorded as a valid backup. Private staging directories and plaintext dumps are removed during normal error handling if encryption or a later step fails. Process termination, a crash or a cleanup filesystem error can leave private staging behind; interruption handling is described below.

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
- the target report directory is not empty, cannot be created or cannot accept a preflight write

After restoring it verifies the region, the mode, every known per-table row count, the report file count, and **each `reports.pdf_keys` filename against the restored directory**. A matching total file count is not enough: a missing referenced PDF fails the drill. Manifest table names are matched against an allowlist; unknown names are not interpolated into SQL. Keep the target web service isolated from traffic. Keep report workers and queue consumers stopped until the authorization, consent and deletion reconciliation below is complete; run subsequent validation only in the isolated target.

The database restore uses a single transaction: an SQL failure rolls back the database changes. The database and report filesystem are **not** restored in one atomic transaction. A later extraction, disk, permission or verification failure exits unsuccessfully but can leave a restored database with incomplete files. Region/mode checks and health responses do not certify a completed restore, and there is no automatic quarantine flag. Do not start service against that target. Preserve the failure evidence and retry into a fresh isolated database and report directory; the script deliberately refuses to overwrite a partial target and does not drop or repair it automatically.

A backup restores authorization and consent **as of its snapshot**. Before starting workers or admitting traffic, reconcile later password changes, local sessions, recovery links, invitation acceptance or revocation, Clerk revocations, disabled accounts, roles, assignments, memberships, deletions and consent withdrawals against an authoritative post-snapshot record. Clearing sessions alone does not suffice: an older password hash can allow a new login, and old consent can permit report processing. Clerk manages its own credentials, while restored Nova identity mappings and local revocations can still be stale. If the later state cannot be established, keep the target isolated until the service owner chooses a recovery and re-verification policy; this script cannot reconstruct lost history or choose that policy. The same snapshot-freshness requirement applies to database-backed report recovery.

After authorization and consent reconciliation, start the report worker to complete physical deletion, confirm that the deletion queue drains, open and decrypt a historical PDF, and publish one new authorized synthetic assessment end to end. Switch service traffic only after these checks succeed. Neither `--verify-only` nor the final row/file checks certify authorization freshness or render every historical PDF.

Encrypted restores decrypt only into their own unique `.restore-*` staging directory, with directory mode `0700` and plaintext file mode `0600`, and remove that directory on ordinary completion or failure. On the supported macOS/Linux process environment, during decryption and database/file restoration, `SIGINT` and `SIGTERM` request coordinated cancellation: stop and wait for the owned restore commands before removing their plaintext staging. If command termination cannot be confirmed within the cancellation window, the command fails and reports the retained private staging path rather than deleting potentially active inputs. An interrupted restore exits unsuccessfully; interruption after the database commit can still leave a partial target. An uncatchable `SIGKILL`, a process crash or filesystem cleanup failure can prevent removal. Keep backups on restricted encrypted media. After an interrupted drill, confirm that its restore process and subprocesses have stopped, identify that exact drill's owned staging directory, and handle its plaintext under the applicable retention policy. Do not delete all `.restore-*` directories by name or age: another drill may still be using one, and an unrelated sibling may not belong to this run.

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

## Password login for designated test accounts

In Clerk mode, `NOVA_TEST_ACCOUNT_USERNAMES` enables a separate username/password entry for a comma-separated list of existing synthetic test accounts. Keep this variable in the production secret configuration; do not put usernames or passwords in the repository. The service database and account classification stay unchanged. Leave the variable unset to disable this entry. Ordinary local login, public demo login, and local registration remain disabled in Clerk mode.

Test login verifies the existing password and uses a separate regional cookie and token namespace. Every request checks the allowlist, account status, region, and session expiry. Removing an account from the list immediately prevents its existing test session from authorizing requests. An expired test session cannot silently switch to a coexisting email identity. Opening the email sign-in or registration page clears the test session before showing the email form.

### Synthetic questionnaire and report testing in production

`NOVA_SYNTHETIC_TEST_FAMILY_IDS` optionally lists exact family UUIDs designated for
synthetic testing. Keep this configuration private and unset by default. It grants
no access by itself: the caller must use a designated test-account session, and the
family must contain exactly one active parent, student and teacher, all in the
configured region and all on `NOVA_TEST_ACCOUNT_USERNAMES`. Ordinary Clerk sessions,
other families and ordinary members retain the formal-instrument restrictions.

Draft, submission and assignment paths recheck this scope inside the family
transaction. Report workers check the canonical pinned source identities and
recheck membership before publication. Consent, ownership, age/role eligibility,
retake intervals, immutable submissions, stale-draft rejection and report access
rules still apply. This synthetic configuration does not change public registration
or family joining; the application's registered `growth-triad` versions are available
in service mode independently, with their unvalidated and non-diagnostic status retained.

Synthetic snapshots and reports are explicitly marked. They always use rule
templates, never call AI, and never change `scale.norm.validated`. An existing
submitted synthetic source can participate only when its actual family, round,
respondent and role match the current scoped family; it is not rewritten.
Both questionnaire and report explain that this is synthetic testing, not a
formal assessment or diagnosis.

Before enabling a family, verify its members and synthetic-data provenance and
preserve a recovery record. Ensure the keyed `growth-triad` advice/template library
exists; the bounded helper in
`scripts/migrations/20261020-synthetic-triad-content.ts` adds missing canonical
rows in a caller-owned transaction and refuses conflicting existing content.
Do not run full setup or mark an instrument validated to enable testing. Deploy
after changing the environment allowlist, including when disabling this channel.
Disabled or changed database members invalidate the scope on the next check.

## Consent and workspace schema upgrade

Existing databases created before the consent-scope changes need
[`20261020-consent-workspace-schema.sql`](../scripts/migrations/20261020-consent-workspace-schema.sql).
Back up the entire database, including `report_files`, verify the archive, and preserve
the report encryption key separately before applying this migration. Compare the live
schema with `src/lib/schema.sql` and rehearse against a schema-only copy with synthetic
fixtures. Do not run the full setup script against production.

The bounded migration adds consent-scope revocations, purpose-specific grant indexes,
content-library metadata, alert resolution fields, and the report job `paused` state.
Existing grants remain unchanged. Invalid or duplicate grants abort the transaction
instead of being silently revoked. It uses an advisory lock and short lock and statement
timeouts and can be applied again without rewriting existing rows.

Use an authenticated PostgreSQL client with errors configured to stop execution.
Afterward, compare original-column fingerprints and verify the resulting columns,
constraints, indexes, and immutable-data triggers. Verify actual parent, student, and
teacher login and workspace loading on the deployed domain. A ready deployment or a
successful login alone does not prove that `/api/workspace` can read the production
schema. Keep the additive schema during a code rollback; do not drop consent history
or restore a database over subsequent user activity as a routine rollback.

### Starting another synthetic round

The designated parent test session can start a new round from its synthetic
family's detail page after the latest three-person round has a published synthetic
report. `POST /api/families/:id/synthetic-retake` accepts exactly
`{ previousRoundId, locale }`. It checks the same synthetic family membership and
all three participation/report consent scopes under a family lock, then creates
three empty tasks using the prior round's same active questionnaire versions.
Existing answers, timestamps and reports remain untouched. Repeating a request
for the same previous round returns the same immediate successor rather than
creating another round. An incomplete or inconsistent next round blocks creation.

This separate endpoint alone permits immediate synthetic retesting. Ordinary
assignment and its `RETAKE_INTERVAL` check are unchanged, as are Clerk email
registration and verification. Disabling the existing test-account/family scope
also disables this entry. Retake eligibility does not grant permission to change
questionnaire definitions or mark norms validated.


## Non-clinical triad trial release

The default questionnaires are `growth-parent@1.3.0`, `growth-child@1.3.0`, and `growth-teacher@1.2.0`. Before deploying the trial admission change, run `npx tsx scripts/migrations/20261021-triad-trial.ts` against the approved production connection as a dry run. After reviewing its three target versions, run the same command with `--apply`. The migration requires an initialized HK/service database, compatible growth-triad advice and template content, and unvalidated canonical definitions. It inserts only missing target versions and rejects conflicting or retired targets. It preserves every original scale row and does not modify families, tasks, answers, reports, or prior versions. Repeating the migration inserts no duplicate versions. Do not run `db:setup` on the live service for this release.

The web and worker use the same trial admission policy. Questionnaire entry and reports explicitly say “非临床试用 / 非臨床試用”; `norm.validated` remains false. Existing consent requirements, regional authorization, private report access, and the separate synthetic-account channel still apply. A code rollback can leave the additive questionnaire versions stored; do not delete versions already referenced by tasks.

The service-mode browser regression is `NOVA_SERVICE_ONBOARDING_BASE_URL=https://localhost:<port> npx tsx tests/service-onboarding.browser.ts`. Run it only against an owned local service database with local authentication, HTTPS, the continuous report worker, and AI disabled. It creates ordinary synthetic parent/student/teacher accounts, fills each questionnaire through the browser, reloads saved drafts, submits, checks optional report consent, and downloads both report languages. It does not test real email verification delivery.
