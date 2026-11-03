-- Migration 138: archive copies that differ only in the order of Toast's GUID
-- lists are removed; real changes and the latest import's rows are kept.
-- Run ONLY against a disposable local Supabase after all migrations. Synthetic data, rolled back.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(v boolean, note text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'TEST FAILURE: %', note; END IF; END $$;

DO $copies$
DECLARE
 b uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccc00'; r uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccc01';
 loc uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccc02'; d date:='2026-09-16';
 ord uuid:='cccccccc-cccc-4ccc-8ccc-cccccccc0001';
 run_old uuid; run_mid uuid; run_new uuid;
 tax_a jsonb:='{"guid":"0232db49-4d5b-41e9-9b62-9eb64e465182","name":"CA STATE TAX","taxAmount":0.84}';
 tax_b jsonb:='{"guid":"1c2795c0-ef24-455b-b6cb-b2bcc26b70e5","name":"CA COUNTY TAX","taxAmount":0.04}';
 v_old jsonb; v_shuffled jsonb; v_changed jsonb; removed integer;
 id_old uuid; id_shuffled uuid; id_changed uuid;
BEGIN
 if to_regclass('public.toast_location_mappings') is not null then
  execute 'insert into public.businesses(id,name,is_demo) values($1,$2,false)'
   using b,'Copies test café';
  execute 'insert into public.locations(id,business_id,name) values($1,$2,$3)'
   using loc,b,'Copies test location';
  execute 'select public.toast_save_configuration($1,$2,$3,$4,$5)'
   using b,'https://ws-api.toasttab.com','copies_client','synthetic_ciphertext',
   jsonb_build_array(jsonb_build_object('location_id',loc,'restaurant_guid',r));
  execute 'update public.toast_location_mappings set verified_at=now() where business_id=$1' using b;
 else
  insert into public.businesses(id) values(b);
 end if;
 v_old:=jsonb_build_object('guid',ord,'checks',jsonb_build_array(jsonb_build_object(
  'guid','cccccccc-cccc-4ccc-8ccc-cccccccc0002','amount',14,
  'selections',jsonb_build_array(jsonb_build_object('guid','cccccccc-cccc-4ccc-8ccc-cccccccc0003',
   'appliedTaxes',jsonb_build_array(tax_a,tax_b))))));
 -- Same order, Toast returned the tax list the other way round.
 v_shuffled:=jsonb_set(v_old,'{checks,0,selections,0,appliedTaxes}',jsonb_build_array(tax_b,tax_a));
 -- A real change: the check amount.
 v_changed:=jsonb_set(v_old,'{checks,0,amount}','15'::jsonb);
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,state)
  values(b,r,'backfill','running') returning id into run_old;
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,state)
  values(b,r,'backfill','running') returning id into run_mid;
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,state)
  values(b,r,'backfill','running') returning id into run_new;
 insert into public.toast_day_status(business_id,restaurant_guid,business_date,import_state,
  last_import_run_id,imported_at,unparsed_count)
  values(b,r,d,'imported',run_new,now(),0)
  on conflict(business_id,restaurant_guid,business_date) do update
  set import_state='imported',last_import_run_id=run_new,imported_at=now(),unparsed_count=0;
 insert into public.toast_raw_records(business_id,restaurant_guid,entity,entity_guid,business_date,
  payload,payload_sha256,run_id,seen_run_id,capture_key,first_seen,last_seen)
  values(b,r,'order',ord,d,v_old,encode(sha256(convert_to(v_old::text,'UTF8')),'hex'),
   run_old,run_old,'test:old',now()-interval '3 days',now()-interval '3 days') returning id into id_old;
 insert into public.toast_raw_records(business_id,restaurant_guid,entity,entity_guid,business_date,
  payload,payload_sha256,run_id,seen_run_id,capture_key,first_seen,last_seen)
  values(b,r,'order',ord,d,v_changed,encode(sha256(convert_to(v_changed::text,'UTF8')),'hex'),
   run_mid,run_mid,'test:changed',now()-interval '2 days',now()-interval '2 days') returning id into id_changed;
 insert into public.toast_raw_records(business_id,restaurant_guid,entity,entity_guid,business_date,
  payload,payload_sha256,run_id,seen_run_id,capture_key,first_seen,last_seen)
  values(b,r,'order',ord,d,v_shuffled,encode(sha256(convert_to(v_shuffled::text,'UTF8')),'hex'),
   run_new,run_new,'test:shuffled',now()-interval '1 day',now()-interval '1 day') returning id into id_shuffled;
 -- A legacy separate payment row (written before migration 129).
 insert into public.toast_raw_records(business_id,restaurant_guid,entity,entity_guid,business_date,
  payload,payload_sha256,run_id,capture_key)
  values(b,r,'payment',gen_random_uuid(),d,'{}'::jsonb,encode(sha256('x'::bytea),'hex'),run_old,'test:payment');

 perform pg_temp.assert_true(public.toast_stable_json(v_old)=public.toast_stable_json(v_shuffled),
  'a shuffled GUID list is the same content');
 perform pg_temp.assert_true(public.toast_stable_json(v_old)<>public.toast_stable_json(v_changed),
  'a changed amount is different content');

 removed:=public.toast_archive_drop_identical_copies(b,d);
 perform pg_temp.assert_true(removed=1,'exactly the identical older copy is removed, got '||removed);
 perform pg_temp.assert_true(not exists(select 1 from public.toast_raw_records where id=id_old),
  'the older identical copy is gone');
 perform pg_temp.assert_true(exists(select 1 from public.toast_raw_records where id=id_shuffled and run_id=run_new),
  'the latest import keeps its row');
 perform pg_temp.assert_true(exists(select 1 from public.toast_raw_records where id=id_changed),
  'a real change Toast made is kept');
 perform pg_temp.assert_true(not exists(select 1 from public.toast_order_typed_facts where raw_record_id=id_old),
  'typed details of the removed copy go with it');
 perform pg_temp.assert_true(public.toast_archive_drop_identical_copies(b,d)=0,
  'a second run removes nothing');

 -- The latest import's row is never removed, even when an equal row was seen later.
 update public.toast_raw_records set last_seen=now() where id=id_changed;
 insert into public.toast_raw_records(business_id,restaurant_guid,entity,entity_guid,business_date,
  payload,payload_sha256,run_id,seen_run_id,capture_key,first_seen,last_seen)
  values(b,r,'order',ord,d,v_old,encode(sha256(convert_to(v_old::text,'UTF8')),'hex'),
   run_old,run_old,'test:old-again',now(),now()+interval '1 hour');
 perform public.toast_archive_drop_identical_copies(b,d);
 perform pg_temp.assert_true(exists(select 1 from public.toast_raw_records where id=id_shuffled),
  'a row the latest import reads survives a newer equal copy');
 perform pg_temp.assert_true((select count(*)=2 from public.toast_raw_records
  where business_id=b and entity='order'),'one row per distinct version remains');

 -- Rows archived before migration 128 have no seen_run_id; they are removed too.
 insert into public.toast_raw_records(business_id,restaurant_guid,entity,entity_guid,business_date,
  payload,payload_sha256,run_id,seen_run_id,capture_key,first_seen,last_seen)
  values(b,r,'order',ord,d,v_shuffled,encode(sha256(convert_to(v_shuffled::text,'UTF8')),'hex'),
   run_old,null,'test:legacy',now()-interval '5 days',now()-interval '5 days');
 removed:=public.toast_archive_drop_identical_copies(b,d);
 perform pg_temp.assert_true(removed=1,'a legacy copy without seen_run_id is removed, got '||removed);
 perform pg_temp.assert_true(exists(select 1 from public.toast_raw_records where id=id_shuffled),
  'the latest import row is still kept');

 delete from public.toast_raw_records where business_id=b and entity in ('check','payment');
END $copies$;

ROLLBACK;
