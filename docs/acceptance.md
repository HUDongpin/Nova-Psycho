# Nova Psycho Helper 0.1.0 local delivery and acceptance

Date: 2026-09-10. Main development directory: `/Volumes/Starship/Nova Psycho Helper`.

## Delivery scope

Implemented and running locally: SurveyJS answering, family records, guardian consent, separate student / parent / teacher assessments, server-side scoring, automatic parent reports, simplified and traditional PDFs, same-version retest comparison, care goals and operations content management. Reports publish automatically, with no per-report human review queue. The source, dependency lockfile, PostgreSQL schema, regional run scripts and Docker deployment files are all retained.

This is a locally runnable version using synthetic data. No professional instrument or real family record has been connected, no real mainland China / Hong Kong cloud deployment has been established, and no real Bailian call has been made. The current AI adapter may only select and order among the existing advice applicable to this assessment's scores; when AI is not enabled or fails, the report automatically uses the rule template.

## Automated check results

| Check | Result | Main coverage |
|---|---:|---|
| `npm test` | 37 passed, 5 test files | reverse scoring, missing data and applicability, rule validation, content constraints, AI fallback, HTML output |
| `npm run typecheck` | passed | TypeScript type checking |
| `NOVA_DIST_DIR=.next-verify npm run build` | passed | Next.js production build and page generation |
| `npm run test:integration` | 15 groups passed | regional / family / role permissions, accounts and one-time invitations, consent gating, draft versions, duplicate submission, simplified and traditional reports, risk and missing information, deletion and retest |
| `node scripts/run-region.mjs CN database-checks` | 6 groups passed | concurrent consent and deletion, database immutability, PDF encryption, environment classification and historical comparison source |
| `node scripts/run-region.mjs CN content-regressions` | 4 groups passed | first-version content, incomplete tasks for retired instruments, submission retry, content recovery and instrument reactivation |
| `docker build -f deploy/Dockerfile -t nova-psycho-helper:0.1.0 .` | passed | application image with Chromium and Noto CJK fonts |
| CN and HK Compose configuration checks | passed | both environments' configuration parses; not yet started as real cloud environments |

**Later changes.** This table records the 2026-09-10 delivery point and is left as recorded. Since then: the unit suite has grown well beyond the figure above (run `npm test` for the current count, and see the CI badge in the README); the AI adapter has been verified against the real service (see `docs/ai-regional-verification.md`); and the single runtime image has been split into `-web` and `-worker` targets, so the bare `docker build` command above no longer matches the deployment. Use `docker compose up`, which builds both targets. See `docs/deployment.md`.

Run evidence is in `work/qa/` in the main development directory. Interface checks used two local demo services; content lifecycle checks used an isolated database that was created and then dropped, without covering or deleting existing families.

## Browser and report checks

- The desktop administrator workspace, the traditional-Chinese instrument library and parent reports were viewed in a browser. Students see only the assessments assigned to them.
- Completed a real SurveyJS assessment, draft saving, language switching, submission and parent PDF download; after submission the separate report process published automatically.
- Before the respondent confirmed, there were no operable questions and no draft requests; reopening required confirmation again, and saved answers remained.
- At a 390-pixel mobile viewport, Hong Kong defaulted to traditional Chinese, navigation worked, and the page had no overall horizontal overflow. Real WeChat embedded browser, iOS and Android devices have not been accepted.
- Reproducing a delayed draft request together with a language switch produced only two ordered saves; after another page's write caused a 409, the interface kept the local answers and stopped submitting, and reading the server's latest answers required an explicit reload.
- The first content-edit state was tested with an isolated browser API response, and a real domain validator was used to confirm that blank content is rejected and a valid first version submits successfully; 503 was retained as an error. Real database first-version creation is separately covered by the isolated database check.
- The fonts, charts, pagination and body text of the simplified and traditional parent report PDFs were rendered and reviewed. Simplified and traditional PDF rendering checks were also run inside the container. All output PDF samples include the demonstration notice.

Issues raised in two rounds of code review were fixed and closed on re-review, including drafts before consent, concurrent consent, invitation and deletion races, a demo database misused for a service, historical report freezing, draft overwriting and retired-instrument content dependencies. Review results do not substitute for professional instrument validity or production acceptance.

## Startup and walkthrough

At delivery time, both applications and their report processes were running:

- Mainland local demo: `http://127.0.0.1:3100`
- Hong Kong local demo: `http://127.0.0.1:3101`

The entry page lets you choose a demo administrator, student or parent. A suggested order: view the administrator workspace, then complete a pending assessment as a student, then view the automatic report as the matching parent. Both addresses are local demo entry points and are not directly reachable from other devices.

For restart instructions see the root `README.md`; for the production content format see `docs/scale-intake.md`; for regional deployment and backup see `docs/deployment.md`.

## Still required for a service

1. Provide the source text of the intended professional instrument, in simplified and traditional versions, with electronic and commercial licensing, age and region evidence, complete scoring rules and manual worked examples. Complex scoring that the current engine does not support requires new dedicated rules.
2. Prepare domains, HTTPS, databases, private storage, backups and access environments separately in mainland China and Hong Kong, and complete real regional deployment acceptance.
3. If enabling AI, provide the Bailian configuration for the corresponding regional business workspace, verify the actual inference scope, and validate the permissions and data scope of real calls.
4. Confirm the institution's formal information notice and service-responsibility arrangements, and verify complete answering, login and report download on target phones and inside WeChat.

A demo database cannot be changed directly into a service database. Subsequent development continues in the main directory on Starship; the delivered source archive is a snapshot of this version and contains no runtime keys, database, logged-in sessions, dependency directory or build cache.
