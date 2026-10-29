-- Labor backfill kept only a forward cursor (next_at). When the owner later extended
-- sales history to earlier dates, the cursor was already past them, so that earlier
-- attendance was never read (Codex P1). covered_from records the start of the range
-- already read; earlier history is filled backwards from it so coverage stays one
-- contiguous range [covered_from, next_at). Additive and nullable: a null value means
-- the range started at the earliest imported day when the row was written.
alter table public.toast_labor_backfill_progress
 add column if not exists covered_from timestamptz;
