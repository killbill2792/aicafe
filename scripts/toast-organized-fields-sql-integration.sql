-- Migration 145: item timing, payment server and paid time, and order service charges
-- are kept in the organized tables, on import and (once) for history.
-- Run ONLY against a disposable local Supabase after all migrations. Synthetic data, rolled back.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(v boolean, note text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'TEST FAILURE: %', note; END IF; END $$;
SELECT set_config('request.jwt.claim.role','service_role',true);

DO $fields$
DECLARE
 b uuid:='afafafaf-afaf-4faf-8faf-afafafaf0000'; r uuid:='afafafaf-afaf-4faf-8faf-afafafaf0001';
 loc uuid:='afafafaf-afaf-4faf-8faf-afafafaf0002'; d date:='2026-10-21';
 ord uuid:='afafafaf-afaf-4faf-8faf-afafafafa001'; sel uuid:='afafafaf-afaf-4faf-8faf-afafafafb001';
 pay uuid:='afafafaf-afaf-4faf-8faf-afafafafc001'; srv uuid:='afafafaf-afaf-4faf-8faf-afafafafd001';
 old_ord uuid:='afafafaf-afaf-4faf-8faf-afafafafa002';
 old_sel1 uuid:='afafafaf-afaf-4faf-8faf-afafafafb002'; old_sel2 uuid:='afafafaf-afaf-4faf-8faf-afafafafb003';
 old_pay uuid:='afafafaf-afaf-4faf-8faf-afafafafc002';
 run uuid; raw jsonb; old_raw jsonb; old_order_id uuid; n integer;
BEGIN
 insert into public.businesses(id,name,is_demo) values(b,'Organized fields test café',false);
 insert into public.locations(id,business_id,name) values(loc,b,'Organized fields location');
 perform public.toast_save_configuration(b,'https://ws-api.toasttab.com','fields_client','synthetic_ciphertext',
  jsonb_build_array(jsonb_build_object('location_id',loc,'restaurant_guid',r)));
 update public.toast_location_mappings set verified_at=now(),toast_time_zone='America/Los_Angeles',
  closeout_hour=4,toast_start_date=d where business_id=b;

 -- A new import: the staged page (as Toast sent it) and the parser's rows.
 raw:=jsonb_build_array(jsonb_build_object('guid',ord,'businessDate',20261021,
  'modifiedDate','2026-10-21T19:00:00.000+0000','checks',jsonb_build_array(jsonb_build_object(
   'guid','afafafaf-afaf-4faf-8faf-afafafafe001','amount',6,
   'selections',jsonb_build_array(jsonb_build_object('guid',sel,'displayName','Latte','price',6,'quantity',1,
    'createdDate','2026-10-21T18:01:00.000+0000','fulfillmentStatus','READY')),
   'appliedServiceCharges',jsonb_build_array(jsonb_build_object('chargeAmount',0.25,'gratuity',false,
    'serviceChargeCategory','CREDIT_CARD_SURCHARGE')),
   'payments',jsonb_build_array(jsonb_build_object('guid',pay,'type','CREDIT','paymentStatus','CAPTURED',
    'amount',6.25,'tipAmount',1,'server',jsonb_build_object('guid',srv),
    'paidDate','2026-10-21T18:05:00.000+0000'))))));
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,state)
  values(b,r,'daily','running') returning id into run;
 insert into public.toast_day_pages(run_id,business_date,page,payload) values(run,d,1,raw);
 perform public.toast_import_day(b,loc,r,d,
  jsonb_build_array(jsonb_build_object('posOrderId','toast:'||r||':'||ord,'closedAt','2026-10-21T18:05:00Z',
   'grossSalesCents',600,'discountsCents',0,'refundsCents',0,'taxCents',0,'tipCents',100,'netSalesCents',600,
   'serviceChargesCents',25,'gratuityCents',0,
   'lines',jsonb_build_array(jsonb_build_object('posLineId',sel,'posItemId',null,'name','Latte','quantity',1,
    'netSalesCents',600,'modifiers','[]'::jsonb,'voided',false,'category','Coffee',
    'orderedAt','2026-10-21T18:01:00.000Z','fulfillmentStatus','READY')))),
  jsonb_build_object('net_sales_cents',600,'order_count',1,'gross_sales_cents',600,'discounts_cents',0,
   'refunds_cents',0,'tax_cents',0,'tip_cents',100,'open_check_count',0,'service_charges_cents',25,
   'gratuity_cents',0,'unparsed_count',0,'warnings','{}'::jsonb,'snapshot_sha256','fields',
   'voids','[]'::jsonb,'refund_facts','[]'::jsonb,'unparsed','[]'::jsonb,
   'parsed_order_guids',jsonb_build_array(ord)),run);
 perform pg_temp.assert_true((select ordered_at='2026-10-21T18:01:00Z'::timestamptz and fulfillment_status='READY'
  from public.order_lines where pos_line_id=sel::text),'the import keeps item timing and kitchen status');
 perform pg_temp.assert_true((select service_charges_cents=25 and gratuity_cents=0 from public.orders
  where business_id=b and pos_order_id like '%'||ord),'the import keeps the order''s service charges');
 perform pg_temp.assert_true((select server_guid=srv and paid_at='2026-10-21T18:05:00Z'::timestamptz
  from public.toast_payment_summaries where business_id=b and payment_ref=pay::text),
  'the import keeps who took the payment and when');

 -- History: an order imported before these columns (no line IDs, nothing filled).
 old_raw:=jsonb_build_object('guid',old_ord,'businessDate',20261021,'modifiedDate','2026-10-21T20:00:00.000+0000',
  'checks',jsonb_build_array(jsonb_build_object('guid','afafafaf-afaf-4faf-8faf-afafafafe002','amount',8,
   'selections',jsonb_build_array(
    jsonb_build_object('guid',old_sel1,'displayName','Chai','price',4,'quantity',1,
     'createdDate','2026-10-21T19:10:00.000+0000','fulfillmentStatus','READY'),
    jsonb_build_object('guid',old_sel2,'displayName','Chai','price',4,'quantity',1,
     'createdDate','2026-10-21T19:11:00.000+0000','fulfillmentStatus','SENT')),
   'appliedServiceCharges',jsonb_build_array(jsonb_build_object('chargeAmount',1.5,'gratuity',true)),
   'payments',jsonb_build_array(jsonb_build_object('guid',old_pay,'type','CASH','amount',9.5,
    'server',jsonb_build_object('guid',srv),'paidDate','2026-10-21T19:20:00.000+0000')))));
 insert into public.toast_raw_records(business_id,restaurant_guid,entity,entity_guid,business_date,payload,
  payload_sha256,capture_key)
 values(b,r,'order',old_ord,d,old_raw,repeat('a',64),'test:old-order');
 insert into public.orders(business_id,location_id,pos_order_id,closed_at,business_date,gross_sales_cents,
  discounts_cents,refunds_cents,tax_cents,tip_cents,processing_fee_cents,processing_fee_status,net_sales_cents,
  toast_excluded)
 values(b,loc,'toast:'||r||':'||old_ord,'2026-10-21T19:20:00Z',d,800,0,0,0,0,0,'missing',800,false)
 returning id into old_order_id;
 insert into public.order_lines(order_id,name,quantity,net_sales_cents,modifiers,voided)
 values(old_order_id,'Chai',1,400,'[]'::jsonb,false),(old_order_id,'Chai',1,400,'[]'::jsonb,false);
 insert into public.toast_payment_summaries(business_id,restaurant_guid,business_date,payment_ref,
  payment_type,amount_cents,status)
 values(b,r,d,old_pay::text,'CASH',950,'actual');

 -- Toast moved this order once: an older copy is still archived under the previous day.
 insert into public.toast_raw_records(business_id,restaurant_guid,entity,entity_guid,business_date,payload,
  payload_sha256,capture_key)
 values(b,r,'order',old_ord,d-1,old_raw,repeat('b',64),'test:old-order-moved');
 perform public.toast_fill_organized_fields();
 select count(*) into n from public.order_lines where order_id=old_order_id
  and pos_line_id in (old_sel1::text,old_sel2::text) and ordered_at is not null and fulfillment_status is not null;
 perform pg_temp.assert_true(n=2,'older lines get their Toast ID and timing, got '||n);
 perform pg_temp.assert_true((select count(distinct pos_line_id)=2 from public.order_lines where order_id=old_order_id),
  'two identical items get two different IDs');
 perform pg_temp.assert_true((select gratuity_cents=150 and service_charges_cents=0 from public.orders
  where id=old_order_id),'older orders get their gratuity once, not again from a moved copy');
 perform pg_temp.assert_true((select server_guid=srv and paid_at is not null from public.toast_payment_summaries
  where business_id=b and payment_ref=old_pay::text),'older payments get their server and paid time');
 -- Running it again changes nothing.
 perform public.toast_fill_organized_fields();
 perform pg_temp.assert_true((select count(*)=2 from public.order_lines where order_id=old_order_id),
  'the fill adds no rows');
END $fields$;

ROLLBACK;
