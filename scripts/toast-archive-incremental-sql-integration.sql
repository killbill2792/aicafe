-- Migration 128: re-importing a Toast day stores only new or changed records.
-- Run ONLY against a disposable local Supabase after all migrations. Synthetic data, rolled back.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(v boolean, note text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'TEST FAILURE: %', note; END IF; END $$;

DO $incremental$
DECLARE
 b uuid; r uuid; loc uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02'; d date:='2026-10-19';
 ord uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001';
 chk uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0002';
 pay uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0003';
 run_a uuid; run_b uuid; run_c uuid; run_d uuid;
 page jsonb; changed jsonb; n integer;
BEGIN
 b:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb00'; r:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01';
 -- A verified Toast location on a full database; a bare business elsewhere.
 if to_regclass('public.toast_location_mappings') is not null then
  execute 'insert into public.businesses(id,name,is_demo) values($1,$2,false)'
   using b,'Archive test café';
  execute 'insert into public.locations(id,business_id,name) values($1,$2,$3)'
   using loc,b,'Archive test location';
  execute 'select public.toast_save_configuration($1,$2,$3,$4,$5)'
   using b,'https://ws-api.toasttab.com','archive_client','synthetic_ciphertext',
   jsonb_build_array(jsonb_build_object('location_id',loc,'restaurant_guid',r));
  execute 'update public.toast_location_mappings set verified_at=now() where business_id=$1' using b;
 else
  insert into public.businesses(id) values(b);
 end if;
 page:=jsonb_build_array(jsonb_build_object('guid',ord,'modifiedDate','2026-10-19T12:00:00Z',
  'checks',jsonb_build_array(jsonb_build_object('guid',chk,
   'payments',jsonb_build_array(jsonb_build_object('guid',pay,'type','CREDIT',
    'amount',10,'tipAmount',1,'originalProcessingFee',0.33))))));
 changed:=jsonb_set(page,'{0,checks,0,payments,0,tipAmount}','2'::jsonb);

 -- Import A: everything is new.
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,state)
  values(b,r,'repull_modified','running') returning id into run_a;
 insert into public.toast_day_pages(run_id,business_date,page,payload) values(run_a,d,1,page);
 insert into public.toast_day_status(business_id,restaurant_guid,business_date,import_state,
  last_import_run_id,imported_at,unparsed_count)
  values(b,r,d,'imported',run_a,now(),0)
  on conflict(business_id,restaurant_guid,business_date) do update
  set import_state='imported',last_import_run_id=run_a,imported_at=now(),unparsed_count=0;
 perform public.toast_archive_day_pages(run_a,d);
 delete from public.toast_day_pages where run_id=run_a;
 select count(*) into n from public.toast_raw_records where business_id=b and business_date=d;
 perform pg_temp.assert_true(n=3,'first import stores order, check and payment once');
 perform pg_temp.assert_true((select count(*)=1 from public.toast_payment_facts
  where business_id=b and business_date=d and tip_cents=100),'first import saves the payment fee row');

 -- Import B: Toast sends the same day again, unchanged. Nothing new is stored,
 -- and the fee trigger (which fires before the archive commit) still sees the payment.
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,state)
  values(b,r,'repull_modified','running') returning id into run_b;
 insert into public.toast_day_pages(run_id,business_date,page,payload) values(run_b,d,1,page);
 update public.toast_day_status set last_import_run_id=run_b,imported_at=now()+interval '1 second'
  where business_id=b and restaurant_guid=r and business_date=d;
 perform pg_temp.assert_true((select count(*)=1 from public.toast_payment_facts
  where business_id=b and business_date=d and tip_cents=100),'unchanged re-import keeps the payment fee row');
 perform public.toast_archive_day_pages(run_b,d);
 delete from public.toast_day_pages where run_id=run_b;
 select count(*) into n from public.toast_raw_records where business_id=b and business_date=d;
 perform pg_temp.assert_true(n=3,'unchanged re-import stores no copies');
 perform pg_temp.assert_true((select bool_and(run_id=run_b) from public.toast_raw_records
  where business_id=b and business_date=d),'unchanged records belong to the latest import');
 perform pg_temp.assert_true((select bool_and(run_id=run_b) from public.toast_order_typed_facts
  where business_id=b and order_guid=ord),'typed order details belong to the latest import');

 -- Import C fails after staging: the last good import (B) stays complete.
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,state)
  values(b,r,'repull_modified','running') returning id into run_c;
 insert into public.toast_day_pages(run_id,business_date,page,payload) values(run_c,d,1,page);
 delete from public.toast_day_pages where run_id=run_c;
 perform pg_temp.assert_true((select bool_and(run_id=run_b) from public.toast_raw_records
  where business_id=b and business_date=d),'a failed import never moves records off the last good import');
 select count(*) into n from public.toast_raw_records where business_id=b and business_date=d;
 perform pg_temp.assert_true(n=3,'a failed import stores no copies');

 -- Import D: Toast changed the tip. Only the changed records are added; the
 -- old version is kept, and the fee row shows the new tip.
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,state)
  values(b,r,'repull_modified','running') returning id into run_d;
 insert into public.toast_day_pages(run_id,business_date,page,payload) values(run_d,d,1,changed);
 update public.toast_day_status set last_import_run_id=run_d,imported_at=now()+interval '2 seconds'
  where business_id=b and restaurant_guid=r and business_date=d;
 perform public.toast_archive_day_pages(run_d,d);
 delete from public.toast_day_pages where run_id=run_d;
 select count(*) into n from public.toast_raw_records where business_id=b and business_date=d;
 perform pg_temp.assert_true(n=6,'a changed order adds one new version of order, check and payment');
 perform pg_temp.assert_true((select count(*)=1 from public.toast_payment_facts
  where business_id=b and business_date=d and tip_cents=200),'fee row uses the changed payment');
 perform pg_temp.assert_true((select count(*)=3 from public.toast_raw_records
  where business_id=b and business_date=d and run_id=run_d),'latest import holds exactly the current versions');
END $incremental$;

ROLLBACK;
