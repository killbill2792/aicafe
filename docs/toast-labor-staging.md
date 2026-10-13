# Toast labor and provider schedule staging

Adds a separate read-only pilot endpoint POST /api/pos/toast/pilot/labor, disabled unless TOAST_PILOT_IMPORT_ENABLED is true. The request is owner-only, one verified business/location, one <=30-day interval, and either attendance or schedules.

- Actual time entries are staged in \`toast_labor_entries\` with nullable hourly wage and \`wage_status=missing\`, never a fabricated $0. Active shifts retain null clock-out. Missed breaks are excluded.
- Toast scheduled shifts upsert into the distinct canonical provider schedule store \`pos_scheduled_shifts\` created by migration 42. They do not alter owner recurring schedules, materialized provisional timecards, or payroll.
- Stable external GUIDs and tenant-specific composite unique keys prevent duplicate entries. Explicit Toast deleted flag is preserved; absence from an API range never triggers mass deletion.
- Each successful read records per-location fetch freshness, without asserting that any paid labor amounts were financially reconciled.

Migration 45 is additive and service-role only. Nothing automatically polls or calls these endpoints. Existing \`timecards\`, payroll math and Supervisor are untouched. A later, carefully designed reconciliation step is still needed before connecting staged time entries to actual canonical timecards, particularly when manual timecards or multiple shifts overlap.
