-- Consume the scoped, completed ERA report once. Capture the provider response
-- and the request receipt together; the six financial figures need no writer.
create function public.toast_commit_analytics_report(
 p_business_id uuid,p_restaurant uuid,p_date date,p_request uuid,p_payload jsonb
) returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare capture text; current_revision bigint; account text:=p_restaurant::text; day text:=p_date::text;
begin
 if lower(p_payload->>'restaurantGuid') is distinct from account or
    p_payload->>'businessDate' is distinct from to_char(p_date,'YYYYMMDD') or p_request is null then
   raise exception 'Analytics report scope mismatch';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_business_id,account,day,'ERA')::text,0));
 -- Adopt a previously captured report in place. All other historical captures
 -- keep their IDs. Prefer the request referenced by the previously published metrics.
 select r.capture_key into capture from public.toast_raw_records r
 where r.business_id=p_business_id and r.restaurant_guid=p_restaurant and r.business_date=p_date
   and r.entity='analytics_report'
 order by (r.source_account is not null) desc,exists(
   select 1 from public.toast_analytics_results a where a.business_id=p_business_id and
   a.restaurant_guid=p_restaurant and a.business_date=p_date and a.report='metrics/day' and
   a.value_json->>'requestGuid'=r.entity_guid::text) desc,r.first_seen desc,r.id limit 1;
 select revision into current_revision from public.external_sync_checkpoints where
   business_id=p_business_id and provider='toast' and source_account=account and resource='analytics_report' and stream=day;
 perform public.external_commit_page(p_business_id,'toast',account,'analytics_report',day,
   coalesce(current_revision,0),null,true,jsonb_build_array(jsonb_build_object('key',day,'payload',p_payload,
   'archive_key',capture,'context',jsonb_build_object('request_guid',p_request),
   'restaurant_guid',p_restaurant,'business_date',p_date,'entity_guid',p_request)));
end $$;
revoke all on function public.toast_commit_analytics_report(uuid,uuid,date,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.toast_commit_analytics_report(uuid,uuid,date,uuid,jsonb) to service_role;

create or replace view public.cv_analytics (business_id,source,source_ref,status,business_date,value_numeric,data)
with (security_invoker=true) as
with current_reports as (
 select r.business_id,r.restaurant_guid,r.business_date,r.payload,r.source_context,r.last_seen
 from public.external_records r where r.provider='toast' and r.entity='analytics_report'
  and r.source_account is not null and r.source_key=r.business_date::text
), metrics as (
 select r.business_id,r.restaurant_guid,r.business_date,'metrics/day' as report,v.metric,
   v.amount as value_numeric,jsonb_build_object('value',v.amount,'unit',v.unit,
   'requestGuid',r.source_context->>'request_guid') as value_json,r.last_seen as fetched_at
 from current_reports r cross join lateral (values
 ('net_sales_cents',round((r.payload->>'netSalesAmount')::numeric*100),'cents'),
 ('orders_count',(r.payload->>'ordersCount')::numeric,'count'),
 ('discount_cents',round((r.payload->>'discountAmount')::numeric*100),'cents'),
 ('refund_cents',round((r.payload->>'refundAmount')::numeric*100),'cents'),
 ('void_orders_count',(r.payload->>'voidOrdersCount')::numeric,'count'),
 ('void_orders_amount_cents',round((r.payload->>'voidOrdersAmount')::numeric*100),'cents')
 ) v(metric,amount,unit)
 union all
 -- Preserve measurements whose original report has not yet been reobserved.
 select a.business_id,a.restaurant_guid,a.business_date,a.report,a.metric,a.value_numeric,a.value_json,a.fetched_at
 from public.toast_analytics_results a where a.report<>'metrics/day' or not exists(
  select from current_reports r where (r.business_id,r.restaurant_guid,r.business_date)=
    (a.business_id,a.restaurant_guid,a.business_date))
)
select business_id,'toast'::text,'analytics:'||restaurant_guid::text||':'||report||':'||metric||':'||business_date::text,
 'actual'::text,business_date,value_numeric,jsonb_build_object('report',report,'metric',metric,
 'value_numeric',value_numeric,'value_json',value_json,'fetched_at',fetched_at)
from metrics;
