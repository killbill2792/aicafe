-- Migration 143: staged Toast snapshots (staff, jobs, menu, time entries, voids…) keep
-- one current record per POS object; our own bookkeeping times are not a change; real
-- changes go to the change log; voids are keyed by the voided item.
-- Run ONLY against a disposable local Supabase after all migrations. Synthetic data, rolled back.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(v boolean, note text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'TEST FAILURE: %', note; END IF; END $$;

DO $one_object$
DECLARE
 b uuid:='cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcd0000'; r uuid:='cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcd0001';
 job uuid:='cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcd0010'; ord uuid:='cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcd0020';
 row1 jsonb; n integer; log jsonb; refused boolean:=false;
BEGIN
 insert into public.businesses(id,name,is_demo) values(b,'One object test café',false);
 row1:=jsonb_build_object('business_id',b,'restaurant_guid',r,'job_guid',job,'title','Barista',
  'fetched_at','2026-10-29T07:00:00Z');

 -- Same job downloaded three times; only our fetched_at changes.
 perform public.toast_archive_stage_snapshot(row1,'job','toast_job_directory');
 perform public.toast_archive_stage_snapshot(row1||'{"fetched_at":"2026-10-30T07:00:00Z"}','job','toast_job_directory');
 perform public.toast_archive_stage_snapshot(row1||'{"fetched_at":"2026-10-31T07:00:00Z"}','job','toast_job_directory');
 select count(*) into n from public.toast_raw_records where business_id=b and entity='job';
 perform pg_temp.assert_true(n=1,'repeated downloads keep one job record, got '||n);
 perform pg_temp.assert_true((select payload->>'fetched_at'='2026-10-31T07:00:00Z'
  from public.toast_raw_records where business_id=b and entity='job'),'the record keeps the latest download time');
 perform pg_temp.assert_true(not exists(select 1 from public.toast_raw_changes where business_id=b),
  'a new download time alone is not a change');

 -- A real change: same record, one change line.
 perform public.toast_archive_stage_snapshot(row1||'{"title":"Lead","fetched_at":"2026-11-01T07:00:00Z"}',
  'job','toast_job_directory');
 select count(*) into n from public.toast_raw_records where business_id=b and entity='job';
 perform pg_temp.assert_true(n=1,'a changed job is updated in place, got '||n);
 select changes into log from public.toast_raw_changes where business_id=b and entity_guid=job;
 perform pg_temp.assert_true(jsonb_array_length(log)=1 and log->0->>'path'='.title'
  and log->0->>'before'='Barista' and log->0->>'after'='Lead',
  'the change log says title Barista -> Lead, got '||coalesce(log::text,'nothing'));

 -- Two voided items of one order are two objects, keyed by the item.
 perform public.toast_archive_stage_snapshot(jsonb_build_object('business_id',b,'restaurant_guid',r,
  'order_guid',ord,'selection_guid','cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcd0021','order_business_date','2026-10-01',
  'amount_cents',850),'void','toast_void_facts');
 perform public.toast_archive_stage_snapshot(jsonb_build_object('business_id',b,'restaurant_guid',r,
  'order_guid',ord,'selection_guid','cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcd0022','order_business_date','2026-10-01',
  'amount_cents',750),'void','toast_void_facts');
 perform pg_temp.assert_true((select count(*)=2 and count(distinct entity_guid)=2 and bool_and(entity_guid<>ord)
  from public.toast_raw_records where business_id=b and entity='void'),'each voided item is its own record');

 -- The database refuses a second record for the same object.
 begin
  insert into public.toast_raw_records(business_id,restaurant_guid,entity,entity_guid,business_date,
   payload,payload_sha256,capture_key)
  values(b,r,'job',job,null,'{}'::jsonb,repeat('e',64),'stage:toast_job_directory:second');
 exception when unique_violation then refused:=true;
 end;
 perform pg_temp.assert_true(refused,'a second job record is refused');
END $one_object$;

-- The one-time collapse: re-keys voids, keeps the newest version, logs real changes only.
DO $collapse$
DECLARE
 b uuid:='cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcd0100'; r uuid:='cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcd0101';
 emp uuid:='cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcd0110'; ord uuid:='cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcd0120';
 removed integer;
BEGIN
 drop index public.toast_raw_records_one_object;
 insert into public.businesses(id,name,is_demo) values(b,'Collapse test café',false);
 insert into public.toast_raw_records(business_id,restaurant_guid,entity,entity_guid,business_date,
  payload,payload_sha256,capture_key,first_seen,last_seen)
 values
  (b,r,'employee',emp,null,jsonb_build_object('employee_guid',emp,'name','Sam','fetched_at','1'),
   repeat('1',64),'stage:e:1',now()-interval '3 days',now()-interval '3 days'),
  (b,r,'employee',emp,null,jsonb_build_object('employee_guid',emp,'name','Sam','fetched_at','2'),
   repeat('2',64),'stage:e:2',now()-interval '2 days',now()-interval '2 days'),
  (b,r,'employee',emp,null,jsonb_build_object('employee_guid',emp,'name','Sam B','fetched_at','3'),
   repeat('3',64),'stage:e:3',now()-interval '1 day',now()-interval '1 day'),
  -- Two voided items stored under their order's ID, each twice.
  (b,r,'void',ord,'2026-10-01',jsonb_build_object('order_guid',ord,'selection_guid','cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcd0121','last_seen','1'),
   repeat('4',64),'stage:v:1',now()-interval '2 days',now()),
  (b,r,'void',ord,'2026-10-01',jsonb_build_object('order_guid',ord,'selection_guid','cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcd0121','last_seen','2'),
   repeat('5',64),'stage:v:2',now()-interval '1 day',now()),
  (b,r,'void',ord,'2026-10-01',jsonb_build_object('order_guid',ord,'selection_guid','cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcd0122','last_seen','1'),
   repeat('6',64),'stage:v:3',now()-interval '2 days',now()),
  (b,r,'void',ord,'2026-10-01',jsonb_build_object('order_guid',ord,'selection_guid','cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcd0122','last_seen','2'),
   repeat('7',64),'stage:v:4',now()-interval '1 day',now());
 removed:=public.toast_archive_collapse_snapshots();
 perform pg_temp.assert_true((select count(*)=1 and max(payload->>'name')='Sam B'
  from public.toast_raw_records where business_id=b and entity='employee'),'the newest employee version is kept');
 perform pg_temp.assert_true((select count(*)=2 and count(distinct entity_guid)=2
  from public.toast_raw_records where business_id=b and entity='void'),'voids are re-keyed by item and collapsed');
 perform pg_temp.assert_true((select count(*)=1 from public.toast_raw_changes
  where business_id=b and entity_guid=emp and changes->0->>'path'='.name'),
  'one change line (name Sam -> Sam B); download times log nothing');
 perform pg_temp.assert_true(not exists(select 1 from public.toast_raw_changes where business_id=b and entity='void'),
  'void copies that differ only in our times log nothing');
 perform pg_temp.assert_true(removed>=4,'extra rows are removed, got '||removed);
END $collapse$;

ROLLBACK;
