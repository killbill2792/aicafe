# Toast staged pilot import — dependent PR 4

This stage is deliberately not yet a canonical import. Read-only one-day OrdersBulk uses Toast businessDate creation-day semantics, exhaustively fetches returned pages through the adapter, stores only sanitized normalized operating facts in service-role-only staging, and records a SHA256 snapshot and per-location order-fetch freshness. It will NOT update orders, order_lines, daily_rollups or payroll. It does not assert authoritative zero sales from a modified-order scan.

Pilot HTTP endpoint POST/PUT /api/pos/toast/pilot is owner-only and disabled unless TOAST_PILOT_IMPORT_ENABLED=true (default OFF).
POST stages one explicit location and one Toast business date. PUT compares recorded summary with owner-entered Toast report gross, net, discounts, refunds, tax, order count and product quantity; reconciliation mismatch is marked needs_review. Match is labeled **matched_owner_report**, not independent verification or permission for canonical write.

Wages, actual shifts, webhook processing, canonical import, CSV overlapping, scheduled shift persistence, connection freshness display, multi-day scheduling and automation are NOT complete. No production migration has been applied. To activate staging in an authorized pilot: first validate complete official response schemas, review prior Supabase migrations then apply ONLY 44 after 40–43 in staging, enable flag temporarily, test with tenant-specific authorized credentials, reconcile Toast report, and turn flag off.

Do not mark $0 sales actual or call recomputeDailyRollup from this code.

## Labor/schedule extension in the same draft PR
Migration 45 adds service-only staging of Toast time entries with nullable wages; the read-only manual `POST /api/pos/toast/pilot/labor` supports attendance or schedules separately in bounded, <=30-day intervals. Verified scheduled shifts are stored in `pos_scheduled_shifts` (migration 42). No existing actual paid timecard or payroll formula is touched. The additional code is documented in `docs/toast-labor-staging.md`. This is not yet a continuously scheduled sync or reconciled canonical payroll feed.

## Pilot promotion restriction
Migration 48 adds a transactional service-role wrapper around migration 46. Until refund-date reconciliation and whole-business coverage are proven, only a previously matched, fresh, positive-sales **single-location**, refund-free, historical day may be promoted manually. Multi-location or refund-affected days must remain staged for review. This is a conservative pilot guard, NOT a claim of general completeness.
