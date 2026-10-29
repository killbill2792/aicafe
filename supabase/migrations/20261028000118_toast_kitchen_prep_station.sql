-- Migration 118: Toast's prep-station configuration objects use guid/name,
-- unlike itemFulfillment records (prepStationGuid/prepStationName).
-- Restore both shapes without exposing raw JSON or unsafe merchant labels.
create or replace view public.cv_kitchen
 (business_id,source,source_ref,status,business_date,order_ref,ticket_ref,
 fired_at,started_at,ready_at,prep_station_ref,data) with (security_invoker=true) as
 select s.business_id,'toast'::text,'toast-kitchen:'||s.id::text||':'||x.n::text,
 'actual'::text,s.business_date,x.item->>'orderGuid',x.item->>'ticketGuid',
 x.item->>'ticketFiredAt',x.item->>'itemStartedAt',x.item->>'itemFulfilledAt',
 coalesce(x.item->>'prepStationGuid',x.item->>'guid'),
 jsonb_build_object('endpoint',s.endpoint,'selection_ref',x.item->>'selectionGuid',
 'menu_item_ref',x.item->>'selectionMenuItemGuid','prep_station_name',public.toast_safe_business_label(
  coalesce(x.item->>'prepStationName',x.item->>'name')),
 'dining_option_name',public.toast_safe_business_label(x.item->>'diningOptionName'),
 'dining_option_behavior',x.item->>'diningOptionBehavior',
 'order_source',x.item->>'orderSource',
 'fulfillment_level',x.item->'itemFulfillmentLevel',
 'captured_at',s.fetched_at,'capture_only',true)
 from public.toast_raw_samples s
 cross join lateral jsonb_array_elements(case when jsonb_typeof(s.sample)='array' then s.sample
 when jsonb_typeof(s.sample->'data')='array' then s.sample->'data'
 else '[]'::jsonb end) with ordinality as x(item,n)
 where s.endpoint in ('kitchen/v1/export/itemFulfillments','kitchen/v1/published/prepStations')
 and s.http_status between 200 and 299 and s.error_code is null
 and jsonb_typeof(x.item)='object';

revoke all on public.cv_kitchen from public,anon;
grant select on public.cv_kitchen to authenticated,service_role;
