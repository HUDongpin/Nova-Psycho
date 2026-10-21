# Reproduce triad comparison checks

Run from a fresh checkout as a normal operating-system user:

```sh
npm ci
node scripts/triad-comparison-checks.mjs
```

Prerequisites are Node.js compatible with this repository, native PostgreSQL tools
(`initdb`, `pg_ctl`, `postgres`), Poppler's `pdftotext`, and a local Chrome/Chromium
installation. The runner finds PostgreSQL using `pg_config --bindir` or `PATH`,
and finds Chromium using Playwright's installed browser, Chrome on macOS, or
common executable names on `PATH`. It does not install packages or browsers.

Optional explicit overrides:

```sh
NOVA_TRIAD_PG_BIN=/path/to/postgresql/bin \
NOVA_CHROMIUM_EXECUTABLE=/path/to/chromium \
NOVA_TRIAD_CHECKS_OUTPUT_DIR=work/my-triad-checks \
node scripts/triad-comparison-checks.mjs
```

The output directory must not already exist and must be inside this checkout's
`work/`. Keep its relative path short (the runner checks the OS Unix-socket limit).
The npm/tsx child uses a checkout-relative temporary-directory path so long
checkout paths do not exceed that limit; its temporary files still stay in `work/`. PostgreSQL must run as a non-root user. The runner allocates available
loopback ports rather than using a shared database or an existing `.env` file.

It creates separate CN and HK PostgreSQL clusters, copies the current checkout's
application sources into the run directory, and starts local web and worker
processes with demo mode, local authentication, and AI disabled. Source hashes,
private generated configuration, process receipts, logs, and evidence stay under
`work/`. Configuration and generated secrets have permission `0600`; do not
publish those files.

The checks run in this order:

1. The HTTP integration registers three synthetic respondents, publishes a first
   report, verifies the immediate retake restriction, and submits a second round
   after 91 virtual days. It checks per-role comparisons, immutable prior data,
   bilingual HTML/PDF, authorization, and desktop/mobile browser rendering.
2. The selection integration uses a separate synthetic database to exercise
   earlier-round selection, missing or failed prior reports, incompatible
   versions, changed respondents, and optional dimensions through the real worker.
3. The existing `npm run test:integration` suite runs against the same regional
   applications with their clocks returned to the current time.

Only the dedicated app/worker processes load `tests/helpers/triad-clock.mjs`.
The first round uses an application-clock offset of −91 days, then the second
round uses zero. PostgreSQL's clock remains unchanged. Accepted assessment
snapshots and dates are never rewritten, and immutability triggers remain active.

The runner stops its own web, worker, and database processes in `finally`, also on
SIGINT/SIGTERM. It retains evidence and reports cleanup status in `cleanup.json`.
`results.json` records the overall result; individual integration results, PDFs,
HTML, browser screenshots, and private logs are in the corresponding subfolders.
This verifies local synthetic behavior, not a deployed service or real participants.
