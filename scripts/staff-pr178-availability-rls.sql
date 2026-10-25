\set ON_ERROR_STOP on
-- All rows, authenticated users and tenant references are disposable.
BEGIN;
SELECT gen_random_uuid() AS business,gen_random_uuid() AS other_business,
       gen_random_uuid() AS owner,gen_random_uuid() AS other_owner \gset
INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
VALUES (:'owner','00000000-0000-0000-0000-000000000000','authenticated','authenticated','pr178-owner@example.invalid','',now(),now()),
       (:'other_owner','00000000-0000-0000-0000-000000000000','authenticated','authenticated','pr178-other@example.invalid','',now(),now());
INSERT INTO public.businesses(id,name,timezone,is_demo)
VALUES (:'business','PR178 availability test','America/Los_Angeles',false),
       (:'other_business','PR178 other business','America/New_York',false);
INSERT INTO public.memberships(business_id,user_id,role)
VALUES (:'business',:'owner','owner'),(:'other_business',:'other_owner','owner');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'owner',true);
SELECT set_config('test.pr178.business',:'business',true);
SELECT set_config('test.pr178.other',:'other_business',true);
SELECT public.staff_write_person(:'business'::uuid,NULL,
 jsonb_build_object('name','Quick add','role','Barista','wageCents',NULL,
  'minWeeklyMinutes',NULL,'maxWeeklyMinutes',NULL,'phone',NULL,
  'availability',(SELECT jsonb_agg(jsonb_build_object('day',n,'start',NULL,'end',NULL))
                   FROM generate_series(0,6) n))) AS employee \gset
SELECT set_config('test.pr178.employee',:'employee',true);
DO $$
DECLARE b uuid:=current_setting('test.pr178.business')::uuid;
        e uuid:=current_setting('test.pr178.employee')::uuid;
        today date:=(now() AT TIME ZONE 'America/Los_Angeles')::date;
BEGIN
 IF (SELECT available_days FROM public.employees WHERE id=e)
   IS DISTINCT FROM ARRAY[0,1,2,3,4,5,6]::smallint[] THEN
  RAISE EXCEPTION 'all days not stored for quick add';
 END IF;
 IF (SELECT count(*) FROM public.staff_availability_rules
     WHERE business_id=b AND employee_id=e AND effective_from=today)<>14 THEN
  RAISE EXCEPTION 'quick add requires fourteen exact half-day windows';
 END IF;
 IF (SELECT count(*) FROM public.staff_availability_rules
     WHERE business_id=b AND employee_id=e AND
     start_local=TIME '00:00' AND end_local=TIME '12:00' AND NOT overnight)<>7
 OR (SELECT count(*) FROM public.staff_availability_rules
     WHERE business_id=b AND employee_id=e AND
     start_local=TIME '12:00' AND end_local=TIME '00:00' AND overnight)<>7 THEN
  RAISE EXCEPTION 'all-day union must cover midnight exactly';
 END IF;
 -- Monday timed, Tuesday full-day, other weekdays off.
 PERFORM public.staff_write_person(b,e,'{"name":"Edited","role":"Baker","wageCents":1873,
    "minWeeklyMinutes":null,"maxWeeklyMinutes":null,"phone":null,"availability":[
    {"day":1,"start":"06:15","end":"12:37"},
    {"day":2,"start":null,"end":null}]}'::jsonb);
 IF (SELECT available_days FROM public.employees WHERE id=e)
   IS DISTINCT FROM ARRAY[1,2]::smallint[]
 OR (SELECT wage_amount_cents FROM public.employees WHERE id=e)<>1873
 OR (SELECT count(*) FROM public.staff_availability_rules
    WHERE business_id=b AND employee_id=e AND effective_to IS NULL)<>3
 OR NOT EXISTS(SELECT 1 FROM public.staff_availability_rules
    WHERE business_id=b AND employee_id=e AND day_of_week=1
    AND start_local=TIME '06:15' AND end_local=TIME '12:37') THEN
  RAISE EXCEPTION 'mixed timed/full-day/off availability or exact wages incorrect';
 END IF;
 -- Profile-only updates preserve all availability rows and effective dates.
 PERFORM public.staff_write_person(b,e,'{"name":"Rename","role":"Baker","wageCents":1873,
    "minWeeklyMinutes":null,"maxWeeklyMinutes":null,"phone":null,"availability":null}'::jsonb);
 IF (SELECT available_days FROM public.employees WHERE id=e)
   IS DISTINCT FROM ARRAY[1,2]::smallint[]
 OR (SELECT count(*) FROM public.staff_availability_rules
    WHERE business_id=b AND employee_id=e AND effective_to IS NULL)<>3 THEN
  RAISE EXCEPTION 'profile-only edit destroyed availability';
 END IF;
 PERFORM public.staff_write_person(b,e,'{"name":"Off","role":null,"wageCents":null,
    "minWeeklyMinutes":null,"maxWeeklyMinutes":null,"phone":null,"availability":[]}'::jsonb);
 IF (SELECT available_days FROM public.employees WHERE id=e)
   IS DISTINCT FROM ARRAY[]::smallint[]
 OR EXISTS(SELECT 1 FROM public.staff_availability_rules
    WHERE business_id=b AND employee_id=e AND effective_to IS NULL) THEN
  RAISE EXCEPTION 'deselected weekdays remained available';
 END IF;
 BEGIN
  PERFORM public.staff_write_person(current_setting('test.pr178.other')::uuid,NULL,
    '{"name":"Cross-tenant","role":null,"wageCents":null,"minWeeklyMinutes":null,
      "maxWeeklyMinutes":null,"phone":null,"availability":[]}'::jsonb);
  RAISE EXCEPTION 'cross-tenant owner write succeeded';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
ROLLBACK;
