-- #564 inventory 57014 root fix. The pre-existing cv_inventory view invoked
-- toast_records_for(NULL,NULL,NULL) before filtering to stock, expanding and
-- scrubbing unrelated order/check/item history across all cafés. It can time
-- out even for COUNT(*). Do not change the authority, scopes, money, status,
-- retention history, output columns, row caps or credentials.
-- This makes the original operational current nonorder projection reusable
-- and applies source family selection before expensive JSON sanitization.
-- Other toast_records_for consumers still use one canonical source/permission
-- implementation. No additional writer, importer, store, scheduler or ledger.
-- #564 one operational current-object projection, not a new data authority.
-- Shared by the existing Toast reader, inventory view and field discovery.
-- Never read diagnostic samples. Preserve per-café policy, staged-source
-- verification, all currently retained fields and secret-safe JSON shape.
set lock_timeout='5s';
set statement_timeout='45s';

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
  coalesce(nullif(r.payload->>'endpoint',''),r.entity)::text,
  coalesce(r.entity_guid::text,nullif(r.payload->>'guid',''),
   nullif(r.payload->>'employee_guid',''),nullif(r.payload->>'provider_guid','')),
  null::text,null::text,null::boolean,
  public.ai_safe_retained_json(r.payload-'aiCafeCustomer')
 from public.toast_raw_records r
 where r.entity not in ('order','check','payment','item','modifier',
  'item_discount','check_discount','service_charge')
  and jsonb_typeof(r.payload)='object'
  and (p_record_type is null
   or coalesce(nullif(r.payload->>'endpoint',''),r.entity)=p_record_type)
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
revoke all on function public.toast_current_nonorders_for(uuid,date,date,text)
 from public,anon;
grant execute on function public.toast_current_nonorders_for(uuid,date,date,text)
 to authenticated,service_role;

-- Exact existing order/check/item logic is unchanged; the current nonorder
-- union arm now reads the shared operational projection above.
create or replace function public.toast_records_for(p_business_id uuid,p_from date,p_to date)
returns table(business_id uuid,source text,source_ref text,status text,business_date date,
 record_type text,record_ref text,order_ref text,check_ref text,counts_in_sales boolean,data jsonb)
language sql stable security definer set search_path=public as $records$
with orders as not materialized (
 select r.business_id,r.restaurant_guid,r.business_date,r.id,r.payload o,b.timezone cafe_timezone,
  case when d.business_id is null then 'provisional' else 'actual' end st,
  -- Same exclusions as the importer (lib/pos/toast/dayParser.ts): deleted, voided,
  -- excess-food and test-mode orders are kept here but never count in sales.
  (r.payload->'voided') is not distinct from 'true'::jsonb or (r.payload->'deleted') is not distinct from 'true'::jsonb
   or (r.payload->'excessFood') is not distinct from 'true'::jsonb or (r.payload->'createdInTestMode') is not distinct from 'true'::jsonb o_void
 from public.toast_raw_records r
 join public.businesses b on b.id=r.business_id
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
  o.o_void or (c.v->'voided') is not distinct from 'true'::jsonb or (c.v->'deleted') is not distinct from 'true'::jsonb c_void,
  public.ai_customer_check_evidence(o.business_id,o.restaurant_guid,o.o->>'guid',c.v,
   not (o.o_void or (c.v->'voided') is not distinct from 'true'::jsonb or (c.v->'deleted') is not distinct from 'true'::jsonb))||public.ai_customer_order_context(o.o,o.cafe_timezone,o.business_date) customer_evidence
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
 select * from public.toast_current_nonorders_for(p_business_id,p_from,p_to,null)
)
select raw.business_id,raw.source,raw.source_ref,raw.status,raw.business_date,raw.record_type,raw.record_ref,raw.order_ref,raw.check_ref,raw.counts_in_sales,
 public.ai_safe_retained_json(raw.data) as data
from (
select business_id,'toast'::text,'toast-order:'||id::text,st,business_date,
 'order'::text,o->>'guid',o->>'guid',null::text,not o_void,o-'checks'-'aiCafeCustomer'
from orders
union all
select business_id,'toast','toast-check:'||id::text||':'||cn,st,business_date,
 'check',c->>'guid',o->>'guid',c->>'guid',not c_void,
 (c-'selections'-'payments'-'appliedDiscounts'-'appliedServiceCharges'-'aiCafeCustomer')||jsonb_build_object('aiCafeCustomer',customer_evidence)
from checks
union all
select business_id,'toast','toast-item:'||id::text||':'||cn||':'||sn,st,business_date,
 'item',s->>'guid',o->>'guid',c->>'guid',not s_void,(s-'modifiers'-'appliedDiscounts'-'aiCafeCustomer')||jsonb_build_object('aiCafeCustomer',public.ai_customer_child_evidence(customer_evidence))
from items
union all
select i.business_id,'toast','toast-modifier:'||i.id::text||':'||i.cn||':'||i.sn||':'||m.n,i.st,
 i.business_date,'modifier',m.v->>'guid',i.o->>'guid',i.c->>'guid',
 not i.s_void and (m.v->'voided') is distinct from 'true'::jsonb,
 (m.v-'aiCafeCustomer')||jsonb_build_object('item_ref',i.s->>'guid','aiCafeCustomer',public.ai_customer_child_evidence(i.customer_evidence))
from items i cross join lateral jsonb_array_elements(case when jsonb_typeof(i.s->'modifiers')='array'
 then i.s->'modifiers' else '[]'::jsonb end) with ordinality m(v,n)
where jsonb_typeof(m.v)='object'
union all
select i.business_id,'toast','toast-item-discount:'||i.id::text||':'||i.cn||':'||i.sn||':'||d.n,i.st,
 i.business_date,'item_discount',d.v->>'guid',i.o->>'guid',i.c->>'guid',not i.s_void
  and (d.v->>'processingState') is distinct from 'VOID',
 (d.v-'aiCafeCustomer')||jsonb_build_object('item_ref',i.s->>'guid','aiCafeCustomer',public.ai_customer_child_evidence(i.customer_evidence))
from items i cross join lateral jsonb_array_elements(case when jsonb_typeof(i.s->'appliedDiscounts')='array'
 then i.s->'appliedDiscounts' else '[]'::jsonb end) with ordinality d(v,n)
where jsonb_typeof(d.v)='object'
union all
select k.business_id,'toast','toast-payment:'||k.id::text||':'||k.cn||':'||p.n,k.st,k.business_date,
 'payment',p.v->>'guid',k.o->>'guid',k.c->>'guid',
 not k.c_void and (p.v->'voided') is distinct from 'true'::jsonb
  and coalesce(p.v->>'paymentStatus','') not in ('VOIDED','DENIED','CANCELLED','ERROR','ERROR_NETWORK'),public.ai_customer_safe_payment(p.v)||jsonb_build_object('aiCafeCustomer',public.ai_customer_child_evidence(k.customer_evidence))
from checks k cross join lateral jsonb_array_elements(case when jsonb_typeof(k.c->'payments')='array'
 then k.c->'payments' else '[]'::jsonb end) with ordinality p(v,n)
where jsonb_typeof(p.v)='object'
union all
select k.business_id,'toast','toast-check-discount:'||k.id::text||':'||k.cn||':'||d.n,k.st,k.business_date,
 'check_discount',d.v->>'guid',k.o->>'guid',k.c->>'guid',not k.c_void
  and (d.v->>'processingState') is distinct from 'VOID',(d.v-'aiCafeCustomer')||jsonb_build_object('aiCafeCustomer',public.ai_customer_child_evidence(k.customer_evidence))
from checks k cross join lateral jsonb_array_elements(case when jsonb_typeof(k.c->'appliedDiscounts')='array'
 then k.c->'appliedDiscounts' else '[]'::jsonb end) with ordinality d(v,n)
where jsonb_typeof(d.v)='object'
union all
select k.business_id,'toast','toast-service-charge:'||k.id::text||':'||k.cn||':'||d.n,k.st,k.business_date,
 'service_charge',d.v->>'guid',k.o->>'guid',k.c->>'guid',not k.c_void,(d.v-'aiCafeCustomer')||jsonb_build_object('aiCafeCustomer',public.ai_customer_child_evidence(k.customer_evidence))
from checks k cross join lateral jsonb_array_elements(case when jsonb_typeof(k.c->'appliedServiceCharges')='array'
 then k.c->'appliedServiceCharges' else '[]'::jsonb end) with ordinality d(v,n)
where jsonb_typeof(d.v)='object'
union all
select r.business_id,r.source,r.source_ref,r.status,r.business_date,
 r.record_type,r.record_ref,r.order_ref,r.check_ref,r.counts_in_sales,r.data
from current_nonorders r
) raw(business_id,source,source_ref,status,business_date,record_type,record_ref,order_ref,check_ref,counts_in_sales,data)
$records$;
revoke all on function public.toast_records_for(uuid,date,date)
 from public,anon;
grant execute on function public.toast_records_for(uuid,date,date)
 to authenticated,service_role;

-- Existing canonical inventory view: retain pantry and stock receipt logic,
-- but push stock-only filtering *inside* the shared current-object reader.
create or replace view public.cv_inventory
 (business_id,source,source_ref,status,business_date,data,menu_item_ref,stock_status,quantity)
 with (security_invoker=true) as
 select i.business_id,'app'::text,'stock:'||i.id::text,'actual'::text,
  i.count_date,jsonb_build_object('ingredient_id',i.ingredient_id,
   'ingredient_name',ingredient.name,'base_unit',ingredient.base_unit,
   'count_date',i.count_date,'quantity_base',i.quantity_base,
   'evidence_state','dated_owner_count'),null::text,null::text,
  i.quantity_base::numeric
 from public.pantry_stock_counts i
 left join public.ingredients ingredient on
  ingredient.id=i.ingredient_id and ingredient.business_id=i.business_id
 union all
 select r.business_id,r.source,r.source_ref,r.status,
  case when receipt.restaurant_guid is not null
   then (now() at time zone b.timezone)::date
   else r.business_date end,
  jsonb_build_object('menu_item_ref',r.data->>'guid',
   'reported_stock_status',r.data->>'status',
   'quantity',case when e.evidence_state='observed_current' then r.data->'quantity' end,
   'source_as_of',r.data->>'lastSuccessAt',
   'observed_business_date',r.business_date,
   'checked_at',receipt.checked_at,
   'source_status',receipt.source_status,
   'observed_count',receipt.observed_count,
   'evidence_state',e.evidence_state),
  r.data->>'guid',
  -- Preserve the pre-existing SQL projection for legacy rows that have no
  -- recorded family check. They are NOT verified current stock: evidence_state
  -- stays source_unverified and all owner-facing tools must null the value.
  -- A known failed or newer successful receipt always hides historical stock.
  case when e.evidence_state='observed_current' or receipt.restaurant_guid is null
   then r.data->>'status' end,
  case when (e.evidence_state='observed_current' or receipt.restaurant_guid is null)
    and jsonb_typeof(r.data->'quantity')='number'
    and (r.data->>'quantity')::numeric>=0
   then (r.data->>'quantity')::numeric else null::numeric end
 from public.toast_current_nonorders_for(null,null,null,'stock/v1/inventory') r
 join public.businesses b on b.id=r.business_id
 left join lateral public.toast_stock_source_receipts(r.business_id) receipt
  on receipt.restaurant_guid::text=r.data->>'restaurant_guid'
 cross join lateral (select case
  when receipt.restaurant_guid is null or receipt.successful_at is null
   then 'source_unverified'
  when receipt.source_status not in ('current','empty') then 'source_failed'
  -- An empty family receipt is authoritative absence even if a fast retry
  -- reused the same millisecond timestamp as the retained object.
  when receipt.source_status='empty' then 'not_observed'
  -- Malformed/legacy count metadata cannot certify a full family observation.
  when coalesce(receipt.observed_count,0)<1 then 'source_unverified'
  when r.data->>'lastSuccessAt'=receipt.successful_at then 'observed_current'
  else 'not_observed' end::text as evidence_state) e
 where r.record_type='stock/v1/inventory';
revoke all on public.cv_inventory from public,anon;
grant select on public.cv_inventory to authenticated,service_role;

-- Exact full-history discovery for current config/stock/cash/etc now avoids
-- rebuilding all order/check/selection records. Order-derived field discovery
-- continues through the unchanged canonical Toast reader. No arbitrary
-- historical cutoff, depth change, null-as-zero or secret-path relaxation.
create or replace function public.ai_toast_fields(p_business_id uuid,p_record_type text)
returns jsonb language sql stable security invoker set search_path=public as $fields$
 with recursive walk(path,v,depth) as (
  select 'data'::text,r.data,0
  from (
   -- Push provider-family eligibility before JSON recursion. The shared
   -- safe operational projection is the SAME one used by toast_records_for.
   select x.data from public.toast_current_nonorders_for(
    p_business_id,null,null,p_record_type) x
    where p_record_type not in
     ('order','check','item','modifier','item_discount','payment','check_discount','service_charge')
   union all
   select x.data from public.toast_records_for(p_business_id,null,null) x
    where p_record_type in
     ('order','check','item','modifier','item_discount','payment','check_discount','service_charge')
     and x.record_type=p_record_type
  ) r
  union all
  select w.path||'.'||e.key,e.value,w.depth+1 from walk w
   cross join lateral (
    select key,value from jsonb_each(case when jsonb_typeof(w.v)='object'
     then w.v else '{}'::jsonb end)
    union all
    -- A discovered index must match ai_query_view's literal data #> traversal.
     -- Named-path grammar supports indices 0 through 999.
     select (element.n-1)::text,element.value from jsonb_array_elements(
      case when jsonb_typeof(w.v)='array' then w.v else '[]'::jsonb end
     ) with ordinality as element(value,n) where element.n<=1000
   ) e
  where w.depth<16
 ),
 leaves as (
  select path,min(jsonb_typeof(v)) kind
  from walk where path<>'data'
   and jsonb_typeof(v) not in ('object','array','null')
   and public.ai_query_path(path) is not null
  group by path
 )
 select coalesce(jsonb_agg(jsonb_build_object('field',path,'type',kind,
  'source','retained_current') order by path),'[]'::jsonb)
 from leaves $fields$;
revoke all on function public.ai_toast_fields(uuid,text)
 from public,anon;
grant execute on function public.ai_toast_fields(uuid,text)
 to authenticated,service_role;
