-- The AI must reach every field Toast gives us, not only the ones copied into
-- the fixed views. Additive: one owner-checked reader function, one view over it,
-- and the query function learns to read fields inside a view's "data" JSON by
-- name ("data.server.guid"). Existing views and columns are unchanged.

-- 1. The archive table stays closed to app users (no grant, no read rule).
-- toast_records_for reads it for the AI only after checking that the signed-in
-- user owns the café, and only for the dates asked, so the date filter uses the
-- archive's index. Saved records are already cleaned (no guest names, contact
-- details, card numbers, credentials or notes).
create or replace function public.toast_records_allowed(p_business_id uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select current_setting('role',true) is distinct from 'authenticated'
  or public.scheduling_is_owner(p_business_id) $$;
revoke all on function public.toast_records_allowed(uuid) from public,anon,authenticated;
grant execute on function public.toast_records_allowed(uuid) to service_role;

-- 2. Every Toast record, one row each, full cleaned JSON in "data".
-- Orders come from the archive, only the latest import of each day, split into
-- order, check, item, modifier, payment, check_discount, item_discount and
-- service_charge rows (child lists are removed from the parent row; they are
-- their own rows). Every other Toast endpoint (labor, cash, kitchen, menus,
-- setup) comes from the newest daily capture. Setup lists have no business
-- date: only the newest copy is shown.
create or replace function public.toast_records_for(p_business_id uuid,p_from date,p_to date)
returns table(business_id uuid,source text,source_ref text,status text,business_date date,
 record_type text,record_ref text,order_ref text,check_ref text,counts_in_sales boolean,data jsonb)
language sql stable security definer set search_path=public as $records$
with orders as not materialized (
 select r.business_id,r.business_date,r.id,r.payload o,
  -- Same exclusions as the importer (lib/pos/toast/dayParser.ts): deleted, voided,
  -- excess-food and test-mode orders are kept here but never count in sales.
  (r.payload->'voided') is not distinct from 'true'::jsonb or (r.payload->'deleted') is not distinct from 'true'::jsonb
   or (r.payload->'excessFood') is not distinct from 'true'::jsonb or (r.payload->'createdInTestMode') is not distinct from 'true'::jsonb o_void
 from public.toast_raw_records r
 join public.toast_day_status d on d.business_id=r.business_id
  and d.restaurant_guid=r.restaurant_guid and d.business_date=r.business_date
  and d.import_state='imported'
  and (r.run_id=d.last_import_run_id or r.seen_run_id=d.last_import_run_id)
 where r.entity='order' and jsonb_typeof(r.payload)='object'
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
samples as not materialized (
 select s.*,
  s.endpoint not in ('labor/v1/shifts','labor/v1/timeEntries','cashmgmt/v1/deposits',
   'cashmgmt/v1/entries','kitchen/v1/export/itemFulfillments') and s.endpoint not like 'era/%' setup
 from public.toast_raw_samples s
 where s.http_status between 200 and 299 and s.error_code is null
  and s.endpoint not like 'orders/%' and s.endpoint not like '%{%'
  and (p_business_id is null or s.business_id=p_business_id)
  and case when p_business_id is not null then (select public.toast_records_allowed(p_business_id))
   else public.toast_records_allowed(s.business_id) end
  and coalesce(s.capture_id::text,'row:'||s.id::text)=(
   select coalesce(t.capture_id::text,'row:'||t.id::text) from public.toast_raw_samples t
   where t.business_id=s.business_id and t.restaurant_guid=s.restaurant_guid
    and t.endpoint=s.endpoint and t.http_status between 200 and 299 and t.error_code is null
    and (t.business_date is not distinct from s.business_date or
     s.endpoint not in ('labor/v1/shifts','labor/v1/timeEntries','cashmgmt/v1/deposits',
      'cashmgmt/v1/entries','kitchen/v1/export/itemFulfillments') and s.endpoint not like 'era/%')
   order by t.fetched_at desc,t.id desc limit 1))
select business_id,'toast'::text,'toast-order:'||id::text,'actual'::text,business_date,
 'order'::text,o->>'guid',o->>'guid',null::text,not o_void,o-'checks'
from orders
union all
select business_id,'toast','toast-check:'||id::text||':'||cn,'actual',business_date,
 'check',c->>'guid',o->>'guid',c->>'guid',not c_void,
 c-'selections'-'payments'-'appliedDiscounts'-'appliedServiceCharges'
from checks
union all
select business_id,'toast','toast-item:'||id::text||':'||cn||':'||sn,'actual',business_date,
 'item',s->>'guid',o->>'guid',c->>'guid',not s_void,s-'modifiers'-'appliedDiscounts'
from items
union all
select i.business_id,'toast','toast-modifier:'||i.id::text||':'||i.cn||':'||i.sn||':'||m.n,'actual',
 i.business_date,'modifier',m.v->>'guid',i.o->>'guid',i.c->>'guid',
 not i.s_void and (m.v->'voided') is distinct from 'true'::jsonb,
 m.v||jsonb_build_object('item_ref',i.s->>'guid')
from items i cross join lateral jsonb_array_elements(case when jsonb_typeof(i.s->'modifiers')='array'
 then i.s->'modifiers' else '[]'::jsonb end) with ordinality m(v,n)
where jsonb_typeof(m.v)='object'
union all
select i.business_id,'toast','toast-item-discount:'||i.id::text||':'||i.cn||':'||i.sn||':'||d.n,'actual',
 i.business_date,'item_discount',d.v->>'guid',i.o->>'guid',i.c->>'guid',not i.s_void,
 d.v||jsonb_build_object('item_ref',i.s->>'guid')
from items i cross join lateral jsonb_array_elements(case when jsonb_typeof(i.s->'appliedDiscounts')='array'
 then i.s->'appliedDiscounts' else '[]'::jsonb end) with ordinality d(v,n)
where jsonb_typeof(d.v)='object'
union all
select k.business_id,'toast','toast-payment:'||k.id::text||':'||k.cn||':'||p.n,'actual',k.business_date,
 'payment',p.v->>'guid',k.o->>'guid',k.c->>'guid',
 not k.c_void and (p.v->'voided') is distinct from 'true'::jsonb
  and coalesce(p.v->>'paymentStatus','') not in ('VOIDED','DENIED','CANCELLED','ERROR','ERROR_NETWORK'),p.v
from checks k cross join lateral jsonb_array_elements(case when jsonb_typeof(k.c->'payments')='array'
 then k.c->'payments' else '[]'::jsonb end) with ordinality p(v,n)
where jsonb_typeof(p.v)='object'
union all
select k.business_id,'toast','toast-check-discount:'||k.id::text||':'||k.cn||':'||d.n,'actual',k.business_date,
 'check_discount',d.v->>'guid',k.o->>'guid',k.c->>'guid',not k.c_void,d.v
from checks k cross join lateral jsonb_array_elements(case when jsonb_typeof(k.c->'appliedDiscounts')='array'
 then k.c->'appliedDiscounts' else '[]'::jsonb end) with ordinality d(v,n)
where jsonb_typeof(d.v)='object'
union all
select k.business_id,'toast','toast-service-charge:'||k.id::text||':'||k.cn||':'||d.n,'actual',k.business_date,
 'service_charge',d.v->>'guid',k.o->>'guid',k.c->>'guid',not k.c_void,d.v
from checks k cross join lateral jsonb_array_elements(case when jsonb_typeof(k.c->'appliedServiceCharges')='array'
 then k.c->'appliedServiceCharges' else '[]'::jsonb end) with ordinality d(v,n)
where jsonb_typeof(d.v)='object'
union all
select s.business_id,'toast','toast-capture:'||s.id::text||':'||x.n,'actual',
 case when s.setup then null::date else s.business_date end,
 s.endpoint,x.v->>'guid',null,null,null::boolean,x.v
from samples s cross join lateral jsonb_array_elements(case when jsonb_typeof(s.sample)='array' then s.sample
 when jsonb_typeof(s.sample->'data')='array' then s.sample->'data'
 when jsonb_typeof(s.sample->'results')='array' then s.sample->'results'
 when jsonb_typeof(s.sample->'menus')='array' then s.sample->'menus'
 else jsonb_build_array(s.sample) end) with ordinality x(v,n)
where jsonb_typeof(x.v)='object'
 and (s.setup or ((p_from is null or s.business_date>=p_from) and (p_to is null or s.business_date<=p_to)))
$records$;
revoke all on function public.toast_records_for(uuid,date,date) from public,anon;
grant execute on function public.toast_records_for(uuid,date,date) to authenticated,service_role;

-- The canonical view lists the same rows for the cafés the user owns. The AI's
-- query function reads toast_records_for directly with its café and dates.
create or replace view public.cv_toast_records
 (business_id,source,source_ref,status,business_date,record_type,record_ref,
 order_ref,check_ref,counts_in_sales,data)
 with (security_invoker=true) as
 select * from public.toast_records_for(null,null,null);
revoke all on public.cv_toast_records from public,anon;
grant select on public.cv_toast_records to authenticated,service_role;

-- 3. The query function reads named fields inside "data" on any view that has
-- it: "data.a.b" or "data.checks.0.amount" (keys and list positions, at most 8).
-- Text for grouping/filtering; numbers for sums and numeric comparisons.
create or replace function public.ai_query_path(p_col text) returns text[]
language sql immutable set search_path=public as $$
 select case when p_col ~ '^data(\.([A-Za-z_][A-Za-z0-9_]{0,100}|[0-9]{1,3})){1,8}$'
  then string_to_array(substr(p_col,6),'.') end $$;
revoke all on function public.ai_query_path(text) from public,anon;
grant execute on function public.ai_query_path(text) to authenticated,service_role;

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
 -- Toast records: the owner-checked reader with this café and these dates.
 v_source:=case when p_view='cv_toast_records'
  then format('public.toast_records_for($1,%L::date,%L::date)',p_date_from,p_date_to)
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
  if v_op not in ('=','!=','<','<=','>','>=','in','between','ilike')
   then raise exception 'invalid operator';end if;
  if v_path is null then v_expr:=format('%I',v_col);
  elsif v_op in ('<','<=','>','>=','between') or jsonb_typeof(v_val)='number' or
   (jsonb_typeof(v_val)='array' and jsonb_typeof(v_val->0)='number') then
   v_expr:=format('(case when jsonb_typeof(data #> %L)=''number'' then (data #>> %L)::numeric end)',v_path,v_path);
  else v_expr:=format('(data #>> %L)',v_path);
  end if;
  if v_op='in' then
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
  if v_fn not in ('sum','count','avg','min','max') then raise exception 'invalid aggregate';end if;
  if v_path is not null then
   v_expr:=case when v_fn='count' then format('nullif(data #> %L,''null''::jsonb)',v_path)
    else format('(case when jsonb_typeof(data #> %L)=''number'' then (data #>> %L)::numeric end)',v_path,v_path) end;
  elsif exists(select 1 from information_schema.columns c
    where c.table_schema='public' and c.table_name=p_view and c.column_name=v_col and
    (v_fn='count' or c.data_type in ('numeric','integer','bigint','smallint','double precision','real'))) then
   v_expr:=format('%I',v_col);
  else raise exception 'invalid aggregate';
  end if;
  v_select:=v_select||case when v_select='' then '' else ',' end||
   format('%s(%s) as %I',v_fn,v_expr,v_fn||'_'||v_col);
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
 if v_n>p_limit then
  v_rows:= (select coalesce(jsonb_agg(value),'[]'::jsonb) from (
    select value from jsonb_array_elements(v_rows) with ordinality as v(value,idx)
    where idx<=p_limit order by idx) limited);
 end if;
 execute format('select count(*),coalesce(bool_or(status in (''open'',''estimated'',''needs_match'')),false) from %s where %s',v_source,v_where)
 into v_source_count,v_incomplete using p_business_id;
 execute format('select coalesce(jsonb_object_agg(source,n),''{}''::jsonb) from
 (select source,count(*) n from %s where %s group by source) mix',v_source,v_where)
 into v_mix using p_business_id;
 return jsonb_build_object('rows',v_rows,'rowCount',jsonb_array_length(v_rows),
  'truncated',v_n>p_limit,'sourceMix',v_mix,
  'sourceCount',v_source_count,'hasIncomplete',v_incomplete);
end $query$;
revoke all on function public.ai_query_view(uuid,text,text[],jsonb,text[],jsonb,date,date,jsonb,integer)
 from public,anon,authenticated;
grant execute on function public.ai_query_view(uuid,text,text[],jsonb,text[],jsonb,date,date,jsonb,integer)
 to authenticated,service_role;

-- 4. Field list for one record type, so the AI knows which names to ask for.
-- Reads the newest 30 records of that type and lists each field path once.
create or replace function public.ai_toast_fields(p_business_id uuid,p_record_type text)
returns jsonb language sql stable security invoker set search_path=public as $$
 with recursive recs as (
  select data from public.toast_records_for(p_business_id,current_date-35,current_date)
  where record_type=p_record_type
  order by business_date desc nulls first limit 30),
 walk(path,v,depth) as (
  select 'data'::text,data,0 from recs
  union all
  select w.path||'.'||e.key,e.value,w.depth+1 from walk w
   cross join lateral (
    select key,value from jsonb_each(case when jsonb_typeof(w.v)='object' then w.v else '{}'::jsonb end)
    union all
    select '0',w.v->0 where jsonb_typeof(w.v)='array' and jsonb_array_length(w.v)>0) e
   where w.depth<8),
 leaves as (
  select path,min(jsonb_typeof(v)) kind,min(left(v#>>'{}',40)) example
  from walk where path<>'data' and jsonb_typeof(v) not in ('object','array','null')
  group by path)
 select coalesce(jsonb_agg(jsonb_build_object('field',path,'type',kind,'example',example)
  order by path),'[]'::jsonb)
 from (select * from leaves order by path limit 200) l $$;
revoke all on function public.ai_toast_fields(uuid,text) from public,anon;
grant execute on function public.ai_toast_fields(uuid,text) to authenticated,service_role;
