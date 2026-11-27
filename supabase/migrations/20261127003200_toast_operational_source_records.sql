set lock_timeout = '5s';
set statement_timeout = '60s';
-- The Toast adapter supplies the identity from its authenticated endpoint. Its
-- bookkeeping is kept apart from provider JSON (including names that collide).
create or replace function public.toast_stage_operational_batch(
 p_business_id uuid,p_restaurant_guid uuid,p_endpoint text,
 p_business_date date,p_objects jsonb
) returns integer language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item jsonb; records jsonb; stream text := coalesce(p_business_date::text,'current'); revision bigint;
begin
 if not exists(select 1 from public.toast_location_mappings
   where business_id=p_business_id and restaurant_guid=p_restaurant_guid and verified_at is not null)
 then raise exception 'Unverified Toast account' using errcode='42501'; end if;
 if jsonb_typeof(p_objects) is distinct from 'array' then raise exception 'Invalid source page'; end if;
 for item in select value from jsonb_array_elements(p_objects) loop
   if jsonb_typeof(item->'payload') is distinct from 'object' or nullif(item->>'provider_key','') is null
     or item->>'business_id' is distinct from p_business_id::text
     or item->>'restaurant_guid' is distinct from p_restaurant_guid::text
     or item->>'endpoint' is distinct from p_endpoint
     or (item->'payload' ? 'restaurantGuid' and lower(item->'payload'->>'restaurantGuid') is distinct from p_restaurant_guid::text)
     or item->>'business_date' is distinct from p_business_date::text then
     raise exception 'Invalid source record scope';
   end if;
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

create or replace function public.toast_current_nonorders_for(
 p_business_id uuid,p_from date,p_to date,p_record_type text)
returns table(
 business_id uuid,restaurant_guid uuid,source text,source_ref text,status text,
 business_date date,record_type text,record_ref text,order_ref text,check_ref text,
 counts_in_sales boolean,data jsonb
)
language sql stable security definer set search_path=public as $current$
 select r.business_id,r.restaurant_guid,
  'toast'::text,'toast-current:'||r.id::text,'open'::text,
  r.business_date,
  coalesce(r.source_context->>'endpoint',nullif(r.payload->>'endpoint',''),r.entity)::text,
  coalesce(r.entity_guid::text,nullif(r.payload->>'guid',''),
   nullif(r.payload->>'employee_guid',''),nullif(r.payload->>'provider_guid','')),
  null::text,null::text,null::boolean,
  public.ai_safe_retained_json((r.payload || coalesce(r.source_context,'{}'::jsonb))-'aiCafeCustomer')
 from public.toast_raw_records r
 where r.entity not in ('order','check','payment','item','modifier',
  'item_discount','check_discount','service_charge')
  and jsonb_typeof(r.payload)='object'
  and (p_record_type is null
   or coalesce(r.source_context->>'endpoint',nullif(r.payload->>'endpoint',''),r.entity)=p_record_type)
  and (r.capture_key not like 'stage:%' or exists (
   select 1 from public.toast_location_mappings m
   where m.business_id=r.business_id and m.restaurant_guid=r.restaurant_guid
    and (m.verified_at is not null or m.info_refreshed_at is not null)))
  and (p_business_id is null or r.business_id=p_business_id)
  and (p_from is null or r.business_date is null or r.business_date>=p_from)
  and (p_to is null or r.business_date is null or r.business_date<=p_to)
  and case when p_business_id is not null
   then (select public.toast_records_allowed(p_business_id))
   else public.toast_records_allowed(r.business_id) end
$current$;
