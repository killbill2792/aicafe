# Task 10 production acceptance and recovery plan (2026-11-11)

## Owner instruction and exact repair boundary

Owner asked to repair the outstanding Task 10 effect-uncertainty gap, prove the production migration against a copy of the current database, retain existing jobs/data, and prepare a coordinated recovery path **before** sending live OTPs or applying production SQL. This follow-up extends merged PR #443; it does not modify that PR or its immutable migration.

Editable paths in this repair:
- `supabase/migrations/20261112000301_supervisor_effect_reconciliation.sql` (new additive function, applied **after** Task 10's 00206 migration)
- `lib/ai/supervisor/loop/effectGateway.server.ts`
- `lib/ai/supervisor/loop/effectGateway.test.ts`
- `lib/ai/supervisor/loop/supabase.server.ts`
- `app/api/ai/threads/[threadId]/proposals/route.ts`
- `app/api/ai/threads/[threadId]/proposals/route.test.ts`
- `scripts/test-supervisor-effect-gateway-db.mjs`
- this document.

Read-only sources: `AGENTS.md`, `PROGRESS.md`, original 00206 migration, `supervisor_proposals`, `supervisor_approvals`, `pantry_stock_purchases`, existing MFA Auth factor APIs, existing staff atomic executor, owner/café membership and time zone.

## Source, identity, retention, access, different cafés

Each proposal is uniquely identified by `(business_id, owner_user_id, thread_id, proposal_id)` and immutable `effect_hash`/revision. The existing single `supervisor_effect_attempts` row is uniquely keyed by `(business_id, proposal_id, effect_hash)`, with attempt key and state. Stock purchases have a canonical, unique `(business_id, line_id)`, where `line_id = proposal_id`; compare their ingredient, purchase date, entered amount/unit, cost, source, and non-voided status with the existing immutable effect payload. Do not cache financial data or copy purchase/OTP contents into the attempts ledger. Save only an opaque, scoped canonical receipt reference and verified timestamp. Different cafés have independent memberships, local days, data and quotas.

## One recovery path, fail-closed

A privileged, revision-checked recovery RPC on the same effect gateway may promote **uncertain** attempts only after a verified canonical postcondition. A missing, altered or wrong-café purchase row is not a receipt: the proposal remains uncertain, and no second commit is sent. Goal and event tracking are inert operations, and price experiments require manual POS action; the RPC may finish these internal transitions without any external effect. Menu-price and unrecognized provider effects have no immutable, proposal-scoped receipt adapter in Task 10 and remain uncertain for operator intervention; never infer success from a coincidentally matching current price. An executing claim younger than five minutes is not reconciled; old claims with no proof become uncertain, never automatically retried. Preserve authorization kind and initial mandate daily quota use, even across revocations/revisions.

Owner-authenticated, same-origin POST `action: "reconcile"` on the existing proposals API invokes the RPC; no new scheduler, queue, authorization mechanism, owner UI or live provider permission. Existing behavior for approval, purchase, staff and price writing stays unchanged.

## Non-production acceptance / recovery gates

1. Rehearse `20261111000206_supervisor_effect_gateway.sql` followed by this additive migration on a schema copy of current production; verify existing approval and staff commit function compatibility, indexes, RLS and grants. Never execute against production for a rehearsal.
2. Registered disposable PostgreSQL SQL assertions: owner/café/thread isolation, one-claim quota race, revoked mandate, OTP challenge identity and replay, legacy click parity, staff CAS, uncertain after lost response, matching purchase receipt recovery, missing/mismatched/foreign receipt denial, old crash claim, inert goal recovery, no duplicate purchase execution.
3. Focused Vitest/API tests, required PR baseline, database runner, TS, lint, Codex exact-head review. Non-skipped evidence only.
4. Verify current Supabase phone MFA provider setting and a verified-factor enrollment in a controlled account; **do not send a real OTP** during this coding/acceptance phase.
5. Apply production SQL only after separate production release authorization, then verify exact objects/RLS/permissions, click parity and actual production logs. No release authority is implied by a green PR.

### Production status and branch-cost blocker

Read-only project inspection on 2026-11-11: current production has proposals and approvals but lacks `supervisor_mandates`, `supervisor_mandate_challenges` and `supervisor_effect_attempts`; there were 35 draft, three committed and one rejected proposals, no executing proposal at that instant. Supabase hosted dev branch cost quoted: **$0.01344/hour**, separate explicit user confirmation required; a branch creation was **not** authorized and no data were copied. The existing CI disposable database is synthetic, not a production copy. Report this distinction honestly.

### Coordinated rollback / recovery (prepared, not requested to execute)

* Before activation, capture an up-to-date restorable snapshot and the actual existing `supervisor_transition_proposal` function definition, migration ledger, application deployment SHA, owner authorization states and pending effect attempts.
* Prefer **forward repair** for a schema failure: stop new effect claims at the route/release switch; restore compatible SQL and app behavior together. Do not blindly revert only the Vercel code after 00206 has forbidden the legacy `claim_commit` action.
* If an emergency rollback is necessary, disable all effectful requests, quiesce workers, prove zero in-flight claims, and restore the application and compatible SQL as an atomic coordinated runbook. Never delete stored mandates, purchases or receipts to make rollback green. Existing executing/uncertain receipts require operator reconciliation before any reattempt.
* Do not automatically execute rollback, production schema writes, live provider actions or OTP sends.
