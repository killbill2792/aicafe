\set ON_ERROR_STOP on
BEGIN;
SELECT gen_random_uuid() business,gen_random_uuid() owner,
 gen_random_uuid() manager \gset
INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
VALUES
 (:'owner','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'staff-pr155-owner@example.invalid','',now(),now()),
 (:'manager','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'staff-pr155-manager@example.invalid','',now(),now());
INSERT INTO public.businesses(id,name,timezone,is_demo)
VALUES (:'business','Staff PR155 disposable test','America/Los_Angeles',false);
INSERT INTO public.memberships(business_id,user_id,role)
VALUES (:'business',:'owner','owner'),(:'business',:'manager','manager');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'owner',true);
SELECT set_config('test.staff.business',:'business',true);
SELECT public.staff_write_person(:'business'::uuid,NULL,
 jsonb_build_object('name','Amy','role','Barista','wageCents',NULL,
   'minWeeklyMinutes',NULL,'maxWeeklyMinutes',NULL,'phone',NULL,
   'availability',jsonb_build_array(
     jsonb_build_object('day',3,'start','06:00','end','12:00'),
     jsonb_build_object('day',5,'start',NULL,'end',NULL))))
 AS employee \gset
SELECT set_config('test.staff.employee',:'employee',true);
DO $$
BEGIN
 IF (SELECT count(*) FROM public.employees
     WHERE id=current_setting('test.staff.employee')::uuid
       AND business_id=current_setting('test.staff.business')::uuid
       AND wage_amount_cents IS NULL AND max_weekly_minutes IS NULL)<>1
 OR (SELECT count(*) FROM public.staff_availability_rules
     WHERE business_id=current_setting('test.staff.business')::uuid
       AND employee_id=current_setting('test.staff.employee')::uuid
       AND day_of_week=3
       AND start_local='06:00'::time AND end_local='12:00'::time
       AND effective_from=(now() AT TIME ZONE 'America/Los_Angeles')::date)<>1
 OR (SELECT count(*) FROM public.scheduling_foundation_audit_events
     WHERE business_id=current_setting('test.staff.business')::uuid
       AND table_name='staff_availability_rules' AND operation='INSERT')<>1 THEN
  RAISE EXCEPTION 'person create, optional wages or audited per-day hours incorrect';
 END IF;
END $$;
SELECT public.staff_write_person(:'business'::uuid,:'employee'::uuid,
 jsonb_build_object('name','Amy Updated','role',NULL,'wageCents',1850,
   'minWeeklyMinutes',1200,'maxWeeklyMinutes',2400,'phone','+14155551234',
   'availability',jsonb_build_array(
     jsonb_build_object('day',1,'start','07:00','end','13:00'))));
DO $$
BEGIN
 IF (SELECT count(*) FROM public.employees
  WHERE id=current_setting('test.staff.employee')::uuid
   AND display_name='Amy Updated' AND wage_amount_cents=1850
   AND min_weekly_minutes=1200 AND max_weekly_minutes=2400
   AND phone_e164='+14155551234')<>1
 OR (SELECT count(*) FROM public.staff_availability_rules
  WHERE employee_id=current_setting('test.staff.employee')::uuid
   AND day_of_week=1 AND start_local='07:00'::time
   AND effective_from=(now() AT TIME ZONE 'America/Los_Angeles')::date)<>1
 OR (SELECT count(*) FROM public.scheduling_foundation_audit_events
  WHERE business_id=current_setting('test.staff.business')::uuid
   AND table_name='staff_availability_rules' AND operation='INSERT')<>2 THEN
   RAISE EXCEPTION 'person update not atomic/audited';
 END IF;
END $$;
-- Editing only availability or phone must not change canonical monthly/yearly pay.
SELECT set_config('request.jwt.claim.sub',:'owner',true);
UPDATE public.employees SET wage_period='month',wage_amount_cents=310000,
 default_hourly_wage_cents=1800 WHERE id=:'employee'::uuid;
SELECT public.staff_write_person(:'business'::uuid,:'employee'::uuid,
 '{"name":"Amy Updated","role":null,"wageCents":null,
 "minWeeklyMinutes":1200,"maxWeeklyMinutes":2400,"phone":"+14155551234",
 "availability":[{"day":1,"start":"07:00","end":"13:00"}]}'::jsonb);
DO $
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.employees WHERE id=current_setting('test.staff.employee')::uuid
  AND wage_period='month' AND wage_amount_cents=310000 AND default_hourly_wage_cents=1800) THEN
  RAISE EXCEPTION 'saving salaried staff changed canonical compensation';
 END IF;
END $;
-- A validation failure must roll back the complete profile and windows.
DO $$
BEGIN
 BEGIN
  PERFORM public.staff_write_person(
   current_setting('test.staff.business')::uuid,
   current_setting('test.staff.employee')::uuid,
   jsonb_build_object('name','Corrupted','role',NULL,'wageCents',2000,
    'minWeeklyMinutes',3000,'maxWeeklyMinutes',1200,'phone',NULL,
    'availability',jsonb_build_array(jsonb_build_object(
      'day',1,'start','09:00','end','09:00'))));
  RAISE EXCEPTION 'invalid input unexpectedly succeeded';
 EXCEPTION WHEN check_violation OR invalid_parameter_value THEN NULL;
 END;
 IF (SELECT display_name FROM public.employees
   WHERE id=current_setting('test.staff.employee')::uuid)<>'Amy Updated' THEN
   RAISE EXCEPTION 'invalid write partially changed person';
 END IF;
END $$;
SELECT set_config('request.jwt.claim.sub',:'manager',true);
DO $$
BEGIN
 BEGIN
  PERFORM public.staff_write_person(
   current_setting('test.staff.business')::uuid,NULL,
   '{"name":"Manager bypass","role":null,"wageCents":null,"minWeeklyMinutes":null,"maxWeeklyMinutes":null,"phone":null,"availability":[]}'::jsonb);
  RAISE EXCEPTION 'manager bypassed write authorization';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
ROLLBACK;
