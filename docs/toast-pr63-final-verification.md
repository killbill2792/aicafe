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
