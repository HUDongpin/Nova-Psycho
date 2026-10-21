# Historical triad report privacy

New triad reports omit parent `q32`–`q38` and teacher `t23` from parent-visible writing, including when their source questionnaire version predates the staff-note versions. The source scale definitions, submitted answers and scoring snapshots remain unchanged. Historical child hopes are not added to staff notes by this change.

The composer records `triad.parentAudienceVersion: 1` in newly generated report payloads. Detail JSON, HTML and PDF reads reject **every unmarked historical triad report** with HTTP 409 `REPORT_PRIVACY_REFRESH_REQUIRED`. This includes older reports that may already have safe content. The guard cannot establish that independently stored HTML and PDF are safe from a legacy payload alone. Family, region and current parent-report consent checks still run first. Safe summary data remains visible with `privacyRefreshRequired: true`; the report card explains the hold and has no ready-to-view link. Non-triad reports are unaffected.

## Local redaction preview

For a single authorized local report export, put the JSON **payload only**, not the whole database row, under `work/`. Use synthetic data for application testing. Run from the repository root:

```sh
npx tsx scripts/preview-legacy-report-redaction.ts work/legacy-payload.json work/redacted-report-preview
```

The output must be a new immediate child directory of `work/`. The command reads one explicit input and writes private JSON, simplified/traditional HTML and PDF files. It makes no database or AI calls and leaves the input unchanged. It omits **all legacy `triad.words`**, because the stored words lack stable item IDs. A notice explains the omission. Original scores, safety notices and comparisons remain unchanged. `manifest.json` records the source-file hash and the fact that runtime state was not changed.

This is a review bundle, not a runtime repair. The report stays unavailable until an explicitly scoped restoration replaces its payload, both HTML documents and both private PDFs together. Preserve the original export privately for provenance. Never remove the guard or add the version marker to an old database payload while its original HTML/PDF remain attached. The ordinary report retry endpoint does not rebuild published reports, so resetting an existing job alone is not a repair.

Before any separately authorized restoration, check the exact family, report, data region and current consent; review both rendered languages; and replace artifacts atomically under the existing family/consent publication rules. No runtime restoration or data deletion is performed by this patch or preview command.
