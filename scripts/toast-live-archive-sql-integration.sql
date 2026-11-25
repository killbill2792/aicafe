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
 o1 jsonb; o1_tip jsonb; o1_old jsonb; o2 jsonb; o2_import jsonb;
 n integer; row_id uuid; run_i uuid; refused boolean;
BEGIN
 insert into public.businesses(id,name,is_demo) values(b,'Live archive test café',false);
 insert into public.locations(id,business_id,name) values(loc,b,'Live archive test location');
 perform public.toast_save_configuration(b,'https://ws-api.toasttab.com','live_client','synthetic_ciphertext',
  jsonb_build_array(jsonb_build_object('location_id',loc,'restaurant_guid',r)));
 update public.toast_location_mappings set verified_at=now() where business_id=b;

 -- A finished order with a student discount on one drink.
 o1:=jsonb_build_object('guid',ord,'modifiedDate','2026-11-03T21:00:00.000+0000',
  'closedDate','2026-11-03T21:00:00.000+0000',
  'checks',jsonb_build_array(jsonb_build_object('guid','eeeeeeee-1111-4eee-8eee-eeeeeeee0011',
   'paymentStatus','CLOSED',
   'selections',jsonb_build_array(jsonb_build_object('guid','eeeeeeee-1111-4eee-8eee-eeeeeeee0012',
    'displayName','Strawberry Matcha','quantity',1,'price',7.65,'preDiscountPrice',8.5,
    'appliedDiscounts',jsonb_build_array(jsonb_build_object('guid','eeeeeeee-1111-4eee-8eee-eeeeeeee0013',
     'name','Dental Students & Faculty','discountAmount',0.85)))),
   'payments',jsonb_build_array(jsonb_build_object('guid','eeeeeeee-1111-4eee-8eee-eeeeeeee0014',
    'type','CREDIT','amount',7.65,'tipAmount',1)))));
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
  from public.toast_order_typed_facts where raw_record_id=row_id),'typed details are built for the live record');

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
 n uuid; p jsonb; projection jsonb; revision jsonb; corrected jsonb; receipt jsonb; snapshot jsonb;
 s timestamptz:=now()-interval '7 minutes';e timestamptz:=now()-interval '2 minutes';
 refused boolean;
BEGIN
 perform set_config('request.jwt.claim.role','service_role',true);
 insert into public.businesses(id,name,is_demo,timezone) values(b,'Canonical live test',false,'America/Los_Angeles');
 insert into public.locations(id,business_id,name) values(loc,b,'Test location');
 perform public.toast_save_configuration(b,'https://ws-api.toasttab.com','canonical_client','synthetic_ciphertext',
  jsonb_build_array(jsonb_build_object('location_id',loc,'restaurant_guid',r)));
 update public.toast_location_mappings set verified_at=now(),toast_time_zone='America/Los_Angeles',closeout_hour=4 where business_id=b;
 p:=jsonb_build_object('guid',ord,'businessDate',to_char(d,'YYYYMMDD')::integer,'modifiedDate',e,'checks','[]'::jsonb);
 projection:='{"netSalesCents":1000,"grossSalesCents":1000,"discountsCents":0,"refundsCents":0,"tipCents":0,"orders":1,"openChecks":1,"unparsedOrders":0,"items":[],"observedAt":null}'::jsonb;
 revision:=jsonb_build_object('day',d,'payload',p,'projection',projection);
 perform pg_temp.assert_true(public.toast_ingest_order_revisions(b,r,jsonb_build_array(revision))=1,'first canonical order saved');
 perform pg_temp.assert_true(public.toast_ingest_order_revisions(b,r,jsonb_build_array(revision))=0,'identical canonical order ignored');
 perform pg_temp.assert_true(public.toast_changed_order_days(b,r,jsonb_build_array(revision))='[]'::jsonb,'unchanged evidence cannot create another repair');
 corrected:=jsonb_set(jsonb_set(revision,'{payload,modifiedDate}',to_jsonb(e+interval '1 minute')),'{projection,netSalesCents}','1500'::jsonb);
 perform pg_temp.assert_true(public.toast_ingest_order_revisions(b,r,jsonb_build_array(corrected))=1,'new order revision applied');
 perform pg_temp.assert_true(public.toast_ingest_order_revisions(b,r,jsonb_build_array(revision))=0,'older source version ignored');
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
END $revision$;

ROLLBACK;
