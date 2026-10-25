# Toast operations (PR 1 groundwork)

In Toast Web: **Integrations → Toast API access → Manage credentials**. Standard API requires \`orders:read\` and \`restaurants:read\`. Menus and labor are optional; Analytics is a separate RMS Pro credential. Keep \`TOAST_AUTO_IMPORT_ENABLED\` and every legacy polling/promotion flag OFF while PR 1 is unverified.

Apply migration \`20261024000093_toast_day_import.sql\` only after migration-history checks and SQL integration testing. No production migration is performed by this PR. If a controlled day import is authorized, create a \`toast_sync_runs\` row for its verified business/location, then invoke \`importToastBusinessDay\` with the same run ID. Monitor \`toast_day_status\`, \`toast_unparsed_orders\`, and \`toast_order_revisions\`.

**Do not enable autonomous imports yet.** PR 2 adds cron, complete re-pull, reconciliation, and the void-coverage certification criteria; PR 3 adds owner-facing health and the first-import nonblocking check. A rate-limited page checkpoints the cursor and resumes at the identical page. Imported facts are retained on rollback; switching flags OFF stops new imports but does not erase facts.

No API tokens, full payloads, or secrets should appear in logs. Unparsed records hold a redacted payload checksum and schema error paths only.


## PR 2 automation runbook — manual owner rollout (NOT ACTIVATED BY THE PR)

**Pre-flight:** Merge PR 2 only after the full Vitest + lint + TypeScript + fresh disposable Supabase CI checks are green. Confirm migration 093 has been applied and is healthy. In the Supabase SQL editor, the **owner** manually applies the single new file `supabase/migrations/20261025000094_toast_automation.sql` once, then checks `toast_sync_runs`, `toast_day_status` and `toast_rollup_refresh_jobs`. PR B's migration 092 is independent. No production migration is run by GitHub or this PR.

**Vercel Pro production configuration, one redeploy per gate:**

1. Set `TOKEN_ENCRYPTION_KEY` (base64 of exactly 32 random bytes), `CRON_SECRET`, `TOAST_ALLOWED_API_HOSTS=ws-api.toasttab.com`, and `TOAST_DEFAULT_API_ORIGIN=https://ws-api.toasttab.com` (replace the API host with the HTTPS hostname Toast issued). Do not share credentials in chat, logs or version control.
2. Owner enables `TOAST_SETUP_ENABLED=true`, enters the **Standard API** client ID/secret in Connect Toast and uses Test Connection; verify `orders:read` and `restaurants:read`. `menus:read`/`labor:read` are optional.
3. After the SQL migration, fresh-DB tests, and owner approval, enable `TOAST_AUTO_IMPORT_ENABLED=true`. Vercel's `GET /api/cron/toast-sync` runs every ten minutes and requires the configured `CRON_SECRET`. The first approved location automatically queues an 84-business-day backfill. Owner may also request a bounded, earlier history backfill through the owner-authorized endpoint (e.g. Sep 5–Oct 23 2026).
4. Observe `toast_sync_health_v` and `toast_day_status`: verify that the oldest requested backfill advances to `days_done=days_total`, `last_good_sync_at` stays within 24 hours, `stale=false` after a fresh good run, and each mismatch/missing day is explained. A `time_zone_mismatch` warning means the Toast closeout time zone and the café's reporting zone disagree; investigate before certifying hourly comparisons.
5. If RMS Pro Analytics credentials are available, configure them separately via the owner-protected Analytics endpoint. The Standard API secret cannot authenticate ERA. ERA reports may be pending (202); allow retries, and investigate `analytics_timeout` at 48 hours. Without ERA, internal snapshot/payment/check reconciliations remain explicitly identified as `checked_internal`, not externally confirmed.
6. Only if optional source facts are proven and employee links are explicitly approved, consider `TOAST_LABOR_CANONICAL_ENABLED=true` in a separate owner-authorized rollout. Source-only time-entry and menu staging does not alter canonical wages or recipes.

**Leave OFF unless a separate reviewed rollout explicitly authorizes:** `TOAST_PILOT_IMPORT_ENABLED`, `TOAST_CANONICAL_PROMOTION_ENABLED`, `TOAST_POLLING_ENABLED`, `TOAST_DISPATCH_ENABLED`, `TOAST_JOBS_ENABLED`, `TOAST_WEBHOOKS_ENABLED`, and unused `TOAST_JOB_SECRET`.

**Rollback:** Set `TOAST_AUTO_IMPORT_ENABLED=false` and redeploy. Cron returns `503 {disabled:true}` before opening the DB. Imported orders and their audit facts remain; never delete canonical history as part of rollback. Do not enable legacy polling to compensate. If a costly post-commit recompute fails, inspect `toast_rollup_refresh_jobs` and retry its derivative independently; **never** replay a committed day merely to refresh costs.

**Operating guards:** A 429 stores the exact day/page cursor and `resume_at`. Transient 5xx/timeouts use backoff. `invalid_response` flags only that day while later backfill dates continue. Permanent auth/scope/location errors fail the run. Leases are nonce-specific and released in `finally`; 240s is the tick work deadline, 290s the lease. Missing/unknown sales and void facts are not treated as zero; void certification requires complete location, refund, reconciliation and modified-window proof.
