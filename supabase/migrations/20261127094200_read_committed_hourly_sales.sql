-- Reason: Keep the scoped view replacement and its temporary role grant atomic.
-- squawk-ignore transaction-nesting
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Fetch the original bodies as one indexed café/day set. Both sales readers
-- can establish coverage from the same completed restaurant import receipt.
create or replace function public.toast_committed_sales_orders(p_business uuid,p_day date)
returns table(pos_order_id text,restaurant_guid uuid,payload jsonb)
language sql stable security invoker as $$
 select 'toast:'||r.restaurant_guid::text||':'||r.entity_guid::text,r.restaurant_guid,r.payload
 from public.toast_day_status c
 join public.external_records r on (r.business_id,r.restaurant_guid,r.business_date,r.run_id)=
  (c.business_id,c.restaurant_guid,c.business_date,c.last_import_run_id)
 where c.business_id=p_business and c.business_date=p_day
  and c.import_state='imported' and c.coverage_complete and c.unparsed_count=0
  and r.provider='toast' and r.entity='order' and r.superseded_by is null
  and r.source_account=r.restaurant_guid::text and r.source_key=r.entity_guid::text
  and r.payload->>'guid'=r.entity_guid::text
  and r.payload_origin in ('provider','historical_provider')
$$;
revoke all on function public.toast_committed_sales_orders(uuid,date) from public,anon;
grant execute on function public.toast_committed_sales_orders(uuid,date) to authenticated,service_role;

-- Reconcile an entire business day before replacing the saved hourly view.
-- A missing order, an incomplete restaurant receipt or an ambiguous close
-- leaves the saved history in charge for the whole day.
create or replace function public.sales_hours_for_day(p_business uuid,p_day date)
returns table(source text,source_ref text,status text,business_date date,
 net_sales_cents bigint,orders_count integer,data jsonb)
language plpgsql stable security invoker set search_path=pg_catalog,public
set jit=off as $$
begin
 return query
 with complete_day as materialized (
  select d.business_id,d.business_date,b.timezone,d.orders_count,d.net_sales_cents
  from public.daily_rollups d join public.businesses b on b.id=d.business_id
  where d.business_id=p_business and d.business_date=p_day
    and d.sales_data_status='actual' and d.orders_count>0
    and exists(select from public.toast_day_status c where c.business_id=d.business_id and c.business_date=d.business_date)
 ), originals as materialized (
  select r.pos_order_id,r.payload from public.toast_committed_sales_orders(p_business,p_day) r
 ), orders as materialized (
  select o.location_id,o.closed_at,o.net_sales_cents as accepted_amount,
   case when r.payload->>'closedDate' ~ '(Z|[+-][0-9]{2}:?[0-9]{2})$'
    then public.toast_time_or_null(r.payload->>'closedDate') end as source_close,
   public.toast_committed_order_net_cents(r.payload) as amount
  from complete_day d join public.orders o using(business_id,business_date)
  left join originals r on r.pos_order_id=o.pos_order_id
  where o.toast_excluded is not true and o.superseded_by is null and o.pos_order_id not like 'csv-%'
 ), audited as (
  select d.* from complete_day d
  join (select count(*) as order_count,sum(o.amount) as cents,
    bool_and(o.amount is not null and o.amount=o.accepted_amount
       and o.source_close is not null and o.source_close=o.closed_at) as complete
   from orders o) a on a.complete and a.order_count=d.orders_count and a.cents=d.net_sales_cents
 ), hours as (
  select d.business_date,o.location_id,extract(hour from o.source_close at time zone d.timezone)::smallint as hour_local,
   sum(o.amount)::bigint as cents,count(*)::integer as n
  from audited d cross join orders o group by 1,2,3
 )
 select 'toast'::text,'hour:'||h.business_date::text||':'||h.hour_local::text||':'||coalesce(h.location_id::text,'all'),
  'actual'::text,h.business_date,h.cents,h.n,
  jsonb_build_object('hour_local',h.hour_local,'location_id',h.location_id,
    'net_sales_cents',h.cents,'orders_count',h.n,'evidence','committed_orders') from hours h;
 if found then return; end if;

 return query
 select 'app'::text,'hour:'||h.business_date::text||':'||h.hour_local::text||':'||coalesce(h.location_id::text,'all'),
  'actual'::text,h.business_date,h.net_sales_cents,h.orders_count,
  jsonb_build_object('hour_local',h.hour_local,'location_id',h.location_id,
    'net_sales_cents',h.net_sales_cents,'orders_count',h.orders_count,'evidence','saved_hourly_rollup')
 from public.hourly_sales_rollup h where h.business_id=p_business and h.business_date=p_day;
 if found then return; end if;

 return query
 select 'toast'::text,'live-hour:'||t.business_date::text||':'||(hour.value->>'hourLocal'),
  'provisional'::text,t.business_date,(hour.value->>'netSalesCents')::bigint,(hour.value->>'ordersCount')::integer,
  jsonb_build_object('hour_local',(hour.value->>'hourLocal')::integer,'location_id',null,
   'net_sales_cents',(hour.value->>'netSalesCents')::bigint,'orders_count',(hour.value->>'ordersCount')::integer,
   'source_as_of',t.read_at,'hourly_unassigned_orders',t.reading->'hourlyUnassignedOrders',
   'locations_failed',t.reading->'locationsFailed','truncated',t.reading->'truncated','unparsed_orders',t.reading->'unparsedOrders')
 from public.toast_today_live t cross join lateral jsonb_array_elements(
  case when jsonb_typeof(t.reading->'hourlySales')='array' then t.reading->'hourlySales' else '[]'::jsonb end) hour(value)
 where t.business_id=p_business and t.business_date=p_day
  and hour.value->>'hourLocal' ~ '^([0-9]|1[0-9]|2[0-3])$'
  and hour.value->>'netSalesCents' ~ '^-?[0-9]{1,15}$'
  and hour.value->>'ordersCount' ~ '^[0-9]{1,10}$'
  and pg_input_is_valid(hour.value->>'ordersCount','integer');
end $$;
revoke all on function public.sales_hours_for_day(uuid,date) from public,anon;
grant execute on function public.sales_hours_for_day(uuid,date) to authenticated,service_role;

create or replace view public.cv_sales_hours with (security_invoker=true) as
 select d.business_id,h.source,h.source_ref,h.status,d.business_date,h.net_sales_cents,h.orders_count,h.data
 from (
   select r.business_id,r.business_date from public.daily_rollups r where r.sales_data_status='actual'
   union select r.business_id,r.business_date from public.hourly_sales_rollup r
   union select r.business_id,r.business_date from public.toast_today_live r
 ) d cross join lateral public.sales_hours_for_day(d.business_id,d.business_date) h;

-- Keep native research's existing relation and fields. Resolve the café from
-- its signed scope inside the private wrapper, with no caller-supplied café.
create or replace function u3_research_private.committed_sales_hours(p_day date)
returns table(business_date date,location_id uuid,hour_local smallint,net_sales_cents bigint,orders_count integer)
language sql stable security definer set search_path='' as $$
 select h.business_date,(h.data->>'location_id')::uuid,(h.data->>'hour_local')::smallint,h.net_sales_cents,h.orders_count
 from u3_research_private.scope() s
 cross join lateral public.sales_hours_for_day(s.business_id,p_day) h
 where h.status='actual'
$$;
revoke all on function u3_research_private.committed_sales_hours(date) from public,anon,authenticated,aicafe_research;
-- The view checks EXECUTE as its caller. Research has no private schema USAGE.
grant execute on function u3_research_private.committed_sales_hours(date)
 to aicafe_research_view_owner,aicafe_research;

-- Only these API roles can already execute the owner predicate. Signed
-- research uses its existing café-scoped SELECT policy.
alter policy "owners read" on public.hourly_sales_rollup to authenticated,service_role;
alter policy "owners write" on public.hourly_sales_rollup to authenticated,service_role;

grant aicafe_research_view_owner to postgres with set true;
set local role aicafe_research_view_owner;
create or replace view u3_research.hourly_sales_rollup with (security_barrier=true) as
 select d.business_date,h.location_id,h.hour_local,h.net_sales_cents,h.orders_count
 from (
  select r.business_date from public.hourly_sales_rollup r
  union select r.business_date from public.daily_rollups r where r.sales_data_status='actual'
 ) d cross join lateral u3_research_private.committed_sales_hours(d.business_date) h;
reset role;
revoke aicafe_research_view_owner from postgres;
-- Reason: Complete the role-scoped replacement together.
-- squawk-ignore transaction-nesting
commit;
