-- POS0c: eligible operational Standard GETs reuse the EXISTING stage -> raw current/change writer.
set lock_timeout = '5s';
set statement_timeout = '45s';

alter table public.toast_optional_sync_state
 add column if not exists operational_sources jsonb not null default '{}'::jsonb;
alter table public.toast_optional_sync_state
 add constraint toast_operational_sources_object
 check (jsonb_typeof(operational_sources)='object') not valid;

create or replace function public.toast_stage_object_key(p_origin text,p_row jsonb)
returns text language sql immutable set search_path=public as $key$
 select case when bool_and(nullif(p_row->>c,'') is not null)
  then string_agg(p_row->>c,'|' order by o) end
 from unnest(case p_origin
  when 'toast_labor_entries' then array['restaurant_guid','external_time_entry_id']
  when 'toast_employee_directory' then array['restaurant_guid','employee_guid']
  when 'toast_job_directory' then array['restaurant_guid','job_guid']
  when 'toast_catalog_facts' then array['restaurant_guid','kind','provider_guid']
  when 'toast_catalog_price_versions' then array['restaurant_guid','kind','provider_guid','price_fingerprint']
  when 'toast_payment_day_events' then array['restaurant_guid','payment_guid','kind','event_business_date']
  when 'toast_modified_orders_staging' then array['restaurant_guid','order_guid']
  when 'toast_pilot_days' then array['restaurant_guid','business_date']
  when 'toast_void_facts' then array['selection_guid']
  when 'toast_refund_facts' then array['restaurant_guid','order_guid','payment_guid']
  when 'toast_analytics_jobs' then array['restaurant_guid','business_date']
  when 'toast_operational_current' then array['restaurant_guid','endpoint','provider_key']
 end) with ordinality as k(c,o)
 having count(*)>0
$key$;

create or replace function public.toast_stage_object_id(p_row jsonb)
returns uuid language sql immutable set search_path=public as $id$
 select case when v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then v::uuid end
 from (select coalesce(
  nullif(p_row->>'external_time_entry_id',''),
  nullif(p_row->>'employee_guid',''),
  nullif(p_row->>'provider_guid',''),
  nullif(p_row->>'selection_guid',''),
  nullif(p_row->>'payment_guid',''),
  nullif(p_row->>'order_guid',''),
  nullif(p_row->>'job_guid',''),
  nullif(p_row->>'guid',''),
  nullif(p_row->>'operational_object_uuid','')) v) x
$id$;

create or replace function public.toast_stage_comparable(p_row jsonb)
returns jsonb language sql immutable set search_path=public as $cmp$
 select public.toast_stable_json(
  (case when p_row->>'source_key_kind' in
    ('provider_guid','provider_composite','restaurant_singleton')
    and p_row ? 'endpoint'
    then p_row-'lastSuccessAt' else p_row end)
  - (case when p_row->>'source_business_date_kind'='observed_cafe_day'
    then array['business_date']::text[] else array[]::text[] end)
  - array['id','fetched_at','first_seen','last_seen','checked_at',
    'last_checked_at','report_checked_at','observed_at','updated_at'])
$cmp$;

-- Reject incomplete operational refreshes instead of replacing last-good payload or
-- advancing lastSuccessAt. Explicit JSON null is a reported value, not an omitted key.
create or replace function public.toast_operational_has_missing_keys(p_old jsonb,p_new jsonb)
returns boolean language plpgsql immutable set search_path=public as $missing$
declare field_name text; prior_value jsonb;
begin
 if jsonb_typeof(p_old) is distinct from 'object' then return false; end if;
 if jsonb_typeof(p_new) is distinct from 'object' then return true; end if;
 for field_name,prior_value in select key,value from jsonb_each(p_old) loop
  if not (p_new ? field_name) then return true; end if;
  if jsonb_typeof(prior_value)='object' and jsonb_typeof(p_new->field_name)='object'
   and public.toast_operational_has_missing_keys(prior_value,p_new->field_name)
  then return true; end if;
 end loop;
 return false;
end $missing$;
revoke all on function public.toast_operational_has_missing_keys(jsonb,jsonb)
 from public,anon,authenticated;
grant execute on function public.toast_operational_has_missing_keys(jsonb,jsonb)
 to service_role;

create or replace function public.toast_stage_operational_batch(
 p_business_id uuid,p_restaurant_guid uuid,p_endpoint text,
 p_business_date date,p_objects jsonb
) returns integer language plpgsql security definer set search_path=public as $ops$
declare row_value jsonb; prior_payload jsonb; n integer:=0;
begin
 if auth.role()<>'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only' using errcode='42501'; end if;
 if not exists(select 1 from public.toast_location_mappings m
  where m.business_id=p_business_id and m.restaurant_guid=p_restaurant_guid
  and m.verified_at is not null)
 then raise exception 'unverified operational Toast location' using errcode='42501'; end if;
 if p_endpoint not in ('cashmgmt/v1/entries','cashmgmt/v1/deposits',
   'stock/v1/inventory','kitchen/v1/export/itemFulfillments',
   'kitchen/v1/published/prepStations',
   'restaurant-availability/v1/availability',
   'ordermgmt-config/v1/published/orderingSchedule')
 then raise exception 'unsupported operational endpoint' using errcode='22023'; end if;
 if jsonb_typeof(p_objects) is distinct from 'array'
  or jsonb_array_length(p_objects)>5000
 then raise exception 'invalid operational batch' using errcode='22023'; end if;
 for row_value in select value from jsonb_array_elements(p_objects) loop
  if jsonb_typeof(row_value) is distinct from 'object'
   or nullif(row_value->>'provider_key','') is null
   or row_value->>'business_id' is distinct from p_business_id::text
   or row_value->>'restaurant_guid' is distinct from p_restaurant_guid::text
   or row_value->>'endpoint' is distinct from p_endpoint
   or (p_business_date is not null
     and row_value->>'business_date' is distinct from p_business_date::text)
  then raise exception 'wrong identity for operational object' using errcode='22023'; end if;
  -- A partial GET cannot erase already verified fields or refresh their as-of.
  -- The existing writer is unchanged; reject the whole partial batch first.
  select r.payload into prior_payload from public.toast_raw_records r
  where r.business_id=p_business_id
    and r.capture_key='stage:toast_operational_current:key:'||
      public.toast_stage_object_key('toast_operational_current',row_value)
  for update;
  if found and public.toast_operational_has_missing_keys(
    prior_payload-array['business_date','source_business_date_kind',
      'fetched_at','lastSuccessAt','checked_at','last_checked_at'],row_value)
  then raise exception 'partial operational object omitted verified source fields'
    using errcode='22023'; end if;
  perform public.toast_archive_stage_snapshot(row_value,p_endpoint,'toast_operational_current');
  update public.toast_raw_records r set business_date=p_business_date
  where r.business_id=p_business_id
    and r.capture_key='stage:toast_operational_current:key:'||
      public.toast_stage_object_key('toast_operational_current',row_value)
    and r.business_date is distinct from p_business_date;
  n:=n+1;
 end loop;
 return n;
end $ops$;
revoke all on function public.toast_stage_operational_batch(uuid,uuid,text,date,jsonb)
 from public,anon,authenticated;
grant execute on function public.toast_stage_operational_batch(uuid,uuid,text,date,jsonb)
 to service_role;
