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

## Verification status — November 11, 2026 (UTC)

These are implementation claims, **not** claims of live Muse delivery or merge eligibility.

| Issue | Implementation | Verification boundary |
| --- | --- | --- |
| 1. REST branch updates | Git fetch/merge/non-force push handles same-repo PR heads; parent retarget still uses PR metadata API | Local bare-Git fixtures green; live branch authorization not proven |
| 2. CI bot approvals | No built-in `GITHUB_TOKEN` used for Git branch pushes; existing `DISPATCH_INSTALL_TOKEN` selected | Real workflow-trigger behavior after a dispatcher push must be observed |
| 3. Extra credentials | Reuse listed installation and private-ledger credentials, no new token | Existence/permissions of secrets not exposed to this coding chat |
| 4. All-open-PR polling | GitHub events select affected PR identities | Periodic full audit still checks all on a bounded 30-minute cadence |
| 5. API volume | Unchanged verified PR facts reused; Git transport for queue writes | GitHub PR status and GitHub commit/check/review facts still require some API reads |
| 6. Repeated snapshots | Reuse initial verified observation if ledger head unchanged | CAS conflict fetches latest safely |
| 7. Idle timer | Default 10 minutes | Deterministic tests green |
| 8. Progress/nudges | Commit/head observation resets timer; active CI exempt; one nudge then escalation | End-to-end courier timing not yet proven |
| 9. Old receipts | Blob-SHA checkpoint after authenticated reconciliation; unchanged receipts skipped | Unknown/invalid/early receipts remain eligible for repair |
| 10. Late/invalid receipts | Original action IDs remain valid; no duplicate coding prompt | Existing signed repair receipts retained |
| 11. Codex missing | Existing Ready automatic trigger and once-only fallback retained | External Codex integration must acknowledge actual Ready event |
| 12. Codex over-review | Existing exact-head/dedup/change-classification gates retained | No new coding-completion marker |
| 13. Recursive wakes | No check_run/check_suite subscriptions | Existing workflow_run and delayed wake remain |
| 14. Silent failures | Generic workflow failure handler and unit-preflight notifier; Git emergency owner notice | Git-based fallback requires Git hosting and Muse reader access |
| 15. Queue REST writes | Git CAS ledger and private owner projection; emergency fallback same schema; Muse SSH reader | Live Muse process must be configured/tested for the Git read path |
| 16. Universal deployment | Configuration and project-neutral core; Studio PR3 remains template authority | Cross-repository deployment not performed |

**Evidence:** Dispatcher deterministic tests passed on [Actions 42987946285](https://github.com/killbill2792/aicafe/actions/runs/42987946285) and [Actions 42987676906](https://github.com/killbill2792/aicafe/actions/runs/42987676906); the full baseline is not yet recorded green on a final SHA. The repository's standard 800-line limit was exceeded by this owner-requested 16-issue PR; the existing `big-ok` PR exception is applied, with the size guard unchanged.

**Hard boundary:** Neither an Actions unit test nor a ledger commit proves the deployed Muse browser actually notified the owner. Do not claim universal no-silent-failure coverage until a real authenticated owner-notice receipt exists. A GitHub workflow that never starts and a total outage of both GitHub API and Git hosting cannot self-report from that workflow; that requires an independent delivery path or a trusted external signal. The owner has not authorized a new monitor.
