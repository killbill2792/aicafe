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
('cccccccc-cccc-4ccc-8ccc-cccccccc0001','cccccccc-cccc-4ccc-8ccc-cccccccccccc','Main');
SELECT public.toast_save_configuration('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
'https://ws-api.toasttab.com','test','secret',
'[{"location_id":"cccccccc-cccc-4ccc-8ccc-cccccccc0001",
"restaurant_guid":"cccccccc-cccc-4ccc-8ccc-cccccccc0002"}]'::jsonb);
UPDATE public.toast_location_mappings SET verified_at=now(),
toast_time_zone='America/Los_Angeles',closeout_hour=4
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
END $test$;
ROLLBACK;
