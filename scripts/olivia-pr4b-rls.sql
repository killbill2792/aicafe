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
SELECT set_config('test.pr4b_business',:'business',true);
SELECT set_config('test.pr4b_foreign',:'foreign_business',true);
SELECT set_config('test.pr4b_owner',:'owner',true);
SELECT set_config('test.pr4b_manager',:'manager',true);
SELECT set_config('test.pr4b_employee_a',:'employee_a',true);
SELECT set_config('test.pr4b_employee_b',:'employee_b',true);
SELECT set_config('test.pr4b_foreign_employee',:'foreign_employee',true);
SELECT set_config('test.pr4b_key',:'command_key',true);

DO $$
DECLARE b uuid:=current_setting('test.pr4b_business')::uuid;
 a uuid:=current_setting('test.pr4b_employee_a')::uuid;
 c uuid:=current_setting('test.pr4b_employee_b')::uuid;
 key uuid:=current_setting('test.pr4b_key')::uuid;
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
 PERFORM set_config('test.pr4b_batches',batches::text,true);
 PERFORM set_config('test.pr4b_old_token',token,true);
 first:=public.scheduling_olivia_commit_availability(b,token,key,batches);
 IF first->>'replayed'<>'false' OR jsonb_array_length(first->'batches')<>2
    OR first->>'actorId'<>current_setting('test.pr4b_owner') OR
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
   current_setting('test.pr4b_business')::uuid,current_setting('test.pr4b_old_token'),
   gen_random_uuid(),current_setting('test.pr4b_batches')::jsonb);
 IF result->>'error'<>'source_changed' THEN
   RAISE EXCEPTION 'stale cross-source token accepted';
 END IF;
END $$;

-- Co-owner/owner stale-manifest conflict in the second batch must roll back
-- all writes and audit from the first batch, across employees.
DO $$
DECLARE b uuid:=current_setting('test.pr4b_business')::uuid;
 a uuid:=current_setting('test.pr4b_employee_a')::uuid;
 c uuid:=current_setting('test.pr4b_employee_b')::uuid;
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

-- Clearing a prior timed exception must not inherit stale start/end columns
-- from PR1B's column-selective batch updater.
DO $$
DECLARE b uuid:=current_setting('test.pr4b_business')::uuid;
 c uuid:=current_setting('test.pr4b_employee_b')::uuid;
 old_row record; token text; batches jsonb; result jsonb;
BEGIN
 SELECT id,revision,start_local,end_local INTO old_row
 FROM public.staff_availability_exceptions
 WHERE business_id=b AND employee_id=c AND local_date='2026-10-22';
 IF old_row.id IS NULL OR old_row.start_local IS NULL OR old_row.end_local IS NULL
 THEN RAISE EXCEPTION 'missing timed exception fixture'; END IF;
 token:=public.scheduling_owner_source_token(b);
 batches:=jsonb_build_array(jsonb_build_object(
   'kind','availability_exception','employeeId',c,'locationId',NULL,
   'scope',jsonb_build_object('local_date','2026-10-22'),
   'expected',jsonb_build_array(jsonb_build_object(
     'id',old_row.id,'revision',old_row.revision)),
   'requestKey',gen_random_uuid(),
   'desired',jsonb_build_array(jsonb_build_object('id',old_row.id,
     'data',jsonb_build_object(
       'employee_id',c,'location_id',NULL,'local_date','2026-10-22',
       'exception_type','unavailable','start_local',NULL,'end_local',NULL,
       'overnight',false,'max_minutes',NULL,'source','owner_direct',
       'confirmation','owner_confirmed')))));
 result:=public.scheduling_olivia_commit_availability(
   b,token,gen_random_uuid(),batches);
 IF result->>'replayed'<>'false' OR NOT EXISTS(
   SELECT 1 FROM public.staff_availability_exceptions
   WHERE business_id=b AND id=old_row.id AND revision=old_row.revision+1
     AND exception_type='unavailable' AND start_local IS NULL
     AND end_local IS NULL AND max_minutes IS NULL) THEN
   RAISE EXCEPTION 'old timed exception columns were retained';
 END IF;
END $$;

-- Invalid nested UUID values must not claim an idempotency key. A valid
-- no-op retry with that same top-level key must succeed without table access
-- (command receipts are intentionally hidden from authenticated owners).
DO $$
DECLARE b uuid:=current_setting('test.pr4b_business')::uuid;
 a uuid:=current_setting('test.pr4b_employee_a')::uuid;
 token text; example jsonb; valid jsonb; result jsonb;
 request_key uuid:=gen_random_uuid();
BEGIN
 token:=public.scheduling_owner_source_token(b);
 example:=jsonb_build_array(jsonb_build_object(
   'kind','availability_exception','employeeId','not-a-uuid',
   'locationId',NULL,'scope',jsonb_build_object('local_date','2026-10-25'),
   'expected','[]'::jsonb,'desired','[]'::jsonb,
   'requestKey',gen_random_uuid()));
 result:=public.scheduling_olivia_commit_availability(
   b,token,request_key,example);
 IF result->>'error'<>'invalid_input' THEN
   RAISE EXCEPTION 'invalid nested employee UUID not rejected cleanly';
 END IF;
 valid:=jsonb_build_array(jsonb_build_object(
   'kind','availability_exception','employeeId',a,
   'locationId',NULL,'scope',jsonb_build_object('local_date','2026-10-25'),
   'expected','[]'::jsonb,'desired','[]'::jsonb,
   'requestKey',gen_random_uuid()));
 result:=public.scheduling_olivia_commit_availability(
   b,token,request_key,valid);
 IF result->>'replayed'<>'false' OR jsonb_array_length(result->'batches')<>1
 THEN RAISE EXCEPTION 'invalid command stranded its idempotency key'; END IF;
END $$;

-- Seed legacy recurring fixtures as the database owner: authenticated owners
-- normally write these protected tables through the PR1B SECURITY DEFINER RPC.
RESET ROLE;
-- Full recurring scope has three windows. PR4B must update ONLY the edited
-- row: the other two preserve revisions, confirmation metadata and audit counts.
DO $$
DECLARE b uuid:=current_setting('test.pr4b_business')::uuid;
 a uuid:=current_setting('test.pr4b_employee_a')::uuid;
 first_row public.staff_availability_rules%ROWTYPE;
 second_row public.staff_availability_rules%ROWTYPE;
 third_row public.staff_availability_rules%ROWTYPE;
 token text; manifest jsonb; desired jsonb; batches jsonb;
 result jsonb; replay jsonb; batch_key uuid:=gen_random_uuid();
 command_key uuid:=gen_random_uuid(); before_audit integer;
 before_second integer; before_third integer; confirmed_second timestamptz;
 confirmed_third timestamptz; updated_second timestamptz; updated_third timestamptz;
BEGIN
 INSERT INTO public.staff_availability_rules
  (business_id,employee_id,location_id,day_of_week,start_local,end_local,
   overnight,effective_from,effective_to,source,confirmation)
 VALUES (b,a,NULL,1,'08:00','12:00',false,'2026-10-26',NULL,
     'owner_direct','owner_confirmed') RETURNING * INTO first_row;
 INSERT INTO public.staff_availability_rules
  (business_id,employee_id,location_id,day_of_week,start_local,end_local,
   overnight,effective_from,effective_to,source,confirmation)
 VALUES (b,a,NULL,2,'09:00','13:00',false,'2026-10-26',NULL,
     'worker_reported_by_owner','owner_confirmed') RETURNING * INTO second_row;
 INSERT INTO public.staff_availability_rules
  (business_id,employee_id,location_id,day_of_week,start_local,end_local,
   overnight,effective_from,effective_to,source,confirmation)
 VALUES (b,a,NULL,3,'10:00','14:00',false,'2026-10-26',NULL,
     'owner_direct','owner_confirmed') RETURNING * INTO third_row;
 token:=public.scheduling_owner_source_token(b);
 manifest:=jsonb_build_array(
   jsonb_build_object('id',first_row.id,'revision',first_row.revision),
   jsonb_build_object('id',second_row.id,'revision',second_row.revision),
   jsonb_build_object('id',third_row.id,'revision',third_row.revision));
 desired:=jsonb_build_array(
   jsonb_build_object('id',first_row.id,'data',
     (to_jsonb(first_row) - ARRAY['id','business_id','revision','created_at',
       'updated_at','created_by','updated_by','confirmed_by','confirmed_at'])
       || jsonb_build_object('start_local','07:00','end_local','12:00')),
   jsonb_build_object('id',second_row.id,'data',
     to_jsonb(second_row) - ARRAY['id','business_id','revision','created_at',
       'updated_at','created_by','updated_by','confirmed_by','confirmed_at']),
   jsonb_build_object('id',third_row.id,'data',
     to_jsonb(third_row) - ARRAY['id','business_id','revision','created_at',
       'updated_at','created_by','updated_by','confirmed_by','confirmed_at']));
 batches:=jsonb_build_array(jsonb_build_object(
   'kind','availability_rule','employeeId',a,'locationId',NULL,
   'scope',jsonb_build_object('effective_from','2026-10-26','effective_to',NULL),
   'expected',manifest,'desired',desired,'requestKey',batch_key));
 SELECT count(*) INTO before_audit
   FROM public.scheduling_foundation_audit_events
   WHERE business_id=b AND table_name='staff_availability_rules';
 SELECT count(*) INTO before_second FROM public.scheduling_foundation_audit_events
   WHERE business_id=b AND record_id=second_row.id;
 SELECT count(*) INTO before_third FROM public.scheduling_foundation_audit_events
   WHERE business_id=b AND record_id=third_row.id;
 confirmed_second:=second_row.confirmed_at;
 confirmed_third:=third_row.confirmed_at;
 updated_second:=second_row.updated_at;
 updated_third:=third_row.updated_at;
 result:=public.scheduling_olivia_commit_availability(b,token,command_key,batches);
 IF result->>'replayed'<>'false' OR
    jsonb_array_length(result->'batches'->0->'records')<>3 THEN
   RAISE EXCEPTION 'full-scope batch result was not positional';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.staff_availability_rules
   WHERE business_id=b AND id=first_row.id AND revision=first_row.revision+1
     AND start_local='07:00') THEN
   RAISE EXCEPTION 'edited recurring row did not advance';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.staff_availability_rules
   WHERE business_id=b AND id=second_row.id AND revision=second_row.revision
     AND confirmed_at=confirmed_second AND updated_at=updated_second) OR
    NOT EXISTS(SELECT 1 FROM public.staff_availability_rules
   WHERE business_id=b AND id=third_row.id AND revision=third_row.revision
     AND confirmed_at=confirmed_third AND updated_at=updated_third) THEN
   RAISE EXCEPTION 'untouched recurring window was rewritten';
 END IF;
 IF (SELECT count(*) FROM public.scheduling_foundation_audit_events
     WHERE business_id=b AND table_name='staff_availability_rules')<>before_audit+1
    OR (SELECT count(*) FROM public.scheduling_foundation_audit_events
     WHERE business_id=b AND record_id=second_row.id)<>before_second
    OR (SELECT count(*) FROM public.scheduling_foundation_audit_events
     WHERE business_id=b AND record_id=third_row.id)<>before_third THEN
   RAISE EXCEPTION 'untouched recurring window generated audit events';
 END IF;
 IF (result->'batches'->0->'records'->1->>'revision')::integer<>second_row.revision
    OR (result->'batches'->0->'records'->2->>'revision')::integer<>third_row.revision THEN
   RAISE EXCEPTION 'unchanged receipt revisions did not match saved rows';
 END IF;
 replay:=public.scheduling_olivia_commit_availability(
   b,token,command_key,batches);
 IF replay->>'replayed'<>'true' OR replay->'batches'<>result->'batches' OR
    (SELECT count(*) FROM public.scheduling_foundation_audit_events
     WHERE business_id=b AND table_name='staff_availability_rules')<>before_audit+1 THEN
   RAISE EXCEPTION 'recurring idempotency replay mutated preserved rows';
 END IF;
END $$;

SET ROLE authenticated;
-- Tenant RLS, role authorization and unprotected receipt access are denied.
SELECT set_config('request.jwt.claim.sub',:'manager',true);
DO $$
DECLARE result jsonb;
BEGIN
 result:=public.scheduling_olivia_commit_availability(
  current_setting('test.pr4b_business')::uuid,'aabbccddeeff00112233445566778899',
  gen_random_uuid(),current_setting('test.pr4b_batches')::jsonb);
 IF result->>'error'<>'unauthorized' THEN RAISE EXCEPTION 'manager wrote availability'; END IF;
 BEGIN
  PERFORM 1 FROM public.scheduling_olivia_command_receipts LIMIT 1;
  RAISE EXCEPTION 'receipt table was exposed';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
SELECT set_config('request.jwt.claim.sub',:'owner',true);
DO $$
DECLARE b uuid:=current_setting('test.pr4b_business')::uuid;
 foreign_id uuid:=current_setting('test.pr4b_foreign_employee')::uuid;
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
