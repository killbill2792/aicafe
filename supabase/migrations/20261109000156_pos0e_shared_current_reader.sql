-- POS0e: additive current-source cutover only; do not apply to production.
-- Preserve the latest migration-152 discount exclusion, day-import and live-order eligibility.
-- Diagnostic source capture remains audit-only and is never a live fallback.
set lock_timeout = '5s';
set statement_timeout = '45s';
create or replace function public.toast_records_for(p_business_id uuid,p_from date,p_to date)
returns table(business_id uuid,source text,source_ref text,status text,business_date date,
 record_type text,record_ref text,order_ref text,check_ref text,counts_in_sales boolean,data jsonb)
language sql stable security definer set search_path=public as $records$
with orders as not materialized (
 select r.business_id,r.business_date,r.id,r.payload o,
  case when d.business_id is null then 'provisional' else 'actual' end st,
  -- Same exclusions as the importer (lib/pos/toast/dayParser.ts): deleted, voided,
  -- excess-food and test-mode orders are kept here but never count in sales.
  (r.payload->'voided') is not distinct from 'true'::jsonb or (r.payload->'deleted') is not distinct from 'true'::jsonb
   or (r.payload->'excessFood') is not distinct from 'true'::jsonb or (r.payload->'createdInTestMode') is not distinct from 'true'::jsonb o_void
 from public.toast_raw_records r
 left join public.toast_day_status d on d.business_id=r.business_id
  and d.restaurant_guid=r.restaurant_guid and d.business_date=r.business_date
  and d.import_state='imported'
 where r.entity='order' and jsonb_typeof(r.payload)='object'
  and (
   -- An imported day: only its latest import's records.
   (d.business_id is not null and (r.run_id=d.last_import_run_id or r.seen_run_id=d.last_import_run_id))
   -- A day not imported yet: the orders the live job saved so far.
   or (d.business_id is null and r.run_id is null and r.seen_run_id is null and r.capture_key like 'live:%'))
  and (p_business_id is null or r.business_id=p_business_id)
  and (p_from is null or r.business_date>=p_from) and (p_to is null or r.business_date<=p_to)
  and case when p_business_id is not null then (select public.toast_records_allowed(p_business_id))
   else public.toast_records_allowed(r.business_id) end),
checks as not materialized (
 select o.*,c.v c,c.n cn,
  o.o_void or (c.v->'voided') is not distinct from 'true'::jsonb or (c.v->'deleted') is not distinct from 'true'::jsonb c_void
 from orders o cross join lateral jsonb_array_elements(case when jsonb_typeof(o.o->'checks')='array'
  then o.o->'checks' else '[]'::jsonb end) with ordinality c(v,n)
 where jsonb_typeof(c.v)='object'),
items as not materialized (
 -- Gift card and house-account items are deferred: the importer leaves them out of sales.
 select k.*,s.v s,s.n sn,k.c_void or (s.v->'voided') is not distinct from 'true'::jsonb or (s.v->'deferred') is not distinct from 'true'::jsonb
  or (s.v->>'selectionType') is not distinct from 'HOUSE_ACCOUNT_PAY_BALANCE' s_void
 from checks k cross join lateral jsonb_array_elements(case when jsonb_typeof(k.c->'selections')='array'
  then k.c->'selections' else '[]'::jsonb end) with ordinality s(v,n)
 where jsonb_typeof(s.v)='object'),
current_nonorders as not materialized (
 -- A single real, current object per provider key, never diagnostic samples.
 select r.business_id,r.restaurant_guid,r.id,r.entity,r.entity_guid,
  r.business_date,r.payload,
  coalesce(nullif(r.payload->>'endpoint',''),r.entity)::text record_type
 from public.toast_raw_records r
 where r.entity not in ('order','check','payment','item','modifier',
  'item_discount','check_discount','service_charge')
  and jsonb_typeof(r.payload)='object'
  -- Stage-table triggers also fire when Test Café copies source data. A staged
  -- object is eligible for an operational answer ONLY when its café+restaurant
  -- mapping was verified by Toast. The mirror resets verified_at to NULL
  -- intentionally: those staged rows are fixtures, never provider authority.
  -- Direct current-object archives and order projections retain their existing
  -- identity/date logic; a disconnected real café retains historical records.
  and (r.capture_key not like 'stage:%' or exists (
   select 1 from public.toast_location_mappings m
   where m.business_id=r.business_id and m.restaurant_guid=r.restaurant_guid
    and m.verified_at is not null))
  and (p_business_id is null or r.business_id=p_business_id)
  and (p_from is null or r.business_date is null or r.business_date>=p_from)
  and (p_to is null or r.business_date is null or r.business_date<=p_to)
  and case when p_business_id is not null then (select public.toast_records_allowed(p_business_id))
   else public.toast_records_allowed(r.business_id) end)
select business_id,'toast'::text,'toast-order:'||id::text,st,business_date,
 'order'::text,o->>'guid',o->>'guid',null::text,not o_void,o-'checks'
from orders
union all
select business_id,'toast','toast-check:'||id::text||':'||cn,st,business_date,
 'check',c->>'guid',o->>'guid',c->>'guid',not c_void,
 c-'selections'-'payments'-'appliedDiscounts'-'appliedServiceCharges'
from checks
union all
select business_id,'toast','toast-item:'||id::text||':'||cn||':'||sn,st,business_date,
 'item',s->>'guid',o->>'guid',c->>'guid',not s_void,s-'modifiers'-'appliedDiscounts'
from items
union all
select i.business_id,'toast','toast-modifier:'||i.id::text||':'||i.cn||':'||i.sn||':'||m.n,i.st,
 i.business_date,'modifier',m.v->>'guid',i.o->>'guid',i.c->>'guid',
 not i.s_void and (m.v->'voided') is distinct from 'true'::jsonb,
 m.v||jsonb_build_object('item_ref',i.s->>'guid')
from items i cross join lateral jsonb_array_elements(case when jsonb_typeof(i.s->'modifiers')='array'
 then i.s->'modifiers' else '[]'::jsonb end) with ordinality m(v,n)
where jsonb_typeof(m.v)='object'
union all
select i.business_id,'toast','toast-item-discount:'||i.id::text||':'||i.cn||':'||i.sn||':'||d.n,i.st,
 i.business_date,'item_discount',d.v->>'guid',i.o->>'guid',i.c->>'guid',not i.s_void
  and (d.v->>'processingState') is distinct from 'VOID',
 d.v||jsonb_build_object('item_ref',i.s->>'guid')
from items i cross join lateral jsonb_array_elements(case when jsonb_typeof(i.s->'appliedDiscounts')='array'
 then i.s->'appliedDiscounts' else '[]'::jsonb end) with ordinality d(v,n)
where jsonb_typeof(d.v)='object'
union all
select k.business_id,'toast','toast-payment:'||k.id::text||':'||k.cn||':'||p.n,k.st,k.business_date,
 'payment',p.v->>'guid',k.o->>'guid',k.c->>'guid',
 not k.c_void and (p.v->'voided') is distinct from 'true'::jsonb
  and coalesce(p.v->>'paymentStatus','') not in ('VOIDED','DENIED','CANCELLED','ERROR','ERROR_NETWORK'),p.v
from checks k cross join lateral jsonb_array_elements(case when jsonb_typeof(k.c->'payments')='array'
 then k.c->'payments' else '[]'::jsonb end) with ordinality p(v,n)
where jsonb_typeof(p.v)='object'
union all
select k.business_id,'toast','toast-check-discount:'||k.id::text||':'||k.cn||':'||d.n,k.st,k.business_date,
 'check_discount',d.v->>'guid',k.o->>'guid',k.c->>'guid',not k.c_void
  and (d.v->>'processingState') is distinct from 'VOID',d.v
from checks k cross join lateral jsonb_array_elements(case when jsonb_typeof(k.c->'appliedDiscounts')='array'
 then k.c->'appliedDiscounts' else '[]'::jsonb end) with ordinality d(v,n)
where jsonb_typeof(d.v)='object'
union all
select k.business_id,'toast','toast-service-charge:'||k.id::text||':'||k.cn||':'||d.n,k.st,k.business_date,
 'service_charge',d.v->>'guid',k.o->>'guid',k.c->>'guid',not k.c_void,d.v
from checks k cross join lateral jsonb_array_elements(case when jsonb_typeof(k.c->'appliedServiceCharges')='array'
 then k.c->'appliedServiceCharges' else '[]'::jsonb end) with ordinality d(v,n)
where jsonb_typeof(d.v)='object'
union all
select r.business_id,'toast'::text,'toast-current:'||r.id::text,
 -- Until source-specific freshness is verified, stored is not the same as final.
 'open'::text,r.business_date,r.record_type,
 coalesce(r.entity_guid::text,nullif(r.payload->>'guid',''),
  nullif(r.payload->>'employee_guid',''),nullif(r.payload->>'provider_guid','')),
 null::text,null::text,null::boolean,r.payload
from current_nonorders r
$records$;

revoke all on function public.toast_records_for(uuid,date,date) from public,anon;
grant execute on function public.toast_records_for(uuid,date,date) to authenticated,service_role;

-- One already-registered canonical path; preserve existing columns and pantry counts.
create or replace view public.cv_inventory
 (business_id,source,source_ref,status,business_date,data,menu_item_ref,stock_status,quantity)
 with (security_invoker=true) as
 select i.business_id,'app'::text,'stock:'||i.id::text,'actual'::text,
  i.count_date,jsonb_build_object('ingredient_id',i.ingredient_id,'count_date',i.count_date,
  'quantity_base',i.quantity_base),null::text,null::text,i.quantity_base::numeric
 from public.pantry_stock_counts i
 union all
 select r.business_id,r.source,r.source_ref,r.status,r.business_date,
  jsonb_build_object('menu_item_ref',r.data->>'guid','status',r.data->>'status',
   'quantity',r.data->'quantity','source_as_of',r.data->>'lastSuccessAt'),
  r.data->>'guid',r.data->>'status',
  case when jsonb_typeof(r.data->'quantity')='number'
   then (r.data->>'quantity')::numeric else null::numeric end
 from public.toast_records_for(null,null,null) r
 where r.record_type='stock/v1/inventory';

create or replace view public.cv_cash
 (business_id,source,source_ref,status,business_date,entry_type,amount_cents,
  cash_drawer_ref,employee_ref,data)
 with (security_invoker=true) as
 select r.business_id,r.source,r.source_ref,r.status,r.business_date,
  case when r.record_type='cashmgmt/v1/deposits' then 'deposit'
   else coalesce(r.data->>'type','cash_entry') end,
  public.toast_json_dollars_to_cents(r.data->'amount'),
  r.data->'cashDrawer'->>'guid',
  coalesce(r.data->'employee1'->>'guid',r.data->'employee'->>'guid'),
  jsonb_build_object('endpoint',r.record_type,'event_ref',r.record_ref,
   'event_time',r.data->>'date','reversal_ref',r.data->>'undoes')
 from public.toast_records_for(null,null,null) r
 where r.record_type in ('cashmgmt/v1/entries','cashmgmt/v1/deposits');

create or replace view public.cv_dining_options
 (business_id,source,source_ref,status,business_date,dining_option_ref,dining_option_name,data)
 with (security_invoker=true) as
 select r.business_id,r.source,r.source_ref,r.status,r.business_date,
  r.data->>'guid',public.toast_safe_business_label(r.data->>'name'),
  jsonb_build_object('behavior',r.data->>'behavior',
   'source_as_of',r.data->>'lastSuccessAt')
 from public.toast_records_for(null,null,null) r
 where r.record_type='config/v2/diningOptions';

create or replace view public.cv_kitchen
 (business_id,source,source_ref,status,business_date,order_ref,ticket_ref,
  fired_at,started_at,ready_at,prep_station_ref,data)
 with (security_invoker=true) as
 select r.business_id,r.source,r.source_ref,r.status,r.business_date,
  r.data->>'orderGuid',r.data->>'ticketGuid',
  r.data->>'ticketFiredAt',r.data->>'itemStartedAt',r.data->>'itemFulfilledAt',
  coalesce(r.data->>'prepStationGuid',r.data->>'guid'),
  jsonb_build_object('endpoint',r.record_type,'selection_ref',r.data->>'selectionGuid',
   'menu_item_ref',r.data->>'selectionMenuItemGuid',
   'prep_station_name',public.toast_safe_business_label(
    coalesce(r.data->>'prepStationName',r.data->>'name')),
   'dining_option_name',public.toast_safe_business_label(r.data->>'diningOptionName'),
   'dining_option_behavior',r.data->>'diningOptionBehavior',
   'order_source',r.data->>'orderSource',
   'fulfillment_level',r.data->'itemFulfillmentLevel')
 from public.toast_records_for(null,null,null) r
 where r.record_type in ('kitchen/v1/export/itemFulfillments','kitchen/v1/published/prepStations');

revoke all on public.cv_inventory,public.cv_cash,public.cv_dining_options,public.cv_kitchen from public,anon;
grant select on public.cv_inventory,public.cv_cash,public.cv_dining_options,public.cv_kitchen
 to authenticated,service_role;

-- Safe named JSON paths, supporting deeper official nested fields.
create or replace function public.ai_query_path(p_col text) returns text[]
language sql immutable set search_path=public as $path$
 select case when p_col ~ '^data(\.([A-Za-z_][A-Za-z0-9_]{0,100}|[0-9]{1,3})){1,16}$'
  then string_to_array(substr(p_col,6),'.') end $path$;
revoke all on function public.ai_query_path(text) from public,anon;
grant execute on function public.ai_query_path(text) to authenticated,service_role;

-- Full current-field discovery: no recent-35-day, newest-30-row or 200-path cap.
-- The handler also supplies official never-observed schema paths without inventing values.
create or replace function public.ai_toast_fields(p_business_id uuid,p_record_type text)
returns jsonb language sql stable security invoker set search_path=public as $fields$
 with recursive walk(path,v,depth) as (
  select 'data'::text,r.data,0
  from public.toast_records_for(p_business_id,null,null) r
  where r.record_type=p_record_type
  union all
  select w.path||'.'||e.key,e.value,w.depth+1 from walk w
   cross join lateral (
    select key,value from jsonb_each(case when jsonb_typeof(w.v)='object'
     then w.v else '{}'::jsonb end)
    union all
    select '0',element.value from jsonb_array_elements(
     case when jsonb_typeof(w.v)='array' then w.v else '[]'::jsonb end
    ) element(value)
   ) e
  where w.depth<16),
 leaves as (
  select path,min(jsonb_typeof(v)) kind
  from walk where path<>'data' and jsonb_typeof(v) not in ('object','array','null')
  group by path)
 select coalesce(jsonb_agg(jsonb_build_object('field',path,'type',kind,
  'source','retained_current') order by path),'[]'::jsonb) from leaves $fields$;
revoke all on function public.ai_toast_fields(uuid,text) from public,anon;
grant execute on function public.ai_toast_fields(uuid,text) to authenticated,service_role;
