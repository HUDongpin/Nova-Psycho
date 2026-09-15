# Nova Psycho Helper

[![CI](https://github.com/HUDongpin/Nova-Psycho/actions/workflows/ci.yml/badge.svg)](https://github.com/HUDongpin/Nova-Psycho/actions/workflows/ci.yml)

An assessment, automatic-reporting and ongoing-support workspace for K–12 families in mainland China and Hong Kong.

**Project directory: `/Volumes/Starship/Nova Psycho Helper`.** Questionnaires use the MIT-licensed SurveyJS Form Library; Nova independently implements family management, rule-based scoring, automatic publication, private PDFs and retest comparison. LimeSurvey is retained as an option for a future full survey platform.

## What works today

- Operations staff create family records, assign case workers, record guardian consent, and issue student / parent / teacher access invitations.
- Respondents confirm the information notice, then answer through SurveyJS; drafts save automatically and version checks stop a stale page from overwriting newer answers.
- The server performs reverse scoring, subscale sums and means, missing-data handling, age / region / role eligibility checks and rule triggering.
- A separate report process generates and publishes simplified- and traditional-Chinese HTML and PDF automatically, with no per-report human review step.
- Parents can only read reports for families they are authorised for; students and teachers can only reach assessments assigned to them, and cannot read parent reports.
- Retests by the same respondent on the same instrument version can be compared by raw-score change; student, parent and teacher observations are kept separate.
- Care goals, completion status, private case-worker observations, instrument versions, the advice library and report templates are all managed.
- Administrators, or the assigned case worker, can retry failed reports while preserving the original answers and scores; administrators can reactivate a retired instrument whose advice dependencies are still valid.
- Newly generated retest reports show the previous assessment date, the raw-score change, and what a higher score means for that dimension.
- Mainland China and Hong Kong use separate databases, sessions and report directories; switching language does not switch data region.

**This is currently a demonstration environment.** The bundled instrument is a Nova-original 9-item fictional workflow example; the accompanying families, historical answers and reports are all synthetic data, with no clinical norms. It exists to validate the software and cannot assess a real child's mental health. No user-supplied professional instrument, real family record or real Bailian inference key has been connected yet.

## Running locally

Requires Node.js 24, npm and Docker. On macOS the report process uses Google Chrome directly; other environments can install Playwright Chromium, or point `NOVA_CHROMIUM_EXECUTABLE` at a supported Chromium build.

```sh
cd '/Volumes/Starship/Nova Psycho Helper'
npm ci
npm run bootstrap:local
npm run setup:cn
npm run setup:hk
```

Then run each of these in its own terminal:

```sh
npm run dev
npm run worker:cn
npm run dev:hk
npm run worker:hk
```

| Environment | Web address | PostgreSQL port |
|---|---|---|
| Mainland demo | http://127.0.0.1:3100 | 55431 |
| Hong Kong demo | http://127.0.0.1:3101 | 55432 |

All listeners bind to loopback. The first run generates independent random database passwords and report encryption keys, stored in `work/local-cn.env` and `work/local-hk.env` with permissions `600`; keys are never printed. Re-running initialisation preserves existing data. Databases can be stopped with `docker stop nova-psycho-helper-cn-db nova-psycho-helper-hk-db`, which does not delete data volumes.

The entry page offers clearly labelled synthetic accounts. A suggested walkthrough: view families and assignments as an administrator → complete a pending assessment as a student → view the new report and download the PDF as the matching parent. The two sites share neither logins nor data.

## Scoring and automatic report conventions

Scoring is authoritative on the server; client-supplied totals are not accepted. Every submission freezes the instrument, scores, age, advice library, template and consent scope. Submitted answers and published reports are protected by database triggers. The simplified- and traditional-Chinese HTML and PDF are frozen together at publication and are not rewritten by later template changes.

The AI interface can be enabled for a region-restricted Bailian workspace. In the current version the model **orders the professional advice applicable to this assessment's scores**; it may only return advice IDs that already exist, and cannot add diagnoses, scores, free text or unsupported interventions. Without AI consent, without configured credentials, on model failure, or when a risk signal is present, the rule template is used automatically. Missing information is shown explicitly, and risk notices take precedence over ordinary advice.

Report PDFs are stored server-side encrypted with AES-256-GCM. Role, family and region permissions are checked before decryption and delivery. A PDF the user downloads is an ordinary readable file with no file password; revoking access cannot recall copies a parent has already downloaded.

## Bringing in production content

An administrator first creates the initial advice library and report template under "Report content", then imports full instrument definitions under "Instrument library". Downloading the example JSON shows the format; see `docs/scale-intake.md` for detail.

Any instrument taken live must have applicable electronic / commercial usage rights, age and region evidence, a scoring specification, and an interpretive basis. The current engine supports discrete numeric options, reverse items, sum / mean aggregation, explicit missing-data rules, and raw-score threshold interpretation; it does not support arbitrary code or SQL scoring expressions. Instruments needing additional standard-score conversion or complex algorithms require new deterministic rules and standard worked examples first — they must not be approximated with a similar rule.

## Verification and deployment

```sh
npm test
npm run typecheck
NOVA_DIST_DIR=.next-verify npm run build
npm run test:integration
node scripts/run-region.mjs CN database-checks
node scripts/run-region.mjs CN content-regressions
node scripts/run-region.mjs CN retry-regressions
```

Integration tests run only against explicitly classified demo environments. Concurrency and lifecycle checks use synthetic families, or an isolated test database that is created and then dropped; they do not delete a user's existing families. Evidence is written to `work/qa/`.

Live AI conformance against a real regional workspace is checked separately, using an in-memory synthetic snapshot and no database:

```sh
node scripts/run-region.mjs CN ai-conformance
```

Regional backups are taken with `npm run backup:cn` or `npm run backup:hk`, and restored into an isolated environment with `node scripts/run-region.mjs CN restore <backup-directory>`. The restore refuses to overwrite a live database or a non-empty target. See `docs/deployment.md` for the procedure and its guards.

Production deployment files are in `deploy/`, with operating notes in `docs/deployment.md`. The same image can be deployed to both mainland China and Hong Kong, but production requires separate deployments in the actual corresponding regions, each with its own database, storage, keys and inference workspace. Passing the local dual-environment tests does not constitute a completed real cloud regional deployment, professional instrument validation, or real inference acceptance.

Architecture and interface details are in `docs/api-contract.md`; retained selection rationale is in `docs/platform-decision.md`.

## Development ownership

Under the current arrangement, Grok CLI does the main implementation work, while Codex handles scope control, necessary integration and acceptance. Small tasks and independent source copies are used to keep runtime material out of development prompts. See `docs/grok-workflow.md` for the process, and `docs/grok-batch-20260915.md` for the 2026-09-15 feature completion and current acceptance record.
