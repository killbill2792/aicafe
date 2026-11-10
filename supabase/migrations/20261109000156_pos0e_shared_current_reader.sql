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
  -- Stage triggers also capture mirrored/test rows. A staged object needs a
  -- durable authenticated restaurant-info GET for the same café and Toast
  -- restaurant OR a currently verified mapping awaiting its info GET. Re-save or
  -- failed re-verification clears verified_at but NOT info_refreshed_at.
  -- The mirror lacks provider-identity evidence and remains excluded. Direct
  -- current-object archives and order projections are unchanged.
  and (r.capture_key not like 'stage:%' or exists (
   select 1 from public.toast_location_mappings m
   where m.business_id=r.business_id and m.restaurant_guid=r.restaurant_guid
    and (m.verified_at is not null or m.info_refreshed_at is not null)))
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

-- Safe, bounded named JSON paths from the existing reader. Never expose a
-- card credential, token or reusable security secret, even in old raw payloads.
-- This is a defense-in-depth filter: the operational writer also redacts data.
create or replace function public.ai_query_path(p_col text) returns text[]
language sql immutable set search_path=public as $path$
 select case when p_col ~ '^data(\.([A-Za-z_][A-Za-z0-9_]{0,100}|[0-9]{1,3})){1,16}$'
  and not exists (
   select 1 from unnest(string_to_array(substr(p_col,6),'.')) s(part)
   where part ~* '^(pan|primaryAccountNumber|cardNumber|paymentCardNumber|cvv|cvc|cvv2|cvc2|cardVerificationValue|securityCode|magstripe|track|track1|track2|trackData|track1Data|track2Data|cardLast4|last4Digits|lastFour|first5|first6|expiration|expiry|expireDate|expirationDate|cardExpiry|cardExpiration|password|passcode|pin|apiKey|secret|clientSecret|privateKey|accessToken|refreshToken|sessionToken|authToken|authorization|authorizationToken|paymentToken|cardToken|token|tokenId|fingerprint|networkTransactionIdentifier|routingNumber|bankAccountNumber|accountNumber|signature)$'
      or part ~* '(Password|Secret|ApiKey|PrivateKey|AccessToken|RefreshToken|SessionToken|AuthToken|PaymentToken|CardToken|CardNumber|TrackData|SecurityCode|VerificationValue|Magstripe)$'
      or part ~* '^(card|cardInfo|cardDetails|cardData|creditCard|paymentCard|giftCard|giftCardInfo|paymentMethod)$'
  )
  and not (
   p_col ~* '^data\.(card|cardInfo|cardDetails|cardData|creditCard|paymentCard|giftCard|giftCardInfo|paymentMethod)\.(number|value|last4|first5|first6|lastFour|maskedNumber|expirationDate|expiryDate|expiryMonth|expiryYear|expMonth|expYear|holderName|cardholderName|networkId|networkTransactionIdentifier|accountId|accountNumber|tokenId)(\.|$)'
  )
 then string_to_array(substr(p_col,6),'.') end $path$;
revoke all on function public.ai_query_path(text) from public,anon;
grant execute on function public.ai_query_path(text) to authenticated,service_role;

-- Full retained-field discovery, no recent-window or arbitrary row/path sample.
-- Schema-defined never-observed paths are supplied separately by describe_data.
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
revoke all on function public.ai_toast_fields(uuid,text) from public,anon;
grant execute on function public.ai_toast_fields(uuid,text) to authenticated,service_role;

-- POS0e final shared-query correction: preserve the existing security-invoker,
-- bounded reader and operator semantics while allowing undated retained
-- dining-option configuration through ai_query_view.
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
 'cv_inventory','cv_analytics','cv_orders','cv_cash','cv_kitchen') then
 v_where:=v_where||format(' and business_date between %L and %L',p_date_from,p_date_to);
 elsif p_view in ('cv_toast_records','cv_dining_options') then
 -- Retained setup and dining-option configuration can have a NULL business_date.
 -- Keep undated current configuration accessible without inventing a date.
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
