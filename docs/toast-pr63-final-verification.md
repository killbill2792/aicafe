# PR #63 final polling and reconciliation review

This follow-up is **staging-only** and does not alter any feature flags, live webhooks, or \`vercel.json\`.

## Modified order polling
- A Vercel invocation fetches **one** OrdersBulk page (at most 100 order facts), then calls the tenant- and nonce-fenced \`toast_stage_order_poll_page\` RPC. The SQL transaction either stages that entire page and records its next-page checkpoint, or rolls back both. The modification cursor advances **only** when a page shorter than 100 entries completes the entire window. Exactly 100 entries require a final empty next page to confirm completeness. Checkpointing reuses the frozen window and preserves stable order GUIDs.
- Source modification timestamps and the existing compare-and-set RPC decide overwrite order; a slower stale webhook or poll cannot overwrite the newer state. If a page fails, the nonce-fenced retry deferral preserves the progress row. Following polls resume that exact page.
- For pathological >100,000-order windows, the page cap fails safely rather than looping without bound. This needs an explicit smaller-window repair mechanism before large-scale rollout; no cursor is advanced on cap failure. Auth and HTTP 429 Retry-After are still handled by the Toast client.
- Modified-order scans are **not** evidence that a day contained zero transactions.

## Durable historical recovery
- Migration 54 adds \`toast_poll_recovery\` with exact timestamp bounds \`missing_since\` / \`missing_until\`, a monotonically advancing \`next_since\`, states \`requires_historical_backfill\`, \`backfilling\`, \`failed\` and \`complete\`, and tenant-bound leases. The gap is frozen at detection and processed chronologically.
- Per invocation, historical OrdersBulk backfill processes one page of a maximum three-hour segment; attendance changes process a maximum one-hour modified-time segment, respecting the existing 30-day query cap. Partial results never produce verified-zero coverage, and no backfill path promotes to canonical financials. Completion restores the proper last-successful modification cursor to the final recovered boundary.
- No indefinite Vercel execution, direct worker activation or new Vercel schedule is included. High-volume attendance windows above current staging limits and historical provider retention are still potential operator review cases.

## Post-promotion corrections
- Migration 55 preserves the existing canonical \`orders\`, \`order_lines\` and daily rollups. Newer Toast state for an already canonicalized \`toast:{restaurantGuid}:{orderGuid}\` order is recorded once per stable provider ID in \`toast_canonical_corrections\`, including the affected historical business date and latest modified timestamp.
- Affected \`toast_pilot_days\` promoted state is marked \`needs_review\`. The latest promotion wrapper checks for unresolved corrections and retains the previous independent-report, CSV collision, refund-date and location safeguards. **No automated revenue adjustment, retroactive deletion or proactive AI actions.**
- An operator must reconcile the original and corrected provider reports, identify refund/void business dates independently, and manually authorize a later audited correction workflow. No automatic correction writer or clearance endpoint exists.

## Evidence gate
- Migration 52's separately verified-report evidence, bound to \`staged_sha256\`, remains mandatory; owner-entered figures alone fail the SQL promotion test. There is still no implemented independent report importer or operator approval interface. An internal service-role attestation row is **not, by itself, proof** of a genuinely independent real Toast closeout reconciliation.

## Validation and deployment
- \`npm run test\`, \`npx tsc --noEmit\`, \`npm run build\`, \`npm run lint\`, and the isolated Supabase/PostgreSQL GitHub Actions workflow must be checked on the final PR head. Existing unrelated lint failures must be reported, not suppressed.
- Apply migrations in filename order, **40 through 55**, only after the full existing schema in a disposable local Supabase environment. Never rewrite an applied migration or push these SQL migrations to production without explicit owner approval.
- Activation flags must remain false/unset: \`TOAST_SETUP_ENABLED\`, \`TOAST_WEBHOOKS_ENABLED\`, \`TOAST_PILOT_IMPORT_ENABLED\`, \`TOAST_CANONICAL_PROMOTION_ENABLED\`, \`TOAST_JOBS_ENABLED\`, \`TOAST_POLLING_ENABLED\`.
- To begin the first authorized café pilot later, confirm Toast access plan and scopes, collect credentials only through the owner UI, implement audited webhook signing-secret registration, verify a real full business day's closeout and late refunds against an independently obtained Toast report, and separately approve each staging/promotion/deployment phase.


## Immutable promotion comparison baseline (migration 56)
- New table \`toast_promotion_order_baselines\` freezes the exact report-matched normalized order by \`business_id / restaurant_guid / order_guid\` **inside the original manual promotion transaction**. These rows are immutable to the application service role. A conflicting baseline makes promotion fail atomically; an older promoted order without a valid frozen baseline is treated as **review-required**, not assumed identical. Do not retroactively infer equality from a possibly restaged historical snapshot.
- The latest \`toast_store_order_fact\` wrapper continues to use the original monotonic compare-and-set. A **newer completed order with the same substantive financial and line-item projection** does not create a correction even if the provider modification timestamp changed, or the response adds unrelated transport metadata. A completed order with changed net/gross sales, discounts, taxes, tips, refunds, closed date, quantities, modifier identity or lines creates one review record. Reopened, voided, deleted, refunded or ambiguous states are always reviewed. A later older version cannot overwrite the newer staging row or review marker. Existing unresolved flags are sticky: a later identical fetch cannot automatically clear them.
- The original \`toast_promote_reconciled_day\` remains behind the independent report evidence (migration 52), CSV overlap checks, refund-date safeguards, single-location gate, and unresolved correction blockade (migration 55). Migration 56 wraps those constraints rather than weakening them.

## Required financial reporting integration contract — BLOCKING
A service-role-only, tenant-keyed view, \`toast_financial_reporting_status\`, now supplies \`business_id\`, \`restaurant_guid\`, \`location_id\`, \`business_date\`, \`pilot_state\`, \`promoted_at\`, \`pending_corrections\`, \`last_modified_order_poll_at\`, \`verification_status\`, and \`fully_verified_for_owner_reporting\`. A stale day becomes \`verification_status='review_required'\`, retaining historical canonical cents. Even an unchanged promoted day is \`promoted_pending_live_reconciliation\`, **not independently verified**.

**This view is not yet wired into the existing daily-rollup, Supervisor or profit/expense presentation paths.** Before ANY Toast-backed canonical data can be shown as independently verified, all relevant reporting queries must join this view on exact tenant/location/business date and propagate \`review_required\` as a visibly unresolved source-provenance/freshness status. Missing view rows must mean **unknown/unavailable**, never verified-zero or verified-sales. This should be implemented in a separate reviewable reporting-boundary PR after a real authorized Toast closeout review; do not shortcut existing financial formulas or Supervisor UI in stabilization. \`TOAST_CANONICAL_PROMOTION_ENABLED\` and all other Toast activation flags must remain false/unset.

The only defensible current statement is: SQL supplies review provenance and tests prove its state transitions, but **end-to-end financial report labeling is still blocked**. This is not production readiness and no live Toast comparison or independently audited report import has occurred.

## Test coverage added for migration 56
Actual disposable PostgreSQL tests exercise the in-transaction baseline after manual promotion; a first poll rereading the identical completed order; the same completed order with a later modification timestamp; nonfinancial transport metadata; a truly changed completed net-sales amount; refund, void, reopening and deletion after promotion; an older provider version after a newer one; persistence of original canonical cents; and the reporting-view review state. Client SELECT/UPDATE grants and obsolete RPC-execution restrictions are also asserted.
