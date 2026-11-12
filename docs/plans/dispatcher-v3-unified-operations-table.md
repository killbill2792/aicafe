# Single development-operations table (owner instruction 2026-11-11)

The existing GitHub Pages **Development operations → Tasks and handoffs** table is the only UI table. No secondary encrypted/private table, browser passphrase, signed-owner API, new dispatcher, new scheduler or database.

## Source, transformation and privacy boundary

One authoritative private Git-CAS ledger: `killbill2792/dave-task-queue/dispatcher/state.json` with task identity `tasks[task_id]`, derived `lifecycle_v3.rows[task_id]`, immutable action identities `actions[action_id]` and owner notice identities `owner_alerts[notice_id]`. The existing trusted-main Pages workflow reads it via `readLedgerViaGit` (not the >1 MB-limited Contents API). It publishes a **public, unencrypted, allowlisted** status projection to `owner-operations-snapshot.json`. No raw ledger, prompts, delivery text, owner questions, signed hashes, receipt bodies, chat URLs, credentials or arbitrary GitHub API responses are copied to Pages. Intentional public project-operational metadata only.

Projection key: one row per lifecycle task ID. The snapshot contains task title/stage/outcome, actual linked PR/head, CI status and observed start/finish, Codex status/request/review timestamps, last commit time, dependencies, pending action types/count, pending notice kinds/count, acceptance, merge blockers, integration proof and next responsible actor/action. Missing PR stays missing and must be reconciled by GitHub; UI never fabricates association. A completed integrated task shows `integrated_proven`/PROVEN distinctly from unverified Codex or acceptance.

The existing `#task-rows` DOM element renders both 7-column public-only fallback and full published snapshot; no second table. It supports sortable columns and display of timestamps/elapsed age computed at view time. If the snapshot is stale or unavailable, report that and show last trustworthy public fallback; never imply a 2-minute browser refresh equals a new GitHub reconciliation. The same Pages workflow runs after successful trusted main dispatcher completion or explicit owner-triggered workflow dispatch. GitHub Actions schedule remains best-effort.

## Muse and policy

The existing Muse watchdog reads the same ledger and signed queue from its host. Repo-specific observation policy is stored in `.dispatcher/settings.json`: warn at 5 minutes, escalate at 10 minutes for an outstanding Codex review; request a safe authenticated GitHub recovery only when allowed by the existing verified rules, not automatically duplicate `@codex review` on an unchanged head. Global and PR-specific wakes use the existing `dispatcher_recovery` event and `recoveryIdentity`; 204 is sent/unverified until matching ledger acknowledgment. Muse should surface owner-scope proposals after dependency merges as recommendations, not invent scope authorization. Later Studio projects can supply their own policy without another dispatcher.

## Proof / release gates

1. Source tests check exactly one existing table, sorting and elapsed times for commit, CI, Codex; missing PR/unverified statuses, linked and pending task paths.
2. Projection tests inject prompt/password/chat/receipt secrets and prove all are excluded; direct state upload disallowed.
3. Muse tests check 5/10-minute warning, stable-head dedupe, accepted vs unacknowledged recoveries, and proposals without auto-approvals.
4. Full applicable CI, exact-head Codex, owner-only merge, and postmerge real Pages publication/UI check. No production POS/provider effects.
