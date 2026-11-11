# Development Dispatcher v3 — single-engine migration and operator contract

Status: **draft implementation in PR #440, NOT deployed, NOT ready for unattended operation**.
PR #439 is the unmerged base; PR #440 contains all its fixes and supersedes it after verified owner-controlled merge.
This is a development dispatcher, not the café Supervisor or production application.

## 1. Sources, authority, and responsibilities

| Source | Owner / reader | Meaning |
|---|---|---|
| Signed queue at \`docs/plans/universal-supervisor-queue.json\` | GitHub, Muse (read-only) | Approved goals, file edits, acceptance, task DAG, merge order. Later Studio task list can feed the same contract. |
| Private Git repo \`killbill2792/dave-task-queue\`, \`dispatcher/state.json\` | Existing trusted-main GitHub reconciler; Muse read; authenticated owner controls | **One durable ledger**, never two independent task authorities. Existing \`tasks\`, \`actions\`, signed receipts and owner notices remain v1-compatible. \`lifecycle_v3\` is a derived view, not authority. |
| GitHub PR/checks/reviews/branches | GitHub facts adapter; owner/Muse read | Independent evidence for branch, current SHA, CI, Codex, merge, integration and timestamps. ChatGPT \`coder_done\` never proves task completion. |
| Muse external host | Muse scripts and browser courier | Select/recheck eligible approved work, deliver signed prompts, monitor independent heartbeat/PR inactivity, request GitHub reconciliation, and notify owner. Cannot approve unsigned scope or fabricate GitHub checks. |
| Owner control center | Owner can edit only allowed operational controls; Muse read-only | \`note\`, \`dispatch_priority\`, \`pause_new_dispatch\`, global \`stall_minutes\`, \`escalation_minutes\`. These cannot override approved task contents or GitHub verification. |

Old signed task approvals, receipt IDs/hashes, chat links, PR references, and verified integration proof **MUST survive migration unchanged**. A new \`lifecycle_v3\` field is append-only; only the single trusted-main dispatcher can derive it.

## 2. Per-task lifecycle fields and derived stages

- Approval: task/product/title, signed plan version, scope, priority, DAG and owner holds.
- Muse: selected action, signed prompt hash, dispatch status, attempted/verified delivery, exact saved chat URL, outstanding receipt, notices.
- Coding evidence: branch, SHA, last commit time, last PR activity and *suspected* idle duration (never a ChatGPT-alive assertion).
- PR: missing/draft/open/merged, current base/head, link, ready transition.
- CI: NOT_RUN, PENDING, GREEN, FAILED, UNKNOWN; required missing checks and failure source URL, current head.
- Codex: expected automatic trigger vs verified request, pending/in-progress/clean/findings/stale/unknown, reviewed SHA, threads.
- Acceptance: separate submitted vs GitHub-verified evidence, test paths, current SHA.
- Dependency: approved parent/shared-file merge order, actual predecessor merge SHA, correct base, branch maintenance and conflicts.
- Merge: exact-head checks, clean Codex, resolved threads, non-draft, GitHub mergeable and ordered merged predecessors. Owner privileged/infrastructure holds are retained.
- Integration: merged SHA, exact-merge-SHA Integration Proof workflow, result, pass/fail; only PROVEN closes a task.
- Recovery: next GitHub or Muse actor/action, incident source and age, command request/ack, retry/error and owner notice.

These statuses are built by \`lifecycle-v3.mjs\`, persisted in \`lifecycle_v3.rows\` and timestamped \`transitions\` (last 1,000 transitions in JSON; all prior ledger Git commits remain in history). A missing read is UNKNOWN, never NO or GREEN. \`coder_done\` is explicitly ignored for completion.

The old owner read-only Pages view remains public-safe and **must not** expose private ledger, browser prompts or chat URLs. A complete private Markdown table is generated in \`dispatcher/owner-queue.md\`.

## 3. GitHub event / write contract

One trusted-main \`.github/workflows/ai-cafe-dev-dispatcher.yml\` processes selected PR, workflow_run, owner comment, review, repository_dispatch and fallback schedule events. The script consumes signed queue + existing private ledger + verified GitHub facts. Only changes are committed through the current Git-based CAS ledger (or existing Contents CAS fallback). Identical evidence is not re-written every minute.

The same engine runs safe GitHub effects: early draft PR creation from a verified branch+authentic Muse coding receipt+signed exact files; Ready promotion after full current-head required CI; one Codex trigger/watchdog; safe parent branch maintenance without force-push; authorized coding PR merge; exact-merge-SHA integration. PR create/merge network uncertainty is re-observed before any replay.

**Do not** run two dispatcher engines with production credentials. Do not let PR-branch workflow code receive those credentials. Infrastructure and privileged PRs remain owner-merge-only. Parallel coding does not imply parallel out-of-order merging.

## 4. Muse → GitHub recovery contract

Muse's **independent host** reads \`dispatcher/state.json\` over a locally synced private Git/SSH checkout. No REST API is required for normal status inspection. \`muse-watch-v3.mjs\` computes schedule/ledger age, suspected coding stall, stale Codex, pending browser deliveries and owner notices; it stores a local bounded backlog (0600) and sends a narrowly scoped \`repository_dispatch\` event when available.

GitHub \`repository_dispatch\` event type: \`dispatcher_recovery\`. Example request:

\`\`\`json
{
  "event_type": "dispatcher_recovery",
  "client_payload": {
    "version": 1,
    "intent": "REQUEST_CODEX_IF_ELIGIBLE",
    "task_id": "7",
    "pr_number": 437,
    "expected_head_sha": "<40-character SHA from the signed ledger>",
    "requested_at": "<current ISO UTC timestamp>",
    "request_id": "<sha256 canonical identity generated by recovery-v3.mjs>"
  }
}
\`\`\`

Allowlisted intents: \`RECONCILE\`, \`MARK_READY_IF_ELIGIBLE\`, \`REQUEST_CODEX_IF_ELIGIBLE\`, \`RETRY_CI_IF_SAFE\`, \`REFRESH_BRANCH_IF_SAFE\`, \`MERGE_IF_ELIGIBLE\`, \`VERIFY_INTEGRATION\`, \`CHECK_STALL\`. Global \`RECONCILE\` after a missing GitHub cron uses \`task_id=null\`, \`pr_number=null\`, \`expected_head_sha=null\`.

GitHub uses the **authenticated event sender**, not an actor supplied in JSON, and validates exact task/PR/head, request timestamp and request hash. The request is a **wake**, never an approval, CI result or permission to merge; every action still goes through GitHub's current live safety gate. GitHub persists command status/verified result in \`state.recovery_requests\`; Muse treats HTTP 204 only as *event accepted*, not as completed action, and clears local backlog only after a durable GitHub acknowledgement.

One independent watchdog command: after securely synchronizing the private ledger to a local \`/path/private-ledger.json\`:

\`\`\`bash
GITHUB_REPOSITORY=killbill2792/aicafe MUSE_GITHUB_ACTOR=<authenticated GitHub actor> \\
MUSE_GITHUB_WAKE_TOKEN=<existing authorized narrowly scoped token> \\
node scripts/dev-dispatcher/muse-watch-v3.mjs \\
  /path/private-ledger.json /path/private-muse-recovery-backlog.json
\`\`\`

Run under Muse's existing external scheduler with a single-instance lock and least privilege; **this PR does not install/start a remote service**. GitHub \`repository_dispatch\` requires an authorized GitHub credential, even though polling the ledger over Git/SSH does not. If the existing Muse key is strictly read-only, the host cannot invoke GitHub with that key alone. The owner must authorize the minimum necessary event credential or a preexisting permitted wake path; no new privileged key is minted by this PR. Without it, queued recovery remains pending and the owner monitor reports the missing capability. If Actions or GitHub as a whole is unavailable, Muse retains backlog and can continue already authorized local observations, but cannot claim a verified GitHub merge.

Rate limit vs server outage: 403/429 with documented rate-limit headers respects cooldown/Retry-After; HTTP 500/502/503/504 and transport errors use bounded retry with no blind write replay. Routine branch progress is observed via Git, and event-driven GitHub checks reduce API load. A dispatcher that never runs can only be detected by Muse's outside-GitHub monitor. The private ledger's \`updated_at\` and \`schedule_health.last_schedule_at\` must be displayed separately.

## 5. Private dashboard

Start locally on a trusted private machine with an authorized existing ledger read/write credential and a strong password:

\`\`\`bash
DASHBOARD_OWNER_PASSWORD=<owner-supplied-secret> \\
DISPATCH_LEDGER_TOKEN=<authorized-private-ledger-credential> \\
DISPATCH_LEDGER_GIT_WRITES=true \\
node scripts/dev-dispatcher/owner-dashboard-v3.mjs
\`\`\`

It binds **127.0.0.1:7359 only**. Reach it via an authenticated SSH tunnel to that same host; it is not a public URL or public GitHub Pages application. Optional \`DASHBOARD_MUSE_PASSWORD\` allows Muse read-only dashboard access. No credential appears in the browser source; Basic authentication is restricted to local loopback/tunnel. Never publish a plain HTTP port on the public network. The dashboard includes all task rows, status columns, detailed evidence, next actions, open notices and restricted owner-only edits using CAS revision checks.

The private Markdown dashboard needs no server and can already be opened from GitHub after merge/runtime reconciliation: \`https://github.com/killbill2792/dave-task-queue/blob/main/dispatcher/owner-queue.md\`.

## 6. Migration / acceptance requirements — DO NOT claim live until all verified

1. Compare v3 read-only projection against real historical v1 ledger snapshots without changing existing private \`tasks/actions/receipts\` or authorizations. Legacy unknowns remain UNKNOWN.
2. Run deterministic \`node --test scripts/dev-dispatcher/*.test.mjs scripts/dev-dispatcher/bridge/*.test.mjs\`, full exact-head CI, Codex review and owner-only PR merge. Do not weaken repo guards.
3. Exercise authentic Muse task delivery → receipt → branch → draft PR; CI failed→chat repair; green Ready→one Codex; findings→same-chat fix→clean current-head review; parent merge→child safe update/conflict; authorized ordered merge→exact-SHA integration. No duplicate actions or forged proof.
4. Inject GitHub 429, HTTP 500, dropped cron, stale ledger, rejected receipt, missing PR, wrong repo/branch, changed SHA and uncertain POST, and verify durable recovery record and absence of unauthorized effects.
5. On the Muse host, install a real independent scheduler/runner, verify actual Git SSH ledger read, authenticated recovery wake/receipt and owner notification, and confirm watchdog still fires when GitHub scheduled Actions are deliberately omitted. **Repository code alone is not this proof.**
6. Start the private dashboard on its private host, perform real owner-authenticated write/read-back and Muse read-only access. Do not expose public ledger.
7. Owner authorizes a cutover: new v3 is the **same** trusted-main dispatcher; no second active daemon. Keep old PR #439 unmerged, mark superseded once #440 is proven; do not delete historical receipts or state. Full rollback is previous main dispatcher code and intact private ledger v1 fields. Do not automatically revert GitHub merges or privileged owner effects.

## 7. Explicit limitations

- GitHub cannot directly know whether ChatGPT is still responding. A commit/PR silence is *suspected* stall only, not proof of stopped chat.
- A successful GitHub API event and a GitHub Actions check do not prove Muse actually opened a chat or owner actually received a notification. That requires authenticated Muse receipt.
- Browser courier interaction, external host scheduler and owner dashboard service deployment are outside the GitHub PR and must be independently verified.
- GitHub outages, rate limits, Codex unavailability and missing provider credentials are real external limitations; no design can guarantee zero interruption. It must keep work and incidents durable, continue unrelated coding, and recover when service returns.
