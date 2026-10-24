\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert(ok boolean,message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Toast PR2: %',message;END IF;END $$;

SELECT pg_temp.assert(NOT has_table_privilege('anon','public.toast_rollup_refresh_jobs','INSERT'),
 'browser cannot enqueue rollup jobs');
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.toast_rollup_refresh_jobs','UPDATE'),
 'browser cannot change rollup jobs');
SELECT pg_temp.assert(NOT has_function_privilege('authenticated',
 'public.toast_ack_rollup_refresh(uuid,date,uuid)','EXECUTE'),
 'browser cannot acknowledge an imported day');
SELECT pg_temp.assert(NOT has_function_privilege('anon',
 'public.toast_queue_backfill(uuid,uuid,date,date)','EXECUTE'),
 'anonymous backfill blocked');

SELECT set_config('request.jwt.claim.role','service_role',true);
INSERT INTO public.businesses(id,name,is_demo)
VALUES('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Toast PR2 isolated coverage',false);
INSERT INTO public.locations(id,business_id,name) VALUES
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbba001',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','North'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbba002',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','South');
SELECT public.toast_save_configuration(
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','https://ws-api.toasttab.com',
 'test','not-a-secret',
 '[{"location_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbba001",
 "restaurant_guid":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001"},
 {"location_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbba002",
 "restaurant_guid":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0002"}]'::jsonb);
UPDATE public.toast_location_mappings
SET verified_at=now(),toast_time_zone='America/Los_Angeles',closeout_hour=4,
 toast_start_date=CASE WHEN location_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbba001'
 THEN '2026-10-01'::date ELSE '2026-10-10'::date END
WHERE business_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

-- Before the South location becomes eligible, North alone proves these dates.
INSERT INTO public.toast_day_status(business_id,restaurant_guid,business_date,
 import_state,coverage_complete,imported_at)
VALUES
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001','2026-10-05','imported',true,now()),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001','2026-10-06','imported',true,now()),
 -- South has a proven historical day but no proof for the preceding day.
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0002','2026-10-06','imported',true,now());
INSERT INTO public.daily_rollups(business_id,business_date,
 net_sales_cents,orders_count,drinks_count,ingredients_cents,staff_wages_cents,
 staff_tax_cents,card_fees_cents,voids_cents,sales_data_status)
VALUES
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','2026-10-05',1000,1,1,0,0,0,0,0,'actual'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','2026-10-06',2000,2,2,0,0,0,0,0,'actual');

-- The start-date shift and invalidation MUST commit atomically.
SELECT public.toast_queue_backfill('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0002','2026-10-05','2026-10-06');
SELECT pg_temp.assert((SELECT toast_start_date='2026-10-05' FROM
 public.toast_location_mappings WHERE business_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
 AND restaurant_guid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0002'),
 'start lowered to requested backfill first day');
SELECT pg_temp.assert((SELECT sales_data_status='missing' FROM
 public.daily_rollups WHERE business_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
 AND business_date='2026-10-05'),
 'newly incomplete historical day must be invalidated immediately');
SELECT pg_temp.assert((SELECT sales_data_status='actual' FROM
 public.daily_rollups WHERE business_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
 AND business_date='2026-10-06'),
 'genuinely complete historical day stays actual');

-- The later cost refresh is independent of the canonical day transaction.
SELECT pg_temp.assert((SELECT count(*)=2 FROM public.toast_rollup_refresh_jobs
 WHERE business_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
 'successful imports atomically enqueue their rollup retry work');
DO $generation$
DECLARE first_generation uuid; second_generation uuid;
BEGIN
 SELECT generation INTO first_generation FROM public.toast_rollup_refresh_jobs
 WHERE business_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' AND business_date='2026-10-05';
 UPDATE public.toast_day_status SET imported_at=now()+interval '1 second'
 WHERE business_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
 AND business_date='2026-10-05' AND restaurant_guid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001';
 SELECT generation INTO second_generation FROM public.toast_rollup_refresh_jobs
 WHERE business_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' AND business_date='2026-10-05';
 PERFORM pg_temp.assert(first_generation IS DISTINCT FROM second_generation,
  'each import changes the rollup queue generation');
 PERFORM pg_temp.assert(NOT public.toast_ack_rollup_refresh(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','2026-10-05',first_generation),
  'old worker cannot dismiss newer imported day');
 PERFORM pg_temp.assert(public.toast_ack_rollup_refresh(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','2026-10-05',second_generation),
  'matching post-commit generation acknowledges its own rollup');
END $generation$;

-- New server-only state and RPCs must be inaccessible to browser roles.
SELECT pg_temp.assert(NOT has_table_privilege('authenticated',
 'public.toast_analytics_credentials','SELECT'),
 'RMS Pro secret table is not client-readable');
SELECT pg_temp.assert(NOT has_table_privilege('authenticated',
 'public.toast_automation_leases','UPDATE'),
 'browser cannot steal a Toast lease');
SELECT pg_temp.assert(NOT has_function_privilege('authenticated',
 'public.toast_certify_day_voids(uuid,date)','EXECUTE'),
 'browser cannot certify voids');
SELECT pg_temp.assert(NOT has_function_privilege('anon',
 'public.toast_record_day_error(uuid,uuid,uuid,date,text,boolean,boolean)','EXECUTE'),
 'anonymous cannot replace an imported day');

DO $p1$
declare b uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 g uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0002';r uuid;again uuid;
begin
 -- Duplicate active requests return the same run ID, not a second import.
 select public.toast_queue_backfill(b,g,'2026-10-05','2026-10-06') into r;
 update public.toast_sync_runs set days_done=1,state='paused_rate_limited',
  cursor='{"business_date":"2026-10-06","page":3}'::jsonb,
  resume_at=now()+interval '5 minutes' where id=r;
 select public.toast_queue_backfill(b,g,'2026-10-05','2026-10-06') into again;
 perform pg_temp.assert(r=again,'same active location/range backfill deduplicated');
 perform pg_temp.assert((select days_done=1 and state='paused_rate_limited'
  and cursor->>'business_date'='2026-10-06' and (cursor->>'page')::integer=3
  from public.toast_sync_runs where id=r),
  'ordinary duplicate without invalidation must preserve checkpoint and progress');
end $p1$;

DO $bad_day$
declare b uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 g uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001';r uuid;
begin
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,
  requested_from,requested_to,days_total)
 values(b,g,'backfill','2026-10-06','2026-10-07',2) returning id into r;
 perform public.toast_record_day_error(r,b,g,'2026-10-06','invalid_response',false,true);
 perform pg_temp.assert((select import_state='imported' and last_error_category='invalid_response'
 from public.toast_day_status where business_id=b and restaurant_guid=g
  and business_date='2026-10-06'),'reimport error preserves previous good status');
 perform pg_temp.assert((select sales_data_status='actual'
  from public.daily_rollups where business_id=b and business_date='2026-10-06'),
  'reimport error preserves month-calendar actual sales coverage');
 perform pg_temp.assert((select days_done=1 and state='running'
  from public.toast_sync_runs where id=r),'invalid day advances backfill once');
 perform public.toast_record_day_error(r,b,g,'2026-10-07','invalid_response',false,true);
 perform pg_temp.assert((select days_done=2 and state='completed'
  from public.toast_sync_runs where id=r),'next bad day finishes without stopping');
 begin
  perform public.toast_record_day_error(r,b,g,'2026-10-07','invalid_response',false,true);
  raise exception 'duplicate skip was accepted';
 exception when others then
  if sqlerrm='duplicate skip was accepted' then raise;end if;
 end;
 perform pg_temp.assert((select days_done=2 from public.toast_sync_runs where id=r),
  'completed run cannot increment days_done twice');
end $bad_day$;

-- Full reconciliation and modified-date proof are prerequisites for certifying voids.
UPDATE public.toast_day_status SET recon_state='checked_internal'
WHERE business_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
 AND business_date='2026-10-06' AND import_state='imported';
INSERT INTO public.toast_void_repull_coverage(
 business_id,restaurant_guid,business_date,scanned_at,last_window_end,scan_local_day)
VALUES
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001','2026-10-06',now(),now(),'2026-10-07'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0002','2026-10-06',now(),now(),'2026-10-07');
INSERT INTO public.toast_void_facts(
 business_id,location_id,selection_guid,order_guid,order_business_date,
 void_business_date,amount_basis,amount_cents,level)
VALUES('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbba001',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb4444',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb3333',
 '2026-10-05','2026-10-06','amount_missing',null,'selection');
SELECT pg_temp.assert(NOT public.toast_certify_day_voids(
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','2026-10-06'),
 'missing amount blocks certifying a void day');
UPDATE public.toast_void_facts SET amount_basis='price',amount_cents=100
WHERE selection_guid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb4444';
SELECT pg_temp.assert(public.toast_certify_day_voids(
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','2026-10-06'),
 'reconciled, fully covered day can certify voids');
SELECT pg_temp.assert((SELECT voids_status='complete' and voids_cents=100
 FROM public.daily_rollups WHERE business_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  AND business_date='2026-10-06'),'certified amount is exact integer cents');
UPDATE public.toast_void_facts SET amount_cents=250
 WHERE selection_guid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb4444';
SELECT pg_temp.assert((SELECT voids_status='unknown'
 FROM public.daily_rollups WHERE business_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  AND business_date='2026-10-06'),'later void edit invalidates prior certification');


-- P1: a failed first Toast pull must not hide verified CSV/Square-only sales.
INSERT INTO public.daily_rollups(
 business_id,business_date,net_sales_cents,orders_count,drinks_count,
 ingredients_cents,staff_wages_cents,staff_tax_cents,card_fees_cents,
 voids_cents,sales_data_status)
VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','2026-10-03',
 4300,9,9,0,0,0,0,0,'actual');
DO $csv_only$
declare b uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 g uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0002';r uuid;
begin
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,
  requested_from,requested_to,days_total)
 values(b,g,'backfill','2026-10-03','2026-10-03',1) returning id into r;
 perform public.toast_record_day_error(r,b,g,'2026-10-03','invalid_response',false,true);
 perform pg_temp.assert((select sales_data_status='actual' and net_sales_cents=4300
  from public.daily_rollups where business_id=b and business_date='2026-10-03'),
  'failed first Toast import must not demote a CSV-only day');
 perform public.toast_queue_backfill(b,g,'2026-10-02','2026-10-06');
 perform pg_temp.assert((select sales_data_status='actual' and net_sales_cents=4300
  from public.daily_rollups where business_id=b and business_date='2026-10-03'),
  'backdated Toast start must not demote a date without ANY imported Toast');
end $csv_only$;

-- P1: October 31 business day spans 25 UTC hours across PDT/PST fallback.
-- Only mark coverage for an entire restaurant-local 04:00-to-04:00 day.
SELECT public.toast_commit_repull_scan_window(
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001',
 '2026-11-02','[]'::jsonb,
 '2026-10-31T11:00:00Z','2026-11-01T12:00:00Z');
SELECT pg_temp.assert(exists(select 1 from public.toast_void_repull_coverage
 where business_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  and restaurant_guid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001'
  and business_date='2026-10-31'),'a full 25-hour local closeout day is covered');
DELETE FROM public.toast_void_repull_coverage
WHERE business_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
 AND restaurant_guid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001'
 AND business_date='2026-10-31';
SELECT public.toast_commit_repull_scan_window(
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001',
 '2026-11-02','[]'::jsonb,
 '2026-10-31T11:00:01Z','2026-11-01T12:00:00Z');
SELECT pg_temp.assert(not exists(select 1 from public.toast_void_repull_coverage
 where business_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  and restaurant_guid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001'
  and business_date='2026-10-31'),'a partial FIRST local business day is not covered');
SELECT public.toast_commit_repull_scan_window(
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001',
 '2026-11-02','[]'::jsonb,
 '2026-10-31T11:00:00Z','2026-11-01T11:59:59Z');
SELECT pg_temp.assert(not exists(select 1 from public.toast_void_repull_coverage
 where business_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  and restaurant_guid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001'
  and business_date='2026-10-31'),'a partial LAST local business day is not covered');

-- P1: any not-yet-completed repull from the same full-window scan blocks
-- certification even if an unrelated day has a valid reconciled void fact.
DO $pending_repull$
declare b uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 g uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001';r uuid;
begin
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,
  scan_local_day,requested_from,requested_to,days_total,state)
 values(b,g,'repull_modified','2026-10-07','2026-10-05','2026-10-05',
  1,'queued') returning id into r;
 perform pg_temp.assert(not public.toast_certify_day_voids(b,'2026-10-06'),
  'queued re-pull found in the scan prevents void certification');
 update public.toast_sync_runs set state='failed' where id=r;
 perform pg_temp.assert(not public.toast_certify_day_voids(b,'2026-10-06'),
  'failed re-pull found in the scan prevents void certification');
 update public.toast_sync_runs set state='completed',days_done=1 where id=r;
 perform pg_temp.assert(public.toast_certify_day_voids(b,'2026-10-06'),
  'once all repulls finish, the independently reconciled day can certify');
end $pending_repull$;


-- Recovery P1: changing a location's closeout mid-backfill invalidates ALL
-- previously imported dates and must restart an already-partial identical run.
-- October 1 is outside the seven-day modifiedDate scan as of October 24.
DO $closeout_recovery$
declare
 b uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 north uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001';
 south uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0002';
 north_location uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbba001';
 r uuid; d date;
 v_summary jsonb:='{"net_sales_cents":0,"order_count":0,"gross_sales_cents":0,
 "discounts_cents":0,"refunds_cents":0,"tax_cents":0,"tip_cents":0,
 "open_check_count":0,"service_charges_cents":0,"gratuity_cents":0,
 "unparsed_count":0,"warnings":{},"voids":[],"refund_facts":[],
 "unparsed":[],"parsed_order_guids":[],"snapshot_sha256":"recovered"}'::jsonb;
begin
 -- Existing day 5/6 fixtures are preserved. Give all eligible locations
 -- complete coverage for the range before invalidating its date grouping.
 insert into public.toast_day_status(
  business_id,restaurant_guid,business_date,import_state,
  coverage_complete,imported_at)
 select b,north,day::date,'imported',true,now() from
  generate_series('2026-10-01'::timestamp,'2026-10-04'::timestamp,
   interval '1 day') day;
 insert into public.toast_day_status(
  business_id,restaurant_guid,business_date,import_state,
  coverage_complete,imported_at)
 values(b,south,'2026-10-05','imported',true,now())
 on conflict(business_id,restaurant_guid,business_date) do update
  set import_state='imported',coverage_complete=true,imported_at=now();
 update public.toast_day_status set coverage_complete=true,
  import_state='imported',last_error_category=null
 where business_id=b and restaurant_guid=north
  and business_date between '2026-10-05' and '2026-10-06';
 insert into public.daily_rollups(business_id,business_date,net_sales_cents,
  orders_count,drinks_count,ingredients_cents,staff_wages_cents,
  staff_tax_cents,card_fees_cents,voids_cents,sales_data_status)
 select b,recovery_days.day_value::date,0,0,0,0,0,0,0,0,'actual'
 from generate_series('2026-10-01'::timestamp,'2026-10-06'::timestamp,
  interval '1 day') as recovery_days(day_value)
 on conflict(business_id,business_date) do update
  set sales_data_status='actual';

 insert into public.toast_sync_runs(business_id,restaurant_guid,
  kind,requested_from,requested_to,days_total,days_done,
  state,cursor,resume_at)
 values(b,north,'backfill','2026-10-01','2026-10-06',6,4,
  'paused_rate_limited','{"business_date":"2026-10-05","page":2}'::jsonb,
  now()+interval '5 minutes') returning id into r;
 insert into public.toast_day_pages(run_id,business_date,page,payload)
 values(r,'2026-10-05',1,'[]'::jsonb);
 update public.toast_location_mappings set closeout_hour=5
 where business_id=b and restaurant_guid=north;

 perform pg_temp.assert((select days_done=0 and state='queued'
  and cursor='{}'::jsonb and resume_at is null and finished_at is null
  from public.toast_sync_runs where id=r),
  'closeout change MUST reset an active matching backfill, not keep stale days_done');
 perform pg_temp.assert(not exists(select 1 from public.toast_day_pages
  where run_id=r),'closeout change MUST discard old staged page snapshots');
 perform pg_temp.assert((select count(*)=6 from public.toast_day_status
  where business_id=b and restaurant_guid=north
   and business_date between '2026-10-01' and '2026-10-06'
   and coverage_complete=false),
   'closeout invalidates every date, including October 1 outside modified-date scan');
 perform pg_temp.assert((select count(*)=6 from public.daily_rollups
  where business_id=b and business_date between '2026-10-01' and '2026-10-06'
   and sales_data_status='missing'),'report coverage must stay incomplete while recovery is queued');

 -- The restored run processes ALL six dates, not just the old pending two.
 for d in select gs::date from generate_series('2026-10-01'::timestamp,
  '2026-10-06'::timestamp,interval '1 day') gs loop
  perform public.toast_import_day(b,north_location,north,d,'[]'::jsonb,v_summary,r);
 end loop;
 perform pg_temp.assert((select state='completed' and days_done=6
   from public.toast_sync_runs where id=r),
   'same recovery run commits six days exactly once');
 perform pg_temp.assert((select count(*)=6 from public.toast_day_status
  where business_id=b and restaurant_guid=north
   and business_date between '2026-10-01' and '2026-10-06'
   and coverage_complete and import_state='imported'
   and last_import_run_id=r),
   'every invalidated old and new day was actually re-imported');
 perform pg_temp.assert((select count(*)=6 from public.daily_rollups
  where business_id=b and business_date between '2026-10-01' and '2026-10-06'
   and sales_data_status='actual'),
   'after all applicable locations prove data, NONE of the six dates stays missing');
end $closeout_recovery$;

-- A normal duplicate backfill does not reset progress; a start-date move
-- backwards MUST reset even when the identical range is already in progress.
DO $start_date_recovery$
declare
 b uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 south uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0002';
 r uuid;reused uuid;
begin
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,
 requested_from,requested_to,days_total,days_done,state,cursor)
 values(b,south,'backfill','2026-10-04','2026-10-06',3,2,
  'running','{"business_date":"2026-10-06","page":2}'::jsonb)
 returning id into r;
 insert into public.toast_day_pages(run_id,business_date,page,payload)
 values(r,'2026-10-06',1,'[]'::jsonb);
 select public.toast_queue_backfill(b,south,'2026-10-04','2026-10-06') into reused;
 perform pg_temp.assert(reused=r,'earlier start-date recovers identical active run');
 perform pg_temp.assert((select days_done=0 and state='queued'
  and cursor='{}'::jsonb from public.toast_sync_runs where id=r),
  'earlier Toast start resets stale backfill progress');
 perform pg_temp.assert(not exists(select 1 from public.toast_day_pages
  where run_id=r),'earlier Toast start discards previously staged pages');
 perform pg_temp.assert((select sales_data_status='missing'
  from public.daily_rollups where business_id=b and business_date='2026-10-04'),
  'newly applicable second location must demote previously complete Toast business total');
end $start_date_recovery$;

ROLLBACK;
