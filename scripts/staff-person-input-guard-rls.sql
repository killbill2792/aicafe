-- Disposable-only regressions for direct RPC clients that bypass Zod.
-- Append after existing staff-pr155-rls.sql in the same psql session/transaction
-- or execute standalone; this fixture rolls back all changes.
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
 FOR ix IN 1..17 LOOP
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
 IF (SELECT available_days FROM public.employees WHERE id=e) IS DISTINCT FROM ARRAY[1]::smallint[]
    OR (SELECT count(*) FROM public.staff_availability_rules
        WHERE business_id=b AND employee_id=e AND day_of_week=1)<>1 THEN
   RAISE EXCEPTION 'profile-only edit overwrote availability';
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
