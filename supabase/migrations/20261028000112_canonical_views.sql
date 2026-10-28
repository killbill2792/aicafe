-- Prompt D: owner-readable canonical projections. SECURITY INVOKER means each
-- query is checked against the authenticated café member's underlying RLS.
-- Raw Toast JSON is deliberately NOT exposed by these views.
create or replace view public.cv_sales_days (business_id,source,source_ref,status,business_date,net_sales_cents,orders_count,data) with (security_invoker=true) as
 select d.business_id,'app'::text as source,
   'rollup:'||d.business_date::text as source_ref,
   case when to_jsonb(d)->>'sales_data_status' in ('missing','partial') then 'open'
    when to_jsonb(d)->>'sales_data_status'='estimated' then 'estimated'
    else 'actual' end::text as status,d.business_date,
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

create or replace view public.cv_sales_hours (business_id,source,source_ref,status,business_date,net_sales_cents,orders_count,data) with (security_invoker=true) as
 select h.business_id,'app'::text as source,
 'hour:'||h.business_date::text||':'||h.hour_local::text||':'||coalesce(h.location_id::text,'all') as source_ref,
 'actual'::text as status,h.business_date,h.net_sales_cents,
 h.orders_count,jsonb_build_object('hour_local',h.hour_local,
 'location_id',h.location_id,'net_sales_cents',h.net_sales_cents,'orders_count',h.orders_count) as data
 from public.hourly_sales_rollup h;

create or replace view public.cv_item_sales (business_id,source,source_ref,status,business_date,net_sales_cents,quantity,data) with (security_invoker=true) as
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

create or replace view public.cv_payments (business_id,source,source_ref,status,business_date,amount_cents,tip_cents,data) with (security_invoker=true) as
 select p.business_id,'toast'::text as source,
 'payment:'||p.restaurant_guid::text||':'||p.payment_ref as source_ref,
 p.status,p.business_date,p.amount_cents,p.tip_cents,
 jsonb_build_object('type',p.payment_type,'amount_cents',p.amount_cents,
  'tip_cents',p.tip_cents,'payment_status',p.payment_status) as data
 from public.toast_payment_summaries p;

create or replace view public.cv_discounts (business_id,source,source_ref,status,business_date,amount_cents,data) with (security_invoker=true) as
 select o.business_id,case when o.pos_order_id like 'toast:%' then 'toast' else 'app' end::text as source,
 'order:'||o.id::text as source_ref,'actual'::text as status,
 o.business_date,o.discounts_cents as amount_cents,
 jsonb_build_object('amount_cents',o.discounts_cents,'order_id',o.id) as data
 from public.orders o
 where coalesce(o.discounts_cents,0)<>0 and o.toast_excluded is not true
 and o.superseded_by is null;

create or replace view public.cv_voids_refunds (business_id,source,source_ref,status,business_date,amount_cents,data) with (security_invoker=true) as
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

create or replace view public.cv_card_fees (business_id,source,source_ref,status,business_date,amount_cents,data) with (security_invoker=true) as
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

create or replace view public.cv_labor_entries (business_id,source,source_ref,status,business_date,data) with (security_invoker=true) as
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
 from public.timecards t
 union all
 select s.business_id,'toast'::text,
 'staged-timecard:'||s.restaurant_guid::text||':'||s.external_time_entry_id::text,
 s.status,null::date,
 jsonb_build_object('employee_guid',s.external_employee_id,
  'clock_in',s.clock_in,'clock_out',s.clock_out,
  'hourly_wage_cents',s.hourly_wage_cents,
  'wage_status',s.wage_status)
 from public.toast_open_labor_summaries s
 where s.status in ('open','needs_match');

create or replace view public.cv_staff (business_id,source,source_ref,status,business_date,data) with (security_invoker=true) as
 select e.business_id,
 case when coalesce(e.pos_team_member_id,'') like 'toast:%' then 'toast' else 'app' end::text as source,
 'staff:'||e.id::text as source_ref,'actual'::text as status,
 null::date as business_date,
 jsonb_build_object('id',e.id,'display_name',e.display_name,
  'role',e.role,'active',e.active,
  'default_hourly_wage_cents',e.default_hourly_wage_cents) as data
 from public.employees e
 union all
 select r.business_id,'toast'::text,'review:'||r.review_type||':'||r.source_key,
 'needs_match'::text,null::date,
 jsonb_build_object('review_type',r.review_type,'source_key',r.source_key,
  'detail',r.detail)
 from public.pos_import_reviews r
 where r.provider='toast' and r.review_type='staff_identity' and r.status='needs_owner';

create or replace view public.cv_shifts (business_id,source,source_ref,status,business_date,data) with (security_invoker=true) as
 select s.business_id,'app'::text as source,
 'shift:'||s.id::text as source_ref,
 case when s.status='draft' then 'open' else 'actual' end::text as status,
 s.local_date as business_date,
 jsonb_build_object('id',s.id,'employee_id',s.employee_id,
  'start_local',s.start_local,'end_local',s.end_local,
  'day',s.local_date,'shift_status',s.status,'overnight',s.overnight,
  'break_minutes',s.break_minutes) as data
 from public.scheduled_shifts s;

create or replace view public.cv_menu (business_id,source,source_ref,status,business_date,data) with (security_invoker=true) as
 select m.business_id,case when m.catalog_source='toast' then 'toast' else 'app' end::text as source,
 'item:'||m.id::text as source_ref,'actual'::text as status,
 null::date as business_date,
 jsonb_build_object('id',m.id,'name',m.name,'price_cents',m.price_cents,
  'category',m.category,'menu_group',to_jsonb(m)->'menu_group',
  'is_active',m.is_active,'pos_item_id',m.pos_item_id) as data
 from public.menu_items m
 union all
 select r.business_id,'toast'::text,'review:'||r.review_type||':'||r.source_key,
 'needs_match'::text,null::date,
 jsonb_build_object('review_type',r.review_type,'source_key',r.source_key,'detail',r.detail)
 from public.pos_import_reviews r where r.provider='toast'
 and r.review_type in ('catalog_item','menu_identity','item_identity')
 and r.status='needs_owner';

create or replace view public.cv_bills (business_id,source,source_ref,status,business_date,data) with (security_invoker=true) as
 select c.business_id,'app'::text as source,
 'bill:'||c.id::text as source_ref,'actual'::text as status,
 null::date as business_date,
 jsonb_build_object('id',c.id,'amount_cents',to_jsonb(c)->'amount_cents',
  'frequency',to_jsonb(c)->'frequency','category',to_jsonb(c)->'category',
  'name',to_jsonb(c)->'name') as data
 from public.recurring_costs c;

create or replace view public.cv_inventory (business_id,source,source_ref,status,business_date,data) with (security_invoker=true) as
 select i.business_id,'app'::text as source,
 'stock:'||i.id::text as source_ref,'actual'::text as status,
 i.count_date as business_date,
 jsonb_build_object('id',i.id,'ingredient_id',i.ingredient_id,
  'quantity_base',i.quantity_base,'count_date',i.count_date) as data
 from public.pantry_stock_counts i;

create or replace view public.cv_analytics (business_id,source,source_ref,status,business_date,value_numeric,data) with (security_invoker=true) as
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
  execute $sql$create or replace view public.cv_owner_facts (business_id,source,source_ref,status,business_date,data) with (security_invoker=true) as
   select null::uuid as business_id,'owner'::text as source,
   null::text as source_ref,'owner_provided'::text as status,
   null::date as business_date,'{}'::jsonb as data where false$sql$;
 else
  execute $sql$create or replace view public.cv_owner_facts (business_id,source,source_ref,status,business_date,data) with (security_invoker=true) as
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


-- The model never submits SQL. This invoker-RLS RPC accepts only identifiers
-- present in an allowed canonical view, with bounded literal filter values.
create or replace function public.ai_query_view(
 p_business_id uuid,p_view text,p_columns text[],p_filters jsonb,
 p_group_by text[],p_metrics jsonb,p_date_from date,p_date_to date,
 p_order_by jsonb,p_limit integer
) returns jsonb language plpgsql stable security invoker set search_path=public as $query$
declare
 allowed_views constant text[]=array['cv_sales_days','cv_sales_hours','cv_item_sales',
 'cv_payments','cv_discounts','cv_voids_refunds','cv_card_fees','cv_labor_entries',
 'cv_staff','cv_shifts','cv_menu','cv_bills','cv_inventory','cv_owner_facts','cv_analytics'];
 v_col text;v_metric jsonb;v_filter jsonb;v_fn text;v_op text;v_val jsonb;
 v_where text:='business_id = $1';v_select text:='';v_group text:='';
 v_sql text;v_rows jsonb;v_mix jsonb;v_limit integer;v_n integer;
 v_order text:='';v_field text;v_dir text;
begin
 if p_view is null or not (p_view=any(allowed_views)) then raise exception 'invalid view';end if;
 if p_business_id is null or p_date_from is null or p_date_to is null or
 p_date_to < p_date_from or p_date_to > (p_date_from+interval '3 years')::date
 then raise exception 'invalid date range';end if;
 if p_limit is null or p_limit<1 or p_limit>1000 then raise exception 'invalid limit';end if;
 if coalesce(array_length(p_columns,1),0)>20 or
 coalesce(array_length(p_group_by,1),0)>4 or
 coalesce(jsonb_array_length(coalesce(p_filters,'[]'::jsonb)),0)>15 or
 coalesce(jsonb_array_length(coalesce(p_metrics,'[]'::jsonb)),0)>10
 then raise exception 'query too large';end if;
 -- Enforce the physical canonical view's exact column allowlist.
 foreach v_col in array coalesce(p_columns,array[]::text[]) ||
   coalesce(p_group_by,array[]::text[]) loop
  if not exists(select 1 from information_schema.columns c
    where c.table_schema='public' and c.table_name=p_view and c.column_name=v_col)
   then raise exception 'invalid column';end if;
 end loop;
 v_where:=v_where||format(' and (business_date is null or (business_date >= %L and business_date <= %L))',
  p_date_from,p_date_to);
 for v_filter in select value from jsonb_array_elements(coalesce(p_filters,'[]'::jsonb)) loop
  v_col:=v_filter->>'column';v_op:=v_filter->>'op';v_val:=v_filter->'value';
  if not exists(select 1 from information_schema.columns c
   where c.table_schema='public' and c.table_name=p_view and c.column_name=v_col)
   then raise exception 'invalid filter column';end if;
  if v_op not in ('=','!=','<','<=','>','>=','in','between','ilike')
   then raise exception 'invalid operator';end if;
  if v_op='in' then
   if jsonb_typeof(v_val)<>'array' or jsonb_array_length(v_val)>100 or jsonb_array_length(v_val)=0
   then raise exception 'invalid in';end if;
   v_where:=v_where||format(' and %I in (%s)',v_col,
    (select string_agg(quote_literal(value#>>'{}'),',')
     from jsonb_array_elements(v_val)));
  elsif v_op='between' then
   if jsonb_typeof(v_val)<>'array' or jsonb_array_length(v_val)<>2
   then raise exception 'invalid between';end if;
   v_where:=v_where||format(' and %I between %L and %L',v_col,
    v_val->>0,v_val->>1);
  else
   if v_val is null or jsonb_typeof(v_val) not in ('string','number','boolean')
   then raise exception 'invalid scalar';end if;
   v_where:=v_where||format(' and %I %s %L',v_col,v_op,v_val#>>'{}');
  end if;
 end loop;
 foreach v_col in array coalesce(p_group_by,array[]::text[]) loop
  v_group:=v_group||case when v_group='' then '' else ',' end||format('%I',v_col);
 end loop;
 -- Aggregation and grouping are done inside the database, never in model text.
 for v_metric in select value from jsonb_array_elements(coalesce(p_metrics,'[]'::jsonb)) loop
  v_fn:=lower(v_metric->>'fn');v_col:=v_metric->>'column';
  if v_fn not in ('sum','count','avg','min','max') or
   not exists(select 1 from information_schema.columns c
    where c.table_schema='public' and c.table_name=p_view and c.column_name=v_col and
    (v_fn='count' or c.data_type in ('numeric','integer','bigint','smallint','double precision','real')))
  then raise exception 'invalid aggregate';end if;
  v_select:=v_select||case when v_select='' then '' else ',' end||
   format('%s(%I) as %I',v_fn,v_col,v_fn||'_'||v_col);
 end loop;
 if v_group<>'' then v_select:=v_group||case when v_select<>'' then ',' else '' end||v_select;end if;
 if v_select='' then
  for v_col in select unnest(coalesce(p_columns,array['business_id','source','source_ref','status','business_date'])) loop
   v_select:=v_select||case when v_select='' then '' else ',' end||format('%I',v_col);
  end loop;
 elsif v_group='' then
  -- Aggregate-only requests cannot add ungrouped columns.
  if coalesce(array_length(p_columns,1),0)>0 then raise exception 'columns require group by';end if;
 elsif exists(select 1 from unnest(p_columns) c where c<>all(p_group_by)) then
  raise exception 'ungrouped columns';end if;
 end if;
 if v_group<>'' then v_group:=' group by '||v_group;end if;
 if p_order_by is not null then
  v_field:=p_order_by->>'column';v_dir:=coalesce(p_order_by->>'direction','asc');
  if v_dir not in ('asc','desc') or not (
   v_field=any(coalesce(p_columns,array[]::text[])) or
   v_field=any(coalesce(p_group_by,array[]::text[])) or
   exists(select 1 from jsonb_array_elements(coalesce(p_metrics,'[]'::jsonb)) m
    where (m->>'fn')||'_'||(m->>'column')=v_field))
  then raise exception 'invalid order by';end if;
  v_order:=format(' order by %I %s',v_field,v_dir);
 end if;
 v_limit:=p_limit+1;
 v_sql:=format('select coalesce(jsonb_agg(to_jsonb(q)),''[]''::jsonb)
 from (select %s from public.%I where %s%s%s limit %s) q',
  v_select,p_view,v_where,v_group,v_order,v_limit);
 execute v_sql into v_rows using p_business_id;
 v_n:=jsonb_array_length(v_rows);
 if v_n>p_limit then
  v_rows:= (select coalesce(jsonb_agg(value),'[]'::jsonb) from (
    select value from jsonb_array_elements(v_rows) with ordinality as v(value,idx)
    where idx<=p_limit order by idx) limited);
 end if;
 execute format('select coalesce(jsonb_object_agg(source,n),''{}''::jsonb) from
 (select source,count(*) n from public.%I where %s group by source) mix',p_view,v_where)
 into v_mix using p_business_id;
 return jsonb_build_object('rows',v_rows,'rowCount',jsonb_array_length(v_rows),
  'truncated',v_n>p_limit,'sourceMix',v_mix);
end $query$;
revoke all on function public.ai_query_view(uuid,text,text[],jsonb,text[],jsonb,date,date,jsonb,integer)
 from public,anon,authenticated;
grant execute on function public.ai_query_view(uuid,text,text[],jsonb,text[],jsonb,date,date,jsonb,integer)
 to authenticated,service_role;
