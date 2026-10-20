# TopE 心理助手 (Nova Psycho Helper)

[![CI](https://github.com/HUDongpin/Nova-Psycho/actions/workflows/ci.yml/badge.svg)](https://github.com/HUDongpin/Nova-Psycho/actions/workflows/ci.yml)

An assessment, automatic-reporting and ongoing-support workspace for K–12 families in mainland China and Hong Kong.

**Project directory: `/Volumes/Mars/Nova Psycho Helper`.** Questionnaires use the MIT-licensed SurveyJS Form Library; Nova independently implements family management, rule-based scoring, automatic publication, private PDFs and retest comparison. LimeSurvey is retained as an option for a future full survey platform.

On 2026-10-03 (Asia/Hong_Kong), the user designated the Mars copy as the working project after copying it from Starship. Use the Mars directory for subsequent work; Starship paths in older records are historical references.

## What works today

- Parents and teachers can create an account before joining a family. A parent creates a family and receives a join code; the student and teacher join that family with their own identities. The local username/password and configured Clerk email-identity paths are separate.
- Operations staff can also create family records, assign case workers, record purpose-specific guardian consent, and issue student / parent / teacher access invitations.
- The growth-triad workflow assigns one fixed role-specific instrument to each participant and combines one submitted parent, student and teacher assessment from the same round into one parent report. A later eligible round creates a separate report.
- Assessment participation, sensitive-data processing, parent-report delivery and optional AI processing have separate consent records. Participation requires the first two; a family can complete its questionnaires while withholding the parent report. Report generation, publication and access wait for parent-report consent.
- Triad safety signals create a staff alert when that respondent submits, without waiting for the other two. Viewing an alert does not resolve it. Regional staff can see the minimal unresolved-alert list; family details and handling rights follow assignment or the unassigned-family safety fallback. Report retry authority remains admin or assigned staff.
- With local authentication, an administrator can issue a single-use recovery link so an existing account can set a new password; completing it ends every session that account had open.
- Administrators can read a report-queue status endpoint covering job counts, oldest wait, expired leases, and whether the report worker is actually alive.
- Respondents confirm the information notice, then answer through SurveyJS; drafts save automatically and version checks stop a stale page from overwriting newer answers.
- The server performs reverse scoring, subscale sums and means, missing-data handling, age / region / role eligibility checks and rule triggering.
- A separate report process generates and publishes simplified- and traditional-Chinese HTML and PDF automatically, with no per-report human review step.
- Parents can only read reports for families they are authorised for; students and teachers can only reach assessments assigned to them, and cannot read parent reports.
- Individual-instrument retests by the same respondent on the same instrument version can be compared by raw-score change; student, parent and teacher observations are kept separate.
- Care goals, completion status, private case-worker observations, instrument versions, the advice library and report templates are all managed.
- Administrators, or the assigned case worker, can retry failed reports while preserving the original answers and scores; administrators can reactivate a retired instrument whose advice dependencies are still valid.
- Newly generated individual-instrument retest reports show the previous assessment date, the raw-score change, and what a higher score means for that dimension.
- Mainland China and Hong Kong use separate databases, sessions and report directories; switching language does not switch data region.

**The bundled content is demonstration content.** It includes the fictional 9-item `nova-family-demo` instrument and the parent / child / teacher `growth-triad` instruments. The supplied accounts, families and historical answers are synthetic. The triad instruments have no clinical norms and are labelled demo; they cannot establish a diagnosis or validate a real child's mental health. Traditional Chinese is a reading conversion, not a separately validated translation. Service mode rejects demo or unvalidated instruments at assignment, draft, submit and worker stages, including old unvalidated snapshots. A configured service deployment is not proof that professional content has been supplied.

## Running locally

Requires Node.js 24, npm and Docker. On macOS the report process uses Google Chrome directly; other environments can install Playwright Chromium, or point `NOVA_CHROMIUM_EXECUTABLE` at a supported Chromium build.

```sh
cd '/Volumes/Mars/Nova Psycho Helper'
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

In demo mode the entry page offers five one-click synthetic accounts, and those seeded users have no password. The buttons are the administrator (Nova 管理员 · 演示 / Nova 管理員 · 示範), the 林 family's staff member (陈老师 · 演示 / 陳老師 · 示範), the 林 parent, the 林 student (林小禾), and that family's teacher (许老师 · 演示 / 許老師 · 示範). A suggested walkthrough: sign in as the administrator to view families and assignments → sign in as 林小禾 to complete a pending assessment → sign in as the 林 parent to view the new report and download the PDF. Sign in as 陈老师 / 陳老師 to open that family's case workspace, including safety alerts. Service mode does not show these buttons, and `POST /api/auth/demo` is refused. The two sites share neither logins nor data.

## Three-party flow

1. Create a parent account, then create a family with a birth date and separate consent choices. `assessment` and `sensitiveData` are required; `parentReport` is an explicit independent choice.
2. Share the family join code with the student and teacher. Each signs in or creates the supported role profile and receives that role's questionnaire. Rejoining returns the existing membership/task rather than adding another copy.
3. Complete the questionnaires. Draft revisions prevent stale overwrites. Eligibility and the child's 12+ items use the birth-date age on the deployment region's local date. A stated-age mismatch is a staff review flag; it is not itself a safety signal.
4. A submission is `waiting` while other triad roles are missing, `consent` when report generation or access lacks parent-report permission, including after withdrawal, and `reporting` when an authorised report job exists. Students and teachers see a neutral submitted message for a report-consent hold.
5. With all three submissions and parent-report consent, the worker publishes one combined report automatically. Scores, safety messages and aggregate observations use deterministic rules. Optional AI can order the approved support suggestions when the separate triad switch and consent checks permit it; otherwise the report uses the library's default order. The report excludes the child's raw free text, situation choices, priorities and staff contact information. Student and teacher accounts cannot fetch parent reports.
6. Withdrawing parent-report consent blocks report JSON, HTML and PDF access and prevents a held job from publishing. Re-granting resumes the same report without duplicating it. Original grants and later withdrawal evidence remain separate.

## Scoring and automatic report conventions

Scoring is authoritative on the server; client-supplied totals are not accepted. Every submission freezes the instrument, scores (including age), advice library, template and the AI-consent boolean. Purpose-specific grant and withdrawal evidence is recorded separately in the consent ledger. Submitted answers and published reports are protected by database triggers. The simplified- and traditional-Chinese HTML and PDF are frozen together at publication and are not rewritten by later template changes.

The optional model can only order all eligible, approved advice IDs. It cannot change scores, write report prose, add diagnoses, invent suggestions, or omit an eligible suggestion. Combined triad reports use the advice library frozen in the parent's submitted assessment. Candidate eligibility uses each role's frozen instrument and valid dimension summaries; it does not depend on clinical score bands. Historical snapshots without triad applicability metadata continue to use templates, and published reports are not rewritten.

Triad AI is off by default. It requires both `NOVA_TRIAD_AI_ENABLED=true` and `NOVA_AI_ENABLED=true`, valid provider configuration, AI consent in all three submission snapshots, and a current family `ai_processing` grant. Later consent does not change an earlier snapshot. The worker rechecks the same current grant after inference and during publication. If the grant was withdrawn or replaced, the worker discards the AI order and regenerates the unpublished bilingual files in the default order. This cannot recall a request already sent. Withdrawing `parent_report` continues to hold publication and access.

Each report-job attempt makes at most one AI request; simplified and traditional Chinese share the saved order. With fewer than two triad candidates, missing consent or configuration, a safety risk in any source, an invalid reply, a provider error, or an 8-second timeout, the worker automatically uses templates. The AI payload contains only age band, source role, dimension and domain identifiers, valid dimension summaries with their interpretation direction, and the approved candidates. Names, contact details, school, grade, family and user IDs, raw answers, free text and staff notes are excluded. Safety notices remain first. The HTML and PDF show the actual advice generation mode and frozen advice-library version.

Configuration supports a matching regional Bailian workspace and the explicitly allowed DeepSeek Flash endpoint. `NOVA_AI_DEPLOYMENT_SCOPE` is a configuration assertion; it does not establish the physical processing location of a nonregional endpoint. The generic DeepSeek hostname is not evidence of CN or HK inference. `NOVA_REGION` selects the application's CN/HK data boundary; `NOVA_DATA_REGION` records the configured hosting location. Operators must match those choices to the deployment's actual data arrangements before using real data. The existing integration checks keep AI disabled. Dedicated triad checks use synthetic data, fake credentials and an injected local HTTP mock.

Report PDFs are stored server-side encrypted with AES-256-GCM. Role, family and region permissions are checked before decryption and delivery. A PDF the user downloads is an ordinary readable file with no file password; revoking access cannot recall copies a parent has already downloaded.

## Bringing in production content

An administrator first creates the initial advice library and report template under "Report content", then imports full instrument definitions under "Instrument library". Downloading the example JSON shows the format; see `docs/scale-intake.md` for detail.

The importer rejects `demo: false` with `norm.validated: false`. Service mode also refuses demo or unvalidated instruments, including legacy stored definitions and queued snapshots. The `rights` flags and reference are required metadata, but the importer does not enforce the digital/commercial booleans as licensing checks. Setting a validation flag is an operator attestation, not evidence that the software has verified clinical validity. Age/region/role gates and a complete scoring specification remain required structurally. The current engine supports discrete numeric options, reverse items, sum / mean aggregation, explicit missing-data rules, and raw-score threshold interpretation; it does not support arbitrary code or SQL scoring expressions. Instruments needing additional standard-score conversion or complex algorithms require new deterministic rules and standard worked examples first — they must not be approximated with a similar rule. Clinical and licensing responsibility for imported instruments stays with the operator.

## Verification and deployment

```sh
npm run lint
npm test
npm run typecheck
NOVA_DIST_DIR=.next-verify npm run build
npm run test:integration
npm run test:triad-ai
node scripts/run-region.mjs CN database-checks
node scripts/run-region.mjs CN content-regressions
node scripts/run-region.mjs CN retry-regressions
node scripts/run-region.mjs CN recovery-checks
```

The ESLint CLI checks application code, maintained scripts and tests. Core JavaScript, TypeScript and React Hooks correctness rules can fail CI; narrowly documented warnings remain visible for existing imperative UI and browser-harness patterns. Generated output and private `work/` files are excluded.

Integration tests run only against explicitly classified demo environments. Concurrency and lifecycle checks use synthetic families, or an isolated test database that is created and then dropped; they do not delete a user's existing families. Evidence is written to `work/qa/`. The independent `test:triad-ai` command uses an isolated local database and an injected HTTP mock for triad advice ordering and fallback. Its evidence is kept under `work/qa/triad-ai/`; it does not require or use live-model credentials.

`test:triad-ai` requires local PostgreSQL binaries, Chromium, and Poppler (`pdftotext` / `pdftoppm`). It defaults to Homebrew PostgreSQL 16; set `NOVA_TEST_PG_BIN` for another installation. For a long worktree path, set `NOVA_TEST_TMP_ROOT` to a short private `work/` directory so local IPC sockets fit the operating system's path limit. The runner creates and cleans only its own temporary directory and processes, retaining database files and verification evidence.

The PDF renderer tests need a real Chromium and are skipped without one; the suite says so when it skips them rather than passing quietly. Run `npx playwright install chromium`, or point `NOVA_CHROMIUM_EXECUTABLE` at one, to include them. GitHub Actions installs Playwright Chromium before the unit tests and fails the job if those tests are skipped.

Live AI conformance is a separate, explicitly authorised check using in-memory synthetic data and no database:

```sh
node scripts/run-region.mjs CN ai-conformance
```

Local mock results establish application behaviour only. Real-model output quality, latency and inference-region evidence still require live conformance before regional production enablement. See `docs/ai-regional-verification.md`.

Regional backups are taken with `npm run backup:cn` or `npm run backup:hk`, and restored into an isolated environment with `node scripts/run-region.mjs CN restore <backup-directory>`. The restore refuses to overwrite a live database or a non-empty target. See `docs/deployment.md` for the procedure and its guards.

Production deployment files are in `deploy/`, with operating notes in `docs/deployment.md`. The same image can be deployed to both mainland China and Hong Kong, but production requires separate deployments in the actual corresponding regions, each with its own database, storage, keys and inference workspace. Passing the local dual-environment tests does not constitute a completed real cloud regional deployment, professional instrument validation, or real inference acceptance.

Architecture and interface details are in `docs/api-contract.md`; retained selection rationale is in `docs/platform-decision.md`.

## Development ownership

Under the current arrangement, Grok CLI does the main implementation work, while Cursor handles scope control, runs Grok, integrates diffs and runs acceptance. Small tasks and independent source copies are used to keep runtime material out of development prompts. Verification may set `NOVA_SKIP_PDF_RENDER=1` when Chromium cannot launch; skipped PDF tests are not coverage. Professional, cloud and Bailian gates remain external. See `docs/grok-workflow.md` for the process, and `docs/grok-batch-20260915.md` for the 2026-09-15 feature completion and current acceptance record.
