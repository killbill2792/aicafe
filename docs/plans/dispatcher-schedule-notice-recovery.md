# V3 dispatcher notification self-wake recovery

Owner correction and exact scope: [AI CAFE issue #411 comment #6811689604](https://github.com/killbill2792/aicafe/issues/411#issuecomment-6811689604).

## Current architecture (not the older v2 incident)

One GitHub trusted-main reconciler uses one private Git ledger at `killbill2792/dave-task-queue/dispatcher/state.json`. Muse is the external courier/observer. The five-minute GitHub cron is a **backup** and this PR deliberately leaves it unchanged. The existing delayed-wake workflow requests reconciliation; it is not another dispatcher engine.

PR #446 already fixed the >1MiB GitHub Contents API failure via immutable Git blobs. Real trusted-main [run #43134203778](https://github.com/killbill2792/aicafe/actions/runs/43134203778) succeeded in reconciliation, private dashboard publication, signal and delayed wake. Past failed runs before the merge are not current failures.

## Live problem verified from private-ledger snapshots

The v3 private ledger retains 174 planned notices, including 124 `dispatcher_emergency` notices. Exactly 78 have the old `Unexpected GitHub ledger response` failure signature; **other incidents must not be presumed resolved**. `wake.mjs` currently batches retry items by kind, but iterates overdue creation timestamps and chooses a different wake key every ~minute. The private delayed-wake history confirms separate `owner_notice_retry` dispatches at 01:26, :27, :28, :29, :30 and :33 UTC despite `muse.retry_seconds=900`.

## Correction

1. After a **verified successful trusted-main reconciliation**, resolve but never delete only unsubmitted/unclaimed exact obsolete GitHub-ledger-read incidents. Preserve their original IDs/hashes and lack of Muse delivery receipts, and leave other notices/owner approvals/receipts untouched. Private Git compaction may archive resolved history later.
2. Give batched Muse retry categories a durable lease: do not request a second wake while a prior one is in the future, and schedule the next check no sooner than one configured interval after the previous wake. Do not change Codex, coding, PR or independent host scheduling.
3. Keep immediate opaque Muse signal and original-chat receipts; never claim successful delivery from a GitHub wake.

## Acceptance and remaining unknowns

Test many staggered overdue notices plus repeated current GitHub events, retry cadence, safe historical incident closure, and preservation of all current pending owner decisions. Require exact-head CI/Codex and real post-merge trusted reconciling. The GitHub backup cron was last verified at 2026-11-11T17:26:57.920Z; its schedule events remain **stale/unproven**, but this is distinct from webhook and self-wake reconciliation. The Muse host credentials, independent watchdog, delivery and recovery acknowledgment cannot be observed from the repository alone; no claim of full host deployment.
