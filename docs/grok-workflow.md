# Grok-first development workflow

Use Grok CLI for the main implementation and test-writing work. Codex supplies a bounded task, checks selected diffs, integrates small wiring corrections and runs acceptance. Prefer small tasks with explicit file ownership over an open-ended whole-repository audit. For independent tasks, use non-overlapping files and run final tests centrally after all writers stop.

Prepare a sanitized source copy under `work/` with code/configuration examples only. Exclude runtime env files, credentials, databases, reports, caches and sessions. Do not give the coding agent live family data. Use project-scoped, task-specific editing and command permissions, no global always-approve changes. Use documented tool IDs; inspect CLI warnings because an invalid allowlist entry can cause a full-toolset fallback. Deny MCP/network tools when a task does not need them.

Use Grok headless mode and machine-readable output. Discard internal thought/signature fields when retaining lightweight task summaries. Save concise file changes, final stop reason, tests actually run and available usage fields. Treat cancellation or an exit code alone as insufficient: inspect files and verify results. Do not claim unknown costs are zero or equate CLI cost figures with an actual additional subscription charge.

Before integration, compare the canonical files against the baseline hashes so concurrent changes are not overwritten. Keep previous file versions in the task's work folder. Run applicable unit/type/build/API/database/browser/PDF checks. Professional instruments and regional production infrastructure are separate acceptance gates. The 2026-09-15 implementation and review record is in `docs/grok-batch-20260915.md`.
