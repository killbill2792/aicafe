-- Historical ERA measurements may predate raw capture. Preserve their exact
-- values and provenance before retiring the duplicate results relation.
begin;
set local lock_timeout = '5s';
lock table public.toast_analytics_results in access exclusive mode;

with saved as (
  select a.*,
    jsonb_build_array(a.report,a.metric,a.business_date)::text as source_key,
    jsonb_build_object('report',a.report,'metric',a.metric,'value_numeric',a.value_numeric,
      'value_json',a.value_json,'fetched_at',a.fetched_at) as body
  from public.toast_analytics_results a
)
insert into public.external_records
  (business_id,provider,source_account,entity,source_key,restaurant_guid,business_date,
   payload,payload_sha256,capture_key,first_seen,last_seen,payload_origin)
select business_id,'toast',restaurant_guid::text,'historical_analytics_metric',source_key,
  restaurant_guid,business_date,body,encode(sha256(convert_to(body::text,'UTF8')),'hex'),
  'historical-analytics:'||encode(sha256(convert_to(jsonb_build_array(restaurant_guid,source_key)::text,'UTF8')),'hex'),
  fetched_at,fetched_at,'historical_projection'
from saved;

do $$
begin
  if exists (
    select from public.toast_analytics_results a
    where not exists(select from public.external_records r
      where (r.business_id,r.provider,r.source_account,r.entity,r.source_key)=
        (a.business_id,'toast',a.restaurant_guid::text,'historical_analytics_metric',
         jsonb_build_array(a.report,a.metric,a.business_date)::text)
      and r.payload=jsonb_build_object('report',a.report,'metric',a.metric,'value_numeric',a.value_numeric,
         'value_json',a.value_json,'fetched_at',a.fetched_at))
  ) then raise exception 'Historical analytics parity failed'; end if;
end $$;

create or replace function public.toast_commit_analytics_report(
 p_business_id uuid,p_restaurant uuid,p_date date,p_request uuid,p_payload jsonb
) returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare capture text; current_revision bigint; account text:=p_restaurant::text; day text:=p_date::text;
begin
 if lower(p_payload->>'restaurantGuid') is distinct from account or
    p_payload->>'businessDate' is distinct from to_char(p_date,'YYYYMMDD') or p_request is null then
   raise exception 'Analytics report scope mismatch';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_business_id,account,day,'ERA')::text,0));
 -- Prefer the already adopted report. Earlier standalone captures remain historical.
 select r.capture_key into capture from public.toast_raw_records r
 where r.business_id=p_business_id and r.restaurant_guid=p_restaurant and r.business_date=p_date
   and r.entity='analytics_report'
 order by (r.payload_origin='provider' and r.source_key=day and r.source_account=account) desc nulls last,
  (r.entity_guid=p_request) desc nulls last,r.last_seen desc,r.id limit 1;
 select revision into current_revision from public.external_sync_checkpoints where
   business_id=p_business_id and provider='toast' and source_account=account and resource='analytics_report' and stream=day;
 perform public.external_commit_page(p_business_id,'toast',account,'analytics_report',day,
   coalesce(current_revision,0),null,true,jsonb_build_array(jsonb_build_object('key',day,'payload',p_payload,
   'archive_key',capture,'context',jsonb_build_object('request_guid',p_request),
   'restaurant_guid',p_restaurant,'business_date',p_date,'entity_guid',p_request)));
end $$;

drop view public.cv_analytics;
drop table public.toast_analytics_results;
commit;
