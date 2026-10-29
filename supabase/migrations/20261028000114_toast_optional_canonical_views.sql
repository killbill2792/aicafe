-- Migration 114: additive canonical projections from existing stored orders and REDACTED
-- Toast capture evidence; requires manual application after 110,111,112,113.
-- Capture-only records are NOT continuously ingested operational data.
create or replace view public.cv_orders
 (business_id,source,source_ref,status,business_date,order_ref,dining_option,source_channel,guest_count,data)
 with (security_invoker=true) as
 select o.business_id,case when o.pos_order_id like 'toast:%' then 'toast' else 'app' end::text,
 'order:'||o.id::text,'actual'::text,o.business_date,o.id::text,
 o.dining_option::text,o.source_channel::text,o.guest_count::integer,
 jsonb_build_object('dining_option',o.dining_option,'source_channel',o.source_channel,
 'guest_count',o.guest_count,'order_ref',o.id)
 from public.orders o where o.superseded_by is null and o.toast_excluded is not true;

-- Toast stock omits all ordinary IN_STOCK menu items; an omitted row is NOT zero stock.
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
 from public.toast_raw_samples s join public.businesses b on b.id=s.business_id
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
 from public.toast_raw_samples s
 cross join lateral jsonb_array_elements(case when jsonb_typeof(s.sample)='array' then s.sample
 when jsonb_typeof(s.sample->'data')='array' then s.sample->'data'
 else '[]'::jsonb end) with ordinality as x(item,n)
 where s.endpoint in ('cashmgmt/v1/entries','cashmgmt/v1/deposits')
 and s.http_status between 200 and 299 and s.error_code is null
 and jsonb_typeof(x.item)='object';

create or replace view public.cv_kitchen
 (business_id,source,source_ref,status,business_date,order_ref,ticket_ref,
 fired_at,started_at,ready_at,prep_station_ref,data) with (security_invoker=true) as
 select s.business_id,'toast'::text,'toast-kitchen:'||s.id::text||':'||x.n::text,
 'actual'::text,s.business_date,x.item->>'orderGuid',x.item->>'ticketGuid',
 x.item->>'ticketFiredAt',x.item->>'itemStartedAt',x.item->>'itemFulfilledAt',
 x.item->>'prepStationGuid',
 jsonb_build_object('endpoint',s.endpoint,'selection_ref',x.item->>'selectionGuid',
 'menu_item_ref',x.item->>'selectionMenuItemGuid','prep_station_name',x.item->>'prepStationName',
 'fulfillment_level',x.item->'itemFulfillmentLevel',
 'captured_at',s.fetched_at,'capture_only',true)
 from public.toast_raw_samples s
 cross join lateral jsonb_array_elements(case when jsonb_typeof(s.sample)='array' then s.sample
 when jsonb_typeof(s.sample->'data')='array' then s.sample->'data'
 else '[]'::jsonb end) with ordinality as x(item,n)
 where s.endpoint in ('kitchen/v1/export/itemFulfillments','kitchen/v1/published/prepStations')
 and s.http_status between 200 and 299 and s.error_code is null
 and jsonb_typeof(x.item)='object';

create or replace view public.cv_dining_options
 (business_id,source,source_ref,status,business_date,dining_option_ref,dining_option_name,data)
 with (security_invoker=true) as
 select s.business_id,'toast'::text,'toast-option:'||s.id::text||':'||x.n::text,
 'actual'::text,(s.fetched_at at time zone b.timezone)::date,
 x.item->>'guid',public.toast_safe_business_label(x.item->>'name'),
 jsonb_build_object('behavior',x.item->>'behavior','captured_at',s.fetched_at,'capture_only',true)
 from public.toast_raw_samples s join public.businesses b on b.id=s.business_id
 cross join lateral jsonb_array_elements(case when jsonb_typeof(s.sample)='array' then s.sample
 when jsonb_typeof(s.sample->'data')='array' then s.sample->'data'
 else '[]'::jsonb end) with ordinality as x(item,n)
 where s.endpoint='config/v2/diningOptions' and s.http_status between 200 and 299
 and s.error_code is null and jsonb_typeof(x.item)='object';

revoke all on public.cv_orders,public.cv_inventory,public.cv_cash,
 public.cv_kitchen,public.cv_dining_options from public,anon;
grant select on public.cv_orders,public.cv_inventory,public.cv_cash,
 public.cv_kitchen,public.cv_dining_options to authenticated,service_role;

create or replace function public.ai_query_view(
 p_business_id uuid,p_view text,p_columns text[],p_filters jsonb,
 p_group_by text[],p_metrics jsonb,p_date_from date,p_date_to date,
 p_order_by jsonb,p_limit integer
) returns jsonb language plpgsql stable security invoker set search_path=public as $query$
declare
 allowed_views constant text[]=array['cv_sales_days','cv_sales_hours','cv_item_sales',
 'cv_payments','cv_discounts','cv_voids_refunds','cv_card_fees','cv_labor_entries',
 'cv_staff','cv_shifts','cv_menu','cv_bills','cv_inventory','cv_owner_facts','cv_analytics','cv_orders','cv_cash',
 'cv_kitchen','cv_dining_options'];
 v_col text;v_metric jsonb;v_filter jsonb;v_fn text;v_op text;v_val jsonb;
 v_where text:='business_id = $1';v_select text:='';v_group text:='';
 v_sql text;v_rows jsonb;v_mix jsonb;v_limit integer;v_n integer;
 v_order text:='';v_field text;v_dir text;
 v_source_count bigint;v_incomplete boolean;
begin
 if p_view is null or not (p_view=any(allowed_views)) then raise exception 'invalid view';end if;
 if p_business_id is null or p_date_from is null or p_date_to is null or
 p_date_to < p_date_from
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
 if p_view in ('cv_sales_days','cv_sales_hours','cv_item_sales','cv_payments',
 'cv_discounts','cv_voids_refunds','cv_card_fees','cv_labor_entries','cv_shifts',
 'cv_inventory','cv_analytics','cv_orders','cv_cash','cv_kitchen',
 'cv_dining_options') then
 v_where:=v_where||format(' and business_date between %L and %L',p_date_from,p_date_to);
 end if;
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
  raise exception 'ungrouped columns';
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
 execute format('select count(*),coalesce(bool_or(status in (''open'',''estimated'',''needs_match'')),false) from public.%I where %s',p_view,v_where)
 into v_source_count,v_incomplete using p_business_id;
 execute format('select coalesce(jsonb_object_agg(source,n),''{}''::jsonb) from
 (select source,count(*) n from public.%I where %s group by source) mix',p_view,v_where)
 into v_mix using p_business_id;
 return jsonb_build_object('rows',v_rows,'rowCount',jsonb_array_length(v_rows),
  'truncated',v_n>p_limit,'sourceMix',v_mix,
  'sourceCount',v_source_count,'hasIncomplete',v_incomplete);
end $query$;
revoke all on function public.ai_query_view(uuid,text,text[],jsonb,text[],jsonb,date,date,jsonb,integer)
 from public,anon,authenticated;
grant execute on function public.ai_query_view(uuid,text,text[],jsonb,text[],jsonb,date,date,jsonb,integer)
 to authenticated,service_role;
