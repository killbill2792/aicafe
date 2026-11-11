# Dispatcher reliable handoff — owner-approved repair plan (November 10, 2026)

Goal: one GitHub-authoritative task approval progresses to exactly one authenticated Muse delivery, or records an actionable retryable error; never hide failure behind a green workflow.

## Existing data path
1. Owner approval enters as an authenticated, versioned `owner_reply` receipt in private `dave-task-queue/dispatcher/receipts/`, signed by GitHub commit actor and bound to current task/notice signature.
2. The existing trusted-main dispatcher reads private receipts, PR/CI/Codex facts and the machine queue; its sole CAS ledger is `dave-task-queue/dispatcher/state.json`.
3. The dispatcher creates an immutable versioned Muse assignment and publishes the same opaque `aicafe:muse-signal` hint; Muse only sends the verified prompt and writes a receipt with the exact chat URL.
4. The existing dispatcher validates the receipt and records the task/chat once. Neither this proposal nor its code adds a browser agent, production job, POS row, credential, or second coordinator.

## Fixes in the existing path
- Accept an authenticated current-notice owner `yes` and its matching notice acknowledgement in one reconciliation; never require the owner to approve twice. Do not treat a courier acknowledgement as independent authority.
- Issue a new signed assignment when a historic `cancelled_approval_changed` action is definitively unsent, while retaining old history and refusing any uncertain/claimed/submitted prior delivery.
- Recover overdue Muse, owner-notice and receipt-repair wakes without waiting for best-effort cron; never discard overdue deadlines.
- Make receipt names deterministic through a shared helper and use it from the existing inbox, tests and Muse bridge instructions. A GitHub `repository_dispatch` wake is the fast path; the durable ledger plus bounded self-wake is the backup.
- Verify the exact task-6 state transition, duplicate prevention, signature/scope revocation, bad receipts and delayed-wake behavior with behavioral tests.

## Release boundaries and gaps
This is an infrastructure-only, owner-merge draft. CI and simulated end-to-end tests cannot prove live Muse browser delivery; after owner merge, an authenticated Muse-side courier test and one real task-6 handoff must be observed. The private ledger stays immutable except via trusted-main CAS reconciliation. No new owner gate, merge action or production permission is added.
