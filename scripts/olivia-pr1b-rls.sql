\set ON_ERROR_STOP on
BEGIN;
SELECT gen_random_uuid() AS business, gen_random_uuid() AS owner,
 gen_random_uuid() AS co_owner, gen_random_uuid() AS manager,
 gen_random_uuid() AS employee, gen_random_uuid() AS location,
 gen_random_uuid() AS key1, gen_random_uuid() AS key2 \gset
INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
VALUES
 (:'owner','00000000-0000-0000-0000-000000000000','authenticated','authenticated','olivia1b-owner@example.invalid','',now(),now()),
 (:'co_owner','00000000-0000-0000-0000-000000000000','authenticated','authenticated','olivia1b-coowner@example.invalid','',now(),now()),
 (:'manager','00000000-0000-0000-0000-000000000000','authenticated','authenticated','olivia1b-manager@example.invalid','',now(),now());
INSERT INTO public.businesses(id,name,is_demo,timezone)
 VALUES(:'business','Olivia PR1B disposable',false,'America/Los_Angeles');
INSERT INTO public.memberships(business_id,user_id,role)
 VALUES(:'business',:'owner','owner'),(:'business',:'co_owner','owner'),(:'business',:'manager','manager');
INSERT INTO public.locations(id,business_id,name)
 VALUES(:'location',:'business','Night Shift Test');
INSERT INTO public.employees(id,business_id,display_name,active)
 VALUES(:'employee',:'business','Night employee',true);
-- Zone checked against real pg_timezone_names; invalid zone fails without changing state.
SELECT set_config('test.pr1b_location',:'location',true);
UPDATE public.locations SET timezone='America/Los_Angeles' WHERE id=:'location';
DO $$
BEGIN
 BEGIN
  UPDATE public.locations SET timezone='Not/A_Timezone' WHERE id=current_setting('test.pr1b_location',true)::uuid;
  RAISE EXCEPTION 'invalid timezone accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
END $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'owner',true);
SELECT set_config('test.pr1b_employee',:'employee',true);
SELECT set_config('test.pr1b_business',:'business',true);
SELECT set_config('test.pr1b_key',:'key1',true);
SELECT set_config('test.pr1b_location',:'location',true);
-- Full scope set: two Wednesday split windows in one atomic transaction.
SELECT public.scheduling_save_availability_batch(
 :'business'::uuid,:'employee'::uuid,NULL,'availability_rule',
 '{"effective_from":"2026-10-14","effective_to":null}'::jsonb,'[]'::jsonb,
 jsonb_build_array(
  jsonb_build_object('data',jsonb_build_object('employee_id',:'employee',
   'day_of_week',3,'start_local','07:00','end_local','11:00','overnight',false,
   'effective_from','2026-10-14','source','owner_direct','confirmation','owner_confirmed')),
  jsonb_build_object('data',jsonb_build_object('employee_id',:'employee',
   'day_of_week',3,'start_local','16:00','end_local','20:00','overnight',false,
   'effective_from','2026-10-14','source','owner_direct','confirmation','owner_confirmed'))
 ),:'key1'::uuid) AS first_result \gset
SELECT set_config('test.pr1b_first',:'first_result',true);
-- Exact retry returns same immutable two IDs, with no extra audit.
SELECT public.scheduling_save_availability_batch(
 :'business'::uuid,:'employee'::uuid,NULL,'availability_rule',
 '{"effective_from":"2026-10-14","effective_to":null}'::jsonb,'[]'::jsonb,
 jsonb_build_array(
  jsonb_build_object('data',jsonb_build_object('employee_id',:'employee',
   'day_of_week',3,'start_local','07:00','end_local','11:00','overnight',false,
   'effective_from','2026-10-14','source','owner_direct','confirmation','owner_confirmed')),
  jsonb_build_object('data',jsonb_build_object('employee_id',:'employee',
   'day_of_week',3,'start_local','16:00','end_local','20:00','overnight',false,
   'effective_from','2026-10-14','source','owner_direct','confirmation','owner_confirmed'))
 ),:'key1'::uuid) AS second_result \gset
SELECT set_config('test.pr1b_second',:'second_result',true);
DO $$
BEGIN
 IF (current_setting('test.pr1b_first')::jsonb->'records') <>
    (current_setting('test.pr1b_second')::jsonb->'records')
 OR (current_setting('test.pr1b_second')::jsonb->>'replayed')<>'true'
 OR (SELECT count(*) FROM public.staff_availability_rules
     WHERE business_id=current_setting('test.pr1b_business')::uuid)<>2
 OR (SELECT count(*) FROM public.scheduling_foundation_audit_events
     WHERE business_id=current_setting('test.pr1b_business')::uuid
       AND operation='INSERT' AND table_name='staff_availability_rules')<>2 THEN
   RAISE EXCEPTION 'batch replay duplicated record or audit';
 END IF;
END $$;
-- Same key with different payload conflicts.
DO $$
DECLARE conflict jsonb;
BEGIN
 SELECT public.scheduling_save_availability_batch(
 current_setting('test.pr1b_business')::uuid,current_setting('test.pr1b_employee')::uuid,
 NULL,'availability_rule','{"effective_from":"2026-10-14","effective_to":null}'::jsonb,
 '[]'::jsonb,'[]'::jsonb,current_setting('test.pr1b_key')::uuid) INTO conflict;
 IF conflict->>'conflict'<>'true' THEN RAISE EXCEPTION 'reused key modified payload'; END IF;
END $$;
-- Stale empty expected manifest cannot overwrite the saved two rows.
DO $$
DECLARE conflict jsonb; again jsonb; stable_key uuid:=gen_random_uuid();
BEGIN
 SELECT public.scheduling_save_availability_batch(
 current_setting('test.pr1b_business')::uuid,current_setting('test.pr1b_employee')::uuid,
 NULL,'availability_rule','{"effective_from":"2026-10-14","effective_to":null}'::jsonb,
 '[]'::jsonb,'[]'::jsonb,stable_key) INTO conflict;
 SELECT public.scheduling_save_availability_batch(
 current_setting('test.pr1b_business')::uuid,current_setting('test.pr1b_employee')::uuid,
 NULL,'availability_rule','{"effective_from":"2026-10-14","effective_to":null}'::jsonb,
 '[]'::jsonb,'[]'::jsonb,stable_key) INTO again;
 IF conflict->>'conflict'<>'true' OR again->>'conflict'<>'true' THEN
   RAISE EXCEPTION 'phantom batch overwrite/replayed conflict';
 END IF;
END $;
-- A late invalid row must roll back earlier updates and their audit events.
-- The SQL function's exception subtransaction preserves the original version.
DO $
DECLARE before_rows jsonb; after_rows jsonb; expected jsonb; before_audits integer;
BEGIN
 SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id::text),'[]'::jsonb)
 INTO before_rows FROM public.staff_availability_rules t
 WHERE t.business_id=current_setting('test.pr1b_business')::uuid;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'revision',revision)
   ORDER BY id::text),'[]'::jsonb)
 INTO expected FROM public.staff_availability_rules
 WHERE business_id=current_setting('test.pr1b_business')::uuid;
 SELECT count(*) INTO before_audits FROM public.scheduling_foundation_audit_events
  WHERE business_id=current_setting('test.pr1b_business')::uuid;
 BEGIN
  PERFORM public.scheduling_save_availability_batch(
   current_setting('test.pr1b_business')::uuid,
   current_setting('test.pr1b_employee')::uuid,NULL,'availability_rule',
   '{"effective_from":"2026-10-14","effective_to":null}'::jsonb, expected,
   jsonb_build_array(
    jsonb_build_object('id', (expected->0->>'id'),
      'data',jsonb_build_object('employee_id',current_setting('test.pr1b_employee'),
       'day_of_week',3,'start_local','07:30','end_local','11:30','overnight',false,
       'effective_from','2026-10-14','source','owner_direct',
       'confirmation','owner_confirmed')),
    jsonb_build_object('data',
      jsonb_build_object('employee_id',current_setting('test.pr1b_employee'),
       'day_of_week',4,'start_local','09:00','end_local','24:00:00','overnight',false,
       'effective_from','2026-10-14','source','owner_direct',
       'confirmation','owner_confirmed'))
    ),gen_random_uuid());
  RAISE EXCEPTION 'invalid final item committed';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id::text),'[]'::jsonb)
 INTO after_rows FROM public.staff_availability_rules t
 WHERE t.business_id=current_setting('test.pr1b_business')::uuid;
 IF before_rows<>after_rows OR before_audits<>(
   SELECT count(*) FROM public.scheduling_foundation_audit_events
   WHERE business_id=current_setting('test.pr1b_business')::uuid) THEN
    RAISE EXCEPTION 'failed batch partially changed records or audit';
 END IF;
END $;
-- Manager cannot invoke the elevated transactional RPC.
SELECT set_config('request.jwt.claim.sub',:'manager',true);
DO $$
BEGIN
 BEGIN
  PERFORM public.scheduling_save_availability_batch(
   current_setting('test.pr1b_business')::uuid,current_setting('test.pr1b_employee')::uuid,
   NULL,'availability_rule','{"effective_from":"2026-10-14","effective_to":null}'::jsonb,
   '[]'::jsonb,'[]'::jsonb,gen_random_uuid());
  RAISE EXCEPTION 'manager authorized for availability batch';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
-- Co-owner can read current revision snapshot but not overwrite with stale set.
SELECT set_config('request.jwt.claim.sub',:'co_owner',true);
DO $$
DECLARE conflict jsonb;
BEGIN
 SELECT public.scheduling_save_availability_batch(
   current_setting('test.pr1b_business')::uuid,current_setting('test.pr1b_employee')::uuid,
   NULL,'availability_rule','{"effective_from":"2026-10-14","effective_to":null}'::jsonb,
   '[]'::jsonb,'[]'::jsonb,gen_random_uuid()) INTO conflict;
 IF conflict->>'conflict'<>'true' THEN RAISE EXCEPTION 'coowner stale overwrite'; END IF;
END $$;
-- Ordinary per-record changes remain protected and audited.
UPDATE public.staff_availability_rules SET start_local='07:30'
 WHERE business_id=:'business' AND start_local='07:00';
DO $$
BEGIN
 IF (SELECT count(*) FROM public.staff_availability_rules
  WHERE business_id=current_setting('test.pr1b_business')::uuid
    AND start_local='07:30')<>1
 OR (SELECT count(*) FROM public.scheduling_foundation_audit_events
  WHERE business_id=current_setting('test.pr1b_business')::uuid
    AND operation='UPDATE' AND table_name='staff_availability_rules')<>1 THEN
  RAISE EXCEPTION 'coowner single-record update regressions';
 END IF;
END $$;
RESET ROLE;
ROLLBACK;
\echo Olivia PR1B disposable batch RLS and idempotency tests passed
