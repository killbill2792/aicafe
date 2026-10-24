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
ROLLBACK;
