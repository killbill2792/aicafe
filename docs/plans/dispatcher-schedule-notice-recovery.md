# Dispatcher incident cleanup and five-minute schedule re-registration

## Owner-approved scope / rationale

See [issue #411 comment #6811689604](https://github.com/killbill2792/aicafe/issues/411#issuecomment-6811689604). This is a small **post-merge** repair for the existing dispatcher; PR #446 was merged into `main` and real trusted run [#43134203778](https://github.com/killbill2792/aicafe/actions/runs/43134203778) was successful. It is **not** a v3 rewrite, second brain or second scheduler.

## Evidence from the current active path

- Old run logs (examples #43123864935, #43129077620, #43129563404) fail at `GitHubLedger.load()`: `Unexpected GitHub ledger response` and emit an emergency notice.
- After PR #446, code reads the >1MiB private ledger with immutable Git blobs and commits private archives through Git CAS; #43134203778 has a successful trusted reconcile and owner queue / wake publication. The old overflow error is **resolved**, not a current outage.
- The private queue still has many `dispatcher_emergency` entries for each previous failed run, including 78 **planned** entries with the now-fixed exact signature. Treat them as historical failures, not new operational asks.
- The ledger's `schedule_health.last_schedule_at` remains `2026-11-11T17:26:57.920Z`. Non-schedule triggers do not establish five-minute cron health. The existing workflow retains exactly one `schedule` cron at `2/5 * * * *`.
- Muse's external watchdog is a different host mechanism and not installed or verified by this PR. No `recovery_requests` evidence is present at audit.

## One-path change, exact six paths

1. `.github/workflows/ai-cafe-dev-dispatcher.yml`: change only the single cron from `2/5` to `3/5` (five minutes, offset by one) to re-register the scheduled-workflow actor on owner main commit. No additional job, credential or scheduler.
2. `scripts/dev-dispatcher/alerts.mjs`: pure, narrow cleanup function to mark only planned legacy `dispatcher_emergency` with identity `run:<digits>:failure` **and** exact old `Unexpected GitHub ledger response` error signature resolved. Record resolution timestamp and reason; never forge delivery or delete notice/receipt records.
3. `scripts/dev-dispatcher/run.mjs`: after **successful** GitHub reconciliation in the existing trusted Git CAS projection, apply the cleanup once. Do not call it on read failure or preflight failure.
4. `scripts/dev-dispatcher/alerts.test.mjs`: positive/negative tests for exact signature, statuses, identities and repeat safety.
5. `scripts/dev-dispatcher/reconciliation-fixes.test.mjs`: assert the single existing five-minute cron is `3/5`, no added scheduler, and that cleanup is gated behind successful reconciliation.
6. `docs/plans/dispatcher-schedule-notice-recovery.md`: this operational contract and post-merge validation.

All other paths read-only, including PR #447 encrypted Pages and the existing Muse host tools.

## Acceptance and non-goals

- Correctly close only old, verified obsolete run failure notices; keep new/current failures and all owner questions. `status=resolved` does not claim Muse delivery.
- Deterministic tests; full applicable PR baseline; exact-head Codex and thread resolution; owner-only infrastructure merge.
- After merge, verify a real trusted-main `push` reconciliation, private ledger readback and reduction in planned old overflow notices. Record actual merge SHA, not PR SHA.
- **Five-minute cron is not declared healthy from the YAML edit.** Observe real `schedule` workflow starts and `schedule_health.last_schedule_at` updates across consecutive ticks, or explicitly report external GitHub scheduling blocked; do not duplicate the scheduler just to make the metric green.
- Muse-host watcher must be verified separately from the host by an authenticated event → durable GitHub ledger acknowledgment. This PR cannot enable external credentials or prove a host service exists.
