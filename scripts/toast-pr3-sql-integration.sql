\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert(ok boolean,msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Toast PR3: %',msg;END IF;END $$;
SELECT pg_temp.assert(NOT has_table_privilege('authenticated',
 'public.toast_day_owner_flags','INSERT'),'owner flag writes must be server-only');
SELECT pg_temp.assert(NOT has_table_privilege('anon',
 'public.toast_first_import_check','SELECT'),'anonymous check read blocked');
SELECT pg_temp.assert(NOT has_function_privilege('authenticated',
 'public.toast_requeue_failed(uuid,uuid)','EXECUTE'),'retry service-only');
SELECT set_config('request.jwt.claim.role','service_role',true);
INSERT INTO public.businesses(id,name,is_demo)
VALUES('cccccccc-cccc-4ccc-8ccc-cccccccccccc','Toast PR3 test',false);
INSERT INTO public.locations(id,business_id,name) VALUES
('cccccccc-cccc-4ccc-8ccc-cccccccc0001','cccccccc-cccc-4ccc-8ccc-cccccccccccc','Main'),
('cccccccc-cccc-4ccc-8ccc-cccccccc0003','cccccccc-cccc-4ccc-8ccc-cccccccccccc','Later location');
SELECT public.toast_save_configuration('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
'https://ws-api.toasttab.com','test','secret',
'[{"location_id":"cccccccc-cccc-4ccc-8ccc-cccccccc0001",
"restaurant_guid":"cccccccc-cccc-4ccc-8ccc-cccccccc0002"},
{"location_id":"cccccccc-cccc-4ccc-8ccc-cccccccc0003",
"restaurant_guid":"cccccccc-cccc-4ccc-8ccc-cccccccc0004"}]'::jsonb);
UPDATE public.toast_location_mappings SET verified_at=now(),
toast_time_zone='America/Los_Angeles',closeout_hour=4,
 toast_start_date=case when restaurant_guid='cccccccc-cccc-4ccc-8ccc-cccccccc0002'
 then '2026-10-01'::date else '2026-10-10'::date end
WHERE business_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
DO $test$
DECLARE b uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
g uuid:='cccccccc-cccc-4ccc-8ccc-cccccccc0002';
run uuid; resumed uuid;
BEGIN
 INSERT INTO public.toast_sync_runs(business_id,restaurant_guid,kind,
 requested_from,requested_to,days_done,days_total,state)
 VALUES(b,g,'backfill','2026-10-01','2026-10-10',2,10,'failed') RETURNING id INTO run;
 PERFORM pg_temp.assert(public.toast_requeue_failed(b,g)=1,'failed backfill requeued');
 SELECT retry_run_id INTO resumed FROM public.toast_sync_runs WHERE id=run;
 PERFORM pg_temp.assert((SELECT requested_from='2026-10-03' AND requested_to='2026-10-10'
 FROM public.toast_sync_runs WHERE id=resumed),'resume starts on unfinished day');
 PERFORM pg_temp.assert(public.toast_requeue_failed(b,g)=0,'retry is idempotent');
 INSERT INTO public.toast_sync_runs(business_id,restaurant_guid,kind,
 requested_from,requested_to,days_done,days_total,state)
 VALUES(b,g,'daily','2026-10-11','2026-10-11',0,1,'failed') RETURNING id INTO run;
 PERFORM pg_temp.assert(public.toast_requeue_failed(b,g)=1,'daily retries');
 PERFORM pg_temp.assert((SELECT state='queued' AND days_done=0
 FROM public.toast_sync_runs WHERE id=run),'daily cursor reset');
 INSERT INTO public.toast_day_status(business_id,restaurant_guid,business_date,
 import_state,coverage_complete,recon_state)
 VALUES(b,g,'2026-10-01','imported',true,'matched');
 INSERT INTO public.toast_day_owner_flags(business_id,restaurant_guid,business_date)
 VALUES(b,g,'2026-10-01');
 PERFORM pg_temp.assert((SELECT days_needing_look=1 FROM
 public.toast_sync_health_v WHERE business_id=b AND restaurant_guid=g),
 'owner flagged matched day remains visible');
 -- Before the second location starts, one location proves the whole business day.
 PERFORM pg_temp.assert(public.toast_is_complete_business_day(b,'2026-10-01'),
  'pre-start second location must not invalidate first location');
 INSERT INTO public.toast_day_status(business_id,restaurant_guid,business_date,
  import_state,coverage_complete,recon_state)
 SELECT b,g,gs::date,'imported',true,'matched'
 FROM generate_series('2026-10-02'::date,'2026-10-07'::date,interval '1 day') gs;
 PERFORM pg_temp.assert((select count(distinct business_date)=7 from public.toast_day_status
  where business_id=b and import_state='imported' and coverage_complete),
  'seven imported days exist before answering');
 PERFORM pg_temp.assert(not public.toast_is_complete_business_day(b,'2026-10-10'),
  'second location becomes required at its actual start date');
 PERFORM public.toast_answer_first_import_check(b,'something_off',
  array['2026-10-05'::date],'Review Oct 5');
 PERFORM pg_temp.assert((select answered_at is not null and answer='something_off'
   from public.toast_first_import_check where business_id=b),
  'one-time check saves an answer');
 PERFORM pg_temp.assert((select count(*)=1 from public.toast_day_owner_flags
   where business_id=b and business_date='2026-10-05' and cleared_at is null),
  'owner flags only the date-eligible restaurant');
 BEGIN
  PERFORM public.toast_answer_first_import_check(b,'looks_right',array[]::date[],null);
  RAISE EXCEPTION 'duplicate first-import answer succeeded';
 EXCEPTION WHEN OTHERS THEN
  IF sqlerrm='duplicate first-import answer succeeded' THEN RAISE;END IF;
 END;
END $test$;
ROLLBACK;
