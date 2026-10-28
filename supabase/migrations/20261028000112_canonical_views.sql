-- Prompt D: owner-readable canonical projections. SECURITY INVOKER means each
-- query is checked against the authenticated café member's underlying RLS.
-- Raw Toast JSON is deliberately NOT exposed by these views.
create or replace view public.cv_sales_days with (security_invoker=true) as
 select d.business_id,'app'::text as source,
   'rollup:'||d.business_date::text as source_ref,
   'actual'::text as status,d.business_date,
   d.net_sales_cents,
   (to_jsonb(d)->>'orders_count')::integer as orders_count,
   jsonb_build_object(
    'net_sales_cents',d.net_sales_cents,'orders_count',to_jsonb(d)->'orders_count',
    'drinks_count',to_jsonb(d)->'drinks_count',
    'staff_wages_cents',to_jsonb(d)->'staff_wages_cents',
    'staff_tax_cents',to_jsonb(d)->'staff_tax_cents',
    'card_fees_cents',to_jsonb(d)->'card_fees_cents',
    'sales_data_status',to_jsonb(d)->'sales_data_status') as data
 from public.daily_rollups d;

create or replace view public.cv_sales_hours with (security_invoker=true) as
 select h.business_id,'app'::text as source,
 'hour:'||h.business_date::text||':'||h.hour_local::text||':'||coalesce(h.location_id::text,'all') as source_ref,
 'actual'::text as status,h.business_date,h.net_sales_cents,
 h.orders_count,jsonb_build_object('hour_local',h.hour_local,
 'location_id',h.location_id,'net_sales_cents',h.net_sales_cents,'orders_count',h.orders_count) as data
 from public.hourly_sales_rollup h;

create or replace view public.cv_item_sales with (security_invoker=true) as
 select o.business_id,
 case when o.pos_order_id like 'toast:%' then 'toast' else 'app' end::text as source,
 'line:'||l.id::text as source_ref,'actual'::text as status,
 o.business_date,l.net_sales_cents,l.quantity as quantity,
 jsonb_build_object('order_id',o.id,'menu_item_id',l.menu_item_id,
  'pos_item_id',l.pos_item_id,'name',l.name,'category',l.category,
  'quantity',l.quantity,'net_sales_cents',l.net_sales_cents,
  'modifiers',l.modifiers,'voided',l.voided) as data
 from public.order_lines l join public.orders o on o.id=l.order_id
 where o.toast_excluded is not true and o.superseded_by is null;

create or replace view public.cv_payments with (security_invoker=true) as
 select p.business_id,'toast'::text as source,
 'payment:'||p.restaurant_guid::text||':'||p.payment_ref as source_ref,
 p.status,p.business_date,p.amount_cents,p.tip_cents,
 jsonb_build_object('type',p.payment_type,'amount_cents',p.amount_cents,
  'tip_cents',p.tip_cents,'payment_status',p.payment_status) as data
 from public.toast_payment_summaries p;

create or replace view public.cv_discounts with (security_invoker=true) as
 select o.business_id,case when o.pos_order_id like 'toast:%' then 'toast' else 'app' end::text as source,
 'order:'||o.id::text as source_ref,'actual'::text as status,
 o.business_date,o.discounts_cents as amount_cents,
 jsonb_build_object('amount_cents',o.discounts_cents,'order_id',o.id) as data
 from public.orders o
 where coalesce(o.discounts_cents,0)<>0 and o.toast_excluded is not true
 and o.superseded_by is null;

create or replace view public.cv_voids_refunds with (security_invoker=true) as
 select v.business_id,'toast'::text as source,
 'void:'||v.selection_guid::text as source_ref,
 case when v.amount_cents is null then 'open' else 'actual' end::text as status,
 v.void_business_date as business_date,v.amount_cents,
 jsonb_build_object('kind','void','level',v.level,'amount_cents',v.amount_cents,
   'amount_basis',v.amount_basis,'order_guid',v.order_guid,'void_reason_guid',v.void_reason_guid) as data
 from public.toast_void_facts v
 union all
 select f.business_id,'toast'::text,'refund:'||f.id::text,'actual'::text,
 coalesce(f.refund_business_date,f.order_business_date),f.amount_cents,
 jsonb_build_object('kind','refund','amount_cents',f.amount_cents,
   'order_guid',f.order_guid,'payment_guid',f.payment_guid)
 from public.toast_refund_facts f;

create or replace view public.cv_card_fees with (security_invoker=true) as
 select o.business_id,case when o.pos_order_id like 'toast:%' then 'toast' else 'app' end::text as source,
 'order:'||o.id::text as source_ref,
 case when o.processing_fee_status='missing' then 'open'
      when o.processing_fee_status='estimated' then 'estimated'
      else 'actual' end::text as status,
 o.business_date,
 case when o.processing_fee_status='missing' then null::bigint else o.processing_fee_cents end as amount_cents,
 jsonb_build_object('amount_cents',case when o.processing_fee_status='missing' then null else o.processing_fee_cents end,
  'provider',o.processing_fee_provider,'fee_status',o.processing_fee_status) as data
 from public.orders o where o.toast_excluded is not true and o.superseded_by is null;

create or replace view public.cv_labor_entries with (security_invoker=true) as
 select t.business_id,
 case when coalesce(to_jsonb(t)->>'pos_time_entry_id','') like 'toast:%'
   then 'toast' else 'app' end::text as source,
 'timecard:'||t.id::text as source_ref,
 case when to_jsonb(t)->>'clock_out' is null then 'open' else 'actual' end::text as status,
 null::date as business_date,
 jsonb_build_object('id',t.id,'employee_id',to_jsonb(t)->'employee_id',
  'clock_in',to_jsonb(t)->'clock_in','clock_out',to_jsonb(t)->'clock_out',
  'hourly_wage_cents',to_jsonb(t)->'hourly_wage_cents',
  'regular_minutes',to_jsonb(t)->'regular_minutes',
  'overtime_minutes',to_jsonb(t)->'overtime_minutes') as data
 from public.timecards t;

create or replace view public.cv_staff with (security_invoker=true) as
 select e.business_id,
 case when coalesce(e.pos_team_member_id,'') like 'toast:%' then 'toast' else 'app' end::text as source,
 'staff:'||e.id::text as source_ref,'actual'::text as status,
 null::date as business_date,
 jsonb_build_object('id',e.id,'display_name',e.display_name,
  'role',e.role,'active',e.active,
  'default_hourly_wage_cents',e.default_hourly_wage_cents) as data
 from public.employees e;

create or replace view public.cv_shifts with (security_invoker=true) as
 select s.business_id,'app'::text as source,
 'shift:'||s.id::text as source_ref,'actual'::text as status,
 null::date as business_date,
 jsonb_build_object('id',s.id,'employee_id',to_jsonb(s)->'employee_id',
  'start_at',to_jsonb(s)->'starts_at','end_at',to_jsonb(s)->'ends_at',
  'day',to_jsonb(s)->'shift_date',
  'deleted_at',to_jsonb(s)->'deleted_at') as data
 from public.scheduled_shifts s;

create or replace view public.cv_menu with (security_invoker=true) as
 select m.business_id,case when m.catalog_source='toast' then 'toast' else 'app' end::text as source,
 'item:'||m.id::text as source_ref,'actual'::text as status,
 null::date as business_date,
 jsonb_build_object('id',m.id,'name',m.name,'price_cents',m.price_cents,
  'category',m.category,'menu_group',to_jsonb(m)->'menu_group',
  'is_active',m.is_active,'pos_item_id',m.pos_item_id) as data
 from public.menu_items m;

create or replace view public.cv_bills with (security_invoker=true) as
 select c.business_id,'app'::text as source,
 'bill:'||c.id::text as source_ref,'actual'::text as status,
 null::date as business_date,
 jsonb_build_object('id',c.id,'amount_cents',to_jsonb(c)->'amount_cents',
  'frequency',to_jsonb(c)->'frequency','category',to_jsonb(c)->'category',
  'name',to_jsonb(c)->'name') as data
 from public.recurring_costs c;

create or replace view public.cv_inventory with (security_invoker=true) as
 select i.business_id,'app'::text as source,
 'stock:'||i.id::text as source_ref,'actual'::text as status,
 null::date as business_date,
 jsonb_build_object('id',i.id,'ingredient_id',to_jsonb(i)->'ingredient_id',
  'quantity',to_jsonb(i)->'quantity',
  'counted_at',to_jsonb(i)->'counted_at') as data
 from public.pantry_stock_counts i;

create or replace view public.cv_analytics with (security_invoker=true) as
 select a.business_id,'toast'::text as source,
 'analytics:'||a.restaurant_guid::text||':'||a.report||':'||a.metric||':'||a.business_date::text as source_ref,
 'actual'::text as status,a.business_date,
 a.value_numeric,
 jsonb_build_object('report',a.report,'metric',a.metric,
 'value_numeric',a.value_numeric,'value_json',a.value_json,
 'fetched_at',a.fetched_at) as data
 from public.toast_analytics_results a;

-- Prompt C migration 110 defines owner_facts. This branch can be tested
-- independently before C merges; once 110 is applied, this view resolves to it.
do $owner$
begin
 if to_regclass('public.owner_facts') is null then
  execute $sql$create or replace view public.cv_owner_facts with (security_invoker=true) as
   select null::uuid as business_id,'owner'::text as source,
   null::text as source_ref,'owner_provided'::text as status,
   null::date as business_date,'{}'::jsonb as data where false$sql$;
 else
  execute $sql$create or replace view public.cv_owner_facts with (security_invoker=true) as
   select o.business_id,'owner'::text as source,
   coalesce(to_jsonb(o)->>'id',md5(to_jsonb(o)::text)) as source_ref,
   'owner_provided'::text as status,null::date as business_date,
   to_jsonb(o) - 'business_id' as data
   from public.owner_facts o$sql$;
 end if;
end $owner$;

-- No anonymous or public access to canonical business data.
do $grants$
declare v text;
begin
 foreach v in array array['cv_sales_days','cv_sales_hours','cv_item_sales',
  'cv_payments','cv_discounts','cv_voids_refunds','cv_card_fees',
  'cv_labor_entries','cv_staff','cv_shifts','cv_menu','cv_bills',
  'cv_inventory','cv_owner_facts','cv_analytics']
 loop
  execute format('revoke all on public.%I from public,anon',v);
  execute format('grant select on public.%I to authenticated,service_role',v);
 end loop;
end $grants$;
