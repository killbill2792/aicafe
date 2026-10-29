-- Snapshot views must count each Toast capture once. A business date can be captured
-- more than once (a manual diagnostic run and the scheduled daily capture), and the
-- previous definitions summed every capture: one $50 cash entry captured twice read
-- as $100. Keep only the newest successful capture per café, location, date and
-- endpoint. All chunk/page rows of that capture share its capture_id.
-- Additive: replaces four views with identical columns; no data changes.

create or replace view public.toast_raw_samples_latest with (security_invoker=true) as
select s.* from public.toast_raw_samples s
where coalesce(s.capture_id::text,'row:'||s.id::text)=(
 select coalesce(t.capture_id::text,'row:'||t.id::text)
 from public.toast_raw_samples t
 where t.business_id=s.business_id and t.restaurant_guid=s.restaurant_guid
  and t.endpoint=s.endpoint and t.business_date is not distinct from s.business_date
  and t.http_status between 200 and 299 and t.error_code is null
 order by t.fetched_at desc,t.id desc
 limit 1);
revoke all on public.toast_raw_samples_latest from public,anon;
grant select on public.toast_raw_samples_latest to authenticated,service_role;

create or replace view public.cv_inventory
 (business_id,source,source_ref,status,business_date,data,menu_item_ref,stock_status,quantity)
 with (security_invoker=true) as
 select i.business_id,'app'::text,'stock:'||i.id::text,'actual'::text,
 i.count_date,jsonb_build_object('ingredient_id',i.ingredient_id,'count_date',i.count_date,
 'quantity_base',i.quantity_base),null::text,null::text,i.quantity_base::numeric
 from public.pantry_stock_counts i
 union all
 select s.business_id,'toast'::text,'toast-stock:'||s.id::text||':'||x.n::text,
 'actual'::text,(s.fetched_at at time zone b.timezone)::date,
 jsonb_build_object('menu_item_ref',x.item->>'guid','status',x.item->>'status',
 'quantity',x.item->'quantity','captured_at',s.fetched_at,'capture_only',true),
 x.item->>'guid',x.item->>'status',
 case when jsonb_typeof(x.item->'quantity')='number' then (x.item->>'quantity')::numeric
 else null::numeric end
 from public.toast_raw_samples_latest s join public.businesses b on b.id=s.business_id
 cross join lateral jsonb_array_elements(case when jsonb_typeof(s.sample)='array' then s.sample
 when jsonb_typeof(s.sample->'data')='array' then s.sample->'data'
 else '[]'::jsonb end) with ordinality as x(item,n)
 where s.endpoint='stock/v1/inventory' and s.http_status between 200 and 299
 and s.error_code is null and jsonb_typeof(x.item)='object';

create or replace view public.cv_cash
 (business_id,source,source_ref,status,business_date,entry_type,amount_cents,cash_drawer_ref,employee_ref,data)
 with (security_invoker=true) as
 select s.business_id,'toast'::text,'toast-cash:'||s.id::text||':'||x.n::text,
 case when jsonb_typeof(x.item->'amount')='number' then 'actual' else 'open' end::text,
 s.business_date,case when s.endpoint='cashmgmt/v1/deposits' then 'deposit'
 else coalesce(x.item->>'type','cash_entry') end,
 case when jsonb_typeof(x.item->'amount')='number'
 and abs((x.item->>'amount')::numeric)<100000000 then
 round((x.item->>'amount')::numeric*100)::bigint else null::bigint end,
 x.item->'cashDrawer'->>'guid',
 coalesce(x.item->'employee1'->>'guid',x.item->'employee'->>'guid'),
 jsonb_build_object('endpoint',s.endpoint,'event_ref',x.item->>'guid',
 'event_time',x.item->>'date','reversal_ref',x.item->>'undoes',
 'captured_at',s.fetched_at,'capture_only',true)
 from public.toast_raw_samples_latest s
 cross join lateral jsonb_array_elements(case when jsonb_typeof(s.sample)='array' then s.sample
 when jsonb_typeof(s.sample->'data')='array' then s.sample->'data'
 else '[]'::jsonb end) with ordinality as x(item,n)
 where s.endpoint in ('cashmgmt/v1/entries','cashmgmt/v1/deposits')
 and s.http_status between 200 and 299 and s.error_code is null
 and jsonb_typeof(x.item)='object';

create or replace view public.cv_dining_options
 (business_id,source,source_ref,status,business_date,dining_option_ref,dining_option_name,data)
 with (security_invoker=true) as
 select s.business_id,'toast'::text,'toast-option:'||s.id::text||':'||x.n::text,
 'actual'::text,(s.fetched_at at time zone b.timezone)::date,
 x.item->>'guid',public.toast_safe_business_label(x.item->>'name'),
 jsonb_build_object('behavior',x.item->>'behavior','captured_at',s.fetched_at,'capture_only',true)
 from public.toast_raw_samples_latest s join public.businesses b on b.id=s.business_id
 cross join lateral jsonb_array_elements(case when jsonb_typeof(s.sample)='array' then s.sample
 when jsonb_typeof(s.sample->'data')='array' then s.sample->'data'
 else '[]'::jsonb end) with ordinality as x(item,n)
 where s.endpoint='config/v2/diningOptions' and s.http_status between 200 and 299
 and s.error_code is null and jsonb_typeof(x.item)='object';

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
 from public.toast_raw_samples_latest s
 cross join lateral jsonb_array_elements(case when jsonb_typeof(s.sample)='array' then s.sample
 when jsonb_typeof(s.sample->'data')='array' then s.sample->'data'
 else '[]'::jsonb end) with ordinality as x(item,n)
 where s.endpoint in ('kitchen/v1/export/itemFulfillments','kitchen/v1/published/prepStations')
 and s.http_status between 200 and 299 and s.error_code is null
 and jsonb_typeof(x.item)='object';

revoke all on public.cv_inventory,public.cv_cash,public.cv_dining_options,public.cv_kitchen from public,anon;
grant select on public.cv_inventory,public.cv_cash,public.cv_dining_options,public.cv_kitchen to authenticated,service_role;
