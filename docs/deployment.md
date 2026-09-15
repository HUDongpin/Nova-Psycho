# Regional deployment and operations

## Operating boundary

What is verified today is two independent local CN/HK sets of database, application and report directory. Production should deploy the same application image into two environments actually located in mainland China and Hong Kong. Two local ports, or two databases, do not by themselves prove real geographic residency.

Deployment mode is written into the database `deployment_settings`, and the application checks both the region and the `demo/service` classification. A demo database cannot be upgraded to a service database by changing one environment variable; create a new service database and use a verified professional instrument.

`deploy/Dockerfile` contains the Next.js application, the report-process runtime dependencies, Chromium and Noto CJK fonts. `deploy/compose.yml` starts the database, migration, web and report processes separately for each region. The database has no host public port; by default the web service listens only on host 127.0.0.1, fronted by that region's HTTPS reverse proxy.

## Per-region configuration

Prepare a permissions-600 environment file outside version control, following the root `.env.example`. Set these separately:

- `NOVA_MODE=service`, and the correct `NOVA_REGION=CN` or `HK`.
- A real HTTPS site origin `NOVA_PUBLIC_URL`; this is also the basis for server-side write-request origin validation.
- This region's `DATABASE_URL`, plus the PostgreSQL settings needed to create the database on first run.
- This region's independent `NOVA_REPORT_KEY` (a 32-byte random key expressed as 64 hex characters). The database and disk/backups also need the encryption and access control provided by the deployment environment.
- A private report directory. Docker uses `/var/lib/nova/reports`; it must not be mapped to a public static directory or a public storage bucket.
- `NOVA_DIST_DIR=.next`, so that CN and HK share one image build.

Replace the environment file paths in the example commands with the real paths for that region. No cloud resources are created, no services are purchased, and no real family data is sent:

```sh
docker build -f deploy/Dockerfile -t nova-psycho-helper:0.1.0 .
NOVA_ENV_FILE=/secure/nova-cn.env docker compose --env-file /secure/nova-cn.env -f deploy/compose.yml config --quiet
NOVA_ENV_FILE=/secure/nova-cn.env docker compose --env-file /secure/nova-cn.env -f deploy/compose.yml up -d
```

Run the same flow on the Hong Kong host with a separate Hong Kong environment file. Do not copy a production environment file, a database backup or a report key into the other region as a convenience for testing.

The first migration creates no users and no clinical content. Supply `NOVA_NEW_USER_USERNAME`, `NOVA_NEW_USER_NAME`, `NOVA_NEW_USER_ROLE` (admin or staff) and `NOVA_NEW_USER_PASSWORD` through the deployment environment's secure secret input, and run `node --import tsx scripts/create-user.ts` in the corresponding container. Do not put passwords in command arguments or terminal logs. Afterwards, parents, students and teachers create their own accounts through one-time invitations.

## AI regional verification

When AI is not enabled, or credentials are incomplete, the rule template continues to publish reports automatically. To enable Bailian, set:

- `NOVA_AI_ENABLED=true`
- `NOVA_AI_DEPLOYMENT_SCOPE=CN` or `HK`, which must equal the deployment region.
- `NOVA_AI_BASE_URL`: the HTTPS OpenAI-compatible address of the corresponding regional business workspace, with path `/compatible-mode/v1`.
- `NOVA_AI_MODEL`, and this business workspace's `NOVA_AI_API_KEY`.

The software restricts the configured address to regional domains and rejects cross-region and global domains, but **a domain name and environment variables alone cannot prove that the business workspace actually used in-region inference nodes**. Before enabling real data, verify that workspace's actual inference scope, storage, logging and data-use terms in the Model Studio console, and retain the deployment configuration as evidence. Per the official documentation, the access/storage region and the service deployment scope are separate settings: https://help.aliyun.com/zh/model-studio/hong-kong-china-global

This version sends only age band, respondent role, structured scores/bands and optional advice — not names, contact details, school, per-item answers or case observations. No model call is made without current AI-processing consent. Risk signals always use the preset template and do not wait for AI.

### Verifying the adapter against a real workspace

The adapter's constraints are unit-tested, but those tests use a stubbed fetcher. To verify it against an actual regional workspace, with credentials configured for that region, run:

```sh
node scripts/run-region.mjs CN ai-conformance
```

This script imports no database module and builds its snapshot in memory from the fictional demo instrument, so there is no code path by which real family data can reach the provider. It refuses to run if the active instrument is not marked as a demo instrument, inspects the transmitted payload for identity and raw-answer leakage, and never prints the API key or response bodies. It reports per-assumption results with stable codes, writes evidence to `work/qa/ai-conformance.json`, and exits non-zero if any check fails. See `docs/ai-regional-verification.md` for what each check means and which assumptions were confirmed against the official documentation rather than a live call.

## Monitoring and recovery

- `/api/health` checks the database connection, region and mode; a successful probe alone does not prove the report pipeline works.
- Monitor the ready/running/failed counts and the oldest wait time in `report_jobs`, and confirm the report process runs continuously. Processes claim jobs under a lease; an expired lease can be taken over by another process, and after at most three failures a job is explicitly marked failed.
- Failure logs contain only the region, attempt count and a stable error code; do not add answers, report bodies, cookies or vendor request content to logs for troubleshooting.
- After diagnosing and fixing an infrastructure problem, failed jobs can be rescheduled in that region; first confirm the family still exists and consent is still valid. The action should leave an operational record and must not serve as a per-report clinical approval step. The workspace shows a "requeue report generation" control to administrators and staff for failed tasks, calling `POST /api/assessments/:id/retry-report` and returning `{id,status:'queued'}`; repeated clicks must be blocked while the request is in flight, and the server error or the requeued explanation must be shown before refreshing. Parents, students and teachers cannot see or use this action. After an instrument version is retired, only an administrator can reactivate it through a confirmation dialog (`PATCH /api/scales/:id`, `{status:'active'}`), with the server validating the current advice content; on a mismatch it stays retired and shows the error.
- Data deletion immediately revokes query and session access; encrypted file deletion runs through a persistent deletion queue, and the report process also clears orphaned files. The report process is therefore also a necessary service for completing physical deletion.

## Backup and restore

Back up PostgreSQL, the private report files and the report key independently for each region, on restricted and encrypted backup media in that region. The key is backed up separately under its own controls and must not be mixed into public code packages. Before changing a key, design an old-file migration or key-versioning strategy; replacing a key directly makes existing PDFs undecryptable.

### Taking a backup

```sh
npm run backup:cn
npm run backup:hk
```

This writes `work/backups/<REGION>/<timestamp>/` (override with `NOVA_BACKUP_DIR`) containing a `pg_dump` custom-format dump, an archive of the private report directory, and a `manifest.json` holding sizes, SHA-256 checksums, per-table row counts, the region and mode, and a **fingerprint** of the report key.

The report key itself is never included. The fingerprint exists so that a restore can detect a mismatched key, which would otherwise produce silently unreadable PDFs.

The dump contains answer and snapshot data in plaintext. Set `NOVA_BACKUP_KEY` (64 hex characters) to encrypt both archives with AES-256-GCM; without it the command warns loudly and protection rests entirely on the storage medium. Files are written `0600` inside a `0700` directory. The database password is passed through the environment rather than as a command argument, so it does not appear in the process table.

A backup is refused if `pg_restore --list` reports no table data, so an empty or failed dump is never recorded as a valid backup.

### Restoring

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

After restoring it verifies the region, the mode, every per-table row count and the report file count against the manifest, and exits non-zero if any check fails. Stop the report worker before restoring and start it afterwards: it is also the service that completes physical deletion. Switch service traffic only after that verification.

A restore drill was run against the local CN environment on 2026-09-15. Seventeen tables and twelve report files were restored into a throwaway database; every row count matched the manifest, and all twelve restored report files decrypted back to valid PDFs with the report key. The live database was not modified, and the drill database was dropped afterwards.

## External inputs required for production

Code, partial tests and local runs are no substitute for: professional instruments and standard worked examples, electronic and commercial licensing, mainland/Hong Kong applicability evidence, real domains and cloud environments, the institution's information notice and service-responsibility arrangements, and real region-restricted inference credentials and acceptance. The v1 base capabilities are implemented in this source; the retry/reactivation interface in this batch passed central tests and local browser verification on 2026-09-15 (see `docs/grok-batch-20260915.md`). Professional instruments, licensing, cloud residency, Bailian regional inference and device acceptance are not yet complete, and the current source state must not be written up as having passed them.
