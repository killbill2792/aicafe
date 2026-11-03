-- Toast archive: remove copies of orders that did not change.
--
-- The database filled up again after migrations 128-129 (Nov 2: one café,
-- 72 days, 9,567 orders stored as 36,373 archive rows, ~31 MB more each day).
-- Two causes, both fixed in the app in the same change:
--  1. Toast returns some lists inside an order (applied taxes, selections) in a
--     different order on every download, so an unchanged order got a new hash
--     and was archived again. The app now sorts every list whose items carry a
--     Toast GUID before staging (lib/pos/toast/stableOrder.ts).
--  2. 48 days stuck with "a payment whose order Toast never returned" were
--     re-pulled once a day, forever. An exhausted recovery is no longer
--     re-queued (lib/pos/toast/reconcile.ts).
--
-- This migration deletes the copies already stored. Two archived versions of
-- the same order are the same version when they are equal after sorting their
-- GUID lists (toast_stable_json, the same rule as the app). Of each set of
-- equal versions it keeps one: the version the day's latest import uses, else
-- the most recently seen. Every real change Toast made to an order is kept.
-- Typed order details of removed copies go with them (on delete cascade).
--
-- It also removes the separate check and payment rows that migration 129
-- stopped writing; nothing reads them (their data is inside each order).
--
-- After applying, return the freed space to Supabase by running, outside a
-- transaction, in the SQL editor:
--   vacuum (full, analyze) public.toast_raw_records;
--   vacuum (full, analyze) public.toast_order_typed_facts;

-- Same rule as stableToastOrder (lib/pos/toast/stableOrder.ts): lists of two
-- or more objects that all have a string "guid" are sorted by guid; nothing
-- else changes.
create or replace function public.toast_stable_json(j jsonb)
returns jsonb language sql immutable parallel safe set search_path=public as $stable$
 select case jsonb_typeof(j)
  when 'object' then coalesce((select jsonb_object_agg(k,public.toast_stable_json(v))
   from jsonb_each(j) e(k,v)),'{}'::jsonb)
  when 'array' then case
   when jsonb_array_length(j)>=2 and not exists(select 1 from jsonb_array_elements(j) x
    where jsonb_typeof(x)<>'object' or jsonb_typeof(x->'guid') is distinct from 'string')
   then (select jsonb_agg(public.toast_stable_json(x) order by x->>'guid' collate "C",n)
    from jsonb_array_elements(j) with ordinality a(x,n))
   else (select coalesce(jsonb_agg(public.toast_stable_json(x) order by n),'[]'::jsonb)
    from jsonb_array_elements(j) with ordinality a(x,n))
  end
  else j end
$stable$;
revoke all on function public.toast_stable_json(jsonb) from public,anon,authenticated;
grant execute on function public.toast_stable_json(jsonb) to service_role;

-- One café-day at a time, so each call stays short. Returns rows removed.
create or replace function public.toast_archive_drop_identical_copies(
 p_business_id uuid,p_business_date date
) returns integer language plpgsql security definer set search_path=public as $drop$
declare n integer;
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only'; end if;
 with versions as (
  select r.id,r.run_id,r.seen_run_id,d.last_import_run_id,
   row_number() over (
    partition by r.restaurant_guid,r.entity_guid,
     md5(public.toast_stable_json(r.payload)::text)
    order by coalesce(r.run_id=d.last_import_run_id or r.seen_run_id=d.last_import_run_id,false) desc,
     r.last_seen desc,r.first_seen desc,r.id desc) as rank
  from public.toast_raw_records r
  left join public.toast_day_status d on d.business_id=r.business_id
   and d.restaurant_guid=r.restaurant_guid and d.business_date=r.business_date
  where r.business_id=p_business_id and r.business_date=p_business_date
   and r.entity='order' and r.entity_guid is not null
 )
 delete from public.toast_raw_records r using versions v
 where r.id=v.id and v.rank>1
  -- Never remove a row the latest import reads.
  and not coalesce(v.run_id=v.last_import_run_id or v.seen_run_id=v.last_import_run_id,false);
 get diagnostics n=row_count;
 return n;
end $drop$;
revoke all on function public.toast_archive_drop_identical_copies(uuid,date) from public,anon,authenticated;
grant execute on function public.toast_archive_drop_identical_copies(uuid,date) to service_role;

-- Clean every café-day that has more than one row for some order.
do $cleanup$
declare d record;
begin
 set local statement_timeout=0;
 for d in
  select business_id,business_date from public.toast_raw_records
  where entity='order' and entity_guid is not null and business_date is not null
  group by business_id,business_date
  having count(*)>count(distinct (restaurant_guid,entity_guid))
  order by business_id,business_date
 loop
  perform public.toast_archive_drop_identical_copies(d.business_id,d.business_date);
 end loop;
end $cleanup$;

-- Separate check/payment rows (written before migration 129; unread).
delete from public.toast_raw_records where entity in ('check','payment');
