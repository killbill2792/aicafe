-- "Days that need a look" should list only real problems: a failed or
-- incomplete import, a money mismatch, unreadable orders, an owner flag, or a
-- lasting error (permissions, reconnect). It listed every day whose last
-- check hit ANY error, including temporary ones (Toast rate limit, Toast
-- unavailable, a timeout) and the normal case of a payment that belongs to an
-- order from another day. Those now stay "checking" and retry on their own.
create or replace view public.toast_owner_attention_days_v with(security_invoker=true) as
 select business_id,restaurant_guid,business_date from public.toast_day_status
 where owner_confirmed_at is null and
 (import_state='failed' or recon_state in ('mismatch','coverage_invalid')
  -- Missing source rows need an owner's attention, but are not a money mismatch.
  or unparsed_count>0
  or (last_error_category is not null and last_error_category not in
   ('analytics_timeout','closeout_changed','rate_limited','unavailable','timeout',
    'unverified_payment_order')))
 union
 select f.business_id,f.restaurant_guid,f.business_date
 from public.toast_day_owner_flags f
 left join public.toast_day_status s
 on s.business_id=f.business_id and s.restaurant_guid=f.restaurant_guid
 and s.business_date=f.business_date
 where f.cleared_at is null and s.owner_confirmed_at is null
 union
 select e.business_id,e.restaurant_guid,e.business_date
 from public.toast_owner_summary_entries e
 left join public.toast_day_status s
 on s.business_id=e.business_id and s.restaurant_guid=e.restaurant_guid
 and s.business_date=e.business_date
 where e.comparison='owner_summary_mismatch' and s.owner_confirmed_at is null;

-- One-time cleanup. Older check code recorded "changed_snapshot" (Toast's data
-- serialized differently on a later read) as a reason; current code treats a
-- changed snapshot as provenance only, but the old reason was never cleared.
update public.toast_day_status set
 warnings=warnings-'changed_snapshot',
 internal_reasons=coalesce((select jsonb_agg(r) from jsonb_array_elements(internal_reasons) r
  where r<>to_jsonb('changed_snapshot'::text)),'[]'::jsonb)
where warnings ? 'changed_snapshot' or internal_reasons ? 'changed_snapshot';

-- Internal mismatches whose remaining reasons are only "paid on another day"
-- (or none) were never money problems: check them again from scratch.
update public.toast_day_status set
 recon_state='pending',recon_source=null,internal_state=null,last_recon_attempt_at=null
where recon_state='mismatch' and recon_source='internal' and internal_state='mismatch'
 and not exists(select 1 from jsonb_array_elements_text(internal_reasons) r
  where r<>'unknown_payment_order');
