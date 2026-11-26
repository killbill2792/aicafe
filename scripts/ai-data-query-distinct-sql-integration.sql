-- Universal query PR1: anonymized Toast Nov 2 applied/removed discount shape,
-- expanded across orders and checks. Disposable local Supabase only; ROLLBACK.
-- Run after all migrations with: psql -v ON_ERROR_STOP=1 -f scripts/ai-data-query-distinct-sql-integration.sql
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(v boolean, note text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'TEST FAILURE: %', note; END IF; END $$;
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
 -- Check named groups independently, retaining the expected two types.
 select count(distinct data->>'name') into uses
 from public.toast_records_for(b,d,d)
 where counts_in_sales AND record_type IN ('item_discount','check_discount') AND data->>'name' ilike '%student%';
 perform pg_temp.assert_true(uses=2,'two named discount groups exist');

 -- PR2: the Toast fixture's two business dates prove exact decimal cents.
 with priced as (
  select business_date,sum(round((data->>'price')::numeric*100)::bigint) cents
  from public.toast_records_for(b,prior,d)
  where record_type='item' and counts_in_sales=true
   and jsonb_typeof(data->'price')='number'
  group by business_date
 ) select jsonb_object_agg(business_date::text,cents) into baseline from priced;
 select jsonb_object_agg(business_date::text,cents) into by_name from (
  select business_date,sum(price_cents) cents FROM public.cv_toast_records
  WHERE business_id=b AND business_date BETWEEN prior AND d AND record_type='item' AND counts_in_sales
  GROUP BY business_date) q;
 perform pg_temp.assert_true(by_name=baseline AND (select count(*) from jsonb_object_keys(by_name))=2,
  'Toast item price cents equal direct JSON decimal cents on both dates');

 with discounts as (
  select business_date,sum(round((data->>'discountAmount')::numeric*100)::bigint) cents
  from public.toast_records_for(b,prior,d)
  where record_type in ('item_discount','check_discount') and counts_in_sales=true
   and jsonb_typeof(data->'discountAmount')='number' group by business_date
 ) select jsonb_object_agg(business_date::text,cents) into baseline from discounts;
 select jsonb_object_agg(business_date::text,cents) into by_name from (
  select business_date,sum(discount_amount_cents) cents FROM public.cv_toast_records
  WHERE business_id=b AND business_date BETWEEN prior AND d AND record_type IN ('item_discount','check_discount') AND counts_in_sales
  GROUP BY business_date) q;
 perform pg_temp.assert_true(by_name=baseline AND (select count(*) from jsonb_object_keys(by_name))=2,
  'discount cents exclude removed VOID uses');
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
 perform pg_temp.assert_true(
  (select sum(net_sales_cents) from public.cv_sales_days where business_id=b and business_date=prior)
   = (select sum(net_sales_cents) from public.daily_rollups where business_id=b and business_date=prior)
  AND (select sum(orders_count) from public.cv_sales_days where business_id=b and business_date=prior)
   = (select sum(orders_count) from public.daily_rollups where business_id=b and business_date=prior),
  'screen and canonical SQL day sales cents and order counts match');

END $discounts$;
ROLLBACK;
