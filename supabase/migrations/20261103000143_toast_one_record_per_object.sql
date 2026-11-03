-- Toast archive: one current record per POS object for the staged snapshots too
-- (AGENTS.md §4b, docs/plans/toast-storage.md step 4b).
--
-- Migration 111 copies every insert/update of our Toast tables (time entries, staff,
-- jobs, menu items, prices, voids, refunds…) into toast_raw_records, keyed by the
-- exact text. Our own bookkeeping times (fetched_at, last_seen…) change on every
-- download, so each download added a full new row: the first health check found
-- ~2,200 extra rows. Voids were also keyed by their order, so different voided
-- items of one order looked like versions of one object.
-- Now, like orders in migration 140:
--  * one current record per (café, restaurant, entity, POS ID, business date),
--    enforced by a unique index;
--  * our bookkeeping times are ignored when comparing (still stored, kept current);
--  * a real change updates the record and writes a toast_raw_changes line;
--  * voids are keyed by the voided selection, refunds by the payment;
--  * existing extra rows are collapsed once into change lines.
-- Nothing in the app or the AI reads these snapshot rows (they read orders only).

-- 1. The POS ID of a staged row. Most specific ID first.
create or replace function public.toast_stage_object_id(p_row jsonb)
returns uuid language sql immutable set search_path=public as $id$
 select case when v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v::uuid end
 from (select coalesce(
  nullif(p_row->>'external_time_entry_id',''),
  nullif(p_row->>'employee_guid',''),
  nullif(p_row->>'provider_guid',''),
  nullif(p_row->>'selection_guid',''),
  nullif(p_row->>'payment_guid',''),
  nullif(p_row->>'order_guid',''),
  nullif(p_row->>'job_guid',''),
  nullif(p_row->>'report_request_guid',''),
  nullif(p_row->>'guid','')) v) x
$id$;

-- 2. What counts as a change: every field except our own bookkeeping times.
create or replace function public.toast_stage_comparable(p_row jsonb)
returns jsonb language sql immutable set search_path=public as $cmp$
 select public.toast_stable_json(p_row - array['fetched_at','first_seen','last_seen','checked_at',
  'last_checked_at','report_checked_at','observed_at','updated_at'])
$cmp$;

-- 3. Snapshot writer: same signature and trigger as migration 111.
create or replace function public.toast_archive_stage_snapshot(
 p_row jsonb,p_entity text,p_origin text
) returns void language plpgsql security definer set search_path=public as $archive$
declare v_guid uuid; v_biz uuid; v_rest uuid; v_day date; v_hash text;
 cur public.toast_raw_records%rowtype; diff jsonb;
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only'; end if;
 if nullif(p_row->>'business_id','') is null then return; end if;
 v_biz:=(p_row->>'business_id')::uuid;
 v_rest:=nullif(p_row->>'restaurant_guid','')::uuid;
 v_guid:=public.toast_stage_object_id(p_row);
 v_hash:=encode(sha256(convert_to(p_row::text,'UTF8')),'hex');
 if coalesce(p_row->>'business_date',p_row->>'order_business_date','') ~ '^\d{4}-\d{2}-\d{2}$'
 then v_day:=coalesce(p_row->>'business_date',p_row->>'order_business_date')::date; end if;
 if v_guid is not null then
  select * into cur from public.toast_raw_records r
  where r.business_id=v_biz and r.restaurant_guid is not distinct from v_rest and r.entity=p_entity
   and r.entity_guid=v_guid and r.business_date is not distinct from v_day
  order by r.last_seen desc,r.id desc limit 1 for update;
  if found then
   if cur.payload_sha256=v_hash then return; end if;
   select coalesce(jsonb_agg(jsonb_build_object('path',d.path,'before',d.before,'after',d.after)
     order by d.path),'[]'::jsonb) into diff
   from public.toast_json_diff(public.toast_stage_comparable(cur.payload),
    public.toast_stage_comparable(p_row)) d;
   if jsonb_array_length(diff)>0 then
    insert into public.toast_raw_changes(business_id,restaurant_guid,entity,entity_guid,business_date,changes)
    values(v_biz,v_rest,p_entity,v_guid,v_day,diff);
   end if;
   update public.toast_raw_records set payload=p_row,payload_sha256=v_hash,last_seen=now() where id=cur.id;
   return;
  end if;
 end if;
 insert into public.toast_raw_records(
  business_id,restaurant_guid,entity,entity_guid,business_date,payload,payload_sha256,capture_key)
 values(v_biz,v_rest,p_entity,v_guid,v_day,p_row,v_hash,'stage:'||p_origin||':'||v_hash)
 on conflict do nothing;
end $archive$;
revoke all on function public.toast_archive_stage_snapshot(jsonb,text,text) from public,anon,authenticated;
grant execute on function public.toast_archive_stage_snapshot(jsonb,text,text) to service_role;

-- 4. One-time: re-key staged rows, then keep the newest version of each object and
--    turn older real versions into change lines.
create or replace function public.toast_archive_collapse_snapshots()
returns integer language plpgsql security definer set search_path=public as $collapse$
declare g record; v record; prev jsonb; has_prev boolean; keep uuid; n integer:=0; k integer; diff jsonb;
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only'; end if;
 update public.toast_raw_records r set entity_guid=public.toast_stage_object_id(r.payload)
 where r.capture_key like 'stage:%' and r.entity<>'order'
  and r.entity_guid is distinct from public.toast_stage_object_id(r.payload);
 for g in
  select r.business_id,r.restaurant_guid,r.entity,r.entity_guid,r.business_date
  from public.toast_raw_records r
  where r.capture_key like 'stage:%' and r.entity<>'order' and r.entity_guid is not null
  group by 1,2,3,4,5 having count(*)>1
 loop
  select r.id into keep from public.toast_raw_records r
  where r.business_id=g.business_id and r.restaurant_guid is not distinct from g.restaurant_guid
   and r.entity=g.entity and r.entity_guid=g.entity_guid and r.business_date is not distinct from g.business_date
   and r.capture_key like 'stage:%'
  order by r.first_seen desc,r.last_seen desc,r.id desc limit 1;
  has_prev:=false;
  for v in
   select r.payload,r.first_seen from public.toast_raw_records r
   where r.business_id=g.business_id and r.restaurant_guid is not distinct from g.restaurant_guid
    and r.entity=g.entity and r.entity_guid=g.entity_guid and r.business_date is not distinct from g.business_date
    and r.capture_key like 'stage:%'
   order by r.first_seen,r.id
  loop
   if has_prev then
    select coalesce(jsonb_agg(jsonb_build_object('path',d.path,'before',d.before,'after',d.after)
      order by d.path),'[]'::jsonb) into diff
    from public.toast_json_diff(public.toast_stage_comparable(prev),public.toast_stage_comparable(v.payload)) d;
    if jsonb_array_length(diff)>0 then
     insert into public.toast_raw_changes(business_id,restaurant_guid,entity,entity_guid,business_date,
      changed_at,changes)
     values(g.business_id,g.restaurant_guid,g.entity,g.entity_guid,g.business_date,v.first_seen,diff);
    end if;
   end if;
   prev:=v.payload;has_prev:=true;
  end loop;
  delete from public.toast_raw_records r
  where r.business_id=g.business_id and r.restaurant_guid is not distinct from g.restaurant_guid
   and r.entity=g.entity and r.entity_guid=g.entity_guid and r.business_date is not distinct from g.business_date
   and r.capture_key like 'stage:%' and r.id<>keep;
  get diagnostics k=row_count;
  n:=n+k;
 end loop;
 return n;
end $collapse$;
revoke all on function public.toast_archive_collapse_snapshots() from public,anon,authenticated;
grant execute on function public.toast_archive_collapse_snapshots() to service_role;

do $collapse_all$
begin
 set local statement_timeout=0;
 perform public.toast_archive_collapse_snapshots();
end $collapse_all$;

-- 5. From now on the database refuses a second record for the same staged object.
create unique index if not exists toast_raw_records_one_object
 on public.toast_raw_records(business_id,restaurant_guid,entity,entity_guid,business_date)
 nulls not distinct
 where entity_guid is not null and capture_key like 'stage:%';
