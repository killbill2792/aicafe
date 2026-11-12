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
- `lib/ai/supervisor/loop/menuPriceChange.server.ts` (existing CAS writer: add immutable proposal receipt identity only)
- `lib/ai/supervisor/loop/menuPriceChange.server.test.ts`
- `lib/ai/supervisor/loop/menuPriceChange.independent.test.ts`
- this document.

Read-only sources: `AGENTS.md`, `PROGRESS.md`, original 00206 migration, `supervisor_proposals`, `supervisor_approvals`, `pantry_stock_purchases`, existing MFA Auth factor APIs, existing staff atomic executor, owner/café membership and time zone.

## Source, identity, retention, access, different cafés

Each proposal is uniquely identified by `(business_id, owner_user_id, thread_id, proposal_id)` and immutable `effect_hash`/revision. The existing single `supervisor_effect_attempts` row is uniquely keyed by `(business_id, proposal_id, effect_hash)`, with attempt key and state. Stock purchases have a canonical, unique `(business_id, line_id)`, where `line_id = proposal_id`; compare their ingredient, purchase date, entered amount/unit, cost, source, and non-voided status with the existing immutable effect payload. The existing canonical `menu_price_history` stores `(business_id,menu_item_id,old_price_cents,new_price_cents,source_type,source_provider,id)`; attach the exact proposal ID to `source_provider` in the existing atomic price writer. For price reconciliation require an exact matching history row created after the claim **and** the matching current canonical menu price. The old RLS policy allowed any café member to insert/alter history; this additive migration replaces that broad write policy with owner-only append access, preserving existing member SELECT and service-role sync access. The history source is still owner-writable, so this is a bounded database postcondition, not an unforgeable independent provider receipt. Do not cache financial data or copy purchase/OTP contents into the attempts ledger. Save only an opaque, scoped canonical receipt reference and verified timestamp. Different cafés have independent memberships, local days, data and quotas.

## One recovery path, fail-closed

A privileged, revision-checked recovery RPC on the same effect gateway may promote **uncertain** attempts only after a verified canonical postcondition. A missing, altered or wrong-café purchase row is not a receipt: the proposal remains uncertain, and no second commit is sent. Goal and event tracking are inert operations, and price experiments require manual POS action; the RPC may finish these internal transitions without any external effect. Menu-price effects after this repair use proposal-specific canonical history **plus** the live canonical menu price as a database postcondition; old history without proposal ID, owner-forged history without the matching price, and unknown provider effects remain uncertain for operator intervention. An executing claim younger than five minutes is not reconciled; old claims with no proof become uncertain, never automatically retried. Preserve authorization kind and initial mandate daily quota use, even across revocations/revisions.

Owner-authenticated, same-origin POST `action: "reconcile"` on the existing proposals API invokes the RPC; no new scheduler, queue, authorization mechanism, owner UI or live provider permission. Existing behavior for approval, purchase, staff and price writing stays unchanged.

## Non-production acceptance / recovery gates

1. Use the **existing, zero-hosted-branch-cost** disposable CI infrastructure: `supabase start` + `supabase db reset --local --yes` applies every repository migration, including `20261111000206` and `20261112000301`, to the current repository schema; PostgreSQL 16's independent `scripts/test-supervisor-effect-gateway-db.mjs` applies pre-Task-10 approval-lifecycle migrations, then these two migrations and tests their behavior. Reconcile critical table/function/policy signatures against **read-only production introspection** before a later live release. Neither test creates a byte-for-byte production database clone. Never execute acceptance SQL against production.
2. Registered disposable PostgreSQL SQL assertions: owner/café/thread isolation, one-claim quota race, revoked mandate, OTP challenge identity and replay, legacy click parity, staff CAS, uncertain after lost response, matching purchase receipt recovery, missing/mismatched/foreign receipt denial, old crash claim, inert goal recovery, price-history owner-only append/no staff forge or mutation, exact price/current-menu postcondition, no duplicate effect execution.
3. Focused Vitest/API tests, required PR baseline, database runner, TS, lint, Codex exact-head review. Non-skipped evidence only.
4. Verify current Supabase phone MFA provider setting and a verified-factor enrollment in a controlled account; **do not send a real OTP** during this coding/acceptance phase.
5. Apply production SQL only after separate production release authorization, then verify exact objects/RLS/permissions, click parity and actual production logs. No release authority is implied by a green PR.

### Production status and existing disposable database acceptance

Read-only project inspection on 2026-11-11: current production has proposals and approvals but lacks `supervisor_mandates`, `supervisor_mandate_challenges` and `supervisor_effect_attempts`; there were 35 draft, three committed and one rejected proposals, no executing proposal at that instant. Supabase Auth has zero verified phone MFA factors and zero verified TOTP factors; this does not establish whether a messaging provider is configured. The actual existing price CAS writer passes the `source_provider` unchanged to a transactionally inserted canonical `menu_price_history` row. **No hosted Supabase branch is needed or requested.** The repository already contains a free-to-this-project, throwaway local Supabase/Postgres CI path. Actual completed proof: [PR #454 run 43165829562](https://github.com/killbill2792/aicafe/actions/runs/43165829562) at exact head `e564d8319050d1f65db818e8cc9c1db037692643`; 11 jobs green (browser intentionally not selected for a backend-only PR). [Database job 131007947375](https://github.com/killbill2792/aicafe/actions/runs/43165829562/job/131007947375) reports **64 database checks passed, 0 failed/skipped**. Its log shows both `00206` and `00301` applied during local Supabase initialization **and again during database reset**. The full PostgreSQL 16 fixture applies the existing proposal/approval-lifecycle migrations before Task 10 migrations, and includes canonical receipt, RLS, mandate quota, cross-café and replay checks. This validates clean repository schema and an isolated synthetic prior-ledger fixture, **not exact production-data migration**, provider OTP delivery, or an unverified full production schema snapshot. An actual copy of private production data is not necessary for this scoped acceptance. Any production-specific drift is handled through read-only signatures and release preflight instead.

### Coordinated rollback / recovery (prepared, not requested to execute)

* Before activation, capture an up-to-date restorable snapshot and the actual existing `supervisor_transition_proposal` function definition, migration ledger, application deployment SHA, owner authorization states and pending effect attempts.
* Prefer **forward repair** for a schema failure: stop new effect claims at the route/release switch; restore compatible SQL and app behavior together. Do not blindly revert only the Vercel code after 00206 has forbidden the legacy `claim_commit` action.
* If an emergency rollback is necessary, disable all effectful requests, quiesce workers, prove zero in-flight claims, and restore the application and compatible SQL as an atomic coordinated runbook. Never delete stored mandates, purchases or receipts to make rollback green. Existing executing/uncertain receipts require operator reconciliation before any reattempt.
* Do not automatically execute rollback, production schema writes, live provider actions or OTP sends.

### CI execution ledger

Initial PR #454 run `43163204490` failed due to GitHub API rate limits; subsequent SQL guard and synthetic fixture issues were corrected without weakening the guard or tests. A later [full baseline run 43165829562](https://github.com/killbill2792/aicafe/actions/runs/43165829562) at head `e564d8319050d1f65db818e8cc9c1db037692643` **succeeded**, including every required SQL/DB test and 3 Vitest shards; targeted Playwright was intentionally not selected for this backend-only diff, and is not claimed as passed. After this documentation clarification, a new exact-head baseline and final Codex review will still be required before merge.

### Existing price-history RLS compatibility check (read-only production evidence)

The production table currently has a broad `members write price history` policy (`FOR ALL` with `is_member(business_id)`) and full table grants to `authenticated`. This makes a history row alone too easy to forge. The follow-up migration removes that write policy while keeping the existing member READ policy; it adds owner-only INSERT. The `set_menu_item_price_with_history_if_current` function runs as a security invoker, checks the authenticated owner and calls the original atomic price/history writer; it should remain functional for owners and service-role POS sync. This is a **behavioral policy change** requiring migration-rehearsal checks for any other writer (not a no-risk additive table-only change). Never claim it has been applied until a verified production migration.

### Production migration-ledger drift (read-only verification, release blocker)

Production `supabase_migrations.schema_migrations` currently ends at `20261105012125_forget_owner_fact`. The latest `main` migration directory has **nine later** files not recorded in that production ledger: `20261105040000`, `20261105040001`, `20261105160000`, `20261109000156`, `20261109000158`, `20261109000159`, `20261109000200`, `20261111000204`, and Task 10 `20261111000206`. This new PR adds `20261112000301`. Some unrecorded files may have been applied out of band; absence from the ledger is not proof that every corresponding object is absent. Confirm actual function/table signatures and the complete source migration chain on a schema clone **before any bulk CLI push**. Never apply all ten blindly. No production migration was executed in this PR.

### Owner clarification — no paid testing infrastructure (Nov 11)

The owner correctly identified that the existing local Supabase/PostgreSQL disposable CI environment already provides database migration and effect-gateway acceptance. The earlier request for authorization to create a hosted development branch at `$0.01344/hour` was unnecessary and withdrawn. **Do not create a Supabase development branch, accept extra cloud costs, or block this repair PR on such a purchase.** The remaining distinct gates are: explicit confirmation of production-specific schema drift/read-only signatures before live migration, final exact-head non-skipped CI/Codex, and later real phone MFA verification. Existing jobs and owner records are not deleted to make acceptance pass.

## Production-readiness audit: actual production vs disposable schema (2026-11-11, 22:40 PT)

**Decision: targeted migration is technically plausible, but not certified for a blind production push.** No production SQL has been changed. We have not asserted a byte-for-byte production clone. The repository's zero-cost local Supabase PG17 runs every migration from scratch; its PostgreSQL 16 fixture applies the pre-Task10 ledger plus both Task10 migrations and checks security/claims/receipts. The pre-existing-data upgrade fixture now seeds three legacy click approvals *before* Task10 migration and proves that the migration preserves the exact owner/effect/revision data and that a legacy approved proposal remains executable through the new gateway. CI evidence for **the changed test head** must pass before these *new* scenarios are accepted.

### Recorded read-only production facts and interpretation

| Fact | Confirmed state | Meaning for deployment |
| --- | --- | --- |
| PostgreSQL | 17.6 (2026-11-12 06:37Z UTC inspection) | Matches local Supabase major 17; the isolated claim/race fixture additionally uses PG16 |
| Proposals | 39: 35 event-readiness drafts, 1 event-readiness committed, 2 price-change committed, 1 price-change rejected | Must not wipe/reseed; no current executing proposals at inspection time |
| Approvals | 3, all for committed proposals, each approved revision 1 | None has inconsistent owner/café/effect hash or future approved revision; Task10 should add `authorization_kind='click'` and null mandate identifiers |
| Cafés | 9, all timezones valid in PostgreSQL | Café-local-day quota cannot fail due to a missing timezone **at inspection time** |
| Old authority | `supervisor_proposals`, `supervisor_approvals`, `supervisor_transition_proposal` and `supervisor_commit_staff_proposal` exist | Mandatory 00206 dependencies are present |
| Canonical receipts | `pantry_stock_purchases`, `menu_price_history`, `menu_items` exist | 00301 recovery dependencies exist |
| New Task10 tables | mandates/challenges/effect_attempts **absent** | Vercel application code is ahead of database; live gateway is not certified |
| Verified phone MFA factors | 0 | The mandate grant flow cannot complete yet; does **not** prove the OTP provider is disabled |
| Production ledger | last recorded `20261105012125` | Nine later repository migrations exist but some objects are already live, implying mixed out-of-band/manual deployment or ledger drift. Never bulk push pending migrations |

**Unrecorded migration family spot checks:** `supervisor_runs` and `supervisor_run_steps` already exist though 40000 is unrecorded; `create_operating_commitment` and the `due_at` column are already present though 40001 is unrecorded; the shared `toast_records_for` function from POS0e and the POS0b labor staging RPC are present; the Task7 `supervisor_routines` tables and POS0c `toast_stage_operational_batch` function are absent. This mixed state is positive evidence that a blanket `supabase db push` would not be safe. It is **not** permission to mark those missing migrations applied.

**Production Vercel** most recent inspected READY build was at main SHA `d5df6e5623b3589b7f9df9ccb0dcb76b8ed60878`, which already contains #443. A 24-hour runtime error scan found an unrelated Supervisor `get_peak_hours` invalid reporting period and prior events-lookahead timeouts. These are existing operational concerns, *not* proof of a Task10 SQL migration failure; no clean runtime acceptance for Task10 can be inferred from Vercel READY alone.

### Migration compatibility and safety matrix

| Change | Existing data / blast radius | Precondition | Failure response |
| --- | --- | --- | --- |
| 00206: add three authorization columns to `supervisor_approvals` | All three existing approval rows gain click defaults; no row deletion, no existing approval reset | Three pre-existing approvals have valid scope/hash/revision; zero executing proposals at cutover | Do not apply if a new executing claim appears; maintain a coordinated release checkpoint |
| 00206: add mandate, challenge, attempt tables | New, initially empty tables with FK, constraints and RLS | Parent businesses/owners/proposals and `auth.users` present | Stop if table/function signature conflicts; do not use `IF NOT EXISTS` to conceal drift |
| 00206: replace `supervisor_transition_proposal` | Behavior change: legacy `claim_commit` is explicitly blocked in favor of the gateway | Application #443 / #454 commits exclusively through `supervisor_claim_effect` | Application and SQL MUST stay compatible; never revert only frontend/Next |
| 00206: staff wrapper `supervisor_gateway_commit_staff` | Delegates to existing atomic staff executor | Existing `supervisor_commit_staff_proposal` signature and privilege still valid | Verify staff compare-and-swap on disposable full schema; do not perform a real staffing action for acceptance |
| 00301: recovery RPC | Adds a privileged, owner/café/revision-scoped receipt check; never re-sends external effects | 00206 installed; canonical purchase/history/menu records available | On absent/wrong receipt, stay uncertain and stop; no retry |
| 00301: price-history RLS | Previous all-member-write policy removed; SELECT retained | Owner must still write `owner_manual` through canonical CAS; ordinary authenticated members must still be able to add legitimate `initial`, `imported`, `connected_pos` rows for CSV/catalog | New separate INSERT policy preserves those member import sources but rejects staff `owner_manual` forgery; all authenticated UPDATE/DELETE denied |
| PR #454 menu writer provenance | Source provider becomes `Alex (owner approved; proposal <uuid>)` | Existing canonical CAS writer passes source provider transactionally into history | History + matching live price must both exist after effect claim; otherwise stay uncertain |

### Human-readable release procedure — **prepared, NOT executed**

**Stage A — release gates before any live migration**
1. Approve only the 11 changed paths in PR #454 and obtain a reviewed exact-head clean CI (guards, DB, full Vitest, TS/lint, production build) **and** a clean Codex review. No skipped check may be presented as passed.
2. Recheck read-only production: table/function signatures, current approver hash/scope consistency, valid café timezones, no executing proposals, exact current migration ledger and Vercel production SHA. Confirm live PSQL PG17 version and there are no unexpected newly created Task10 objects.
3. Obtain a verified restorable backup/snapshot, capture the old transition-function definition, and establish how to put all effectful owner approvals temporarily into maintenance. No delete/reseed of owner jobs, approvals or data.
4. Resolve the nine unrecorded migration entries **by actual object/signature inspection** with the responsible migration owners. Do not use `supabase db push` or any command that automatically applies all outstanding migrations. No fabrication of migration-history rows.
5. Choose a controlled low-activity window and confirm which Vercel SHA is on production; do not allow an unrelated automatic deploy between verification and migration.

**Stage B — targeted release (requires a separate explicit production authorization)**
1. Merge the reviewed repair PR using normal main protections, recognizing that **main auto-deploys on Vercel**. Verify the production deployment is READY, and hold owner effect approvals while schema is missing; the optional reconcile action must remain unused until its RPC exists.
2. Apply **only** SQL `20261111000206_supervisor_effect_gateway.sql` through a tracked, explicit migration operation. No bulk CLI push. Confirm new tables, authorization columns/defaults, constraints, RLS, grants and transition-function signature before continuing. Confirm all 39 proposals and all 3 approvals are still present.
3. Apply **only** SQL `20261112000301_supervisor_effect_reconciliation.sql` after 00206 succeeds. Confirm scoped recovery function exists, canonical menu-price import/owner policies are correct, and non-owner `owner_manual` writes remain forbidden.
4. Reload PostgREST schema cache as needed, then perform read-only integrity checks and specifically exercise a **synthetic controlled, non-provider** goal proposal under approved owner context. Do not use a real purchase, staff command, POS price change or SMS test as a first smoke.
5. Capture actual post-deploy Vercel request traces, Supabase errors, function response/status and counts. Only mark `integrated_proven` when those receipts and all owner authorization protections pass.

**Stage C — MFA enablement later, not part of this release authorization**
Confirm project phone MFA provider and delivery setup without exposing credentials; enroll a dedicated test owner phone factor; test OTP delivery, wrong/expired OTP, factor/owner mismatch, one challenge replay, grant/revise/revoke, the café-shared cap 5, expiry and midnight/DST rollover. There are currently **zero verified phone factors** on production, so real phone-based mandates cannot be considered available. Owner-facing grant/revoke UI is a separate Task16a dependency.

### Production preflight SQL (READ-ONLY, safe to inspect; never execute against an unknown target)

```sql
select current_setting('server_version') as pg_version,
 (select count(*) from public.supervisor_proposals) as proposals,
 (select count(*) from public.supervisor_approvals) as approvals,
 (select count(*) from public.supervisor_proposals where status='executing') as executing;
select count(*) as approval_mismatches
 from public.supervisor_approvals a join public.supervisor_proposals p on p.id=a.proposal_id
 where a.effect_hash is distinct from p.effect_hash
   or a.business_id is distinct from p.business_id
   or a.owner_user_id is distinct from p.owner_user_id
   or a.approved_revision>p.revision;
select to_regclass('public.supervisor_mandates') as mandates,
 to_regclass('public.supervisor_mandate_challenges') as challenges,
 to_regclass('public.supervisor_effect_attempts') as attempts;
select version from supabase_migrations.schema_migrations
 where version >= '20261105000000' order by version;
```

**Interpretation:** pre-cutover `executing=0`, `approval_mismatches=0`, no Task10 tables. After cutover `proposals` and `approvals` must be unchanged except for explicitly approved synthetic smoke records; all three new tables exist and their RPCs are present. Recheck that Task10 table RLS is enabled and that no `anon`/unauthorized role can execute the service functions. Never treat an empty runtime error stream as proof that live effects were exercised.

### Task 10 implementation gap inventory (do not misstate completed scope)

1. **Already fixed in #454:** missing recovery of uncertain attempts using canonical purchase and immutable proposal-specific price/history postconditions; explicit no-resend owner API; conservative older-claim policy; price-history staff forgery; preserving legitimate CSV imports; compatibility test with three legacy approvals; **the owner proposal-card GET no longer reports an uncertain/executing menu-price operation as 'applied' merely because the live current price matches the requested price** (it waits for a verified receipt/committed ledger).
2. **Still gated:** no live phone-MFA/SMS provider configuration or verified factor delivery proof; zero verified phone factors; no owner-facing mandate grant/revoke controls (Task16a); no live provider-effect smoke proof, and no guaranteed automatic/operator-visible workflow to periodically reconcile uncertain effects. The `POST action=reconcile` endpoint is usable by an authenticated owner but not yet surfaced as a visible UI recovery button.
3. **Known limitation:** a price-history row remains owner-writable and a current matching price is not an independent signed provider receipt. For POS/external effects, do not equate the local canonical price with a provider-verified menu update.
4. **Existing platform health unrelated to Task10:** mixed production migration ledger and newer POS/Task7 objects missing despite deployed code; separate Supervisor peak-hours error. These need their own owner-scoped plans rather than being silently changed in Task10.
5. **Operational recovery:** forward repair preferred over rollback, but a verified restore path and an effect-claim maintenance plan remain compulsory. No automatic deletion or downgrade of live owner data.

**Production go/no-go is conditional, not an unconditional promise.** A successful disposable test proves code/migration behavior under the test fixtures, not that the user's production database and external providers cannot fail. Merge, production migration and SMS delivery must each be tracked as separate verified steps.

### Additional high-severity correction: no false owner-visible price success

Before this repair, the GET projection for an `executing` menu-price proposal returned `state:'applied'` whenever the current menu price happened to equal the proposed value, even if the effect gateway ledger was still `uncertain`. A POS sync or a separate owner edit can create this coincidence. **This violates the effect receipt contract** and could mislead the owner into believing their exact approved action completed. PR #454 now returns `applying` for a live executing claim and `uncertain` for an unknown outcome until the scoped canonical receipt is verified and the actual proposal becomes committed. The route's regression test explicitly sets the current price equal to the proposed price and requires the outcome remain unverified, with zero extra writes. No automatic second effect is sent.
