-- Migration 140: one current record per order, a change log for real changes,
-- and a database rule that refuses a second row for the same order.
-- Run ONLY against a disposable local Supabase after all migrations. Synthetic data, rolled back.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(v boolean, note text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'TEST FAILURE: %', note; END IF; END $$;

DO $one_record$
DECLARE
 b uuid:='dddddddd-dddd-4ddd-8ddd-dddddddddd00'; r uuid:='dddddddd-dddd-4ddd-8ddd-dddddddddd01';
 loc uuid:='dddddddd-dddd-4ddd-8ddd-dddddddddd02'; d date:='2026-10-21';
 ord uuid:='dddddddd-dddd-4ddd-8ddd-dddddddd0001';
 chk uuid:='dddddddd-dddd-4ddd-8ddd-dddddddd0002';
 pay uuid:='dddddddd-dddd-4ddd-8ddd-dddddddd0003';
 run_a uuid; run_b uuid; run_c uuid;
 page jsonb; changed jsonb; n integer; row_id uuid; log jsonb; refused boolean:=false;
BEGIN
 if to_regclass('public.toast_location_mappings') is not null then
  execute 'insert into public.businesses(id,name,is_demo) values($1,$2,false)'
   using b,'One record test café';
  execute 'insert into public.locations(id,business_id,name) values($1,$2,$3)'
   using loc,b,'One record test location';
  execute 'select public.toast_save_configuration($1,$2,$3,$4,$5)'
   using b,'https://ws-api.toasttab.com','one_record_client','synthetic_ciphertext',
   jsonb_build_array(jsonb_build_object('location_id',loc,'restaurant_guid',r));
  execute 'update public.toast_location_mappings set verified_at=now() where business_id=$1' using b;
 else
  insert into public.businesses(id) values(b);
 end if;
 page:=jsonb_build_array(jsonb_build_object('guid',ord,'modifiedDate','2026-10-21T12:00:00Z',
  'checks',jsonb_build_array(jsonb_build_object('guid',chk,
   'payments',jsonb_build_array(jsonb_build_object('guid',pay,'type','CREDIT',
    'amount',10,'tipAmount',1,'originalProcessingFee',0.33))))));
 changed:=jsonb_set(page,'{0,checks,0,payments,0,tipAmount}','2'::jsonb);

 -- Import A: the order is new.
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
 select id into row_id from public.toast_raw_records where business_id=b and entity='order';
 perform pg_temp.assert_true(row_id is not null,'first import stores the order');

 -- Import B: the same content again. Still one row, now on run B.
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,state)
  values(b,r,'repull_modified','running') returning id into run_b;
 insert into public.toast_day_pages(run_id,business_date,page,payload) values(run_b,d,1,page);
 update public.toast_day_status set last_import_run_id=run_b,imported_at=now()+interval '1 second'
  where business_id=b and restaurant_guid=r and business_date=d;
 perform public.toast_archive_day_pages(run_b,d);
 delete from public.toast_day_pages where run_id=run_b;
 select count(*) into n from public.toast_raw_records where business_id=b and entity='order';
 perform pg_temp.assert_true(n=1,'an unchanged re-import keeps one row, got '||n);
 perform pg_temp.assert_true((select run_id=run_b from public.toast_raw_records where id=row_id),
  'the row belongs to the latest import');
 perform pg_temp.assert_true(not exists(select 1 from public.toast_raw_changes where business_id=b),
  'no change is logged when nothing changed');

 -- Import C: Toast changed the tip. The same row is updated, the change is logged,
 -- and the fee row (written before the archive commit) sees the new tip.
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,state)
  values(b,r,'repull_modified','running') returning id into run_c;
 insert into public.toast_day_pages(run_id,business_date,page,payload) values(run_c,d,1,changed);
 update public.toast_day_status set last_import_run_id=run_c,imported_at=now()+interval '2 seconds'
  where business_id=b and restaurant_guid=r and business_date=d;
 perform pg_temp.assert_true((select count(*)=1 from public.toast_payment_facts
  where business_id=b and business_date=d and tip_cents=200),'fee row uses the changed payment');
 perform public.toast_archive_day_pages(run_c,d);
 delete from public.toast_day_pages where run_id=run_c;
 select count(*) into n from public.toast_raw_records where business_id=b and entity='order';
 perform pg_temp.assert_true(n=1,'a changed order is updated in place, got '||n||' rows');
 perform pg_temp.assert_true((select id=row_id and run_id=run_c
  and (payload->'checks'->0->'payments'->0->>'tipAmount')::int=2
  from public.toast_raw_records where business_id=b and entity='order'),
  'the one row holds the latest version and belongs to the latest import');
 select changes into log from public.toast_raw_changes where business_id=b and entity_guid=ord;
 perform pg_temp.assert_true(jsonb_array_length(log)=1
  and log->0->>'path' like '%tipAmount' and log->0->>'before'='1' and log->0->>'after'='2',
  'the change log says tip 1 -> 2, got '||coalesce(log::text,'nothing'));
 perform pg_temp.assert_true((select count(*)=1 from public.toast_order_typed_facts
  where raw_record_id=row_id and run_id=run_c),'typed details are rebuilt for the latest import');

 -- The database itself refuses a second row for the same order.
 begin
  insert into public.toast_raw_records(business_id,restaurant_guid,entity,entity_guid,business_date,
   payload,payload_sha256,run_id,capture_key)
  values(b,r,'order',ord,d,'{}'::jsonb,repeat('b',64),run_c,'test:second-copy');
 exception when unique_violation then refused:=true;
 end;
 perform pg_temp.assert_true(refused,'a second row for the same order is refused');
END $one_record$;

-- The one-time collapse turns extra versions into change-log lines.
DO $collapse$
DECLARE
 b uuid:='dddddddd-dddd-4ddd-8ddd-dddddddddd00'; r uuid:='dddddddd-dddd-4ddd-8ddd-dddddddddd01';
 d date:='2026-10-22'; ord uuid:='dddddddd-dddd-4ddd-8ddd-dddddddd0011'; run_new uuid; removed integer;
 v1 jsonb:='{"guid":"dddddddd-dddd-4ddd-8ddd-dddddddd0011","total":5}';
 v2 jsonb:='{"guid":"dddddddd-dddd-4ddd-8ddd-dddddddd0011","total":6}';
BEGIN
 -- Rows written before migration 140 could hold several versions of one order.
 drop index public.toast_raw_records_one_order;
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,state)
  values(b,r,'backfill','running') returning id into run_new;
 insert into public.toast_day_status(business_id,restaurant_guid,business_date,import_state,
  last_import_run_id,imported_at,unparsed_count)
  values(b,r,d,'imported',run_new,now(),0);
 insert into public.toast_raw_records(business_id,restaurant_guid,entity,entity_guid,business_date,
  payload,payload_sha256,run_id,capture_key,first_seen,last_seen)
 values(b,r,'order',ord,d,v1,repeat('c',64),null,'test:v1',now()-interval '2 days',now()-interval '2 days'),
  (b,r,'order',ord,d,v1,repeat('d',64),null,'test:v1-copy',now()-interval '1 day',now()-interval '1 day'),
  (b,r,'order',ord,d,v2,repeat('e',64),run_new,'test:v2',now(),now());
 removed:=public.toast_archive_collapse_day(b,d);
 perform pg_temp.assert_true(removed=2,'two extra versions are removed, got '||removed);
 perform pg_temp.assert_true((select count(*)=1 and bool_and(run_id=run_new)
  from public.toast_raw_records where business_id=b and entity_guid=ord),
  'the row the latest import reads is kept');
 perform pg_temp.assert_true((select count(*)=1 from public.toast_raw_changes
  where business_id=b and entity_guid=ord and changes->0->>'path'='.total'),
  'one change line (total 5 -> 6); the identical copy logs nothing');
END $collapse$;

ROLLBACK;
