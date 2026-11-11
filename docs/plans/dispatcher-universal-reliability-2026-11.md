# Universal dispatcher: reduce GitHub work and eliminate silent coordination failures

Owner-approved direction (November 10–11, 2026): keep one dispatcher responsible for signed task/dependency decisions, branch updates, ready transitions and permitted merges; GitHub still owns normal CI; Muse is a browser/owner-message courier, never a code writer or second manager. Do **not** alter task-completion/acceptance or owner merge gates. Reuse this architecture for other repositories through `.dispatcher/settings.json` and Studio's template rather than a second dispatcher.

## Sources, state and recipients
- GitHub webhook/event payloads: repository, PR number, head SHA, event/action, CI workflow run conclusion, review identity. A verified PR head and current-state facts remain authoritative before irreversible operations; events only select the affected PR(s).
- Signed queue: task ID, approved goal/paths, predecessors and permitted actions. Do not infer approvals from PR text.
- Muse receipt: signed original action/notice identity, authenticated Git commit actor, receipt filename/path and content; process newly changed entries, preserve late arrivals and authenticated history.
- Private ledger: `dispatcher/state.json`, keyed by task/action/receipt/notice ID. Existing Muse owner queue remains a projection, not a new authority.
- GitHub errors: safe error category, repo, failed step, reset time, workflow run URL and deduplication identity. No token or private code in emergency notices.
- Muse receives normal authorized actions/notices and emergency owner notifications. Only a confirmed receipt constitutes delivered status.
- Emergency fallback writes through authenticated Git transport to the **same private queue repository**, not through the exhausted REST API. Git transport failure is visible in job logs; out-of-band Muse delivery would need a separately authenticated path if Git hosting also fails.

## Implemented in this PR / acceptance checklist (subject to executed verification)
1. Replace REST `update-branch` requests with conflict-safe Git fetch/merge/push in trusted-main dispatcher, maintaining parent/child identity and preserving commit history; keep PR base retargeting through the API.
2. Do not use the built-in Actions token for unattended Git writes that must trigger CI; use an already-authorized non-Actions Git credential if present, otherwise fail closed with an explicit owner incident rather than create approval-required CI.
3. Keep GitHub's ordinary PR-triggered CI; do not invent a separate CI runner or bypass required PR checks.
4–6. Select affected PRs using trusted GitHub event identity and avoid duplicate full snapshots; bounded periodic audit catches lost events.
7–8. Ten-minute unfinished-coding progress window, one Muse continuation, no false stall while legitimately waiting for CI/Codex; escalate one unresolved nudge.
9–10. Process newly changed Muse receipts by verified identity, accept late receipts, request repair of bad originals, no duplicate browser prompt.
11–12. Keep green-CI-first automatic Codex, one verified explicit fallback for unacknowledged review and dedupe per actual head/patch.
13. Avoid recursive GitHub check_run/check_suite event storms.
14–15. One generic failure-report path for all notification publication failures; Git fallback to private queue without REST API, including rate-limit errors, and recover/close notices after successful delivery.
16. Project-neutral source/settings and tests; no Studio architectural duplication.

## Verification and boundaries
- Add deterministic tests for normal, conflict, stale-head, API-limit, Git failure, late/invalid receipt, duplicate event, ten-minute idle and active-CI cases.
- CI and external Muse browser delivery are separate: tests can prove queue records and wake semantics but **not** confirm that the deployed Ubuntu courier delivered a message until authenticated live receipts exist.
- No PROGRESS.md edits, production/Vercel changes, new task-done marker, new external credentials or changes to PR merge authorization. Dispatcher-only PR stays draft/owner-merge.
