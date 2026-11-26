-- Production timeouts: 336 ai_query_view and several cv_* reads scrubbed EVERY order, check and item to answer a
-- question about one record family. The caller's record_type filter could not reach the reader (security definer),
-- so a 7-day check count scrubbed every order, check and item. This pushes the family into the reader before any
-- expansion or scrubbing, and moves the cash, kitchen and dining-option views onto the current-object projection that
-- cv_inventory already uses. Same sources, permissions, scrubber, columns and caps; only unrequested families are skipped.
set lock_timeout='5s';
set statement_timeout='60s';

create or replace function public.toast_records_for(p_business_id uuid,p_from date,p_to date,p_record_types text[])
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
  and (p_record_types is null or p_record_types && array['order','check','item','modifier','item_discount','payment','check_discount','service_charge'])
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
 select * from public.toast_current_nonorders_for(p_business_id,p_from,p_to,
  case when cardinality(p_record_types)=1 and not (p_record_types[1]=any(array['order','check','item','modifier','item_discount','payment','check_discount','service_charge'])) then p_record_types[1] end)
)
select raw.business_id,raw.source,raw.source_ref,raw.status,raw.business_date,raw.record_type,raw.record_ref,raw.order_ref,raw.check_ref,raw.counts_in_sales,
 public.ai_safe_retained_json(raw.data) as data
from (
select business_id,'toast'::text,'toast-order:'||id::text,st,business_date,
 'order'::text,o->>'guid',o->>'guid',null::text,not o_void,o-'checks'-'aiCafeCustomer'
from orders
where p_record_types is null or 'order'=any(p_record_types)
union all
select business_id,'toast','toast-check:'||id::text||':'||cn,st,business_date,
 'check',c->>'guid',o->>'guid',c->>'guid',not c_void,
 (c-'selections'-'payments'-'appliedDiscounts'-'appliedServiceCharges'-'aiCafeCustomer')||jsonb_build_object('aiCafeCustomer',customer_evidence)
from checks
where p_record_types is null or 'check'=any(p_record_types)
union all
select business_id,'toast','toast-item:'||id::text||':'||cn||':'||sn,st,business_date,
 'item',s->>'guid',o->>'guid',c->>'guid',not s_void,(s-'modifiers'-'appliedDiscounts'-'aiCafeCustomer')||jsonb_build_object('aiCafeCustomer',public.ai_customer_child_evidence(customer_evidence))
from items
where p_record_types is null or 'item'=any(p_record_types)
union all
select i.business_id,'toast','toast-modifier:'||i.id::text||':'||i.cn||':'||i.sn||':'||m.n,i.st,
 i.business_date,'modifier',m.v->>'guid',i.o->>'guid',i.c->>'guid',
 not i.s_void and (m.v->'voided') is distinct from 'true'::jsonb,
 (m.v-'aiCafeCustomer')||jsonb_build_object('item_ref',i.s->>'guid','aiCafeCustomer',public.ai_customer_child_evidence(i.customer_evidence))
from items i cross join lateral jsonb_array_elements(case when jsonb_typeof(i.s->'modifiers')='array'
 then i.s->'modifiers' else '[]'::jsonb end) with ordinality m(v,n)
where jsonb_typeof(m.v)='object' and (p_record_types is null or 'modifier'=any(p_record_types))
union all
select i.business_id,'toast','toast-item-discount:'||i.id::text||':'||i.cn||':'||i.sn||':'||d.n,i.st,
 i.business_date,'item_discount',d.v->>'guid',i.o->>'guid',i.c->>'guid',not i.s_void
  and (d.v->>'processingState') is distinct from 'VOID',
 (d.v-'aiCafeCustomer')||jsonb_build_object('item_ref',i.s->>'guid','aiCafeCustomer',public.ai_customer_child_evidence(i.customer_evidence))
from items i cross join lateral jsonb_array_elements(case when jsonb_typeof(i.s->'appliedDiscounts')='array'
 then i.s->'appliedDiscounts' else '[]'::jsonb end) with ordinality d(v,n)
where jsonb_typeof(d.v)='object' and (p_record_types is null or 'item_discount'=any(p_record_types))
union all
select k.business_id,'toast','toast-payment:'||k.id::text||':'||k.cn||':'||p.n,k.st,k.business_date,
 'payment',p.v->>'guid',k.o->>'guid',k.c->>'guid',
 not k.c_void and (p.v->'voided') is distinct from 'true'::jsonb
  and coalesce(p.v->>'paymentStatus','') not in ('VOIDED','DENIED','CANCELLED','ERROR','ERROR_NETWORK'),public.ai_customer_safe_payment(p.v)||jsonb_build_object('aiCafeCustomer',public.ai_customer_child_evidence(k.customer_evidence))
from checks k cross join lateral jsonb_array_elements(case when jsonb_typeof(k.c->'payments')='array'
 then k.c->'payments' else '[]'::jsonb end) with ordinality p(v,n)
where jsonb_typeof(p.v)='object' and (p_record_types is null or 'payment'=any(p_record_types))
union all
select k.business_id,'toast','toast-check-discount:'||k.id::text||':'||k.cn||':'||d.n,k.st,k.business_date,
 'check_discount',d.v->>'guid',k.o->>'guid',k.c->>'guid',not k.c_void
  and (d.v->>'processingState') is distinct from 'VOID',(d.v-'aiCafeCustomer')||jsonb_build_object('aiCafeCustomer',public.ai_customer_child_evidence(k.customer_evidence))
from checks k cross join lateral jsonb_array_elements(case when jsonb_typeof(k.c->'appliedDiscounts')='array'
 then k.c->'appliedDiscounts' else '[]'::jsonb end) with ordinality d(v,n)
where jsonb_typeof(d.v)='object' and (p_record_types is null or 'check_discount'=any(p_record_types))
union all
select k.business_id,'toast','toast-service-charge:'||k.id::text||':'||k.cn||':'||d.n,k.st,k.business_date,
 'service_charge',d.v->>'guid',k.o->>'guid',k.c->>'guid',not k.c_void,(d.v-'aiCafeCustomer')||jsonb_build_object('aiCafeCustomer',public.ai_customer_child_evidence(k.customer_evidence))
from checks k cross join lateral jsonb_array_elements(case when jsonb_typeof(k.c->'appliedServiceCharges')='array'
 then k.c->'appliedServiceCharges' else '[]'::jsonb end) with ordinality d(v,n)
where jsonb_typeof(d.v)='object' and (p_record_types is null or 'service_charge'=any(p_record_types))
union all
select r.business_id,r.source,r.source_ref,r.status,r.business_date,
 r.record_type,r.record_ref,r.order_ref,r.check_ref,r.counts_in_sales,r.data
from current_nonorders r
where p_record_types is null or r.record_type=any(p_record_types)
) raw(business_id,source,source_ref,status,business_date,record_type,record_ref,order_ref,check_ref,counts_in_sales,data)
$records$;

-- The unfiltered reader keeps its exact signature and behavior for every existing caller.
create or replace function public.toast_records_for(p_business_id uuid,p_from date,p_to date)
returns table(business_id uuid,source text,source_ref text,status text,business_date date,
 record_type text,record_ref text,order_ref text,check_ref text,counts_in_sales boolean,data jsonb)
language sql stable security definer set search_path=public as $wrap$
 select * from public.toast_records_for(p_business_id,p_from,p_to,null::text[])
$wrap$;
revoke all on function public.toast_records_for(uuid,date,date,text[]) from public,anon;
grant execute on function public.toast_records_for(uuid,date,date,text[]) to authenticated,service_role;
revoke all on function public.toast_records_for(uuid,date,date) from public,anon;
grant execute on function public.toast_records_for(uuid,date,date) to authenticated,service_role;

create or replace function public.ai_query_view(
 p_business_id uuid,p_view text,p_columns text[],p_filters jsonb,
 p_group_by text[],p_metrics jsonb,p_date_from date,p_date_to date,
 p_order_by jsonb,p_limit integer
) returns jsonb language plpgsql stable security invoker set search_path=public as $query$
declare
 allowed_views constant text[]=array['cv_sales_days','cv_sales_hours','cv_item_sales',
 'cv_payments','cv_discounts','cv_voids_refunds','cv_card_fees','cv_labor_entries',
 'cv_staff','cv_shifts','cv_menu','cv_bills','cv_inventory','cv_owner_facts','cv_analytics','cv_orders','cv_cash',
 'cv_kitchen','cv_dining_options','cv_toast_records','cv_customer_visits','cv_customer_products'];
 v_col text;v_metric jsonb;v_filter jsonb;v_fn text;v_op text;v_val jsonb;
 v_where text:='business_id = $1';v_select text:='';v_group text:='';
 v_sql text;v_rows jsonb;v_mix jsonb;v_limit integer;v_n integer;
 v_order text:='';v_field text;v_dir text;v_expr text;v_path text[];v_has_data boolean;v_source text;
 v_source_count bigint;v_incomplete boolean;
 v_today date;v_current_day boolean:=false;
 v_bounded jsonb:='[]'::jsonb;v_row jsonb;v_bytes integer:=2;
 v_row_bytes integer;v_bytes_cut boolean:=false;
 v_customer_coverage jsonb;v_types text[];
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
 -- A record_type equality/in filter is also pushed into the reader so only that family is expanded and scrubbed.
 -- The same filters still apply to the result below, so this only avoids work and never widens it.
 v_types:=(select case when jsonb_typeof(x->'value')='string' then array[x->>'value']
   else array(select jsonb_array_elements_text(x->'value')) end
  from jsonb_array_elements(coalesce(p_filters,'[]'::jsonb)) x
  where p_view='cv_toast_records' and x->>'column'='record_type' and x->>'op' in ('=','in')
   and jsonb_typeof(x->'value') in ('string','array')
  limit 1);
 v_source:=case when p_view='cv_toast_records'
  then format('(select r.*,
  case when r.record_type=''item''
   then public.toast_json_dollars_to_cents(r.data->''price'') end as price_cents,
  case when r.record_type in (''item_discount'',''check_discount'')
   then public.toast_json_dollars_to_cents(r.data->''discountAmount'') end as discount_amount_cents
  from public.toast_records_for($1,%L::date,%L::date,%L::text[]) r) money',p_date_from,p_date_to,v_types)
  when p_view='cv_customer_visits' then format('public.customer_visits_for($1,%L::date,%L::date)',p_date_from,p_date_to)
  when p_view='cv_customer_products' then format('public.customer_products_for($1,%L::date,%L::date)',p_date_from,p_date_to)
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
   'cv_dining_options','cv_toast_records','cv_customer_visits','cv_customer_products');
 if p_view in ('cv_sales_days','cv_sales_hours','cv_item_sales','cv_payments',
 'cv_discounts','cv_voids_refunds','cv_card_fees','cv_labor_entries','cv_shifts',
 'cv_inventory','cv_analytics','cv_orders','cv_cash','cv_kitchen','cv_customer_visits','cv_customer_products') then
 v_where:=v_where||format(' and business_date between %L and %L',p_date_from,p_date_to);
 elsif p_view in ('cv_toast_records','cv_dining_options') then
 -- Undated current Toast setup/configuration is independent of the selected
 -- café business day. Never synthesize a timestamp to satisfy a date filter.
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
 -- For customer and retained Toast/inventory paths, expanding the source
 -- three times per query is expensive. Execute the SAME tenant/date-filtered
 -- source once for the limited page, incompleteness, and source distribution.
 if p_view in ('cv_customer_visits','cv_customer_products','cv_toast_records','cv_inventory') then
  v_sql:=format('with scoped_source as materialized (select * from %s where %s),
  page_rows as (select %s from scoped_source%s%s limit %s)
  select (select coalesce(jsonb_agg(to_jsonb(q)),''[]''::jsonb) from page_rows q),
  (select count(*) from scoped_source),
  (select coalesce(bool_or(status in (''open'',''estimated'',''needs_match'',''provisional'')),false) from scoped_source),
  (select coalesce(jsonb_object_agg(source,n),''{}''::jsonb)
   from (select source,count(*) n from scoped_source group by source) tally)',
   v_source,v_where,v_select,v_group,v_order,v_limit);
  execute v_sql into v_rows,v_source_count,v_incomplete,v_mix using p_business_id;
 else
 v_sql:=format('select coalesce(jsonb_agg(to_jsonb(q)),''[]''::jsonb)
 from (select %s from %s where %s%s%s limit %s) q',
  v_select,v_source,v_where,v_group,v_order,v_limit);
 execute v_sql into v_rows using p_business_id;
 end if;
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
 if p_view not in ('cv_customer_visits','cv_customer_products','cv_toast_records','cv_inventory') then
 execute format('select count(*),coalesce(bool_or(status in (''open'',''estimated'',''needs_match'',''provisional'')),false) from %s where %s',v_source,v_where)
 into v_source_count,v_incomplete using p_business_id;
 execute format('select coalesce(jsonb_object_agg(source,n),''{}''::jsonb) from
 (select source,count(*) n from %s where %s group by source) mix',v_source,v_where)
 into v_mix using p_business_id;
 end if;
 -- Customer denominator is the full selected period, not the filtered
 -- subset; never imply all-café coverage from a single identity or product.
 if p_view in ('cv_customer_visits','cv_customer_products') or (p_view='cv_toast_records' and exists(
  select 1 from (
   select unnest(coalesce(p_columns,array[]::text[])) field
   union all select unnest(coalesce(p_group_by,array[]::text[]))
   union all select f->>'column' from jsonb_array_elements(coalesce(p_filters,'[]'::jsonb)) f
   union all select m->>'column' from jsonb_array_elements(coalesce(p_metrics,'[]'::jsonb)) m
  ) requested
  where requested.field like 'data.aiCafeCustomer.%'
   or requested.field ~* '(^|\.)(customer|customerInfo|customerDetails|guest|guestInfo|loyalty|loyaltyAccount|appliedLoyaltyInfo|tabName|cardholder|cardholderName|cardPaymentId|loyaltyIdentifier|payer|payerName)(\.|$)'))
  then
  v_customer_coverage:=public.customer_query_coverage(p_business_id,p_date_from,p_date_to);
 end if;
 return jsonb_build_object('rows',v_rows,'rowCount',jsonb_array_length(v_rows),
  'truncated',v_n>p_limit or v_bytes_cut,'sourceMix',v_mix,
  'sourceCount',v_source_count,'hasIncomplete',v_incomplete,
  'currentDayIncomplete',v_current_day)||case when v_customer_coverage is null then '{}'::jsonb
  else jsonb_build_object('customerCoverage',v_customer_coverage) end;
end $query$;
revoke all on function public.ai_query_view(uuid,text,text[],jsonb,text[],jsonb,date,date,jsonb,integer) from public,anon,authenticated;
grant execute on function public.ai_query_view(uuid,text,text[],jsonb,text[],jsonb,date,date,jsonb,integer) to authenticated,service_role;

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
 from (select * from public.toast_current_nonorders_for(null,null,null,'cashmgmt/v1/entries') union all select * from public.toast_current_nonorders_for(null,null,null,'cashmgmt/v1/deposits')) r
 where r.record_type in ('cashmgmt/v1/entries','cashmgmt/v1/deposits');

create or replace view public.cv_dining_options
 (business_id,source,source_ref,status,business_date,dining_option_ref,dining_option_name,data)
 with (security_invoker=true) as
 select r.business_id,r.source,r.source_ref,r.status,r.business_date,
  r.data->>'guid',public.toast_safe_business_label(r.data->>'name'),
  jsonb_build_object('behavior',r.data->>'behavior',
   'source_as_of',r.data->>'lastSuccessAt')
 from (select * from public.toast_current_nonorders_for(null,null,null,'config/v2/diningOptions')) r
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
 from (select * from public.toast_current_nonorders_for(null,null,null,'kitchen/v1/export/itemFulfillments') union all select * from public.toast_current_nonorders_for(null,null,null,'kitchen/v1/published/prepStations')) r
 where r.record_type in ('kitchen/v1/export/itemFulfillments','kitchen/v1/published/prepStations');


revoke all on public.cv_cash,public.cv_dining_options,public.cv_kitchen from public,anon;
grant select on public.cv_cash,public.cv_dining_options,public.cv_kitchen to authenticated,service_role;
