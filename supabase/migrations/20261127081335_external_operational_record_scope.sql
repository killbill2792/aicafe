-- Check response completeness at the Toast connector boundary before committing
-- the original payload and its separate observation metadata to the shared archive.
set lock_timeout = '5s';
set statement_timeout = '45s';
create or replace function public.toast_stage_operational_batch(
 p_business_id uuid,p_restaurant_guid uuid,p_endpoint text,
 p_business_date date,p_objects jsonb
) returns integer language plpgsql security invoker set search_path=pg_catalog,public as $$
declare
 item jsonb;
 records jsonb;
 prior record;
 stream text := coalesce(p_business_date::text,'current');
 revision bigint;
begin
 if not exists(select 1 from public.toast_location_mappings
   where business_id=p_business_id and restaurant_guid=p_restaurant_guid and verified_at is not null)
 then raise exception 'Unverified Toast account' using errcode='42501'; end if;
 if p_endpoint is null or p_endpoint not in ('cashmgmt/v1/entries','cashmgmt/v1/deposits',
   'stock/v1/inventory','kitchen/v1/export/itemFulfillments','kitchen/v1/published/prepStations',
   'restaurant-availability/v1/availability','ordermgmt-config/v1/published/orderingSchedule')
   or jsonb_typeof(p_objects) is distinct from 'array' or jsonb_array_length(p_objects)>5000
 then raise exception 'Invalid operational source page' using errcode='22023'; end if;
 -- Multiple date windows and a webhook may observe the same current object.
 perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
   'toast-operational',p_business_id,p_restaurant_guid,p_endpoint)::text,0));
 for item in select value from jsonb_array_elements(p_objects) loop
   if jsonb_typeof(item->'payload') is distinct from 'object' or nullif(item->>'provider_key','') is null
     or item->>'business_id' is distinct from p_business_id::text
     or item->>'restaurant_guid' is distinct from p_restaurant_guid::text
     or item->>'endpoint' is distinct from p_endpoint
     or (item->'payload' ? 'restaurantGuid' and lower(item->'payload'->>'restaurantGuid') is distinct from p_restaurant_guid::text)
     or (p_business_date is not null and item->>'business_date' is distinct from p_business_date::text)
   then raise exception 'Invalid source record scope' using errcode='22023'; end if;
   select r.payload,r.source_context into prior from public.external_records r
   where r.business_id=p_business_id and r.provider='toast'
     and r.capture_key='stage:toast_operational_current:key:'||
       public.toast_stage_object_key('toast_operational_current',item);
   if found and public.toast_operational_has_missing_keys(
     case when prior.source_context is not null then prior.payload else prior.payload-array[
       'business_id','restaurant_guid','endpoint','provider_key','source_key_kind',
       'operational_object_uuid','business_date','source_business_date_kind',
       'fetched_at','lastSuccessAt','checked_at','last_checked_at'] end,
     item->'payload')
   then raise exception 'Incomplete operational source record' using errcode='22023'; end if;
 end loop;
 select coalesce(jsonb_agg(jsonb_build_object(
    'key',v->>'provider_key','payload',v->'payload','context',v-'payload',
    'archive_key','stage:toast_operational_current:key:'||public.toast_stage_object_key('toast_operational_current',v),
    'restaurant_guid',p_restaurant_guid,'business_date',p_business_date,
    'entity_guid',coalesce(v->'payload'->>'guid',v->>'operational_object_uuid'))),'[]'::jsonb) into records
 from jsonb_array_elements(p_objects) v;
 select c.revision into revision from public.external_sync_checkpoints c where
   business_id=p_business_id and provider='toast' and source_account=p_restaurant_guid::text
   and resource=p_endpoint and c.stream=coalesce(p_business_date::text,'current');
 perform public.external_commit_page(p_business_id,'toast',p_restaurant_guid::text,p_endpoint,stream,
   coalesce(revision,0),null,true,records);
 return jsonb_array_length(p_objects);
end $$;
