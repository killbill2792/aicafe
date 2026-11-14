\set ON_ERROR_STOP on
-- Task 13a: executed only by scripts/db/run-all.sh against migrated
-- 127.0.0.1 disposable Supabase. Every inserted row is rolled back.
BEGIN;
SELECT gen_random_uuid() AS cafe_a,gen_random_uuid() AS cafe_b,
  gen_random_uuid() AS owner_a,gen_random_uuid() AS owner_b,
  gen_random_uuid() AS loc_a,gen_random_uuid() AS loc_b,
  gen_random_uuid() AS staff_a \gset
INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
VALUES (:'owner_a','00000000-0000-0000-0000-000000000000','authenticated','authenticated','task13a-owner-a@example.invalid','',now(),now()),
 (:'owner_b','00000000-0000-0000-0000-000000000000','authenticated','authenticated','task13a-owner-b@example.invalid','',now(),now());
INSERT INTO public.businesses(id,name,timezone,currency,is_demo)
VALUES (:'cafe_a','Task13a disposable A','America/Los_Angeles','EUR',false),
       (:'cafe_b','Task13a disposable B','America/New_York','GBP',false);
INSERT INTO public.memberships(business_id,user_id,role)
VALUES (:'cafe_a',:'owner_a','owner'),(:'cafe_b',:'owner_b','owner');
INSERT INTO public.locations(id,business_id,name,open_hours)
VALUES (:'loc_a',:'cafe_a','A','{"mon":[["09:00","17:00"]]}'::jsonb),
       (:'loc_b',:'cafe_b','B','{"mon":[["08:00","18:00"]]}'::jsonb);
INSERT INTO public.employees(id,business_id,display_name,active,wage_period,wage_amount_cents)
VALUES (:'staff_a',:'cafe_a','Shift worker',true,'hour',1900);
-- Actual recorded attendance is not a future plan. Open timecards are never
-- completed worked shifts; historical zero placeholders do not prove zero pay.
INSERT INTO public.timecards(business_id,employee_id,pos_timecard_id,clock_in,clock_out,
 hourly_wage_cents,source_type,source_provider)
VALUES (:'cafe_a',:'staff_a','task13a-incomplete',
 '2026-11-09T16:00:00Z',NULL,0,'connected_pos','Toast');
INSERT INTO public.hourly_sales_rollup(business_id,location_id,business_date,hour_local,net_sales_cents,orders_count)
VALUES (:'cafe_a',:'loc_a','2026-11-02',9,1800,6),
       (:'cafe_a',:'loc_a','2026-11-09',9,2400,8),
       (:'cafe_b',:'loc_b','2026-11-02',9,7200,16),
       (:'cafe_b',:'loc_b','2026-11-09',9,8200,18);
SELECT set_config('test.t13a.a',:'cafe_a',true);
SELECT set_config('test.t13a.b',:'cafe_b',true);
SELECT set_config('test.t13a.staff',:'staff_a',true);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'owner_a',true);
-- Single existing scheduling owner RPC. The source record is tenant-scoped
-- and confirmation is attributed; the direct applicant has no SQL grant.
SELECT public.scheduling_create_foundation(
 :'cafe_a'::uuid,'availability_rule',gen_random_uuid(),
 jsonb_build_object('employee_id',:'staff_a','day_of_week',1,
 'start_local','08:00','end_local','12:00','overnight',false,
 'effective_from','2026-11-01','source','owner_direct','confirmation','owner_confirmed'));
SELECT public.scheduling_create_foundation(
 :'cafe_a'::uuid,'coverage',gen_random_uuid(),
 jsonb_build_object('location_id',:'loc_a','day_of_week',1,
 'start_local','08:00','end_local','10:00','overnight',false,
 'min_headcount',1,'effective_from','2026-11-01',
 'source','owner_direct','confirmation','owner_confirmed'));
DO $task13a$
DECLARE a uuid:=current_setting('test.t13a.a')::uuid;
        b uuid:=current_setting('test.t13a.b')::uuid;
        emp uuid:=current_setting('test.t13a.staff')::uuid;
BEGIN
 IF NOT public.scheduling_is_owner(a) OR public.scheduling_is_owner(b) THEN
  RAISE EXCEPTION 'Task13a owner/café scope violation';
 END IF;
 IF (SELECT count(*) FROM public.staff_availability_rules
   WHERE business_id=a AND employee_id=emp AND confirmation='owner_confirmed')<>1 THEN
  RAISE EXCEPTION 'Task13a canonical confirmed availability missing';
 END IF;
 IF (SELECT count(*) FROM public.scheduling_coverage_requirements
   WHERE business_id=a AND confirmation='owner_confirmed' AND min_headcount=1)<>1 THEN
  RAISE EXCEPTION 'Task13a confirmed coverage missing';
 END IF;
 IF (SELECT count(*) FROM public.hourly_sales_rollup WHERE business_id=a)<>2
 OR (SELECT count(*) FROM public.hourly_sales_rollup WHERE business_id=b)<>0 THEN
  RAISE EXCEPTION 'Task13a hourly POS reader crossed café RLS';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.timecards
  WHERE business_id=a AND employee_id=emp AND clock_out IS NULL
    AND hourly_wage_cents=0) THEN
  RAISE EXCEPTION 'Task13a incomplete timecard was lost';
 END IF;
 IF EXISTS (SELECT 1 FROM public.scheduling_plan_series WHERE business_id=a)
 OR EXISTS (SELECT 1 FROM public.scheduled_shifts WHERE business_id=a) THEN
  RAISE EXCEPTION 'Task13a read-only planning created scheduled assignments';
 END IF;
 IF (SELECT count(*) FROM public.employees WHERE business_id=b)<>0 THEN
  RAISE EXCEPTION 'Task13a no-staff café was fabricated';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.locations
  WHERE business_id=a AND open_hours::jsonb->'mon' IS NOT NULL) THEN
  RAISE EXCEPTION 'Task13a source opening hours missing';
 END IF;
END $task13a$;
SELECT set_config('request.jwt.claim.sub',:'owner_b',true);
DO $task13a$
BEGIN
 IF public.scheduling_is_owner(current_setting('test.t13a.a')::uuid)
 OR NOT public.scheduling_is_owner(current_setting('test.t13a.b')::uuid)
 OR (SELECT count(*) FROM public.hourly_sales_rollup
      WHERE business_id=current_setting('test.t13a.a')::uuid)<>0
 OR (SELECT count(*) FROM public.hourly_sales_rollup
      WHERE business_id=current_setting('test.t13a.b')::uuid)<>2
 OR (SELECT count(*) FROM public.staff_availability_rules
      WHERE business_id=current_setting('test.t13a.a')::uuid)<>0 THEN
  RAISE EXCEPTION 'Task13a foreign café can see private staffing or sales facts';
 END IF;
END $task13a$;
ROLLBACK;
