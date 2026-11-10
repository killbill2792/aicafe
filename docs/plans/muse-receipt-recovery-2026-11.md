# Trusted Muse receipt recovery — design and implementation plan

> **Owner decision (Nov 9, 2026):** Extend the EXISTING GitHub dispatcher ↔ Muse courier loop so that missing or unauthenticated receipts cannot silently stall authorized coding work. No second agent, queue, scheduler, browser executor, model bill, or scope override.

## Existing path and observed fault

Approved task/PR → trusted-main dispatcher `run.mjs` → private `killbill2792/dave-task-queue/dispatcher/state.json` actions → existing signed opaque `muse-signal` → Muse's existing browser courier → authenticated GitHub receipt in private `dispatcher/receipts/<sha256(action_id:prompt_hash)>.json` → GitHub `collectReceipts`/role/hash/URL validation → same task, same chat, next signed repair/proof round.

The actual POS0e assignment receipt existed and had a valid chat URL and matching hashes, but its Git commit used a custom "Muse" name without an attributable `author.login`. The old `collectReceipts` silently skipped that file. With no saved `conversation_ref`, `decideNudge` correctly held all follow-ups. The same receipt later committed by a recognized allowed GitHub user was accepted and queued a single `repair_review` instruction. This is the verified root cause. The failed paid POS0e real-agent acceptance test is **separate** and remains blocked until verified within approved cost/scope.

## Contract and ownership

1. **GitHub is the only authority.** Keep `dispatcher/state.json`, signed queue, validated receipt hashes and GitHub allowlisted commit author as before. No self-declared `submitted_by`, changed target, or custom Git author may authenticate a receipt.
2. **Examine all receipts every trusted reconcile** without discarding one error silently. Return accepted receipts and **coded, bounded, sanitized** rejections. For receipts without an attributable or allowlisted GitHub author, derive task/action only by matching the SHA-256 *filename* to an already approved ledger action's exact ID and prompt hash. Never trust unverified file body to assign work.
3. **Private repair state** records for known outstanding actions: code `unattributed_git_actor`, `unapproved_git_actor`, `invalid_receipt_identity`, `receipt_validation_failed`, or `github_receipt_read_failed`; first/last observation, bounded reminders and whether resolved. No raw prompts, credentials, private chat URLs, or provider responses.
4. **Muse wake-up:** derive a new opaque HMAC fingerprint from pending receipt repairs, using the existing `signal.json` writer. Show the **specific** action, failure reason and safe steps only in the existing GitHub-authenticated `dispatcher/owner-queue.md`, where Muse can inspect the private ledger. Do not publish private receipt/action IDs to GitHub Pages or public signal. Recheck with bounded 15-minute wake increments; do not create repeat browser action IDs.
5. **Repair the evidence, NOT the prompt:** Muse must re-commit the *same* existing receipt file through GitHub's authenticated Contents API using its **already authorized token** or another explicitly allowlisted GitHub actor. The resulting latest commit must have `author.login` recognized by GitHub. The original action ID, prompt/approval hashes, project, provider, and chat URL must be unchanged. GitHub validates it against current task scope/head; if it was already submitted, acknowledge idempotently. **Never resend the browser instruction merely to fix a receipt**, never silently alter `state.json`.
6. **Public owner signal:** show `Courier receipt rejected — Muse must re-authenticate; no new send` for a tracked task, and overall count of private receipt-repair holds without private details. Owner only participates when actual scope/cost/credential authorization is needed, not ordinary retry.
7. **Safety:** if GitHub receipt scan is incomplete or the API fails, preserve last known repair state, label scan health, don't treat unknown receipts as accepted or reset delivery locks, and don't allow action/merge bypass. A stale receipt on an already merged task must not revive it. Accepted/superseded receipts are audit history only.

## Exact modified files

- `scripts/dev-dispatcher/inbox.mjs`: inspect and safely process receipt batch, report typed rejects.
- `scripts/dev-dispatcher/receipt-recovery.mjs`: pure private ledger matching, idempotent feedback, bounded wake/resolve.
- `scripts/dev-dispatcher/run.mjs`: wire existing trusted reconciliation to acceptance/rejection feedback before next planned dispatch; never write private contents to public log.
- `scripts/dev-dispatcher/signal.mjs`: add opaque repair requests to existing HMAC signal, no new scheduler.
- `scripts/dev-dispatcher/private-owner-view.mjs`: private repair table and instructions for Muse.
- `scripts/dev-dispatcher/owner-view.mjs`: generic sanitized public owner status for unresolved handoff and distinct tasks.
- `scripts/dev-dispatcher/bridge/README.md`: courier retry contract using existing authenticated GitHub token, same action, no resend.
- Focused regression tests in `inbox.test.mjs`, `receipt-recovery.test.mjs`, `signal.test.mjs`, `owner-view.test.mjs`, `private-owner-view.test.mjs`.

## Testable progression

- [ ] Missing/unlinked GitHub author rejects receipt and preserves raw delivery state; another valid receipt still processes.
- [ ] A rejection file cannot claim an unrelated task: only hash-matching a currently known action can appear as task-specific recovery.
- [ ] Repeated ticks are idempotent; bounded wake rounds change the opaque HMAC hint without altering a browser delivery.
- [ ] Same receipt after valid GitHub-authenticated rewrite resolves rejection and restores normal receipt + original chat; second reconciliation does not duplicate prompts.
- [ ] Old-head, revoked, invalid URL/hash, wrong courier and closed PR receipts cannot produce a new authorized action.
- [ ] Public owner dashboard never renders receipt SHA, prompt, private URL, or author identity; private view shows action and corrective step.
- [ ] GitHub rate-limit/fetch error retains the prior rejection and alerts that the scan is not complete, without claiming clean health.
- [ ] Full exact-head repo guards, dispatcher tests, database/TS/Vitest baseline and Codex review pass. Merge only under existing policy; main/Pages/private-view readback after any approved merge.

## Explicit operational limitation

This repository can implement GitHub-side feedback and a protocol that the **already running Muse courier** reads and acts on. GitHub alone cannot modify Muse's separate host/Git identity or guarantee an external browser handoff. The private repair record and opaque wake-up will make that blocked external step observable and actionable; **fully autonomous recovery still requires Muse to use its authenticated GitHub API write path**, which must be verified by a real courier receipt after deployment. No extra paid service is required.
