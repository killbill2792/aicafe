-- Migration 141: organized Toast tables hold one row per POS object, enforced by
-- the database. Re-importing the same day changes nothing; a repeated item line is
-- refused instead of double counted; repeated refunds on one payment become one row.
-- Run ONLY against a disposable local Supabase after all migrations. Synthetic data, rolled back.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(v boolean, note text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'TEST FAILURE: %', note; END IF; END $$;
SELECT set_config('request.jwt.claim.role','service_role',true);

DO $organized$
DECLARE
 b uuid:='abababab-abab-4bab-8bab-abababab0000'; r uuid:='abababab-abab-4bab-8bab-abababab0001';
 loc uuid:='abababab-abab-4bab-8bab-abababab0002'; d date:='2026-10-21';
 ord text:='toast:abababab-abab-4bab-8bab-abababab0001:abababab-abab-4bab-8bab-ababababa001';
 ord_guid uuid:='abababab-abab-4bab-8bab-ababababa001';
 pay uuid:='abababab-abab-4bab-8bab-ababababa003';
 run_a uuid; run_b uuid; run_c uuid; orders jsonb; dup_lines jsonb; summary jsonb;
 n integer; refused boolean:=false;
BEGIN
 insert into public.businesses(id,name,is_demo) values(b,'Organized keys test café',false);
 insert into public.locations(id,business_id,name) values(loc,b,'Organized keys location');
 perform public.toast_save_configuration(b,'https://ws-api.toasttab.com','organized_client',
  'synthetic_ciphertext',jsonb_build_array(jsonb_build_object('location_id',loc,'restaurant_guid',r)));
 update public.toast_location_mappings set verified_at=now(),toast_time_zone='America/Los_Angeles',
  closeout_hour=4,toast_start_date=d where business_id=b;

 orders:=jsonb_build_array(jsonb_build_object('posOrderId',ord,'closedAt','2026-10-21T18:00:00Z',
  'grossSalesCents',1100,'discountsCents',0,'refundsCents',150,'taxCents',0,'tipCents',0,
  'netSalesCents',950,'lines',jsonb_build_array(
   jsonb_build_object('posLineId','abababab-abab-4bab-8bab-ababababb001','posItemId',null,
    'name','Latte','quantity',1,'netSalesCents',600,'modifiers','[]'::jsonb,'voided',false,
    'category','Coffee'),
   jsonb_build_object('posLineId','abababab-abab-4bab-8bab-ababababb002','posItemId',null,
    'name','Latte','quantity',1,'netSalesCents',500,'modifiers','[]'::jsonb,'voided',false,
    'category','Coffee'))));
 -- Two refunds on the same payment (e.g. a partial refund, then another).
 summary:=jsonb_build_object('net_sales_cents',950,'order_count',1,'gross_sales_cents',1100,
  'discounts_cents',0,'refunds_cents',150,'tax_cents',0,'tip_cents',0,'open_check_count',0,
  'service_charges_cents',0,'gratuity_cents',0,'unparsed_count',0,'warnings','{}'::jsonb,
  'voids','[]'::jsonb,'unparsed','[]'::jsonb,'snapshot_sha256','organized',
  'parsed_order_guids',jsonb_build_array(ord_guid),
  'refund_facts',jsonb_build_array(
   jsonb_build_object('order_guid',ord_guid,'payment_guid',pay,'order_business_date',d,
    'refund_business_date',d,'amount_cents',100),
   jsonb_build_object('order_guid',ord_guid,'payment_guid',pay,'order_business_date',d,
    'refund_business_date','2026-10-22','amount_cents',50)));

 -- Import A.
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,state)
  values(b,r,'daily','running') returning id into run_a;
 perform public.toast_import_day(b,loc,r,d,orders,summary,run_a);
 perform pg_temp.assert_true((select count(*)=1 from public.orders where business_id=b),'one order row');
 perform pg_temp.assert_true((select count(*)=2 and count(distinct l.pos_line_id)=2
  from public.order_lines l join public.orders o on o.id=l.order_id where o.business_id=b),
  'each item line is stored once with its Toast ID');
 perform pg_temp.assert_true((select count(*)=1 and sum(amount_cents)=150
  and max(refund_business_date)='2026-10-22' from public.toast_refund_facts where business_id=b),
  'two refunds on one payment are one row with the total');

 -- Import B: the same day again. Nothing is added.
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,state)
  values(b,r,'daily','running') returning id into run_b;
 perform public.toast_import_day(b,loc,r,d,orders,summary,run_b);
 perform pg_temp.assert_true((select count(*)=1 from public.orders where business_id=b),
  're-import keeps one order row');
 select count(*) into n from public.order_lines l join public.orders o on o.id=l.order_id
  where o.business_id=b;
 perform pg_temp.assert_true(n=2,'re-import keeps two line rows, got '||n);
 perform pg_temp.assert_true((select count(*)=1 and sum(amount_cents)=150
  from public.toast_refund_facts where business_id=b),'re-import keeps one refund row');
 perform pg_temp.assert_true((select net_sales_cents=950 from public.daily_rollups
  where business_id=b and business_date=d),'the day total is unchanged');

 -- Import C: a payload that lists one item line twice is refused, not double counted.
 dup_lines:=jsonb_set(orders,'{0,lines}',(orders->0->'lines')||jsonb_build_array(orders->0->'lines'->0));
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,state)
  values(b,r,'daily','running') returning id into run_c;
 begin
  perform public.toast_import_day(b,loc,r,d,dup_lines,summary,run_c);
 exception when unique_violation then refused:=true;
 end;
 perform pg_temp.assert_true(refused,'a repeated item line is refused');
 select count(*) into n from public.order_lines l join public.orders o on o.id=l.order_id
  where o.business_id=b;
 perform pg_temp.assert_true(n=2,'the refused import left the stored lines as they were, got '||n);

 -- The database itself refuses a second refund row for the same payment.
 refused:=false;
 begin
  insert into public.toast_refund_facts(business_id,restaurant_guid,order_guid,payment_guid,
   order_business_date,refund_business_date,amount_cents)
  values(b,r,ord_guid,pay,d,d,1);
 exception when unique_violation then refused:=true;
 end;
 perform pg_temp.assert_true(refused,'a second refund row for one payment is refused');

 -- Lines from other sources (CSV) have no POS line ID and are not constrained.
 insert into public.order_lines(order_id,name,quantity,net_sales_cents,modifiers,voided)
 select id,'Manual',1,100,'[]'::jsonb,false from public.orders where business_id=b;
 insert into public.order_lines(order_id,name,quantity,net_sales_cents,modifiers,voided)
 select id,'Manual',1,100,'[]'::jsonb,false from public.orders where business_id=b;
END $organized$;

ROLLBACK;
