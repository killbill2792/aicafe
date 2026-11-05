-- Additive, owner-scoped read-only Toast cent projections. Source JSON stays unchanged.
-- Only fields exercised by the recorded PR1 Toast fixture are projected.
create or replace function public.toast_json_dollars_to_cents(p_value jsonb)
returns bigint language sql immutable parallel safe set search_path=public as $cents$
 select case when jsonb_typeof(p_value)='number'
  and abs((p_value #>> '{}')::numeric * 100) <= 9007199254740991::numeric
  then round((p_value #>> '{}')::numeric * 100)::bigint
  else null::bigint end
$cents$;
revoke all on function public.toast_json_dollars_to_cents(jsonb) from public,anon;
grant execute on function public.toast_json_dollars_to_cents(jsonb) to authenticated,service_role;

create or replace view public.cv_toast_records
 (business_id,source,source_ref,status,business_date,record_type,record_ref,
 order_ref,check_ref,counts_in_sales,data,price_cents,discount_amount_cents)
 with (security_invoker=true) as
 select r.*,
  case when r.record_type='item'
   then public.toast_json_dollars_to_cents(r.data->'price') end as price_cents,
  case when r.record_type in ('item_discount','check_discount')
   then public.toast_json_dollars_to_cents(r.data->'discountAmount') end as discount_amount_cents
 from public.toast_records_for(null,null,null) r;
revoke all on public.cv_toast_records from public,anon;
grant select on public.cv_toast_records to authenticated,service_role;

-- Keep all PR1 query grammar, security, result-size and current-day policies.
-- Match the view's derived columns while reading only the requested dates.
create or replace function public.ai_query_view(
 p_business_id uuid,p_view text,p_columns text[],p_filters jsonb,
 p_group_by text[],p_metrics jsonb,p_date_from date,p_date_to date,
 p_order_by jsonb,p_limit integer
) returns jsonb language plpgsql stable security invoker set search_path=public as $query$
declare
 allowed_views constant text[]=array['cv_sales_days','cv_sales_hours','cv_item_sales',
 'cv_payments','cv_discounts','cv_voids_refunds','cv_card_fees','cv_labor_entries',
 'cv_staff','cv_shifts','cv_menu','cv_bills','cv_inventory','cv_owner_facts','cv_analytics','cv_orders','cv_cash',
 'cv_kitchen','cv_dining_options','cv_toast_records'];
 v_col text;v_metric jsonb;v_filter jsonb;v_fn text;v_op text;v_val jsonb;
 v_where text:='business_id = $1';v_select text:='';v_group text:='';
 v_sql text;v_rows jsonb;v_mix jsonb;v_limit integer;v_n integer;
 v_order text:='';v_field text;v_dir text;v_expr text;v_path text[];v_has_data boolean;v_source text;
 v_source_count bigint;v_incomplete boolean;
 v_today date;v_current_day boolean:=false;
 v_bounded jsonb:='[]'::jsonb;v_row jsonb;v_bytes integer:=2;
 v_row_bytes integer;v_bytes_cut boolean:=false;
begin
 if p_view is null or not (p_view=any(allowed_views)) then raise exception 'invalid view';end if;
 if p_business_id is null or p_date_from is null or p_date_to is null or
 p_date_to < p_date_from
 then raise exception 'invalid date range';end if;
 if p_limit is null or p_limit<1 or p_limit>100 then raise exception 'invalid limit';end if;
 if coalesce(array_length(p_columns,1),0)>20 or
 coalesce(array_length(p_group_by,1),0)>4 or
 coalesce(jsonb_array_length(coalesce(p_filters,'[]'::jsonb)),0)>15 or
 coalesce(jsonb_array_length(coalesce(p_metrics,'[]'::jsonb)),0)>10
 then raise exception 'query too large';end if;
 -- Toast records: the owner-checked reader with this café and these dates.
 v_source:=case when p_view='cv_toast_records'
  then format('(select r.*,
  case when r.record_type=''item''
   then public.toast_json_dollars_to_cents(r.data->''price'') end as price_cents,
  case when r.record_type in (''item_discount'',''check_discount'')
   then public.toast_json_dollars_to_cents(r.data->''discountAmount'') end as discount_amount_cents
  from public.toast_records_for($1,%L::date,%L::date) r) money',p_date_from,p_date_to)
  else format('public.%I',p_view) end;
 v_has_data:=exists(select 1 from information_schema.columns c where c.table_schema='public'
  and c.table_name=p_view and c.column_name='data' and c.data_type='jsonb');
 -- Enforce the physical canonical view's exact column allowlist, or a field path in data.
 foreach v_col in array coalesce(p_columns,array[]::text[]) ||
   coalesce(p_group_by,array[]::text[]) loop
  if not exists(select 1 from information_schema.columns c
    where c.table_schema='public' and c.table_name=p_view and c.column_name=v_col)
   and not (v_has_data and public.ai_query_path(v_col) is not null)
   then raise exception 'invalid column';end if;
 end loop;
 -- Active day comes from the café's actual configured timezone.
 select (now() at time zone b.timezone)::date into v_today
 from public.businesses b where b.id=p_business_id;
 v_current_day:=v_today is not null and v_today between p_date_from and p_date_to
  and p_view in ('cv_sales_days','cv_sales_hours','cv_item_sales','cv_payments',
   'cv_discounts','cv_voids_refunds','cv_card_fees','cv_labor_entries','cv_shifts',
   'cv_inventory','cv_analytics','cv_orders','cv_cash','cv_kitchen',
   'cv_dining_options','cv_toast_records');
 if p_view in ('cv_sales_days','cv_sales_hours','cv_item_sales','cv_payments',
 'cv_discounts','cv_voids_refunds','cv_card_fees','cv_labor_entries','cv_shifts',
 'cv_inventory','cv_analytics','cv_orders','cv_cash','cv_kitchen',
 'cv_dining_options') then
 v_where:=v_where||format(' and business_date between %L and %L',p_date_from,p_date_to);
 elsif p_view='cv_toast_records' then
 -- Setup lists (menus, tables, discounts...) are undated: always the newest copy.
 v_where:=v_where||format(' and (business_date between %L and %L or business_date is null)',p_date_from,p_date_to);
 end if;
 for v_filter in select value from jsonb_array_elements(coalesce(p_filters,'[]'::jsonb)) loop
  v_col:=v_filter->>'column';v_op:=v_filter->>'op';v_val:=v_filter->'value';
  v_path:=case when v_has_data then public.ai_query_path(v_col) end;
  if v_path is null and not exists(select 1 from information_schema.columns c
   where c.table_schema='public' and c.table_name=p_view and c.column_name=v_col)
   then raise exception 'invalid filter column';end if;
  if v_op not in ('=','!=','<','<=','>','>=','in','between','ilike','is_null','is_not_null')
   then raise exception 'invalid operator';end if;
  if v_path is null then v_expr:=format('%I',v_col);
  elsif v_op in ('<','<=','>','>=','between') or jsonb_typeof(v_val)='number' or
   (jsonb_typeof(v_val)='array' and jsonb_typeof(v_val->0)='number') then
   v_expr:=format('(case when jsonb_typeof(data #> %L)=''number'' then (data #>> %L)::numeric end)',v_path,v_path);
  else v_expr:=format('(data #>> %L)',v_path);
  end if;
  if v_op in ('is_null','is_not_null') then
   if v_val is not null and v_val<>'null'::jsonb then raise exception 'invalid null filter';end if;
   v_where:=v_where||format(' and %s is %snull',v_expr,
     case when v_op='is_not_null' then 'not ' else '' end);
  elsif v_op='in' then
   if jsonb_typeof(v_val)<>'array' or jsonb_array_length(v_val)>100 or jsonb_array_length(v_val)=0
   then raise exception 'invalid in';end if;
   v_where:=v_where||format(' and %s in (%s)',v_expr,
    (select string_agg(quote_literal(value#>>'{}'),',')
     from jsonb_array_elements(v_val)));
  elsif v_op='between' then
   if jsonb_typeof(v_val)<>'array' or jsonb_array_length(v_val)<>2
   then raise exception 'invalid between';end if;
   v_where:=v_where||format(' and %s between %L and %L',v_expr,
    v_val->>0,v_val->>1);
  else
   if v_val is null or jsonb_typeof(v_val) not in ('string','number','boolean')
   then raise exception 'invalid scalar';end if;
   v_where:=v_where||format(' and %s %s %L',v_expr,v_op,v_val#>>'{}');
  end if;
 end loop;
 foreach v_col in array coalesce(p_group_by,array[]::text[]) loop
  v_path:=case when v_has_data then public.ai_query_path(v_col) end;
  v_expr:=case when v_path is null then format('%I',v_col) else format('(data #>> %L)',v_path) end;
  v_group:=v_group||case when v_group='' then '' else ',' end||v_expr;
  v_select:=v_select||case when v_select='' then '' else ',' end||format('%s as %I',v_expr,v_col);
 end loop;
 -- Aggregation and grouping are done inside the database, never in model text.
 for v_metric in select value from jsonb_array_elements(coalesce(p_metrics,'[]'::jsonb)) loop
  v_fn:=lower(v_metric->>'fn');v_col:=v_metric->>'column';
  v_path:=case when v_has_data then public.ai_query_path(v_col) end;
  if v_fn not in ('sum','count','count_distinct','avg','min','max') then raise exception 'invalid aggregate';end if;
  if v_path is not null then
   v_expr:=case when v_fn in ('count','count_distinct') then format('nullif(data #> %L,''null''::jsonb)',v_path)
    else format('(case when jsonb_typeof(data #> %L)=''number'' then (data #>> %L)::numeric end)',v_path,v_path) end;
  elsif exists(select 1 from information_schema.columns c
    where c.table_schema='public' and c.table_name=p_view and c.column_name=v_col and
    (v_fn='count' or (v_fn='count_distinct' and c.data_type not in ('json','jsonb','ARRAY')) or
     c.data_type in ('numeric','integer','bigint','smallint','double precision','real'))) then
   v_expr:=format('%I',v_col);
  else raise exception 'invalid aggregate';
  end if;
  v_select:=v_select||case when v_select='' then '' else ',' end||
   format('%s as %I',
    case when v_fn='count_distinct' then format('count(distinct %s)',v_expr)
     else format('%s(%s)',v_fn,v_expr) end,
    v_fn||'_'||v_col);
 end loop;
 if v_select='' then
  for v_col in select unnest(coalesce(p_columns,array['business_id','source','source_ref','status','business_date'])) loop
   v_path:=case when v_has_data then public.ai_query_path(v_col) end;
   v_expr:=case when v_path is null then format('%I',v_col) else format('(data #> %L)',v_path) end;
   v_select:=v_select||case when v_select='' then '' else ',' end||format('%s as %I',v_expr,v_col);
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
 from (select %s from %s where %s%s%s limit %s) q',
  v_select,v_source,v_where,v_group,v_order,v_limit);
 execute v_sql into v_rows using p_business_id;
 v_n:=jsonb_array_length(v_rows);
 -- Count and byte limits are enforced by PostgreSQL, not just the UI.
 -- Keep only a fitting prefix and explicitly mark it truncated.
 for v_row in select value from jsonb_array_elements(v_rows) loop
  exit when jsonb_array_length(v_bounded)>=p_limit;
  v_row_bytes:=octet_length(v_row::text)+1;
  if v_bytes+v_row_bytes>6000 then v_bytes_cut:=true;exit;end if;
  v_bounded:=v_bounded||jsonb_build_array(v_row);
  v_bytes:=v_bytes+v_row_bytes;
 end loop;
 v_rows:=v_bounded;
 execute format('select count(*),coalesce(bool_or(status in (''open'',''estimated'',''needs_match'',''provisional'')),false) from %s where %s',v_source,v_where)
 into v_source_count,v_incomplete using p_business_id;
 execute format('select coalesce(jsonb_object_agg(source,n),''{}''::jsonb) from
 (select source,count(*) n from %s where %s group by source) mix',v_source,v_where)
 into v_mix using p_business_id;
 return jsonb_build_object('rows',v_rows,'rowCount',jsonb_array_length(v_rows),
  'truncated',v_n>p_limit or v_bytes_cut,'sourceMix',v_mix,
  'sourceCount',v_source_count,'hasIncomplete',v_incomplete,
  'currentDayIncomplete',v_current_day);
end $query$;
revoke all on function public.ai_query_view(uuid,text,text[],jsonb,text[],jsonb,date,date,jsonb,integer)
 from public,anon,authenticated;
grant execute on function public.ai_query_view(uuid,text,text[],jsonb,text[],jsonb,date,date,jsonb,integer)
 to authenticated,service_role;
