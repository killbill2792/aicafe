set lock_timeout = '5s';
set statement_timeout = '60s';

-- Bind accepted app order/selection identities to the committed archive.
-- Native identity mappings, exclusions and unresolved historical lines stay
-- on their existing application records.
-- Keep this a single, fully qualified SELECT so PostgreSQL can inline the
-- lookup and use the archive's café, restaurant, day and order index.
create function public.toast_committed_order_body(p_business uuid,p_pos_order text,p_day date)
returns table(payload jsonb) language sql stable security invoker as $$
 select r.payload
 from public.external_records r
 join public.toast_day_status d on (d.business_id,d.restaurant_guid,d.business_date,d.last_import_run_id)=
  (r.business_id,r.restaurant_guid,r.business_date,r.run_id)
 where p_pos_order like 'toast:%' and r.business_id=p_business and r.provider='toast' and r.entity='order'
  and r.business_date=p_day and r.superseded_by is null and d.import_state='imported'
  and r.restaurant_guid=public.toast_uuid_or_null(pg_catalog.split_part(p_pos_order,':',2))
  and r.entity_guid=public.toast_uuid_or_null(pg_catalog.split_part(p_pos_order,':',3))
  and r.source_account=r.restaurant_guid::text and r.source_key=r.entity_guid::text
  and r.payload->>'guid'=r.entity_guid::text
  and r.payload_origin in ('provider','historical_provider')
 limit 1
$$;
revoke all on function public.toast_committed_order_body(uuid,text,date) from public,anon;
grant execute on function public.toast_committed_order_body(uuid,text,date) to authenticated,service_role;

-- The approved day parser's inclusion rules as a read of retained source.
-- A missing required monetary field cannot certify a replacement total.
create function public.toast_committed_order_net_cents(p_order jsonb)
returns bigint language sql immutable strict parallel safe security invoker set search_path=pg_catalog,public as $$
 with checks as materialized (
  select c.raw,public.toast_json_dollars_to_cents(c.raw->'amount') as amount
  from jsonb_array_elements(case when jsonb_typeof(p_order->'checks')='array'
   then p_order->'checks' else '[]'::jsonb end) c(raw)
  where c.raw->>'deleted' is distinct from 'true' and c.raw->>'voided' is distinct from 'true'
 ), adjustments as (
  select public.toast_json_dollars_to_cents(x.raw->'chargeAmount') as cents
  from checks c cross join lateral jsonb_array_elements(case when jsonb_typeof(c.raw->'appliedServiceCharges')='array'
   then c.raw->'appliedServiceCharges' else '[]'::jsonb end) x(raw)
  where x.raw->>'serviceChargeCategory'='FUNDRAISING_CAMPAIGN'
  union all
  select public.toast_json_dollars_to_cents(x.raw->'price')
  from checks c cross join lateral jsonb_array_elements(case when jsonb_typeof(c.raw->'selections')='array'
   then c.raw->'selections' else '[]'::jsonb end) x(raw)
  where (x.raw->>'deferred'='true' or x.raw->>'selectionType'='HOUSE_ACCOUNT_PAY_BALANCE')
   and x.raw->>'voided' is distinct from 'true'
  union all
  select public.toast_json_dollars_to_cents(x.raw->'refund'->'refundAmount')
  from checks c cross join lateral jsonb_array_elements(case when jsonb_typeof(c.raw->'payments')='array'
   then c.raw->'payments' else '[]'::jsonb end) x(raw)
  where x.raw->>'voided' is distinct from 'true'
   and coalesce(x.raw->>'paymentStatus','') not in ('VOIDED','DENIED','CANCELLED','ERROR','ERROR_NETWORK')
   and jsonb_typeof(x.raw->'refund')='object'
 )
 select case when p_order->>'deleted' is distinct from 'true' and p_order->>'voided' is distinct from 'true'
  and p_order->>'excessFood' is distinct from 'true' and p_order->>'createdInTestMode' is distinct from 'true'
  and not exists(select from checks c where c.amount is null)
  and not exists(select from adjustments a where a.cents is null)
  then (select sum(amount) from checks)-(select coalesce(sum(cents),0) from adjustments) end::bigint
$$;
revoke all on function public.toast_committed_order_net_cents(jsonb) from public,anon;
grant execute on function public.toast_committed_order_net_cents(jsonb) to authenticated,service_role;

create function public.toast_committed_line_values(p_order jsonb,p_selection text)
returns table(quantity numeric,net_sales_cents bigint,display_name text,ordered_at timestamptz)
language sql stable strict security invoker set search_path=pg_catalog,public as $$
 select (case when jsonb_typeof(p.raw->'quantity')='number' then (p.raw->>'quantity')::numeric end),
  public.toast_json_dollars_to_cents(p.raw->'price')-
   case when p.raw->'refundDetails'->'refundAmount' is null or p.raw->'refundDetails'->'refundAmount'='null'::jsonb then 0
    else public.toast_json_dollars_to_cents(p.raw->'refundDetails'->'refundAmount') end,
  nullif(btrim(p.raw->>'displayName'),''),
  case when p.raw->>'createdDate' ~ '(Z|[+-][0-9]{2}:?[0-9]{2})$'
   then public.toast_time_or_null(p.raw->>'createdDate') end
 from (
  select x.raw,count(*) over() as matches
  from jsonb_array_elements(case when jsonb_typeof(p_order->'checks')='array'
   then p_order->'checks' else '[]'::jsonb end) c(raw)
  cross join lateral jsonb_array_elements(case when jsonb_typeof(c.raw->'selections')='array'
   then c.raw->'selections' else '[]'::jsonb end) x(raw)
  where x.raw->>'guid'=p_selection
   and c.raw->>'deleted' is distinct from 'true' and c.raw->>'voided' is distinct from 'true'
   and x.raw->>'voided' is distinct from 'true' and x.raw->>'deferred' is distinct from 'true'
   and x.raw->>'selectionType' is distinct from 'HOUSE_ACCOUNT_PAY_BALANCE'
 ) p
 where p.matches=1
$$;
revoke all on function public.toast_committed_line_values(jsonb,text) from public,anon;
grant execute on function public.toast_committed_line_values(jsonb,text) to authenticated,service_role;

create or replace view public.cv_orders
 (business_id,source,source_ref,status,business_date,order_ref,dining_option,source_channel,guest_count,data,net_sales_cents)
with (security_invoker=true) as
 select o.business_id,case when o.pos_order_id like 'toast:%' then 'toast' else 'app' end::text,
 'order:'||o.id::text,case when o.toast_excluded is true or o.superseded_by is not null then 'needs_match' else 'actual' end::text,
 o.business_date,o.id::text,read.dining_option,read.source_channel,read.guest_count,
 jsonb_build_object('order_ref',o.id,'dining_option',read.dining_option,'source_channel',read.source_channel,
 'guest_count',read.guest_count,'toast_excluded',o.toast_excluded,'superseded',o.superseded_by is not null,
 'recorded_net_sales_cents',read.net_sales_cents,'pos_order_id',o.pos_order_id,
 'processing_fee_provider',o.processing_fee_provider,'evidence',case when value.net_sales_cents is not null then 'committed_order'
  when o.pos_order_id like 'toast:%' then 'historical_projection' else 'app_record' end),
 case when o.toast_excluded is true or o.superseded_by is not null then null::bigint else read.net_sales_cents end,
 o.location_id,o.employee_id,o.closed_at,o.pos_order_id,o.processing_fee_provider
 from public.orders o
 left join lateral public.toast_committed_order_body(o.business_id,o.pos_order_id,o.business_date) p on true
 cross join lateral (select public.toast_committed_order_net_cents(p.payload) as net_sales_cents offset 0) value
 cross join lateral (select coalesce(value.net_sales_cents,o.net_sales_cents) as net_sales_cents,
  case when p.payload is not null then nullif(btrim(p.payload#>>'{diningOption,name}'),'') else o.dining_option end as dining_option,
  case when p.payload is not null then nullif(btrim(p.payload->>'source'),'') else o.source_channel end as source_channel,
  case when p.payload is null then o.guest_count::integer
    when pg_input_is_valid(p.payload->>'numberOfGuests','integer') then (p.payload->>'numberOfGuests')::integer end as guest_count) read;

create or replace view public.cv_item_sales_daily with (security_invoker=true) as
 select o.business_id,'item-day:'||o.business_date::text||':'||l.menu_item_id::text as source_ref,
 'actual'::text as status,o.business_date,l.menu_item_id,
 sum(coalesce(p.quantity,l.quantity)) as quantity,sum(coalesce(p.net_sales_cents,l.net_sales_cents)) as net_sales_cents
 from public.order_lines l join public.orders o on o.id=l.order_id
 left join lateral public.toast_committed_order_body(o.business_id,o.pos_order_id,o.business_date) body on true
 left join lateral public.toast_committed_line_values(body.payload,l.pos_line_id) p on true
 where o.toast_excluded is not true and o.superseded_by is null and l.voided=false and l.menu_item_id is not null
 group by o.business_id,o.business_date,l.menu_item_id;

create or replace view public.cv_item_sales (business_id,source,source_ref,status,business_date,net_sales_cents,quantity,data,order_duration_seconds,item_taxes,modifier_prices) with (security_invoker=true) as
 select o.business_id,
 case when o.pos_order_id like 'toast:%' then 'toast' else 'app' end::text as source,
 'line:'||l.id::text as source_ref,'actual'::text as status,
 o.business_date,coalesce(p.net_sales_cents,l.net_sales_cents),coalesce(p.quantity,l.quantity),
 jsonb_build_object('order_id',o.id,'menu_item_id',l.menu_item_id,
  'pos_item_id',l.pos_item_id,'name',coalesce(p.display_name,l.name),'category',l.category,
  'quantity',coalesce(p.quantity,l.quantity),'net_sales_cents',coalesce(p.net_sales_cents,l.net_sales_cents),
  'modifiers',l.modifiers,'voided',l.voided,
  'evidence',case when p.net_sales_cents is not null then 'committed_order'
    when o.pos_order_id like 'toast:%' then 'historical_projection' else 'app_record' end) as data,
 t.order_duration_seconds,t.item_taxes,t.modifier_prices,
 l.id as order_line_id,l.menu_item_id,
 case when body.payload is null then l.ordered_at else p.ordered_at end as ordered_at,
 case when body.payload is null then o.closed_at
  when body.payload->>'closedDate' ~ '(Z|[+-][0-9]{2}:?[0-9]{2})$'
   then public.toast_time_or_null(body.payload->>'closedDate') end as closed_at
 from public.order_lines l join public.orders o on o.id=l.order_id
 left join lateral public.toast_committed_order_body(o.business_id,o.pos_order_id,o.business_date) body on true
 left join lateral public.toast_committed_line_values(body.payload,l.pos_line_id) p on true
 left join public.toast_current_typed_order_facts_v t
  on t.business_id=o.business_id and t.business_date=o.business_date
  and t.order_guid::text=regexp_replace(o.pos_order_id,'^toast:[^:]+:','')
  and t.restaurant_guid::text=split_part(o.pos_order_id,':',2)
 where o.toast_excluded is not true and o.superseded_by is null and l.voided=false
 union all
 select m.business_id,'toast'::text,'modified-order:'||m.restaurant_guid::text||':'||m.order_guid::text,
  'needs_match'::text,(m.last_checked_at at time zone b.timezone)::date,
  null::bigint,null::numeric,
  jsonb_build_object('kind','modified_order','order_guid',m.order_guid,
   'reviewed_at',m.last_checked_at,'staging_state',m.state),
  null::bigint,null::jsonb,null::jsonb,null::uuid,null::uuid,null::timestamptz,null::timestamptz
 from public.toast_modified_orders_staging m
 join public.businesses b on b.id=m.business_id
 where m.state='review_required';
