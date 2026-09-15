# Nova Psycho Helper Implementation Plan

**Goal:** Implement the approved first version, with SurveyJS assessments, deterministic scoring, automatically published parent reports, longitudinal tracking and separate CN/HK deployment environments.

**Architecture:** One Next.js web application and one report worker per region, each using its region's PostgreSQL database and encrypted private report directory. Questionnaire definitions and all scoring/content versions are frozen with each submission. The frontend consumes a region-scoped authenticated API and does not calculate authoritative scores.

**Tech stack:** Next.js 16, React 19, TypeScript, SurveyJS 3 Form Library, PostgreSQL 16, Playwright Chromium PDF rendering, Vitest.

## Work sequence

- [x] Foundation: pinned dependencies, API contract and separate local CN/HK PostgreSQL examples exist in this source tree. Local presence is not a production deployment proof.
- [x] Domain: reverse scoring, missing values, eligibility, bands, risk signalling and comparison are implemented in source. Fresh central verification passed on 2026-09-15 (see docs/grok-batch-20260915.md).
- [x] Services: migrations, scoped users/sessions/families, guardian consent, invitations, immutable scale/content versions, drafts and idempotent submission are locally implemented.
- [x] Reporting: durable worker queue, constrained AI adapter, template fallback, bilingual HTML and encrypted PDF paths are locally implemented. Live Bailian regional acceptance is not done.
- [x] Interface: operations/parent workspace, SurveyJS runner, reports, goals/observations, scale import, content versions, language switch and privacy controls are locally implemented. This batch adds bilingual admin/staff report retry and admin scale reactivation UI against existing APIs; central tests for the batch passed on 2026-09-15.
- [x] Local verification: 42 unit tests, 15 API groups, 6 database groups, 4 content groups, 7 retry groups, typecheck, production build, actual retry/reactivation browser flows and rendered bilingual PDF review passed on 2026-09-15. Physical device/WeChat acceptance remains pending.
- [x] Local delivery: source, deployment manifests, operating notes and a dated source snapshot are supplied. Professional instruments, rights, actual cloud region residency, Bailian geographic inference acceptance and physical-device acceptance remain separate external prerequisites.

## Current honest status

v1 base is locally implemented in this source. The retry/reactivation UI in this batch is written against `POST /api/assessments/:id/retry-report` (`{id,status:'queued'}`, admin/staff) and `PATCH /api/scales/:id {status:'active'}` (admin; server validates advice). Central verification completed on 2026-09-15; details are recorded in docs/grok-batch-20260915.md. Professional instruments, rights, cloud, Bailian and device acceptance are not completed. These are local synthetic-data checks and do not establish production or clinical readiness.

## Fixed defaults

- Local ports: CN web 3100/database 55431; HK web 3101/database 55432. Bind to 127.0.0.1.
- Explicit demo mode only; demo sessions and synthetic seeding are disabled in service mode.
- AI is off without a configured, region-restricted provider; reports still publish from templates. Live AI credentials have not been supplied.
- Real scales require digital/commercial rights, applicable norms, and complete scoring configuration. Demo data does not prove clinical validity.
- User updates supersede earlier choices: no per-report human review; both mainland and Hong Kong included.
- Source resides in `/Volumes/Starship/Nova Psycho Helper`; no public deployment is assumed.
