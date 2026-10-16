\set ON_ERROR_STOP on
BEGIN;
SELECT gen_random_uuid() AS business, gen_random_uuid() AS owner,
 gen_random_uuid() AS manager, gen_random_uuid() AS outsider,
 gen_random_uuid() AS employee_a, gen_random_uuid() AS employee_b,
 gen_random_uuid() AS foreign_business, gen_random_uuid() AS foreign_employee,
 gen_random_uuid() AS command_key \gset

INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
VALUES (:'owner','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
        'olivia4b-owner@example.invalid','',now(),now()),
       (:'manager','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
        'olivia4b-manager@example.invalid','',now(),now()),
       (:'outsider','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
        'olivia4b-outsider@example.invalid','',now(),now());
INSERT INTO public.businesses(id,name,is_demo,timezone)
VALUES (:'business','Olivia 4B Test',false,'America/Los_Angeles'),
       (:'foreign_business','Other Cafe',false,'America/Los_Angeles');
INSERT INTO public.memberships(business_id,user_id,role)
VALUES(:'business',:'owner','owner'),(:'business',:'manager','manager'),
      (:'foreign_business',:'outsider','owner');
INSERT INTO public.employees(id,business_id,display_name,active)
VALUES(:'employee_a',:'business','Ana',true),
      (:'employee_b',:'business','Bea',true),
      (:'foreign_employee',:'foreign_business','Not Ours',true);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'owner',true);
SELECT set_config('test.4b_business',:'business',true);
SELECT set_config('test.4b_foreign',:'foreign_business',true);
SELECT set_config('test.4b_owner',:'owner',true);
SELECT set_config('test.4b_manager',:'manager',true);
SELECT set_config('test.4b_employee_a',:'employee_a',true);
SELECT set_config('test.4b_employee_b',:'employee_b',true);
SELECT set_config('test.4b_foreign_employee',:'foreign_employee',true);
SELECT set_config('test.4b_key',:'command_key',true);

DO $$
DECLARE b uuid:=current_setting('test.4b_business')::uuid;
 a uuid:=current_setting('test.4b_employee_a')::uuid;
 c uuid:=current_setting('test.4b_employee_b')::uuid;
 key uuid:=current_setting('test.4b_key')::uuid;
 token text; batches jsonb; first jsonb; replay jsonb; reused jsonb;
 before_audits integer;
BEGIN
 token:=public.scheduling_owner_source_token(b);
 batches:=jsonb_build_array(
  jsonb_build_object('kind','availability_exception','employeeId',a,
    'locationId',NULL,'scope',jsonb_build_object('local_date','2026-10-20'),
    'expected','[]'::jsonb,'requestKey',gen_random_uuid(),
    'desired',jsonb_build_array(jsonb_build_object('data',jsonb_build_object(
      'employee_id',a,'location_id',NULL,'local_date','2026-10-20',
      'exception_type','unavailable','start_local',NULL,'end_local',NULL,
      'overnight',false,'max_minutes',NULL,'source','worker_reported_by_owner',
      'confirmation','owner_confirmed')))),
  jsonb_build_object('kind','availability_exception','employeeId',c,
    'locationId',NULL,'scope',jsonb_build_object('local_date','2026-10-22'),
    'expected','[]'::jsonb,'requestKey',gen_random_uuid(),
    'desired',jsonb_build_array(jsonb_build_object('data',jsonb_build_object(
      'employee_id',c,'location_id',NULL,'local_date','2026-10-22',
      'exception_type','replace_day','start_local','08:00','end_local','12:00',
      'overnight',false,'max_minutes',NULL,'source','owner_direct',
      'confirmation','owner_confirmed'))))
 );
 PERFORM set_config('test.4b_batches',batches::text,true);
 PERFORM set_config('test.4b_old_token',token,true);
 first:=public.scheduling_olivia_commit_availability(b,token,key,batches);
 IF first->>'replayed'<>'false' OR jsonb_array_length(first->'batches')<>2
    OR first->>'actorId'<>current_setting('test.4b_owner') OR
    (SELECT count(*) FROM public.staff_availability_exceptions
      WHERE business_id=b)<>2 THEN
   RAISE EXCEPTION 'multi-employee save failed';
 END IF;
 SELECT count(*) INTO before_audits FROM public.scheduling_foundation_audit_events
  WHERE business_id=b;
 replay:=public.scheduling_olivia_commit_availability(b,token,key,batches);
 IF replay->>'replayed'<>'true' OR replay->'batches'<>first->'batches'
   OR before_audits<>(
     SELECT count(*) FROM public.scheduling_foundation_audit_events WHERE business_id=b
   ) THEN
   RAISE EXCEPTION 'idempotent replay duplicated availability or audit';
 END IF;
 reused:=public.scheduling_olivia_commit_availability(b,token,key,'[]'::jsonb);
 IF reused->>'error'<>'invalid_input' THEN RAISE EXCEPTION 'bad invalid-input check'; END IF;
 reused:=public.scheduling_olivia_commit_availability(b,token,key,
    jsonb_set(batches,'{0,scope,local_date}','"2026-10-23"'::jsonb));
 IF reused->>'error'<>'conflict' THEN RAISE EXCEPTION 'reused key mutated command'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.staff_availability_exceptions
   WHERE business_id=b AND employee_id=a AND local_date='2026-10-20'
     AND confirmation='owner_confirmed' AND source='worker_reported_by_owner') THEN
   RAISE EXCEPTION 'confirmed provenance was lost';
 END IF;
END $$;

-- After the first commit the original source token is stale.
DO $$
DECLARE result jsonb;
BEGIN
 result:=public.scheduling_olivia_commit_availability(
   current_setting('test.4b_business')::uuid,current_setting('test.4b_old_token'),
   gen_random_uuid(),current_setting('test.4b_batches')::jsonb);
 IF result->>'error'<>'source_changed' THEN
   RAISE EXCEPTION 'stale cross-source token accepted';
 END IF;
END $$;

-- Co-owner/owner stale-manifest conflict in the second batch must roll back
-- all writes and audit from the first batch, across employees.
DO $$
DECLARE b uuid:=current_setting('test.4b_business')::uuid;
 a uuid:=current_setting('test.4b_employee_a')::uuid;
 c uuid:=current_setting('test.4b_employee_b')::uuid;
 token text; batches jsonb; before_audits integer; failed boolean:=false;
BEGIN
 token:=public.scheduling_owner_source_token(b);
 SELECT count(*) INTO before_audits FROM public.scheduling_foundation_audit_events
  WHERE business_id=b;
 batches:=jsonb_build_array(
  jsonb_build_object('kind','availability_exception','employeeId',a,
    'locationId',NULL,'scope',jsonb_build_object('local_date','2026-10-23'),
    'expected','[]'::jsonb,'requestKey',gen_random_uuid(),
    'desired',jsonb_build_array(jsonb_build_object('data',jsonb_build_object(
      'employee_id',a,'location_id',NULL,'local_date','2026-10-23',
      'exception_type','unavailable','overnight',false,'source','owner_direct',
      'confirmation','owner_confirmed')))),
  jsonb_build_object('kind','availability_exception','employeeId',c,
    'locationId',NULL,'scope',jsonb_build_object('local_date','2026-10-22'),
    'expected','[]'::jsonb,'requestKey',gen_random_uuid(),
    'desired','[]'::jsonb)
 );
 BEGIN
  PERFORM public.scheduling_olivia_commit_availability(b,token,gen_random_uuid(),batches);
 EXCEPTION WHEN SQLSTATE 'P4B01' THEN failed:=true;
 END;
 IF NOT failed OR EXISTS(SELECT 1 FROM public.staff_availability_exceptions
   WHERE business_id=b AND employee_id=a AND local_date='2026-10-23')
   OR before_audits<>(
     SELECT count(*) FROM public.scheduling_foundation_audit_events WHERE business_id=b
   ) THEN RAISE EXCEPTION 'partial multi-employee write survived conflict'; END IF;
END $$;

-- Tenant RLS, role authorization and unprotected receipt access are denied.
SELECT set_config('request.jwt.claim.sub',:'manager',true);
DO $$
DECLARE result jsonb;
BEGIN
 result:=public.scheduling_olivia_commit_availability(
  current_setting('test.4b_business')::uuid,'aabbccddeeff00112233445566778899',
  gen_random_uuid(),current_setting('test.4b_batches')::jsonb);
 IF result->>'error'<>'unauthorized' THEN RAISE EXCEPTION 'manager wrote availability'; END IF;
 BEGIN
  PERFORM 1 FROM public.scheduling_olivia_command_receipts LIMIT 1;
  RAISE EXCEPTION 'receipt table was exposed';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
SELECT set_config('request.jwt.claim.sub',:'owner',true);
DO $$
DECLARE b uuid:=current_setting('test.4b_business')::uuid;
 foreign_id uuid:=current_setting('test.4b_foreign_employee')::uuid;
 token text; result jsonb;
BEGIN
 token:=public.scheduling_owner_source_token(b);
 result:=public.scheduling_olivia_commit_availability(
  b,token,gen_random_uuid(),jsonb_build_array(jsonb_build_object(
    'kind','availability_exception','employeeId',foreign_id,'locationId',NULL,
    'scope',jsonb_build_object('local_date','2026-10-24'),
    'expected','[]'::jsonb,'desired','[]'::jsonb,
    'requestKey',gen_random_uuid())));
 IF result->>'error'<>'invalid_input' THEN
   RAISE EXCEPTION 'foreign café employee accepted'; END IF;
 IF EXISTS(SELECT 1 FROM public.staff_availability_exceptions
   WHERE employee_id=foreign_id) THEN RAISE EXCEPTION 'foreign tenant modified'; END IF;
END $$;
RESET ROLE;
ROLLBACK;
\echo Olivia PR4B-A transactional tenant/CAS/replay/audit tests passed
