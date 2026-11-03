-- Found by the real-messiness test (plan step 5): every import deletes and re-inserts a
-- day's refund facts, and toast_refund_facts has an auto-numbered id. Migration 143
-- compared snapshots on every field except our bookkeeping times, so each re-import
-- gave the same refund a new id and logged a false change line.
-- Our own row number is bookkeeping too: ignore it when comparing. (It is still stored.)
-- No other staged table has an id column. Production has no refund facts yet.
create or replace function public.toast_stage_comparable(p_row jsonb)
returns jsonb language sql immutable set search_path=public as $cmp$
 select public.toast_stable_json(p_row - array['id','fetched_at','first_seen','last_seen','checked_at',
  'last_checked_at','report_checked_at','observed_at','updated_at'])
$cmp$;
