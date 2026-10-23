-- Disposable-only regressions for direct RPC clients that bypass Zod.
-- Run against a freshly migrated disposable database only; all rows roll back.
\set ON_ERROR_STOP on
BEGIN;
SELECT gen_random_uuid() business,gen_random_uuid() owner,
       gen_random_uuid() manager \gset
INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
VALUES (:'owner','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
        'staff-guard-owner@example.invalid','',now(),now()),
       (:'manager','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
        'staff-guard-manager@example.invalid','',now(),now());
INSERT INTO public.businesses(id,name,timezone,is_demo)
VALUES (:'business','Staff person guard disposable test','America/Los_Angeles',false);
INSERT INTO public.memberships(business_id,user_id,role)
VALUES (:'business',:'owner','owner'),(:'business',:'manager','manager');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'owner',true);
SELECT set_config('test.staff.guard.business',:'business',true);
SELECT public.staff_write_person(:'business'::uuid,NULL,
  '{"name":"Amy","role":null,"wageCents":1800,"phone":null,
  "minWeeklyMinutes":null,"maxWeeklyMinutes":null,
  "availability":[{"day":1,"start":"07:00","end":"12:00"},
                  {"day":2,"start":null,"end":null}]}'::jsonb) employee \gset
SELECT set_config('test.staff.guard.employee',:'employee',true);

DO $$
DECLARE
 b uuid:=current_setting('test.staff.guard.business')::uuid;
 e uuid:=current_setting('test.staff.guard.employee')::uuid;
 good jsonb:='{"name":"Amy","role":null,"wageCents":1800,"phone":null,
 "minWeeklyMinutes":null,"maxWeeklyMinutes":null,
 "availability":null}'::jsonb;
 bad jsonb;
 ix integer;
BEGIN
 IF (SELECT available_days FROM public.employees WHERE id=e) IS DISTINCT FROM ARRAY[1]::smallint[] THEN
   RAISE EXCEPTION 'closed weekday incorrectly marked available';
 END IF;
 -- Each case must raise and must never partially edit employee or availability.
 FOR ix IN 1..29 LOOP
   bad:=good;
   CASE ix
     WHEN 1 THEN bad:=bad-'name';
     WHEN 2 THEN bad:=jsonb_set(bad,'{name}','null'::jsonb);
     WHEN 3 THEN bad:=jsonb_set(bad,'{name}','true'::jsonb);
     WHEN 4 THEN bad:=bad-'availability';
     WHEN 5 THEN bad:=jsonb_set(bad,'{availability}','{"day":1}'::jsonb);
     WHEN 6 THEN bad:=jsonb_set(bad,'{wageCents}','-15'::jsonb);
     WHEN 7 THEN bad:=jsonb_set(bad,'{wageCents}','1.25'::jsonb);
     WHEN 8 THEN bad:=jsonb_set(bad,'{wageCents}','true'::jsonb);
     WHEN 9 THEN bad:=jsonb_set(bad,'{phone}','"nonsense"'::jsonb);
     WHEN 10 THEN bad:=jsonb_set(bad,'{minWeeklyMinutes}','10081'::jsonb);
     WHEN 11 THEN bad:=jsonb_set(bad,'{maxWeeklyMinutes}','-1'::jsonb);
     WHEN 12 THEN bad:=jsonb_set(bad,'{minWeeklyMinutes}','1800'::jsonb);
                  bad:=jsonb_set(bad,'{maxWeeklyMinutes}','1200'::jsonb);
     WHEN 13 THEN bad:=jsonb_set(bad,'{availability}',
                             '[{"day":1,"start":"07:00"}]'::jsonb);
     WHEN 14 THEN bad:=jsonb_set(bad,'{availability}',
                             '[{"day":1,"start":null,"end":"10:00"}]'::jsonb);
     WHEN 15 THEN bad:=jsonb_set(bad,'{availability}',
                             '[{"day":1,"start":"09:00","end":"09:00"}]'::jsonb);
     WHEN 16 THEN bad:=jsonb_set(bad,'{availability}',
                             '[{"day":1,"start":"07:00","end":"12:00"},
                               {"day":1,"start":"12:00","end":"16:00"}]'::jsonb);
     WHEN 17 THEN bad:=jsonb_set(bad,'{availability}',
                             '[{"day":"1","start":"07:00","end":"12:00"}]'::jsonb);
     WHEN 18 THEN bad:=jsonb_set(bad,'{phone}','"14155551234"'::jsonb);
     WHEN 19 THEN bad:=jsonb_set(bad,'{phone}','"+1234567890123456"'::jsonb);
     WHEN 20 THEN bad:=jsonb_set(bad,'{unexpected}','true'::jsonb);
     WHEN 21 THEN bad:=jsonb_set(bad,'{availability}',
                             '[{"day":1,"start":"07:00","end":"12:00","extra":true}]'::jsonb);
     WHEN 22 THEN bad:=jsonb_set(bad,'{availability}',
                             '[{"day":1,"start":700,"end":"12:00"}]'::jsonb);
     WHEN 23 THEN bad:=jsonb_set(bad,'{availability}',
                             '[{"day":1.5,"start":"07:00","end":"12:00"}]'::jsonb);
     WHEN 24 THEN bad:=jsonb_set(bad,'{wageCents}','"1800"'::jsonb);
     WHEN 25 THEN bad:=jsonb_set(bad,'{availability}',
                             '[{"day":null,"start":"07:00","end":"12:00"}]'::jsonb);
     WHEN 26 THEN bad:=jsonb_set(bad,'{name}','"  "'::jsonb);
     WHEN 27 THEN bad:=jsonb_set(bad,'{phone}','""'::jsonb);
     WHEN 28 THEN bad:=jsonb_set(bad,'{wageCents}','0'::jsonb);
     WHEN 29 THEN bad:=jsonb_set(bad,'{availability}',
                             '[{"day":1,"start":"24:00","end":"12:00"}]'::jsonb);
   END CASE;
   BEGIN
     PERFORM public.staff_write_person(b,e,bad);
     RAISE EXCEPTION 'invalid case % accepted',ix;
   EXCEPTION WHEN sqlstate '22023' OR check_violation OR invalid_text_representation
          OR numeric_value_out_of_range THEN NULL;
   END;
 END LOOP;
 IF (SELECT display_name FROM public.employees WHERE id=e) IS DISTINCT FROM 'Amy'
    OR (SELECT count(*) FROM public.staff_availability_rules
        WHERE business_id=b AND employee_id=e)<>1 THEN
   RAISE EXCEPTION 'invalid JSON changed persisted employee/availability';
 END IF;
 -- A legitimate profile-only update keeps the existing window and its day list.
 PERFORM public.staff_write_person(b,e,jsonb_set(good,'{phone}','"+14155551234"'::jsonb));
 IF (SELECT phone_e164 FROM public.employees WHERE id=e) IS DISTINCT FROM '+14155551234'
    OR (SELECT available_days FROM public.employees WHERE id=e) IS DISTINCT FROM ARRAY[1]::smallint[]
    OR (SELECT count(*) FROM public.staff_availability_rules
        WHERE business_id=b AND employee_id=e AND day_of_week=1)<>1 THEN
   RAISE EXCEPTION 'valid phone/profile-only edit overwrote availability';
 END IF;
 -- E.164 boundary: 15 digits is valid; both editing and creation must accept it.
 PERFORM public.staff_write_person(b,e,jsonb_set(good,'{phone}','"+123456789012345"'::jsonb));
 IF (SELECT phone_e164 FROM public.employees WHERE id=e) IS DISTINCT FROM '+123456789012345' THEN
   RAISE EXCEPTION '15-digit E.164 phone was rejected or not persisted';
 END IF;
 PERFORM public.staff_write_person(b,NULL,
   '{"name":"New worker","phone":"+123456789012345","wageCents":null,
     "minWeeklyMinutes":0,"maxWeeklyMinutes":10080,"availability":[]}'::jsonb);
 IF (SELECT count(*) FROM public.employees
     WHERE business_id=b AND display_name='New worker'
       AND phone_e164='+123456789012345'
       AND min_weekly_minutes=0 AND max_weekly_minutes=10080)<>1 THEN
   RAISE EXCEPTION 'valid phone or weekly-limit boundaries failed on create';
 END IF;
END $$;
SELECT set_config('request.jwt.claim.sub',:'manager',true);
DO $$
BEGIN
 BEGIN
   PERFORM public.staff_write_person(
     current_setting('test.staff.guard.business')::uuid,
     current_setting('test.staff.guard.employee')::uuid,
     '{"name":"Unauthorized","availability":null}'::jsonb);
   RAISE EXCEPTION 'manager wrote owner-only RPC';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
ROLLBACK;
