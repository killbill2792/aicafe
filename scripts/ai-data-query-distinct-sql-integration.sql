-- Universal query PR1: anonymized Toast Nov 2 applied/removed discount shape,
-- expanded across orders and checks. Disposable local Supabase only; ROLLBACK.
-- Run after all migrations with: psql -v ON_ERROR_STOP=1 -f scripts/ai-data-query-distinct-sql-integration.sql
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(v boolean, note text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'TEST FAILURE: %', note; END IF; END $$;
-- Each answer must equal an independent direct aggregate, regardless of row order.
CREATE FUNCTION pg_temp.assert_parity(
 p_business uuid,p_from date,p_to date,p_filters jsonb,p_groups text[],p_metrics jsonb,
 p_direct_sql text,p_question text
) RETURNS void LANGUAGE plpgsql AS $parity$
DECLARE expected jsonb;actual jsonb;reply jsonb;
BEGIN
 execute p_direct_sql into expected using p_business,p_from,p_to;
 reply:=public.ai_query_view(p_business,'cv_toast_records',null,p_filters,p_groups,
   p_metrics,p_from,p_to,null,100);
 select coalesce(jsonb_agg(e.value order by e.value::text),'[]'::jsonb) into expected
 from jsonb_array_elements(coalesce(expected,'[]'::jsonb)) as e(value);
 select coalesce(jsonb_agg(e.value order by e.value::text),'[]'::jsonb) into actual
 from jsonb_array_elements(reply->'rows') as e(value);
 IF actual IS DISTINCT FROM expected OR reply->>'truncated'<>'false' THEN
  RAISE EXCEPTION 'PARITY FAILED %: expected %, got % (truncated %)',
   p_question,expected,actual,reply->>'truncated';
 END IF;
END $parity$;
DO $discounts$
DECLARE
 b uuid:='eeeeeeee-3333-4eee-8eee-eeeeeeeeee00';
 r uuid:='eeeeeeee-3333-4eee-8eee-eeeeeeeeee01';
 loc uuid:='eeeeeeee-3333-4eee-8eee-eeeeeeeeee02';
 d date;ts text;first_order jsonb;second_order jsonb;response jsonb;by_name jsonb;
 uses bigint;orders bigint;checks bigint;baseline jsonb;prior date;run_i uuid;old_order jsonb;
BEGIN
 insert into public.businesses(id,name,is_demo) values(b,'Query fixture café',false);
 insert into public.locations(id,business_id,name) values(loc,b,'Query fixture location');
 perform public.toast_save_configuration(b,'https://ws-api.toasttab.com','query_fixture','test_ciphertext',
  jsonb_build_array(jsonb_build_object('location_id',loc,'restaurant_guid',r)));
 update public.toast_location_mappings set verified_at=now() where business_id=b;
 select (now() at time zone timezone)::date into d from public.businesses where id=b;
 prior:=d-1;
 ts:=now()::text;
 -- The recorded Toast pattern is preserved: a discount on one selection is VOID
 -- and then applied again. These anonymized orders add another check and order.
 first_order:=jsonb_build_object('guid','eeeeeeee-3333-4eee-8eee-eeeeeeee0001',
  'businessDate',to_char(d,'YYYYMMDD')::integer,'modifiedDate',ts,'closedDate',ts,
  'checks',jsonb_build_array(
   jsonb_build_object('guid','eeeeeeee-3333-4eee-8eee-eeeeeeee0011','paymentStatus','CLOSED',
    'selections',jsonb_build_array(
     jsonb_build_object('guid','eeeeeeee-3333-4eee-8eee-eeeeeeee0021','displayName','Banana Bread Matcha',
      'quantity',1,'price',7.87,'appliedDiscounts',jsonb_build_array(
       jsonb_build_object('guid','eeeeeeee-3333-4eee-8eee-eeeeeeee0031','name','Dental Students & Faculty',
        'discountAmount',0.88,'processingState','VOID'),
       jsonb_build_object('guid','eeeeeeee-3333-4eee-8eee-eeeeeeee0032','name','Dental Students & Faculty',
        'discountAmount',0.88))),
     jsonb_build_object('guid','eeeeeeee-3333-4eee-8eee-eeeeeeee0022','displayName','Cinnamon Roll Matcha',
      'quantity',1,'price',7.87,'appliedDiscounts',jsonb_build_array(
       jsonb_build_object('guid','eeeeeeee-3333-4eee-8eee-eeeeeeee0033','name','Dental Students & Faculty',
        'discountAmount',0.88))))),
   jsonb_build_object('guid','eeeeeeee-3333-4eee-8eee-eeeeeeee0012','paymentStatus','CLOSED',
    'selections',jsonb_build_array(
     jsonb_build_object('guid','eeeeeeee-3333-4eee-8eee-eeeeeeee0023','displayName','Coffee',
      'quantity',1,'price',4,'appliedDiscounts',jsonb_build_array(
       jsonb_build_object('guid','eeeeeeee-3333-4eee-8eee-eeeeeeee0034','name','Dental Students & Faculty',
        'discountAmount',0.4)))))));
 second_order:=jsonb_build_object('guid','eeeeeeee-3333-4eee-8eee-eeeeeeee0002',
  'businessDate',to_char(d,'YYYYMMDD')::integer,'modifiedDate',ts,'closedDate',ts,
  'checks',jsonb_build_array(
   jsonb_build_object('guid','eeeeeeee-3333-4eee-8eee-eeeeeeee0013','paymentStatus','CLOSED',
    'appliedDiscounts',jsonb_build_array(
     jsonb_build_object('guid','eeeeeeee-3333-4eee-8eee-eeeeeeee0035','name','Student Lunch',
      'discountAmount',1)),
    'selections',jsonb_build_array(
     jsonb_build_object('guid','eeeeeeee-3333-4eee-8eee-eeeeeeee0024','displayName','Sandwich',
      'quantity',1,'price',9,'appliedDiscounts',jsonb_build_array(
       jsonb_build_object('guid','eeeeeeee-3333-4eee-8eee-eeeeeeee0036','name','Staff Meal',
        'discountAmount',0.5)))))));
 first_order:=first_order||jsonb_build_object('source','In Store','numberOfGuests',2);
 second_order:=second_order||jsonb_build_object('source','Online','numberOfGuests',1);
 second_order:=jsonb_set(second_order,'{checks,0,selections,0,quantity}','2'::jsonb);
 perform pg_temp.assert_true(public.toast_archive_live_orders(b,r,d,jsonb_build_array(first_order,second_order))=2,
  'two fresh live orders are captured');
 -- Historical imported day, rather than the live feed: compare two dates with
 -- different evidence status and data shapes. This is still the same archive.
 old_order:=jsonb_build_object('guid','eeeeeeee-3333-4eee-8eee-eeeeeeee0003',
  'businessDate',to_char(prior,'YYYYMMDD')::integer,'modifiedDate',ts,'closedDate',ts,
  'source','Online','numberOfGuests',3,'checks',jsonb_build_array(
  jsonb_build_object('guid','eeeeeeee-3333-4eee-8eee-eeeeeeee0014',
   'paymentStatus','CLOSED','appliedDiscounts',jsonb_build_array(
    jsonb_build_object('guid','eeeeeeee-3333-4eee-8eee-eeeeeeee0037',
     'name','Student Lunch','discountAmount',1),
    jsonb_build_object('guid','eeeeeeee-3333-4eee-8eee-eeeeeeee0038',
     'name','Student Lunch','discountAmount',1,'processingState','VOID')),
   'selections',jsonb_build_array(
    jsonb_build_object('guid','eeeeeeee-3333-4eee-8eee-eeeeeeee0025',
     'displayName','Muffin','quantity',2,'price',4,'appliedDiscounts',jsonb_build_array(
      jsonb_build_object('guid','eeeeeeee-3333-4eee-8eee-eeeeeeee0039',
       'name','Dental Students & Faculty','discountAmount',0.4))),
    jsonb_build_object('guid','eeeeeeee-3333-4eee-8eee-eeeeeeee0026',
     'quantity',1,'price',3)))));
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,state)
 values(b,r,'daily','running') returning id into run_i;
 insert into public.toast_day_pages(run_id,business_date,page,payload)
 values(run_i,prior,1,jsonb_build_array(old_order));
 insert into public.toast_day_status(business_id,restaurant_guid,business_date,import_state,
  last_import_run_id,imported_at,unparsed_count)
 values(b,r,prior,'imported',run_i,now(),0);
 perform public.toast_archive_day_pages(run_i,prior);
 perform pg_temp.assert_true((select count(*)=2 from public.toast_records_for(b,prior,prior)
  where record_type in ('item_discount','check_discount') and counts_in_sales=true and status='actual'),
  'historical day must contain two imported discount uses, not an empty comparison');
 with valid as (
  select * from public.toast_records_for(b,d,d)
  where counts_in_sales=true and record_type in ('item_discount','check_discount')
   and data->>'name' ilike '%student%'
 )
 select count(*),count(distinct order_ref),count(distinct check_ref)
 into uses,orders,checks from valid;
 perform pg_temp.assert_true(uses=4 and orders=2 and checks=3,
  format('database truth expected four uses/two orders/three checks, got %s/%s/%s',uses,orders,checks));
 perform pg_temp.assert_true((select count(*)=1 from public.toast_records_for(b,d,d)
  where record_type='item_discount' and data->>'processingState'='VOID'
   and counts_in_sales=false),'removed discount is retained but not counted');
 response:=public.ai_query_view(b,'cv_toast_records',null,
  '[{"column":"record_type","op":"in","value":["item_discount","check_discount"]},
    {"column":"counts_in_sales","op":"=","value":true},
    {"column":"data.name","op":"ilike","value":"%student%"}]'::jsonb,
  null,'[{"fn":"count","column":"source_ref"},{"fn":"count_distinct","column":"order_ref"},
   {"fn":"count_distinct","column":"check_ref"}]'::jsonb,d,d,null,20);
 perform pg_temp.assert_true(
  (response->'rows'->0->>'count_source_ref')::bigint=uses
  and (response->'rows'->0->>'count_distinct_order_ref')::bigint=orders
  and (response->'rows'->0->>'count_distinct_check_ref')::bigint=checks,
  'AI query exactly matches direct database aggregate');
 perform pg_temp.assert_true(response->>'hasIncomplete'='true'
   and response->>'currentDayIncomplete'='true',
   'partial current day is explicitly marked provisional and incomplete');
 with valid as (
  select data->>'name' name,order_ref,check_ref from public.toast_records_for(b,d,d)
  where counts_in_sales=true and record_type in ('item_discount','check_discount')
   and data->>'name' ilike '%student%'
 ), per_name as (
  select name,count(*) use_n,count(distinct order_ref) order_n,count(distinct check_ref) check_n
  from valid group by name
 )
 select jsonb_object_agg(name,jsonb_build_object('uses',use_n,'orders',order_n,'checks',check_n))
 into baseline from per_name;
 response:=public.ai_query_view(b,'cv_toast_records',null,
  '[{"column":"record_type","op":"in","value":["item_discount","check_discount"]},
    {"column":"counts_in_sales","op":"=","value":true},
    {"column":"data.name","op":"ilike","value":"%student%"}]'::jsonb,
  array['data.name'],'[{"fn":"count","column":"source_ref"},
   {"fn":"count_distinct","column":"order_ref"},{"fn":"count_distinct","column":"check_ref"}]'::jsonb,
  d,d,null,20);
 select coalesce(jsonb_object_agg(row->>'data.name',
  jsonb_build_object('uses',(row->>'count_source_ref')::bigint,
    'orders',(row->>'count_distinct_order_ref')::bigint,
    'checks',(row->>'count_distinct_check_ref')::bigint)),'{}'::jsonb)
 into by_name from jsonb_array_elements(response->'rows') row;
 perform pg_temp.assert_true(by_name=baseline and (select count(*) from jsonb_object_keys(by_name))=2,
  'named discount groups exactly match direct SQL');
 -- New owner acceptance gate: questions not hand-picked for student discounts.
 perform pg_temp.assert_parity(b,prior,d,
  '[{"column":"record_type","op":"in","value":["check_discount","item_discount"]}, {"column":"counts_in_sales","op":"=","value":true}]',
  null,
  '[{"fn":"count","column":"source_ref"}, {"fn":"count_distinct","column":"data.name"}]',
  $sql$select jsonb_agg(to_jsonb(q)) from (select count(source_ref) count_source_ref,count(distinct data->>'name') "count_distinct_data.name" from public.toast_records_for($1,$2,$3) where record_type in ('check_discount','item_discount') and counts_in_sales=true) q$sql$,
  'Unplanned: how many different discount names vs total uses?');
 perform pg_temp.assert_parity(b,prior,d,
  '[{"column":"record_type","op":"in","value":["check_discount","item_discount"]}, {"column":"counts_in_sales","op":"=","value":true}]',
  array['business_date','data.name'],
  '[{"fn":"count","column":"source_ref"},{"fn":"count_distinct","column":"order_ref"}]',
  $sql$select jsonb_agg(to_jsonb(q)) from (select business_date,data->>'name' "data.name", count(source_ref) count_source_ref,count(distinct order_ref) count_distinct_order_ref from public.toast_records_for($1,$2,$3) where record_type in ('check_discount','item_discount') and counts_in_sales=true group by business_date,data->>'name') q$sql$,
  'Unplanned: which discounts were applied on each day?');
 perform pg_temp.assert_parity(b,prior,d,
  '[{"column":"record_type","op":"=","value":"item_discount"}, {"column":"counts_in_sales","op":"=","value":true}, {"column":"data.name","op":"ilike","value":"%student%"}]',
  array['data.item_ref','data.name'],
  '[{"fn":"count","column":"source_ref"},{"fn":"count_distinct","column":"check_ref"}]',
  $sql$select jsonb_agg(to_jsonb(q)) from (select data->>'item_ref' "data.item_ref",data->>'name' "data.name", count(source_ref) count_source_ref,count(distinct check_ref) count_distinct_check_ref from public.toast_records_for($1,$2,$3) where record_type='item_discount' and counts_in_sales=true and data->>'name' ilike '%student%' group by data->>'item_ref',data->>'name') q$sql$,
  'Unplanned: which exact items received a student discount, by type?');
 perform pg_temp.assert_parity(b,prior,d,
  '[{"column":"record_type","op":"=","value":"item"}, {"column":"counts_in_sales","op":"=","value":true}]',
  array['business_date'],
  '[{"fn":"count_distinct","column":"record_ref"},{"fn":"sum","column":"data.quantity"}]',
  $sql$select jsonb_agg(to_jsonb(q)) from (select business_date,count(distinct record_ref) count_distinct_record_ref, sum((data->>'quantity')::numeric) "sum_data.quantity" from public.toast_records_for($1,$2,$3) where record_type='item' and counts_in_sales=true group by business_date) q$sql$,
  'Unplanned: how many selections versus how many units by day?');
 perform pg_temp.assert_parity(b,prior,d,
  '[{"column":"record_type","op":"=","value":"item"}, {"column":"counts_in_sales","op":"=","value":true}, {"column":"data.quantity","op":">=","value":2}]',
  array['data.displayName'],
  '[{"fn":"sum","column":"data.quantity"},{"fn":"count","column":"source_ref"}]',
  $sql$select jsonb_agg(to_jsonb(q)) from (select data->>'displayName' "data.displayName", sum((data->>'quantity')::numeric) "sum_data.quantity",count(source_ref) count_source_ref from public.toast_records_for($1,$2,$3) where record_type='item' and counts_in_sales=true and (data->>'quantity')::numeric>=2 group by data->>'displayName') q$sql$,
  'Unplanned: which items were ordered in quantities of at least two?');
 perform pg_temp.assert_parity(b,prior,d,
  '[{"column":"record_type","op":"=","value":"order"}, {"column":"counts_in_sales","op":"=","value":true}, {"column":"data.source","op":"in","value":["Online","In Store"]}]',
  array['business_date','data.source'],
  '[{"fn":"count_distinct","column":"record_ref"}]',
  $sql$select jsonb_agg(to_jsonb(q)) from (select business_date,data->>'source' "data.source", count(distinct record_ref) count_distinct_record_ref from public.toast_records_for($1,$2,$3) where record_type='order' and counts_in_sales=true and data->>'source' in ('Online','In Store') group by business_date,data->>'source') q$sql$,
  'Unplanned: how did Online and In Store order counts differ by day?');
 perform pg_temp.assert_parity(b,prior,d,
  '[{"column":"record_type","op":"=","value":"order"}, {"column":"counts_in_sales","op":"=","value":true}]',
  array['business_date'],
  '[{"fn":"sum","column":"data.numberOfGuests"},{"fn":"count","column":"source_ref"}]',
  $sql$select jsonb_agg(to_jsonb(q)) from (select business_date,sum((data->>'numberOfGuests')::numeric) "sum_data.numberOfGuests", count(source_ref) count_source_ref from public.toast_records_for($1,$2,$3) where record_type='order' and counts_in_sales=true group by business_date) q$sql$,
  'Unplanned: how many recorded guests, compared with orders, each day?');
 perform pg_temp.assert_parity(b,prior,d,
  '[{"column":"record_type","op":"=","value":"item"}, {"column":"counts_in_sales","op":"=","value":true}, {"column":"data.displayName","op":"is_null","value":null}]',
  array['business_date'],
  '[{"fn":"count","column":"source_ref"}]',
  $sql$select jsonb_agg(to_jsonb(q)) from (select business_date,count(source_ref) count_source_ref from public.toast_records_for($1,$2,$3) where record_type='item' and counts_in_sales=true and data->>'displayName' is null group by business_date) q$sql$,
  'Unplanned: how many selections have no recorded item name?');
 perform pg_temp.assert_parity(b,prior,d,
  '[{"column":"record_type","op":"=","value":"item"}, {"column":"counts_in_sales","op":"=","value":true}, {"column":"data.displayName","op":"is_not_null","value":null}]',
  array['data.displayName'],
  '[{"fn":"avg","column":"data.quantity"},{"fn":"min","column":"data.quantity"}, {"fn":"max","column":"data.quantity"}]',
  $sql$select jsonb_agg(to_jsonb(q)) from (select data->>'displayName' "data.displayName", avg((data->>'quantity')::numeric) "avg_data.quantity", min((data->>'quantity')::numeric) "min_data.quantity", max((data->>'quantity')::numeric) "max_data.quantity" from public.toast_records_for($1,$2,$3) where record_type='item' and counts_in_sales=true and data->>'displayName' is not null group by data->>'displayName') q$sql$,
  'Unplanned: what are the average, smallest and largest selection quantities?');
 perform pg_temp.assert_parity(b,prior,d,
  '[{"column":"record_type","op":"in","value":["check_discount","item_discount"]}, {"column":"counts_in_sales","op":"=","value":true}, {"column":"data.name","op":"ilike","value":"%student%"}]',
  array['business_date'],
  '[{"fn":"count","column":"source_ref"},{"fn":"count_distinct","column":"order_ref"}]',
  $sql$select jsonb_agg(to_jsonb(q)) from (select business_date,count(source_ref) count_source_ref, count(distinct order_ref) count_distinct_order_ref from public.toast_records_for($1,$2,$3) where record_type in ('check_discount','item_discount') and counts_in_sales=true and data->>'name' ilike '%student%' group by business_date) q$sql$,
  'Unplanned: did more orders receive student discounts on either day?');
 response:=public.ai_query_view(b,'cv_toast_records',array['data'],
  '[{"column":"record_type","op":"=","value":"item_discount"}]'::jsonb,
  null,null,d,d,null,100);
 perform pg_temp.assert_true(octet_length((response->'rows')::text)<=6000,
  'database output byte cap');

 -- PR2: the Toast fixture's two business dates prove exact decimal cents.
 with priced as (
  select business_date,sum(round((data->>'price')::numeric*100)::bigint) cents
  from public.toast_records_for(b,prior,d)
  where record_type='item' and counts_in_sales=true
   and jsonb_typeof(data->'price')='number'
  group by business_date
 ) select jsonb_object_agg(business_date::text,cents) into baseline from priced;
 response:=public.ai_query_view(b,'cv_toast_records',null,
  '[{"column":"record_type","op":"=","value":"item"},
    {"column":"counts_in_sales","op":"=","value":true}]'::jsonb,
  array['business_date'],'[{"fn":"sum","column":"price_cents"}]'::jsonb,prior,d,null,100);
 select jsonb_object_agg(row->>'business_date',(row->>'sum_price_cents')::bigint)
 into by_name from jsonb_array_elements(response->'rows') row;
 perform pg_temp.assert_true(by_name=baseline
  and (select count(*) from jsonb_object_keys(by_name))=2
  and response->'sourceMix'->>'toast' is not null,
  'Toast item price cents equal direct JSON DECIMAL cents on both dates');

 with discounts as (
  select business_date,sum(round((data->>'discountAmount')::numeric*100)::bigint) cents
  from public.toast_records_for(b,prior,d)
  where record_type in ('item_discount','check_discount') and counts_in_sales=true
   and jsonb_typeof(data->'discountAmount')='number' group by business_date
 ) select jsonb_object_agg(business_date::text,cents) into baseline from discounts;
 response:=public.ai_query_view(b,'cv_toast_records',null,
  '[{"column":"record_type","op":"in","value":["item_discount","check_discount"]},
    {"column":"counts_in_sales","op":"=","value":true}]'::jsonb,
  array['business_date'],'[{"fn":"sum","column":"discount_amount_cents"}]'::jsonb,prior,d,null,100);
 select jsonb_object_agg(row->>'business_date',(row->>'sum_discount_amount_cents')::bigint)
 into by_name from jsonb_array_elements(response->'rows') row;
 perform pg_temp.assert_true(by_name=baseline
  and (select count(*) from jsonb_object_keys(by_name))=2
  and response->>'hasIncomplete'='true' and response->>'currentDayIncomplete'='true',
  'discount cents exclude removed VOID uses and keep provisional day label');
 perform pg_temp.assert_true(
  (select bool_and(price_cents is null) from public.cv_toast_records
   where business_id=b and business_date=d and record_type='item_discount'),
  'a missing price stays null, not zero');
 -- The synthetic screen rollup here uses fixture-derived exact integer cents.
 -- This tests read parity, NOT production Toast net-sales/import accounting.
 insert into public.daily_rollups(
  business_id,business_date,net_sales_cents,orders_count,drinks_count,
  ingredients_cents,staff_wages_cents,staff_tax_cents,card_fees_cents,voids_cents,sales_data_status)
 select b,prior,
  coalesce(sum(price_cents),0)::bigint - coalesce(sum(discount_amount_cents),0)::bigint,
  count(distinct order_ref) filter(where record_type='order')::integer,
  0,0,0,0,0,0,'actual'
 from public.cv_toast_records
 where business_id=b and business_date=prior and counts_in_sales=true;
 response:=public.ai_query_view(b,'cv_sales_days',null,null,array['business_date'],
  '[{"fn":"sum","column":"net_sales_cents"},{"fn":"sum","column":"orders_count"}]'::jsonb,
  prior,prior,null,100);
 perform pg_temp.assert_true(
  (response->'rows'->0->>'sum_net_sales_cents')::bigint =
   (select sum(net_sales_cents) from public.daily_rollups where business_id=b and business_date=prior)
  and (response->'rows'->0->>'sum_net_sales_cents')::bigint =
   (select sum(net_sales_cents) from public.cv_sales_days where business_id=b and business_date=prior)
  and (response->'rows'->0->>'sum_orders_count')::integer =
   (select sum(orders_count) from public.daily_rollups where business_id=b and business_date=prior)
  and response->'sourceMix'='{"app":1}'::jsonb,
  'chat/screen/database day sales cents and order counts match with app source label');
 response:=public.ai_query_view(b,'cv_sales_days',null,null,array['business_date'],
  '[{"fn":"sum","column":"net_sales_cents"}]'::jsonb,prior,d,null,100);
 perform pg_temp.assert_true(response->>'currentDayIncomplete'='true',
  'including today is still incomplete even with only historical rollup rows');

END $discounts$;
ROLLBACK;
