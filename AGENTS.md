# Nova Psycho Helper

This is the user-designated project: `/Volumes/Starship/Nova Psycho Helper`.

- Primary questionnaire engine: MIT SurveyJS Form Library. Keep LimeSurvey as a future alternative, not a v1 dependency.
- V1 serves mainland China and Hong Kong with separate data regions and simplified/traditional Chinese.
- Reports are generated and published automatically, without per-report human approval. Clinical scoring is deterministic; constrained AI may select approved narrative/advice blocks and must fall back to templates on failure.
- Never equate screening with diagnosis or infer clinical norms. Until authorized professional scales arrive, use clearly labelled demo instruments and synthetic data only.
- Keep region and family authorization server-side. Never include names, contact details, raw answers or free text in AI payloads or logs.
- Do not transmit real data to live AI or publish/deploy infrastructure merely to test this application. Local synthetic-data tests and local containers are authorized.
- Keep runtime data, scratch files, captures and private report files in `work/`, outside public assets and version control.
- No commits, pushes, paid cloud provisioning or public deployment are included in the initial implementation request.
- For scholarly evidence use EdUHK Library plus reputable open sources; APA 7 by default. Never retain or delegate credentials.

Checks: `npm test`, `npm run typecheck`, `npm run build`, `npm run test:integration` (when configured), plus real browser and rendered PDF review.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
