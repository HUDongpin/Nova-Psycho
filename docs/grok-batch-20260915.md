# Nova v1 completion batch — 2026-09-15

The canonical project remains `/Volumes/Starship/Nova Psycho Helper`.

## Implemented

- Admin/assigned staff can requeue a failed automatic report through `POST /api/assessments/:id/retry-report`. It requires current guardian consent, checks family/region scope, serializes concurrent requests, preserves the original submitted answers/score/content snapshot and date, and never resets a running or published job. Parents/students/teachers cannot invoke it. The original retake interval remains enforced because the respondent already completed the assessment.
- The assessment list and family view show the retry action and queued/error feedback. The admin scale library can reactivate a retired version through its existing validated API, with confirmation.
- Newly generated bilingual HTML/PDF comparisons display the prior assessment date, the direction of the raw-score change and what a higher score means for that dimension. They retain the caveat that change does not prove treatment efficacy. Previously published reports are not rewritten.
- Vitest discovers only `tests/**/*.test.ts`; synthetic experiments and source copies under `work/` are excluded.

## Development ownership

Grok CLI generated the backend retry implementation, UI components/copy, comparison renderer/tests, Vitest configuration, regression script and draft documentation. Codex reviewed the diffs, applied one missing assessments-page callback connection, corrected the regression scenario order (active-scale retake vs retired-scale rejection), ran verification, updated verification records and handled local runtime recovery.

The first broad audit timed out and the combined implementation call was interrupted after prolonged reading. Its partial backend implementation was preserved. Three smaller Grok calls with disjoint file ownership completed the batch. This demonstrates usable delegation but does not establish a measured percentage reduction in Codex usage. CLI usage costs are not an independently verified subscription invoice; interrupted work can still consume usage.

Grok operated in a sanitized source copy at `work/grok-v1-20260915/source`; private runtime configurations, databases and reports were not copied into its task directory. Only installed dependency code/docs were made available. No global permission bypass, commit, push, public deployment or live clinical-data inference was used.

## Current validation

| Check | Result |
|---|---|
| `npm test` | 42 tests, 5 files passed; no work-directory tests discovered |
| `npm run typecheck` | passed |
| `NOVA_DIST_DIR=.next-verify npm run build` | passed |
| `npm run test:integration` | 15 groups passed, CN/HK real local APIs |
| `node scripts/run-region.mjs CN database-checks` | 6 groups passed |
| `node scripts/run-region.mjs CN content-regressions` | 4 groups passed |
| `node scripts/run-region.mjs CN retry-regressions` | 7 groups passed in an isolated temporary DB; actual bilingual HTML/PDF worker recovery |
| Browser | admin retry: failed → queued → published → report opened; retired scale confirmation → active; temporary synthetic fixtures removed |
| PDF rendering | new simplified/traditional comparison PDFs rendered and visually reviewed; date/direction/cautions visible without clipping |

The regression script initially failed because it expected a retake-interval error after retiring the scale. The test now checks retake while the scale is active and separately checks retired-scale rejection; production eligibility rules were not weakened.

Evidence is in `work/qa/{api-integration-results,database-checks,content-regressions,retry-regressions}.json`, candidate PDF samples and Grok summaries in `work/grok-v1-20260915/`. The synthetic UI fixture returned to the pre-test state: two CN demo families, six CN demo reports, three pending CN tasks. The dated source snapshot contains no runtime secrets or private data.

## Local environment recovery

Docker's status and ordinary restart timed out; the restart identified two stuck backend processes. After terminating those named processes and starting Docker through its official CLI, the engine responded and the existing CN/HK containers started with their original volumes. Database setup reported existing data preserved. Nova's stale HK development process also required termination before a fresh instance could bind the port. Both local apps and report workers were restarted. No factory reset, prune or volume deletion was performed. System-disk free space was approximately 6.3 GiB during diagnosis; that observation does not establish the cause.

## Remaining external acceptance

Professional instruments, digital/commercial rights, scoring examples and population evidence; real CN/HK hosting/storage/HTTPS and geographic-residency acceptance; optional authorized regional Bailian inference; institution-approved notices; physical WeChat/iOS/Android acceptance. Current data and questionnaire are explicitly synthetic demonstrations. No clinical or production-readiness claim follows from the local tests.
