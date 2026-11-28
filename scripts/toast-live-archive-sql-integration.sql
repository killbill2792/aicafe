-- Migration 151: the 15-minute job saves today's finished orders into the same
-- one-record-per-order archive; screens only see them after the 5 AM import.
-- Run ONLY against a disposable local Supabase after all migrations. Synthetic data, rolled back.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(v boolean, note text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'TEST FAILURE: %', note; END IF; END $$;

DO $live$
DECLARE
 b uuid:='eeeeeeee-1111-4eee-8eee-eeeeeeeeee00'; r uuid:='eeeeeeee-1111-4eee-8eee-eeeeeeeeee01';
 loc uuid:='eeeeeeee-1111-4eee-8eee-eeeeeeeeee02'; d date:=current_date;
 ord uuid:='eeeeeeee-1111-4eee-8eee-eeeeeeee0001'; ord2 uuid:='eeeeeeee-1111-4eee-8eee-eeeeeeee0002';
 payment uuid:='eeeeeeee-1111-4eee-8eee-eeeeeeee0014';
 o1 jsonb; o1_tip jsonb; o1_old jsonb; o2 jsonb; o2_import jsonb;
 payment_body jsonb; payment_scope jsonb; payment_revision bigint;
 n integer; row_id uuid; run_i uuid; app_order uuid; app_item uuid; refused boolean;
BEGIN
 insert into public.businesses(id,name,is_demo) values(b,'Live archive test café',false);
 insert into public.locations(id,business_id,name) values(loc,b,'Live archive test location');
 perform public.toast_save_configuration(b,'https://ws-api.toasttab.com','live_client','synthetic_ciphertext',
  jsonb_build_array(jsonb_build_object('location_id',loc,'restaurant_guid',r)));
 update public.toast_location_mappings set verified_at=now() where business_id=b;

 -- A finished order with a student discount on one drink.
 o1:=jsonb_build_object('guid',ord,'modifiedDate','2026-11-03T21:00:00.000+0000',
  'closedDate','2026-11-03T21:00:00.000+0000',
  'numberOfGuests',3,'source','POS','diningOption',jsonb_build_object('name','Dine In'),
  'checks',jsonb_build_array(jsonb_build_object('guid','eeeeeeee-1111-4eee-8eee-eeeeeeee0011',
   'paymentStatus','CLOSED','amount',12.65,'appliedServiceCharges',jsonb_build_array(
    jsonb_build_object('serviceChargeCategory','FUNDRAISING_CAMPAIGN','chargeAmount',1)),
   'selections',jsonb_build_array(jsonb_build_object('guid','eeeeeeee-1111-4eee-8eee-eeeeeeee0012',
    'displayName','Strawberry Matcha','createdDate','2026-11-03T20:55:00.000+0000',
    'quantity',1,'price',7.65,'preDiscountPrice',8.5,'refundDetails',jsonb_build_object('refundAmount',0.40),
    'appliedDiscounts',jsonb_build_array(jsonb_build_object('guid','eeeeeeee-1111-4eee-8eee-eeeeeeee0013',
     'name','Dental Students & Faculty','discountAmount',0.85))),jsonb_build_object('deferred',true,'price',2),
    jsonb_build_object('guid','eeeeeeee-1111-4eee-8eee-eeeeeeee0015','displayName','No recorded sale time','quantity',1,'price',0)),
   'payments',jsonb_build_array(jsonb_build_object('guid','eeeeeeee-1111-4eee-8eee-eeeeeeee0014',
    'type','CREDIT','paymentStatus','CAPTURED','amount',7.65,'tipAmount',1,'refund',jsonb_build_object('refundAmount',1.50))))));
 o1_tip:=jsonb_set(jsonb_set(o1,'{checks,0,payments,0,tipAmount}','2'::jsonb),
  '{modifiedDate}','"2026-11-03T22:00:00.000+0000"'::jsonb);
 o1_old:=jsonb_set(o1,'{modifiedDate}','"2026-11-03T20:00:00.000+0000"'::jsonb);

 -- 1. First live save: one record, no import run, typed details built.
 n:=public.toast_archive_live_orders(b,r,d,jsonb_build_array(o1));
 perform pg_temp.assert_true(n=1,'first live save stores the order, got '||n);
 select id into row_id from public.toast_raw_records where business_id=b and entity_guid=ord;
 perform pg_temp.assert_true((select run_id is null and seen_run_id is null and capture_key like 'live:%'
  from public.toast_raw_records where id=row_id),'a live record has no import run yet');
 perform pg_temp.assert_true((select count(*)=1 and bool_and(run_id is null)
  from public.external_records a cross join lateral public.toast_order_details(a.payload) where a.id=row_id),
  'live details derive from the one provisional archive record');

 -- 2. The same orders again (every 15 minutes): nothing is written.
 n:=public.toast_archive_live_orders(b,r,d,jsonb_build_array(o1));
 perform pg_temp.assert_true(n=0,'an unchanged order is not saved again, got '||n);
 perform pg_temp.assert_true((select count(*)=1 from public.toast_raw_records where business_id=b and entity='order'),
  'still one record');
 perform pg_temp.assert_true(not exists(select 1 from public.toast_raw_changes where business_id=b),
  'no change line when nothing changed');

 -- 3. Screens do not see it: typed details view, organized orders and the discounts view are empty.
 perform pg_temp.assert_true(not exists(select 1 from public.toast_current_typed_order_facts_v where business_id=b),
  'the typed details view shows imported days only');
 perform pg_temp.assert_true(not exists(select 1 from public.orders where business_id=b),
  'the organized orders table is untouched');
 perform pg_temp.assert_true(not exists(select 1 from public.cv_discounts where business_id=b),
  'the discounts view (screens) is untouched');

 -- 4. The AI sees today's discount, labelled provisional.
 perform pg_temp.assert_true((select count(*)=1 and bool_and(status='provisional')
  from public.toast_records_for(b,d,d) where record_type='item_discount'
   and data->>'name'='Dental Students & Faculty'),'the AI reads today''s discount as provisional');
 perform pg_temp.assert_true((select bool_and(status='provisional') from public.toast_records_for(b,d,d)
  where record_type in ('order','check','item','payment')),'every order-derived row is provisional');

 -- 5. A real change (tip added): the same record is updated and one change line is written.
 n:=public.toast_archive_live_orders(b,r,d,jsonb_build_array(o1_tip));
 perform pg_temp.assert_true(n=1,'a changed order is saved, got '||n);
 perform pg_temp.assert_true((select count(*)=1 and bool_and(id=row_id)
  and bool_and((payload->'checks'->0->'payments'->0->>'tipAmount')::int=2)
  from public.toast_raw_records where business_id=b and entity='order'),'the one record holds the new tip');
 perform pg_temp.assert_true((select count(*)=1 from public.toast_raw_changes
  where business_id=b and entity_guid=ord and run_id is null and changes::text like '%tipAmount%'),
  'one change line for the tip');

 -- 6. An older download never replaces newer data.
 n:=public.toast_archive_live_orders(b,r,d,jsonb_build_array(o1_old));
 perform pg_temp.assert_true(n=0 and (select (payload->'checks'->0->'payments'->0->>'tipAmount')::int=2
  from public.toast_raw_records where id=row_id),'an older version is ignored');

 -- 7. A second order saved live, which Toast changes again before closeout.
 o2:=jsonb_build_object('guid',ord2,'modifiedDate','2026-11-03T21:10:00.000+0000','closedDate','2026-11-03T21:10:00.000+0000',
  'checks',jsonb_build_array(jsonb_build_object('guid','eeeeeeee-1111-4eee-8eee-eeeeeeee0021','paymentStatus','CLOSED',
   'payments',jsonb_build_array(jsonb_build_object('guid','eeeeeeee-1111-4eee-8eee-eeeeeeee0022','type','CASH','amount',5,'tipAmount',0)))));
 o2_import:=jsonb_set(jsonb_set(o2,'{checks,0,payments,0,tipAmount}','1'::jsonb),
  '{modifiedDate}','"2026-11-04T01:00:00.000+0000"'::jsonb);
 perform public.toast_archive_live_orders(b,r,d,jsonb_build_array(o2));

 -- 8. The 5 AM import: order 1 unchanged since the last live save, order 2 changed.
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,state)
  values(b,r,'daily','running') returning id into run_i;
 insert into public.toast_day_pages(run_id,business_date,page,payload)
  values(run_i,d,1,jsonb_build_array(o1_tip,o2_import));
 insert into public.toast_day_status(business_id,restaurant_guid,business_date,import_state,
  last_import_run_id,imported_at,unparsed_count)
  values(b,r,d,'imported',run_i,now(),0)
  on conflict(business_id,restaurant_guid,business_date) do update
  set import_state='imported',last_import_run_id=run_i,imported_at=now(),unparsed_count=0;
 perform public.toast_archive_day_pages(run_i,d);
 delete from public.toast_day_pages where run_id=run_i;
 perform pg_temp.assert_true((select count(*)=2 from public.toast_raw_records where business_id=b and entity='order'),
  'the import keeps one record per order: no copies of the live records');
 perform pg_temp.assert_true((select run_id=run_i and seen_run_id=run_i from public.toast_raw_records where id=row_id),
  'the import takes over the live record');
 perform pg_temp.assert_true((select count(*)=1 from public.toast_raw_changes where business_id=b and entity_guid=ord),
  'an unchanged order logs nothing new at import');
 perform pg_temp.assert_true((select count(*)=1 from public.toast_raw_changes
  where business_id=b and entity_guid=ord2 and run_id=run_i),'the import logs order 2''s late change once');
 perform pg_temp.assert_true((select (payload->'checks'->0->'payments'->0->>'tipAmount')::int=1
  from public.toast_raw_records where business_id=b and entity_guid=ord2),'order 2 holds the imported version');
 perform pg_temp.assert_true((select count(*)=2 from public.toast_current_typed_order_facts_v where business_id=b),
  'after the import, the typed details view shows both orders');
 perform pg_temp.assert_true((select count(*)=1 and bool_and(status='actual')
  from public.toast_records_for(b,d,d) where record_type='item_discount'),'after the import the AI reads it as actual');
 perform pg_temp.assert_true((select status='incomplete' and last_complete_scope is null
   from public.external_resources where business_id=b and provider='toast' and resource='order'
    and source_account=r::text),'an imported day without coverage proof stays incomplete');
 update public.toast_day_status set coverage_complete=true
  where business_id=b and restaurant_guid=r and business_date=d;
 perform pg_temp.assert_true((select status='current' and last_complete_scope->>'business_date'=d::text
   from public.external_resources where business_id=b and provider='toast' and resource='order'
    and source_account=r::text),'the verified day publishes its exact archive coverage');

 insert into public.orders(business_id,location_id,pos_order_id,business_date,closed_at,gross_sales_cents,net_sales_cents)
 values(b,loc,'toast:'||r::text||':'||ord::text,d,now(),9999,9999) returning id into app_order;
 insert into public.menu_items(business_id,name,base_name,price_cents,category)
 values(b,'Independent recipe','Independent recipe',750,'drink') returning id into app_item;
 insert into public.order_lines(order_id,menu_item_id,pos_line_id,name,quantity,net_sales_cents,voided,ordered_at)
 values(app_order,app_item,'eeeeeeee-1111-4eee-8eee-eeeeeeee0012','Old copied name',9,9999,false,now()),
  (app_order,null,'eeeeeeee-1111-4eee-8eee-eeeeeeee0015','No recorded sale time',1,0,false,now());
 perform pg_temp.assert_true((select net_sales_cents=815 and guest_count=3 and dining_option='Dine In'
  and data->>'evidence'='committed_order' from public.cv_orders where business_id=b and order_ref=app_order::text),
  'committed source drives order revenue including fundraising, deferred items and payment refunds');
 perform pg_temp.assert_true((select net_sales_cents=725 and quantity=1 and data->>'name'='Strawberry Matcha'
  from public.cv_item_sales where business_id=b and data->>'menu_item_id'=app_item::text),
  'the exact source selection supplies quantity, name and net sales while preserving the recipe ID');
 perform pg_temp.assert_true((select quantity=1 and net_sales_cents=725 from public.cv_item_sales_daily
  where business_id=b and business_date=d and menu_item_id=app_item),
  'the same selection drives the sold item total');
 perform pg_temp.assert_true((select ordered_at=timestamptz '2026-11-03T20:55:00Z'
  and closed_at=timestamptz '2026-11-03T21:00:00Z' from public.cv_item_sales
  where business_id=b and menu_item_id=app_item and order_line_id is not null),
  'source timestamps override copied clock values for elapsed sales windows');
 perform pg_temp.assert_true((select ordered_at is null and closed_at=timestamptz '2026-11-03T21:00:00Z'
  from public.cv_item_sales where business_id=b and menu_item_id is null and order_line_id is not null),
  'a missing original sale time stays unknown even when a stored projection has one');
 perform pg_temp.assert_true(public.toast_committed_order_net_cents('{"checks":[{}]}') is null,
  'a missing original check amount cannot certify zero');

 -- Capture endpoint evidence can supply a fee missing from the order payload.
 perform set_config('request.jwt.claim.role','service_role',true);
 payment_scope:=jsonb_build_object('mode','point','scope',jsonb_build_object('paymentGuid',payment));
 payment_body:=jsonb_build_object('guid',payment,'restaurantGuid',r,'orderGuid',ord2,'amount',7.65,
  'type','CREDIT','paymentStatus','CAPTURED','originalProcessingFee',0);
 payment_revision:=public.external_commit_page(b,'toast',r::text,'orders/v2/payments/{guid}',payment::text,0,
  payment_scope,true,jsonb_build_array(jsonb_build_object('key',payment,'payload',payment_body)));
 perform pg_temp.assert_true(public.toast_apply_archived_payment_fee(b,r,payment,payment_revision)='order_pending',
  'wrong order cannot authorize the fee');
 payment_body:=jsonb_set(payment_body,'{orderGuid}',to_jsonb(ord));
 payment_revision:=public.external_commit_page(b,'toast',r::text,'orders/v2/payments/{guid}',payment::text,payment_revision,
  payment_scope,true,jsonb_build_array(jsonb_build_object('key',payment,'payload',payment_body)));
 perform pg_temp.assert_true(public.toast_apply_archived_payment_fee(b,r,payment,payment_revision-1)='refresh_evidence',
  'a superseded payment receipt cannot update the fee');
 perform pg_temp.assert_true(public.toast_apply_archived_payment_fee(b,r,payment,payment_revision)='applied',
  'a zero provider fee is independently verified');
 perform pg_temp.assert_true((select original_processing_fee_cents=0 and fee_status='actual' from public.toast_payment_facts
  where business_id=b and restaurant_guid=r and business_date=d and payment_ref=payment::text),'zero stays an actual fee');
 perform pg_temp.assert_true((select original_processing_fee_cents=0 and data->>'feeEvidence'='point_observation'
   from public.cv_payments where business_id=b and source_ref='payment:'||r::text||':'||payment::text),
  'one certified payment links the exact order and independent fee');
 perform pg_temp.assert_true((select l.evidence->'targetSelector'->'path'='["checks",0,"payments",0]'::jsonb
  from public.external_record_links l where l.business_id=b and l.relation='order_payment' and l.target_id=row_id),
  'the relationship points to the exact nested payment in the archived order');
 payment_body:=jsonb_set(payment_body,'{originalProcessingFee}','null');
 payment_revision:=public.external_commit_page(b,'toast',r::text,'orders/v2/payments/{guid}',payment::text,payment_revision,
  payment_scope,true,jsonb_build_array(jsonb_build_object('key',payment,'payload',payment_body)));
 perform pg_temp.assert_true(public.toast_apply_archived_payment_fee(b,r,payment,payment_revision)='refresh_evidence',
  'an explicit null cannot supply a fee');
 perform pg_temp.assert_true((select original_processing_fee_cents=0 and data->>'feeEvidence'='historical_projection'
   from public.cv_payments where business_id=b and source_ref='payment:'||r::text||':'||payment::text),
  'a superseded point does not certify the previously verified fee as current');
 payment_body:=jsonb_set(payment_body,'{originalProcessingFee}','0.23');
 payment_revision:=public.external_commit_page(b,'toast',r::text,'orders/v2/payments/{guid}',payment::text,payment_revision,
  payment_scope,true,jsonb_build_array(jsonb_build_object('key',payment,'payload',payment_body)));
 perform pg_temp.assert_true(public.toast_apply_archived_payment_fee(b,r,payment,payment_revision)='applied',
  'matching independently captured fee is applied');
 perform pg_temp.assert_true(public.toast_apply_archived_payment_fee(b,r,payment,payment_revision)='applied',
  'replayed capture evidence is idempotent');
 perform public.external_note_availability(b,'toast',r::text,'orders/v2/payments/{guid}',
   'permission_required',clock_timestamp(),null);
 perform public.external_commit_page(b,'toast',r::text,'orders/v2/payments/{guid}',ord2::text,0,
   jsonb_build_object('mode','point','scope',jsonb_build_object('paymentGuid',ord2)),true,
   jsonb_build_array(jsonb_build_object('key',ord2,'payload',jsonb_set(payment_body,'{guid}',to_jsonb(ord2)))));
 perform pg_temp.assert_true(public.toast_apply_archived_payment_fee(b,r,payment,payment_revision)='refresh_evidence',
  'regaining resource access on another payment leaves the revoked receipt stale');
 payment_revision:=public.external_commit_page(b,'toast',r::text,'orders/v2/payments/{guid}',payment::text,payment_revision,
  payment_scope,true,jsonb_build_array(jsonb_build_object('key',payment,'payload',payment_body)));
 perform pg_temp.assert_true(public.toast_apply_archived_payment_fee(b,r,payment,payment_revision)='applied',
  'another observation of the same payment restores its evidence');
 perform pg_temp.assert_true(not has_function_privilege('authenticated','public.toast_apply_archived_payment_fee(uuid,uuid,uuid,bigint)','EXECUTE'),
  'authenticated users cannot apply an archive fee receipt');
 update public.toast_day_status set imported_at=now()+interval '1 second' where business_id=b and restaurant_guid=r and business_date=d;
 perform pg_temp.assert_true((select original_processing_fee_cents=23 and fee_status='actual' and fee_basis='toast'
  from public.toast_payment_facts where business_id=b and restaurant_guid=r and business_date=d
   and payment_ref='eeeeeeee-1111-4eee-8eee-eeeeeeee0014'),'same captured payment retains provider fee when order copy omits it');
 update public.toast_payment_facts set amount_cents=999999,tip_cents=999999,original_processing_fee_cents=999999
 where business_id=b and restaurant_guid=r and business_date=d and payment_ref=payment::text;
 perform pg_temp.assert_true((select amount_cents=765 and tip_cents=200 and original_processing_fee_cents=23
    and data->>'evidence'='committed_order' and data->>'feeCacheMatches'='false'
   from public.cv_payments where business_id=b and source_ref='payment:'||r::text||':'||payment::text),
  'the canonical payment reader uses original values even when the operational copy differs');
  -- 9. An imported day is final: the live job does not write to it.
 n:=public.toast_archive_live_orders(b,r,d,jsonb_build_array(
  jsonb_set(o1_tip,'{modifiedDate}','"2026-11-05T00:00:00.000+0000"'::jsonb)));
 perform pg_temp.assert_true(n=0 and (select run_id=run_i and payload->>'modifiedDate'='2026-11-03T22:00:00.000+0000'
  from public.toast_raw_records where id=row_id),'the live job never writes to an imported day');

 -- 10. Guards: unverified location, an old date, a page over 100 orders.
 refused:=false;
 begin perform public.toast_archive_live_orders(b,'eeeeeeee-1111-4eee-8eee-eeeeeeeeee99',d,'[]'::jsonb);
 exception when others then refused:=true; end;
 perform pg_temp.assert_true(refused,'an unknown Toast location is refused');
 refused:=false;
 begin perform public.toast_archive_live_orders(b,r,current_date-10,'[]'::jsonb);
 exception when others then refused:=true; end;
 perform pg_temp.assert_true(refused,'an old business day is refused (it belongs to the import)');
 refused:=false;
 begin perform public.toast_archive_live_orders(b,r,d,(select jsonb_agg(jsonb_build_object('i',g)) from generate_series(1,101) g));
 exception when others then refused:=true; end;
 perform pg_temp.assert_true(refused,'a page over 100 orders is refused');
END $live$;

-- The live job never touches a record an import has already staged, even on a day
-- that is not marked imported yet (the import is the authority).
DO $staged$
DECLARE
 b uuid:='eeeeeeee-1111-4eee-8eee-eeeeeeeeee00'; r uuid:='eeeeeeee-1111-4eee-8eee-eeeeeeeeee01';
 d date:=current_date-1; ord uuid:='eeeeeeee-1111-4eee-8eee-eeeeeeee0031'; run_s uuid; n integer;
 v1 jsonb:='{"guid":"eeeeeeee-1111-4eee-8eee-eeeeeeee0031","modifiedDate":"2026-11-02T10:00:00.000+0000","closedDate":"2026-11-02T10:00:00.000+0000","total":5}';
 v2 jsonb:='{"guid":"eeeeeeee-1111-4eee-8eee-eeeeeeee0031","modifiedDate":"2026-11-02T11:00:00.000+0000","closedDate":"2026-11-02T10:00:00.000+0000","total":6}';
BEGIN
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,state)
  values(b,r,'daily','running') returning id into run_s;
 insert into public.toast_day_pages(run_id,business_date,page,payload) values(run_s,d,1,jsonb_build_array(v1));
 perform pg_temp.assert_true((select count(*)=1 and bool_and(seen_run_id=run_s) from public.toast_raw_records
  where business_id=b and entity_guid=ord),'the import staged the order');
 n:=public.toast_archive_live_orders(b,r,d,jsonb_build_array(v2));
 perform pg_temp.assert_true(n=0 and (select (payload->>'total')::int=5 and seen_run_id=run_s
  from public.toast_raw_records where business_id=b and entity_guid=ord),'the staged record is left alone');
 perform pg_temp.assert_true(not exists(select 1 from public.toast_records_for(b,d,d) where order_ref=ord::text),
  'a staged, not yet imported order is not shown as live data');
END $staged$;


-- Canonical writer: one open order, repeat, corrected amount, stale delivery,
-- terminal-page checkpoint and shared current summary. Synthetic, rolled back.
DO $canonical$
DECLARE
 b uuid:='eeeeeeee-1111-4eee-8eee-eeeeeeeeee10';r uuid:='eeeeeeee-1111-4eee-8eee-eeeeeeeeee11';
 loc uuid:='eeeeeeee-1111-4eee-8eee-eeeeeeeeee12';ord uuid:='eeeeeeee-1111-4eee-8eee-eeeeeeeeee13';
 d date:=((now() at time zone 'America/Los_Angeles')-interval '4 hours')::date;
 n uuid; p jsonb; revision jsonb; corrected jsonb; receipt jsonb; snapshot jsonb; historical jsonb;
 s timestamptz:=now()-interval '7 minutes';e timestamptz:=now()-interval '2 minutes';
 refused boolean;
BEGIN
 perform set_config('request.jwt.claim.role','service_role',true);
 insert into public.businesses(id,name,is_demo,timezone) values(b,'Canonical live test',false,'America/Los_Angeles');
 insert into public.locations(id,business_id,name) values(loc,b,'Test location');
 perform public.toast_save_configuration(b,'https://ws-api.toasttab.com','canonical_client','synthetic_ciphertext',
  jsonb_build_array(jsonb_build_object('location_id',loc,'restaurant_guid',r)));
 update public.toast_location_mappings set verified_at=now(),toast_time_zone='America/Los_Angeles',closeout_hour=4 where business_id=b;
 p:=jsonb_build_object('guid',ord,'businessDate',to_char(d,'YYYYMMDD')::integer,'modifiedDate',e,
  'checks',jsonb_build_array(jsonb_build_object('amount',10,'paymentStatus','OPEN')));
 revision:=jsonb_build_object('day',d,'payload',p);
 perform pg_temp.assert_true(public.toast_provisional_dollars_to_cents('1.004999999999'::jsonb)=101
  and public.toast_provisional_dollars_to_cents('-1.004999999999'::jsonb)=-101
  and public.toast_provisional_dollars_to_cents('1.0049999999'::jsonb)=100,
  'provisional rounding keeps Toast parser parity on both sides of a half-cent');
 perform pg_temp.assert_true(public.toast_ingest_order_revisions(b,r,jsonb_build_array(revision))=1,'first canonical order saved');
 perform pg_temp.assert_true(public.toast_ingest_order_revisions(b,r,jsonb_build_array(revision))=0,'identical canonical order ignored');
 perform pg_temp.assert_true(public.toast_changed_order_days(b,r,jsonb_build_array(revision))='[]'::jsonb,'unchanged evidence cannot create another repair');
 corrected:=jsonb_set(jsonb_set(revision,'{payload,modifiedDate}',to_jsonb(e+interval '1 minute')),'{payload,checks,0,amount}','15'::jsonb);
 -- A worker on the previous app version can still send the old projection.
 corrected:=corrected||jsonb_build_object('projection',jsonb_build_object('netSalesCents',999999));
 perform pg_temp.assert_true(public.toast_ingest_order_revisions(b,r,jsonb_build_array(corrected))=1,'new order revision applied');
 perform pg_temp.assert_true(public.toast_ingest_order_revisions(b,r,jsonb_build_array(revision))=0,'older source version ignored');
 perform pg_temp.assert_true((select payload=corrected->'payload' and live_projection is null
  from public.toast_raw_records where business_id=b and entity_guid=ord),
  'canonical ingest retained original JSON without saving a calculated projection');
 n:=public.toast_claim_poll(b,r,'orders');
 receipt:=public.toast_commit_canonical_order_page(b,r,n,s,e,1,'[]'::jsonb,false,d);
 perform pg_temp.assert_true((receipt->>'complete')::boolean,'bootstrap completes');
 receipt:=public.toast_commit_canonical_order_page(b,r,n,s,e,1,'[]'::jsonb,false,null);
 perform pg_temp.assert_true((select canonical_order_poll_at=e and canonical_order_poll_from=s from public.toast_sync_health where business_id=b and restaurant_guid=r),'canonical coverage committed');
 snapshot:=public.toast_refresh_canonical_live(b);
 perform pg_temp.assert_true((snapshot->>'netSalesCents')::integer=1500 and (snapshot->>'openChecks')::integer=1,'shared provisional summary includes revised open order');
 refused:=false;
 begin perform public.toast_commit_canonical_order_page(b,r,gen_random_uuid(),s,e,1,'[]'::jsonb,false,null);
 exception when others then refused:=true;end;
 perform pg_temp.assert_true(refused,'invalid worker lease cannot advance cursor');
 -- A malformed row must not discard valid page-mates or certify the window.
 corrected:=jsonb_set(jsonb_set(corrected,'{payload,modifiedDate}',to_jsonb(e+interval '90 seconds')),'{payload,checks,0,amount}','17'::jsonb);
 receipt:=public.toast_commit_canonical_order_page(b,r,n,e-interval '2 minutes',e+interval '1 minute',1,jsonb_build_array(corrected),false,null,
  jsonb_build_array(jsonb_build_object('order_guid',null,'source_index',2,'raw_sha256',repeat('a',64),'error_path','order_identity_or_business_date')));
 perform pg_temp.assert_true((receipt->>'incomplete')::boolean and not (receipt->>'complete')::boolean,'malformed window not certified');
 perform pg_temp.assert_true((select next_page=1 and jsonb_array_length(unparsed_pages->'1')=1 from public.toast_order_poll_progress where business_id=b and restaurant_guid=r),'durable exception and replay checkpoint');
 perform pg_temp.assert_true((select canonical_order_poll_at=e from public.toast_sync_health where business_id=b and restaurant_guid=r),'coverage stays at last verified window');
 snapshot:=public.toast_refresh_canonical_live(b);
 perform pg_temp.assert_true((snapshot->>'netSalesCents')::integer=1700 and (snapshot->>'truncated')::boolean and (snapshot->>'unparsedOrders')::integer=1,'valid revision remains visible with explicit incomplete evidence');
 receipt:=public.toast_commit_canonical_order_page(b,r,n,e-interval '2 minutes',e+interval '1 minute',1,jsonb_build_array(corrected),false,null);
 perform pg_temp.assert_true((receipt->>'complete')::boolean and not exists(select 1 from public.toast_order_poll_progress where business_id=b and restaurant_guid=r),'corrected replay clears exception');
 perform pg_temp.assert_true((select canonical_order_poll_at=e+interval '1 minute' from public.toast_sync_health where business_id=b and restaurant_guid=r),'only corrected full replay advances coverage');
 p:=jsonb_set(jsonb_set(p,'{guid}',to_jsonb(gen_random_uuid())),'{checks,0,amount}','"invalid"'::jsonb);
 revision:=jsonb_build_object('day',d,'payload',p,'parseFailed',true);
 perform pg_temp.assert_true(public.toast_ingest_order_revisions(b,r,jsonb_build_array(revision))=1,'unparsed provider body is retained');
 snapshot:=public.toast_refresh_canonical_live(b);
 perform pg_temp.assert_true((snapshot->>'netSalesCents')::integer=1700 and (snapshot->>'unparsedOrders')::integer=1,
  'source parse failure is explicit and does not contribute sales');

 p:=jsonb_set(corrected->'payload','{modifiedDate}',to_jsonb(e+interval '100 seconds'));
 perform pg_temp.assert_true(public.toast_archive_live_orders(b,r,d,jsonb_build_array(p))=1,
  'a non-canonical writer observed a newer body');
 snapshot:=public.toast_refresh_canonical_live(b);
 perform pg_temp.assert_true((snapshot->>'truncated')::boolean and (snapshot->>'unparsedOrders')::integer=2,
  'a newer body without canonical validation is explicit incomplete evidence');
 revision:=jsonb_build_object('day',d,'payload',p);
 perform pg_temp.assert_true(public.toast_ingest_order_revisions(b,r,jsonb_build_array(revision))=1,
  'canonical observation validates the newer body already in the archive');

 historical:=public.toast_provisional_order_values(p,r,false)||jsonb_build_object('netSalesCents',1600);
 update public.toast_raw_records set live_projection=historical,
  source_context=jsonb_build_object('toastLegacyProjectionBaseline',payload_sha256)
  where business_id=b and entity_guid=ord;
 perform pg_temp.assert_true(public.toast_ingest_order_revisions(b,r,jsonb_build_array(revision))=0,
  'same-body replay leaves divergent historical evidence authoritative');
 snapshot:=public.toast_refresh_canonical_live(b);
 perform pg_temp.assert_true((snapshot->>'netSalesCents')::integer=1600,'divergent history is readable after replay');
 p:=jsonb_set(jsonb_set(p,'{modifiedDate}',to_jsonb(e+interval '110 seconds')),'{checks,0,amount}','18'::jsonb);
 perform pg_temp.assert_true(public.toast_archive_live_orders(b,r,d,jsonb_build_array(p))=1,
  'an archive-first correction replaced the body beside historical evidence');
 snapshot:=public.toast_refresh_canonical_live(b);
 perform pg_temp.assert_true((snapshot->>'truncated')::boolean and (snapshot->>'unparsedOrders')::integer=2,
  'stale legacy evidence cannot certify the archive-first correction');
 revision:=jsonb_build_object('day',d,'payload',p);
 perform pg_temp.assert_true(public.toast_ingest_order_revisions(b,r,jsonb_build_array(revision))=1,
  'same-body canonical observation admits the archive-first correction');
 snapshot:=public.toast_refresh_canonical_live(b);
 perform pg_temp.assert_true((snapshot->>'netSalesCents')::integer=1800
  and (select live_projection=historical from public.toast_raw_records where business_id=b and entity_guid=ord),
  'new source-backed results preserve the exact divergent history');
END $canonical$;


-- A late correction coalesces durable work. A newer revision cannot be lost
-- while the worker is assembling a checksum-proven local repair.
DO $revision$
DECLARE
 b uuid:='eeeeeeee-1111-4eee-8eee-eeeeeeeeee20';r uuid:='eeeeeeee-1111-4eee-8eee-eeeeeeeeee21';
 loc uuid:='eeeeeeee-1111-4eee-8eee-eeeeeeeeee22';ord uuid:='eeeeeeee-1111-4eee-8eee-eeeeeeeeee23';
 d date:=((now() at time zone 'America/Los_Angeles')-interval '4 hours')::date-2;
 base_run uuid;repair uuid;second uuid;original jsonb;changed jsonb;newer jsonb;orders jsonb;summary jsonb;work jsonb;outcome jsonb;refused boolean;
BEGIN
 perform set_config('request.jwt.claim.role','service_role',true);
 insert into public.businesses(id,name,is_demo,timezone) values(b,'Revision repair test',false,'America/Los_Angeles');
 insert into public.locations(id,business_id,name) values(loc,b,'Revision repair location');
 perform public.toast_save_configuration(b,'https://ws-api.toasttab.com','revision_client','synthetic_ciphertext',
  jsonb_build_array(jsonb_build_object('location_id',loc,'restaurant_guid',r)));
 update public.toast_location_mappings set verified_at=now(),toast_time_zone='America/Los_Angeles',closeout_hour=4 where business_id=b;
 original:=jsonb_build_object('guid',ord,'businessDate',to_char(d,'YYYYMMDD')::integer,
  'modifiedDate',now()-interval '2 days','checks','[]'::jsonb);
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,state,requested_from,requested_to,days_total)
  values(b,r,'daily','running',d,d,1) returning id into base_run;
 perform public.toast_stage_day_page(b,r,base_run,d,1,jsonb_build_array(original));
 summary:=jsonb_build_object('order_count',0,'net_sales_cents',0,'gross_sales_cents',0,'discounts_cents',0,'refunds_cents',0,
  'tax_cents',0,'tip_cents',0,'open_check_count',0,'unparsed_count',0,'service_charges_cents',0,'gratuity_cents',0,
  'warnings','{}'::jsonb,'snapshot_sha256','fixture','voids','[]'::jsonb,'refund_facts','[]'::jsonb,'parsed_order_guids',jsonb_build_array(ord),'unparsed','[]'::jsonb);
 orders:='[]'::jsonb;
 perform public.toast_import_day(b,loc,r,d,orders,summary,base_run);
 changed:=jsonb_set(original,'{modifiedDate}',to_jsonb(now()-interval '2 hours'));
 repair:=public.toast_queue_order_revision(b,r,d,changed,true);
 work:=public.toast_begin_revision_import(b,r,d,repair,false);
 perform pg_temp.assert_true(work->'revision'->>'only'='true','complete prior day selects local revision repair');
 newer:=jsonb_set(changed,'{modifiedDate}',to_jsonb(now()-interval '1 hour'));
 second:=public.toast_queue_order_revision(b,r,d,newer,true);
 perform pg_temp.assert_true(second=repair,'two updates coalesce into one existing run');
 refused:=false;
 begin perform public.toast_commit_revision_day(b,loc,r,d,orders,summary,repair,work->>'token',base_run,jsonb_build_array(jsonb_build_array(changed)));
 exception when serialization_failure then refused:=true;end;
 perform pg_temp.assert_true(refused,'stale source generation cannot commit');
 work:=public.toast_begin_revision_import(b,r,d,repair,false);
 perform pg_temp.assert_true(work->'revision'->'orders'->(ord::text)=newer,'latest complete provider revision retained');
 outcome:=public.toast_commit_revision_day(b,loc,r,d,orders,summary,repair,work->>'token',base_run,jsonb_build_array(jsonb_build_array(newer)));
 perform pg_temp.assert_true((outcome->>'orders')::integer=0,'existing guarded day writer committed local revision');
 perform pg_temp.assert_true((select state='completed' and api_calls=0 and cursor='{}'::jsonb from public.toast_sync_runs where id=repair),'no provider full-day request or retained payload after commit');
 perform pg_temp.assert_true((select count(*)=1 and bool_and(payload=newer) from public.toast_raw_records where business_id=b and entity_guid=ord),'one canonical archive row with latest revision');
 update public.toast_day_status set recon_state='checked_internal',analytics_state='missing'
  where business_id=b and restaurant_guid=r and business_date=d;
 perform pg_temp.assert_true(public.toast_closeout_due(b,r,d,((d+1)::timestamp+interval '12 hours') at time zone 'America/Los_Angeles'),'final payment window remains due after early sales reconciliation');
 insert into public.toast_optional_sync_state(business_id,restaurant_guid,operational_sources)
  values(b,r,jsonb_build_object('final_payments',jsonb_build_object('completed_through',d)))
  on conflict(business_id,restaurant_guid) do update set operational_sources=excluded.operational_sources;
 perform pg_temp.assert_true(not public.toast_closeout_due(b,r,d,((d+1)::timestamp+interval '12 hours') at time zone 'America/Los_Angeles'),'successful day has no more closeout work');
 update public.toast_optional_sync_state set operational_sources=jsonb_set(operational_sources,'{final_payments,pending_details}',
  jsonb_build_array(jsonb_build_object('entry',jsonb_build_object('guid',ord,'adjustment',false),'day',d,'attempts',1,
   'retry_at',((d+1)::timestamp+interval '12 hours 15 minutes') at time zone 'America/Los_Angeles')),true)
  where business_id=b and restaurant_guid=r;
 perform pg_temp.assert_true(not public.toast_closeout_due(b,r,d,((d+1)::timestamp+interval '12 hours') at time zone 'America/Los_Angeles'),'unfinished capture not polled before due');
 perform pg_temp.assert_true(public.toast_closeout_due(b,r,d,((d+1)::timestamp+interval '12 hours 15 minutes') at time zone 'America/Los_Angeles'),'unfinished payment detail remains due after list completion');
 update public.toast_optional_sync_state set operational_sources=jsonb_set(operational_sources,'{final_payments,pending_details,0,retry_at}','null'::jsonb)
  where business_id=b and restaurant_guid=r;
 perform pg_temp.assert_true(not public.toast_closeout_due(b,r,d,((d+1)::timestamp+interval '1 day') at time zone 'America/Los_Angeles'),'exhausted capture evidence remains stored without scheduling another attempt');
 update public.toast_optional_sync_state set operational_sources=operational_sources#-'{final_payments,pending_details}' where business_id=b and restaurant_guid=r;
 perform pg_temp.assert_true(not public.toast_closeout_due(b,r,d,((d+1)::timestamp+interval '12 hours 15 minutes') at time zone 'America/Los_Angeles'),'verified detail completion stops closeout work');
END $revision$;

ROLLBACK;
