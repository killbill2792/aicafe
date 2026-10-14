\set ON_ERROR_STOP on
-- Real database tests: execute only against disposable Supabase after migrations.
-- All inserts are wrapped in a rollback; no production data is accessed.
BEGIN;
SELECT gen_random_uuid() AS owner_id, gen_random_uuid() AS manager_id,
       gen_random_uuid() AS foreign_owner_id,
       gen_random_uuid() AS co_owner_id, gen_random_uuid() AS stranger_id,
       gen_random_uuid() AS biz_a, gen_random_uuid() AS biz_b,
       gen_random_uuid() AS employee_a, gen_random_uuid() AS employee_b,
       gen_random_uuid() AS loc_a, gen_random_uuid() AS loc_b
\gset
INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
VALUES
 (:'owner_id','00000000-0000-0000-0000-000000000000','authenticated','authenticated','olivia-pr1a-owner@example.invalid','',now(),now()),
 (:'manager_id','00000000-0000-0000-0000-000000000000','authenticated','authenticated','olivia-pr1a-manager@example.invalid','',now(),now()),
 (:'foreign_owner_id','00000000-0000-0000-0000-000000000000','authenticated','authenticated','olivia-pr1a-other@example.invalid','',now(),now()),
 (:'co_owner_id','00000000-0000-0000-0000-000000000000','authenticated','authenticated','olivia-pr1a-co-owner@example.invalid','',now(),now()),
 (:'stranger_id','00000000-0000-0000-0000-000000000000','authenticated','authenticated','olivia-pr1a-stranger@example.invalid','',now(),now());
INSERT INTO businesses(id,name,is_demo) VALUES
 (:'biz_a','Olivia Test A',false),(:'biz_b','Olivia Test B',false);
INSERT INTO memberships(business_id,user_id,role) VALUES
 (:'biz_a',:'owner_id','owner'),(:'biz_a',:'manager_id','manager'),
 (:'biz_a',:'co_owner_id','owner'),
 (:'biz_b',:'foreign_owner_id','owner');
INSERT INTO locations(id,business_id,name) VALUES
 (:'loc_a',:'biz_a','A'),(:'loc_b',:'biz_b','B');
INSERT INTO employees(id,business_id,display_name,active) VALUES
 (:'employee_a',:'biz_a','Alex A',true),(:'employee_b',:'biz_b','Alex B',true);
SELECT set_config('test.biz_a',:'biz_a',true),set_config('test.biz_b',:'biz_b',true),
       set_config('test.employee_a',:'employee_a',true),
       set_config('test.employee_b',:'employee_b',true),
       set_config('test.loc_a',:'loc_a',true),set_config('test.loc_b',:'loc_b',true);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'owner_id',true);

-- Defense in depth: PostgREST authenticated owners MUST NOT directly
-- INSERT into any of the eight authoritative foundation tables. Check both
-- SQL permissions and absence of permissive INSERT policies; exercise direct
-- SQL as an authenticated owner (including qualification/compensation).
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY[
  'staff_availability_rules','staff_availability_exceptions',
  'staff_scheduling_preferences','staff_preference_windows',
  'scheduling_qualification_types','staff_qualifications',
  'scheduling_coverage_requirements','staff_scheduling_compensation'
 ] LOOP
  IF has_table_privilege('authenticated',format('public.%I',t),'INSERT') THEN
   RAISE EXCEPTION 'DIRECT_INSERT_GRANT_REMAINS: %',t;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename=t AND cmd IN ('INSERT','ALL')) THEN
   RAISE EXCEPTION 'DIRECT_INSERT_POLICY_REMAINS: %',t;
  END IF;
  BEGIN
   EXECUTE format('INSERT INTO public.%I DEFAULT VALUES',t);
   RAISE EXCEPTION 'AUTHENTICATED_OWNER_DIRECT_INSERT_ACCEPTED: %',t;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
 END LOOP;
END $$;

-- Owner creates through RPC only; distinct split windows retain their identity.
SELECT public.scheduling_create_foundation(
 :'biz_a'::uuid,'availability_rule',gen_random_uuid(),
 jsonb_build_object('employee_id',:'employee_a','day_of_week',3,
 'start_local','07:00','end_local','11:00','overnight',false,
 'effective_from','2026-10-14','source','worker_reported_by_owner','confirmation','owner_confirmed'));
SELECT public.scheduling_create_foundation(
 :'biz_a'::uuid,'availability_rule',gen_random_uuid(),
 jsonb_build_object('employee_id',:'employee_a','day_of_week',3,
 'start_local','16:00','end_local','20:00','overnight',false,
 'effective_from','2026-10-14','source','worker_reported_by_owner','confirmation','owner_confirmed'));
SELECT public.scheduling_create_foundation(
 :'biz_a'::uuid,'availability_exception',gen_random_uuid(),
 jsonb_build_object('employee_id',:'employee_a','local_date','2026-10-15',
 'exception_type','unavailable','source','owner_direct','confirmation','owner_confirmed'));
SELECT public.scheduling_create_foundation(
 :'biz_a'::uuid,'preferences',gen_random_uuid(),
 jsonb_build_object('employee_id',:'employee_a','effective_from','2026-10-14',
 'min_weekly_minutes',120,'desired_weekly_minutes',240,'max_weekly_minutes',480,
 'source','owner_direct','confirmation','owner_confirmed'));
SELECT public.scheduling_create_foundation(
 :'biz_a'::uuid,'qualification_type',gen_random_uuid(),
 jsonb_build_object('code','opener','display_name','Opening qualified'));
SELECT public.scheduling_create_foundation(
 :'biz_a'::uuid,'qualification',gen_random_uuid(),
 jsonb_build_object('employee_id',:'employee_a','qualification_code','opener',
 'valid_from','2026-10-14','source','owner_direct','confirmation','owner_confirmed'));
SELECT public.scheduling_create_foundation(
 :'biz_a'::uuid,'coverage',gen_random_uuid(),
 jsonb_build_object('location_id',:'loc_a','day_of_week',3,'effective_from','2026-10-14',
 'start_local','07:00','end_local','11:00','overnight',false,
 'min_headcount',1,'qualification_code','opener','source','owner_direct',
 'confirmation','owner_confirmed'));
DO $$
BEGIN
 IF (SELECT count(*) FROM staff_availability_rules
     WHERE business_id=current_setting('test.biz_a')::uuid)<>2 THEN
   RAISE EXCEPTION 'split-window test failed';
 END IF;
 IF (SELECT count(*) FROM scheduling_foundation_audit_events
     WHERE business_id=current_setting('test.biz_a')::uuid AND operation='INSERT')<6 THEN
   RAISE EXCEPTION 'missing atomic audit inserts';
 END IF;
 IF (SELECT count(*) FROM staff_availability_rules
     WHERE confirmation='owner_confirmed' AND confirmed_by=auth.uid())<>2 THEN
   RAISE EXCEPTION 'owner confirmation attribution failed';
 END IF;
END $$;

-- Composite FK rejects employee and location IDs from another business, even
-- when an otherwise privileged owner supplies them.
DO $$
BEGIN
 BEGIN
  PERFORM public.scheduling_create_foundation(
   current_setting('test.biz_a')::uuid,'availability_rule',gen_random_uuid(),
   jsonb_build_object('employee_id',current_setting('test.employee_b'),
   'day_of_week',3,'start_local','09:00','end_local','17:00','overnight',false,
   'effective_from','2026-10-14','source','owner_direct','confirmation','unconfirmed'));
  RAISE EXCEPTION 'CROSS_TENANT_EMPLOYEE_ACCEPTED';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
 BEGIN
  PERFORM public.scheduling_create_foundation(
   current_setting('test.biz_a')::uuid,'coverage',gen_random_uuid(),
   jsonb_build_object('location_id',current_setting('test.loc_b'),
   'day_of_week',3,'effective_from','2026-10-14','start_local','09:00',
   'end_local','17:00','overnight',false,'min_headcount',1,
   'source','owner_direct','confirmation','unconfirmed'));
  RAISE EXCEPTION 'CROSS_TENANT_LOCATION_ACCEPTED';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
END $$;

-- Direct writes to the immutable audit table are denied.
DO $$
BEGIN
 BEGIN
  INSERT INTO scheduling_foundation_audit_events
  (business_id,table_name,record_id,operation)
  VALUES (current_setting('test.biz_a')::uuid,'staff_availability_rules',gen_random_uuid(),'INSERT');
  RAISE EXCEPTION 'AUDIT_TAMPER_ACCEPTED';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;

-- Manager sees no sensitive scheduling records and cannot create/alter them.
SELECT set_config('request.jwt.claim.sub',:'manager_id',true);
DO $$
BEGIN
 IF (SELECT count(*) FROM staff_availability_rules
     WHERE business_id=current_setting('test.biz_a')::uuid)<>0 THEN
   RAISE EXCEPTION 'MANAGER_READ_ACCEPTED';
 END IF;
 BEGIN
  INSERT INTO staff_availability_exceptions
    (business_id,employee_id,local_date,exception_type,source)
  VALUES (current_setting('test.biz_a')::uuid,current_setting('test.employee_a')::uuid,
    '2026-10-16','unavailable','owner_direct');
  RAISE EXCEPTION 'MANAGER_WRITE_ACCEPTED';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;

-- Owner B must not be able to read owner A records even with known UUIDs.
SELECT set_config('request.jwt.claim.sub',:'foreign_owner_id',true);
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM staff_availability_rules
    WHERE business_id=current_setting('test.biz_a')::uuid) THEN
  RAISE EXCEPTION 'FOREIGN_OWNER_READ_ACCEPTED';
 END IF;
END $$;

-- A documented owner attestation cannot silently override a positive wage.
RESET ROLE;
UPDATE employees SET wage_period='hour',wage_amount_cents=1200,default_hourly_wage_cents=1200
 WHERE id=:'employee_a';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'owner_id',true);
DO $$
BEGIN
 BEGIN
  PERFORM public.scheduling_create_foundation(
   current_setting('test.biz_a')::uuid,'compensation',gen_random_uuid(),
   jsonb_build_object('employee_id',current_setting('test.employee_a'),
   'cash_cost_state','known_eligible_zero','eligibility_reference',
   'Owner reviewed classification and legal basis'));
  RAISE EXCEPTION 'PAID_EMPLOYEE_MARKED_FREE';
 EXCEPTION WHEN raise_exception THEN
   IF SQLERRM='PAID_EMPLOYEE_MARKED_FREE' THEN RAISE; END IF;
 END;
END $$;

-- No backfill occurs: foreign owner B has UNKNOWN until a deliberate record.
SELECT set_config('request.jwt.claim.sub',:'foreign_owner_id',true);
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM staff_scheduling_compensation
   WHERE employee_id=current_setting('test.employee_b')::uuid) THEN
   RAISE EXCEPTION 'unknown wages were auto-inferred';
 END IF;
END $$;
-- An owner can attest true zero cost ONLY with recorded evidence; that
-- record remains explicitly distinct from a future converted salary.
SELECT public.scheduling_create_foundation(
 :'biz_b'::uuid,'compensation',gen_random_uuid(),
 jsonb_build_object('employee_id',:'employee_b','cash_cost_state','known_eligible_zero',
 'eligibility_reference','Owner reviewed and recorded statutory eligibility evidence'));
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM staff_scheduling_compensation
     WHERE employee_id=current_setting('test.employee_b')::uuid
     AND cash_cost_state='known_eligible_zero'
     AND eligibility_verified_by=auth.uid()
     AND eligibility_verified_at IS NOT NULL) THEN
  RAISE EXCEPTION 'verified-zero provenance not captured';
 END IF;
END $$;
-- Mimics the EXACT canonical employee field update used by
-- lib/actions/staff.ts updateEmployee(): a signed-in owner updates employees,
-- not the compensation record. The employees AFTER UPDATE trigger must
-- invalidate the prior zero attestation before this UPDATE returns.
UPDATE employees SET display_name='Alex B salary',role='barista',
 wage_period='month',wage_amount_cents=200000,default_hourly_wage_cents=0
 WHERE business_id=:'biz_b' AND id=:'employee_b';
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM staff_scheduling_compensation
   WHERE employee_id=current_setting('test.employee_b')::uuid
   AND cash_cost_state='unknown'
   AND eligibility_reference IS NULL AND eligibility_verified_at IS NULL
   AND eligibility_verified_by IS NULL AND revision=2) THEN
   RAISE EXCEPTION 'STAFF_SALARY_EDIT_LEFT_STALE_ZERO';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM scheduling_foundation_audit_events
    WHERE business_id=current_setting('test.biz_b')::uuid
    AND table_name='staff_scheduling_compensation'
    AND operation='UPDATE'
    AND before_value->>'cash_cost_state'='known_eligible_zero'
    AND after_value->>'cash_cost_state'='unknown') THEN
   RAISE EXCEPTION 'WAGE_INVALIDATION_NOT_AUDITED';
 END IF;
END $$;
UPDATE staff_scheduling_compensation
 SET cash_cost_state='salary_conversion_pending',eligibility_reference=NULL
 WHERE business_id=:'biz_b' AND employee_id=:'employee_b';
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM staff_scheduling_compensation
     WHERE employee_id=current_setting('test.employee_b')::uuid
     AND cash_cost_state='salary_conversion_pending'
     AND eligibility_verified_by IS NULL
     AND eligibility_verified_at IS NULL) THEN
  RAISE EXCEPTION 'salary-pending incorrectly kept verified-zero';
 END IF;
END $$;

-- Also exercise the hourly version of updateEmployee() against a real
-- signed-in owner's authenticated RLS session. A past timecard is intentionally
-- present to ensure the scheduling trigger never mutates payroll history.
RESET ROLE;
SELECT gen_random_uuid() AS employee_c \gset
SELECT set_config('test.employee_c',:'employee_c',true);
INSERT INTO employees(id,business_id,display_name,active,
 wage_period,wage_amount_cents,default_hourly_wage_cents)
VALUES (:'employee_c',:'biz_b','Hourly attestation test',true,'hour',0,0);
INSERT INTO timecards(business_id,employee_id,clock_in,clock_out,hourly_wage_cents)
VALUES (:'biz_b',:'employee_c',
 '2026-09-20T09:00:00Z','2026-09-20T12:00:00Z',1100);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'foreign_owner_id',true);
SELECT public.scheduling_create_foundation(
 :'biz_b'::uuid,'compensation',gen_random_uuid(),
 jsonb_build_object('employee_id',:'employee_c','cash_cost_state','known_eligible_zero',
 'eligibility_reference','Owner-reviewed specific zero-cost eligibility attestation'));
-- Changing a name alone must not revoke a still-consistent attestation.
UPDATE employees SET display_name='Hourly employee renamed'
 WHERE business_id=:'biz_b' AND id=current_setting('test.employee_c')::uuid;
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM staff_scheduling_compensation
    WHERE employee_id=current_setting('test.employee_c')::uuid AND cash_cost_state='known_eligible_zero'
    AND revision=1) THEN
   RAISE EXCEPTION 'NON_WAGE_STAFF_EDIT_REVOKED_ZERO';
 END IF;
END $$;
-- Existing Staff wage-update field set, performed as the employee's owner.
UPDATE employees SET display_name='Hourly employee paid',role='cashier',
 wage_period='hour',wage_amount_cents=1800,default_hourly_wage_cents=1800
 WHERE business_id=:'biz_b' AND id=current_setting('test.employee_c')::uuid;
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM staff_scheduling_compensation
    WHERE business_id=current_setting('test.biz_b')::uuid
    AND employee_id=current_setting('test.employee_c')::uuid
    AND cash_cost_state='unknown'
    AND revision=2
    AND eligibility_reference IS NULL
    AND eligibility_verified_by IS NULL
    AND eligibility_verified_at IS NULL) THEN
   RAISE EXCEPTION 'STAFF_HOURLY_EDIT_LEFT_STALE_ZERO';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM employees
    WHERE id=current_setting('test.employee_c')::uuid AND wage_amount_cents=1800
      AND default_hourly_wage_cents=1800 AND display_name='Hourly employee paid') THEN
   RAISE EXCEPTION 'STAFF_EMPLOYEE_WAGE_EDIT_NOT_PRESERVED';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM timecards
    WHERE employee_id=current_setting('test.employee_c')::uuid AND hourly_wage_cents=1100
      AND clock_in='2026-09-20T09:00:00Z'
      AND clock_out='2026-09-20T12:00:00Z') THEN
   RAISE EXCEPTION 'HISTORIC_TIMECARD_CHANGED';
 END IF;
END $$;
-- Once a positive wage exists, a user cannot reattest the person as zero.
DO $$
BEGIN
 BEGIN
  UPDATE staff_scheduling_compensation
    SET cash_cost_state='known_eligible_zero',
        eligibility_reference='Retried after positive hourly wage'
    WHERE employee_id=current_setting('test.employee_c')::uuid;
  RAISE EXCEPTION 'STALE_ZERO_REATTESTATION_ACCEPTED';
 EXCEPTION WHEN raise_exception THEN
   IF SQLERRM='STALE_ZERO_REATTESTATION_ACCEPTED' THEN RAISE; END IF;
 END;
END $$;

-- A salaried employee marked salary_conversion_pending becomes hourly
-- through the same employee fields updated by Staff.updateEmployee().
-- Do not retain a stale salary-pending status when the conversion is irrelevant.
UPDATE employees SET display_name='Alex B now hourly',role='barista',
 wage_period='hour',wage_amount_cents=1850,default_hourly_wage_cents=1850
 WHERE business_id=:'biz_b' AND id=:'employee_b';
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM staff_scheduling_compensation
    WHERE employee_id=current_setting('test.employee_b')::uuid
    AND cash_cost_state='unknown' AND eligibility_reference IS NULL)
 THEN RAISE EXCEPTION 'STAFF_SALARY_PENDING_TO_HOURLY_STALE'; END IF;
END $$;
-- Explicitly review an hourly known_paid state, then keep it on a raise
-- because that state remains consistent with canonical positive wages.
UPDATE staff_scheduling_compensation SET cash_cost_state='known_paid'
 WHERE business_id=:'biz_b' AND employee_id=:'employee_b';
UPDATE employees SET display_name='Alex B raised',role='barista',
 wage_period='hour',wage_amount_cents=1950,default_hourly_wage_cents=1950
 WHERE business_id=:'biz_b' AND id=:'employee_b';
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM staff_scheduling_compensation
    WHERE employee_id=current_setting('test.employee_b')::uuid
    AND cash_cost_state='known_paid') THEN
   RAISE EXCEPTION 'VALID_KNOWN_PAID_INVALIDATED_ON_RAISE';
 END IF;
END $$;
-- Positive hourly -> salary not yet converted must revoke known_paid.
UPDATE employees SET display_name='Alex B salaried',role='barista',
 wage_period='month',wage_amount_cents=210000,default_hourly_wage_cents=0
 WHERE business_id=:'biz_b' AND id=:'employee_b';
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM staff_scheduling_compensation
    WHERE employee_id=current_setting('test.employee_b')::uuid
    AND cash_cost_state='unknown') THEN
   RAISE EXCEPTION 'PAID_TO_UNCONVERTED_SALARY_STALE';
 END IF;
END $$;
UPDATE staff_scheduling_compensation SET cash_cost_state='salary_conversion_pending'
 WHERE business_id=:'biz_b' AND employee_id=:'employee_b';
-- Salary conversion through Staff setWeeklySchedule updates the existing
-- cached hourly field; it must revoke the pending classification.
UPDATE employees SET default_hourly_wage_cents=2300
 WHERE business_id=:'biz_b' AND id=:'employee_b';
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM staff_scheduling_compensation
    WHERE employee_id=current_setting('test.employee_b')::uuid
    AND cash_cost_state='unknown') THEN
   RAISE EXCEPTION 'CONVERTED_SALARY_STILL_PENDING';
 END IF;
END $$;
UPDATE staff_scheduling_compensation SET cash_cost_state='known_paid'
 WHERE business_id=:'biz_b' AND employee_id=:'employee_b';
-- A zero/missing wage may also be written by existing imports/other paths.
-- It must not leave a previously paid employee classified known_paid.
UPDATE employees SET wage_period='hour',wage_amount_cents=0,default_hourly_wage_cents=0
 WHERE business_id=:'biz_b' AND id=:'employee_b';
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM staff_scheduling_compensation
    WHERE employee_id=current_setting('test.employee_b')::uuid
    AND cash_cost_state='unknown') THEN
   RAISE EXCEPTION 'KNOWN_PAID_WITHOUT_WAGE_STALE';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM scheduling_foundation_audit_events
    WHERE business_id=current_setting('test.biz_b')::uuid
    AND operation='UPDATE' AND table_name='staff_scheduling_compensation'
    AND before_value->>'cash_cost_state'='known_paid'
    AND after_value->>'cash_cost_state'='unknown') THEN
   RAISE EXCEPTION 'PAID_STATE_INVALIDATION_NOT_AUDITED';
 END IF;
END $$;
-- Invalid state writes remain rejected against the same wage predicate.
DO $$
BEGIN
 BEGIN
  UPDATE staff_scheduling_compensation SET cash_cost_state='known_paid'
   WHERE business_id=current_setting('test.biz_b')::uuid
     AND employee_id=current_setting('test.employee_b')::uuid;
  RAISE EXCEPTION 'PAID_WITH_ZERO_WAGE_ACCEPTED';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM='PAID_WITH_ZERO_WAGE_ACCEPTED' THEN RAISE; END IF;
 END;
END $$;

-- Negative wage import/privileged edit regression. The canonical employee
-- amount columns may contain legacy invalid values; keep them untouched and
-- fail closed in this additive scheduling foundation only. These edits run as
-- a real authenticated owner under RLS, like the existing Staff wage UPDATE.
UPDATE employees SET wage_period='hour',wage_amount_cents=NULL,default_hourly_wage_cents=NULL
 WHERE business_id=:'biz_b' AND id=:'employee_b';
UPDATE staff_scheduling_compensation SET
 cash_cost_state='known_eligible_zero',
 eligibility_reference='Owner reviewed zero wage evidence for null fields'
 WHERE business_id=:'biz_b' AND employee_id=:'employee_b';
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM staff_scheduling_compensation
   WHERE employee_id=current_setting('test.employee_b')::uuid
   AND cash_cost_state='known_eligible_zero') THEN
   RAISE EXCEPTION 'NULL_WAGES_NOT_ATTESTABLE';
 END IF;
END $$;
UPDATE employees SET wage_amount_cents=-1
 WHERE business_id=:'biz_b' AND id=:'employee_b';
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM staff_scheduling_compensation
   WHERE employee_id=current_setting('test.employee_b')::uuid
   AND cash_cost_state='unknown' AND eligibility_reference IS NULL
   AND eligibility_verified_by IS NULL AND eligibility_verified_at IS NULL) THEN
   RAISE EXCEPTION 'NEGATIVE_WAGE_AMOUNT_LEFT_VERIFIED_ZERO';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM scheduling_foundation_audit_events
   WHERE table_name='staff_scheduling_compensation'
   AND record_id=(SELECT id FROM staff_scheduling_compensation
     WHERE employee_id=current_setting('test.employee_b')::uuid)
   AND before_value->>'cash_cost_state'='known_eligible_zero'
   AND after_value->>'cash_cost_state'='unknown') THEN
   RAISE EXCEPTION 'NEGATIVE_WAGE_INVALIDATION_NOT_AUDITED';
 END IF;
 BEGIN
  UPDATE staff_scheduling_compensation SET
   cash_cost_state='known_eligible_zero',
   eligibility_reference='Do not allow reattestation with negative wages'
   WHERE employee_id=current_setting('test.employee_b')::uuid;
  RAISE EXCEPTION 'NEGATIVE_WAGE_REATTESTATION_ACCEPTED';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM='NEGATIVE_WAGE_REATTESTATION_ACCEPTED' THEN RAISE; END IF;
 END;
END $$;

-- A negative cached hourly rate also revokes verified zero after a wage edit.
UPDATE employees SET wage_amount_cents=0,default_hourly_wage_cents=0
 WHERE business_id=:'biz_b' AND id=:'employee_b';
UPDATE staff_scheduling_compensation SET
 cash_cost_state='known_eligible_zero',
 eligibility_reference='Owner reviewed exact zero wage evidence for both fields'
 WHERE business_id=:'biz_b' AND employee_id=:'employee_b';
UPDATE employees SET default_hourly_wage_cents=-1
 WHERE business_id=:'biz_b' AND id=:'employee_b';
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM staff_scheduling_compensation
   WHERE employee_id=current_setting('test.employee_b')::uuid
   AND cash_cost_state='unknown' AND eligibility_verified_at IS NULL) THEN
   RAISE EXCEPTION 'NEGATIVE_CACHED_HOURLY_LEFT_VERIFIED_ZERO';
 END IF;
END $$;

-- The same negative guard rejects other known states, not just verified zero.
UPDATE employees SET wage_period='month',wage_amount_cents=200000,
 default_hourly_wage_cents=0 WHERE business_id=:'biz_b' AND id=:'employee_b';
UPDATE staff_scheduling_compensation SET cash_cost_state='salary_conversion_pending'
 WHERE business_id=:'biz_b' AND employee_id=:'employee_b';
UPDATE employees SET default_hourly_wage_cents=-3
 WHERE business_id=:'biz_b' AND id=:'employee_b';
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM staff_scheduling_compensation
   WHERE employee_id=current_setting('test.employee_b')::uuid
   AND cash_cost_state='unknown') THEN
  RAISE EXCEPTION 'NEGATIVE_SALARY_CACHE_STILL_PENDING';
 END IF;
END $$;
UPDATE employees SET wage_period='hour',wage_amount_cents=1850,
 default_hourly_wage_cents=1850 WHERE business_id=:'biz_b' AND id=:'employee_b';
UPDATE staff_scheduling_compensation SET cash_cost_state='known_paid'
 WHERE business_id=:'biz_b' AND employee_id=:'employee_b';
UPDATE employees SET default_hourly_wage_cents=-5
 WHERE business_id=:'biz_b' AND id=:'employee_b';
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM staff_scheduling_compensation
   WHERE employee_id=current_setting('test.employee_b')::uuid
   AND cash_cost_state='unknown') THEN
   RAISE EXCEPTION 'NEGATIVE_PAID_CACHE_LEFT_KNOWN_PAID';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM timecards
   WHERE employee_id=current_setting('test.employee_c')::uuid
   AND hourly_wage_cents=1100) THEN
   RAISE EXCEPTION 'HISTORIC_WAGE_CHANGED_BY_NEGATIVE_GUARD';
 END IF;
END $$;

-- SQL predicate must never validate malformed status/period evidence.
-- The original canonical wage-period check remains unchanged.
RESET ROLE;
DO $$
BEGIN
 IF public.scheduling_compensation_matches_wages('known_eligible_zero','hour',-1,0)
   OR public.scheduling_compensation_matches_wages('known_eligible_zero','hour',0,-1)
   OR public.scheduling_compensation_matches_wages('known_paid','hour',1800,-1)
   OR public.scheduling_compensation_matches_wages('salary_conversion_pending','month',200000,-1)
   OR public.scheduling_compensation_matches_wages('known_eligible_zero','invalid-period',0,0)
   OR public.scheduling_compensation_matches_wages('known_eligible_zero',NULL,0,0)
   OR public.scheduling_compensation_matches_wages('not-a-state','hour',0,0) THEN
   RAISE EXCEPTION 'MALFORMED_WAGE_PREDICATE_ACCEPTED';
 END IF;
 IF NOT public.scheduling_compensation_matches_wages('known_eligible_zero','hour',NULL,NULL)
    OR NOT public.scheduling_compensation_matches_wages('known_eligible_zero','hour',0,0)
    OR NOT public.scheduling_compensation_matches_wages('salary_conversion_pending','month',200000,0)
    OR NOT public.scheduling_compensation_matches_wages('known_paid','hour',1850,1850)
    OR NOT public.scheduling_compensation_matches_wages('unknown','hour',-1,-1) THEN
   RAISE EXCEPTION 'VALID_WAGE_PREDICATE_REJECTED';
 END IF;
END $$;

-- Native PostgreSQL time columns serialize minute-precision values as
-- HH:mm:ss. The scheduling read boundary normalizes this without truncating
-- nonzero seconds, and the pure calculator also accepts exact-zero seconds.
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.staff_availability_rules
   WHERE business_id=current_setting('test.biz_a')::uuid
     AND start_local::text='07:00:00' AND end_local::text='11:00:00') THEN
   RAISE EXCEPTION 'POSTGRES_TIME_ROUNDTRIP_NOT_PRESENT';
 END IF;
END $$;

-- Atomic idempotent create RPC: owner can retry, a different key creates a
-- DISTINCT genuine window even if its payload is identical. No direct receipt
-- table access is exposed, and the original outcome survives edit/delete.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'owner_id',true);
SELECT gen_random_uuid() AS same_key, gen_random_uuid() AS distinct_key \gset
SELECT public.scheduling_create_foundation(
 :'biz_a'::uuid,'availability_rule',:'same_key'::uuid,
 jsonb_build_object('employee_id',:'employee_a','day_of_week',3,
  'start_local','22:00','end_local','02:00','overnight',true,
  'effective_from','2026-10-14','source','owner_direct','confirmation','owner_confirmed')
 ) AS original_result \gset
SELECT public.scheduling_create_foundation(
 :'biz_a'::uuid,'availability_rule',:'same_key'::uuid,
 jsonb_build_object('employee_id',:'employee_a','day_of_week',3,
  'start_local','22:00','end_local','02:00','overnight',true,
  'effective_from','2026-10-14','source','owner_direct','confirmation','owner_confirmed')
 ) AS replay_result \gset
DO $$
DECLARE a jsonb := current_setting('test.original_receipt',true)::jsonb;
BEGIN
 -- Saved below with a SESSION-LOCAL custom setting to keep this test isolated.
 NULL;
END $$;
SELECT set_config('test.original_receipt',:'original_result',true);
SELECT set_config('test.replay_receipt',:'replay_result',true);
DO $$
DECLARE a jsonb:=current_setting('test.original_receipt')::jsonb;
        b jsonb:=current_setting('test.replay_receipt')::jsonb;
BEGIN
 IF a->>'id' IS NULL OR a->>'revision'<>'1'
    OR b->>'id' IS DISTINCT FROM a->>'id'
    OR b->>'revision'<>'1'
    OR b->>'replayed'<>'true' OR a->>'replayed'<>'false' THEN
   RAISE EXCEPTION 'IDEMPOTENT_CREATE_REPLAY_CHANGED_ID_OR_REVISION';
 END IF;
 IF (SELECT count(*) FROM public.staff_availability_rules
   WHERE id=(a->>'id')::uuid)<>1 THEN
   RAISE EXCEPTION 'DUPLICATE_RECORD_CREATED_ON_RETRY';
 END IF;
END $$;
-- Co-owner shares the same tenant-scoped key/receipt: a second authorized
-- caller must replay, not duplicate. Authenticated co-owners still cannot INSERT
-- directly and may edit/delete using the existing owner RLS policies.
SELECT set_config('request.jwt.claim.sub',:'co_owner_id',true);
DO $$
BEGIN
 BEGIN
  INSERT INTO public.staff_availability_rules DEFAULT VALUES;
  RAISE EXCEPTION 'CO_OWNER_DIRECT_INSERT_ACCEPTED';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
SELECT public.scheduling_create_foundation(
 :'biz_a'::uuid,'availability_rule',:'same_key'::uuid,
 jsonb_build_object('employee_id',:'employee_a','day_of_week',3,
  'start_local','22:00','end_local','02:00','overnight',true,
  'effective_from','2026-10-14','source','owner_direct','confirmation','owner_confirmed')
 ) AS co_owner_replay \gset
SELECT set_config('test.co_owner_replay',:'co_owner_replay',true);
DO $$
BEGIN
 IF current_setting('test.co_owner_replay')::jsonb->>'id' IS DISTINCT FROM
    current_setting('test.original_receipt')::jsonb->>'id' OR
    current_setting('test.co_owner_replay')::jsonb->>'replayed'<>'true' THEN
   RAISE EXCEPTION 'CO_OWNER_DID_NOT_REPLAY_SAME_RECEIPT';
 END IF;
END $$;
SELECT set_config('request.jwt.claim.sub',:'owner_id',true);

SELECT public.scheduling_create_foundation(
 :'biz_a'::uuid,'availability_rule',:'distinct_key'::uuid,
 jsonb_build_object('employee_id',:'employee_a','day_of_week',3,
  'start_local','22:00','end_local','02:00','overnight',true,
  'effective_from','2026-10-14','source','owner_direct','confirmation','owner_confirmed')
 ) AS distinct_result \gset
SELECT set_config('test.distinct_receipt',:'distinct_result',true);
DO $$
BEGIN
 IF current_setting('test.distinct_receipt')::jsonb->>'id' =
    current_setting('test.original_receipt')::jsonb->>'id' THEN
   RAISE EXCEPTION 'DISTINCT_CREATE_KEY_SUPPRESSED';
 END IF;
END $$;

SELECT public.scheduling_create_foundation(
 :'biz_a'::uuid,'availability_rule',:'same_key'::uuid,
 jsonb_build_object('employee_id',:'employee_a','day_of_week',3,
  'start_local','23:00','end_local','01:00','overnight',true,
  'effective_from','2026-10-14','source','owner_direct','confirmation','owner_confirmed')
 ) AS mismatch_result \gset
DO $$
BEGIN
 IF current_setting('test.mismatch_receipt',true) IS NOT NULL THEN NULL; END IF;
END $$;
SELECT set_config('test.mismatch_receipt',:'mismatch_result',true);
DO $$
BEGIN
 IF current_setting('test.mismatch_receipt')::jsonb->>'conflict'<>'true' THEN
   RAISE EXCEPTION 'REUSED_KEY_WITH_DIFFERENT_PAYLOAD_NOT_REJECTED';
 END IF;
END $$;
-- The receipt survives even when the original row is later updated/deleted.
-- Have the SECOND co-owner perform authorized UPDATE/DELETE, retaining
-- existing revision/audit/RLS semantics without any direct INSERT privilege.
SELECT set_config('request.jwt.claim.sub',:'co_owner_id',true);
UPDATE public.staff_availability_rules SET start_local='21:00',end_local='02:00'
 WHERE id=(current_setting('test.original_receipt')::jsonb->>'id')::uuid;
DELETE FROM public.staff_availability_rules
 WHERE id=(current_setting('test.original_receipt')::jsonb->>'id')::uuid;
SELECT set_config('request.jwt.claim.sub',:'owner_id',true);
SELECT public.scheduling_create_foundation(
 :'biz_a'::uuid,'availability_rule',:'same_key'::uuid,
 jsonb_build_object('employee_id',:'employee_a','day_of_week',3,
  'start_local','22:00','end_local','02:00','overnight',true,
  'effective_from','2026-10-14','source','owner_direct','confirmation','owner_confirmed')
 ) AS deleted_replay \gset
SELECT set_config('test.deleted_replay',:'deleted_replay',true);
DO $$
BEGIN
 IF current_setting('test.deleted_replay')::jsonb->>'id' IS DISTINCT FROM
    current_setting('test.original_receipt')::jsonb->>'id' THEN
   RAISE EXCEPTION 'DELETED_RECORD_WAS_RESURRECTED_OR_REPLAY_CHANGED';
 END IF;
 IF EXISTS (SELECT 1 FROM public.staff_availability_rules
   WHERE id=(current_setting('test.original_receipt')::jsonb->>'id')::uuid) THEN
   RAISE EXCEPTION 'RETRY_RESURRECTED_DELETED_RECORD';
 END IF;
END $$;

-- An owner of a different café and a manager must not invoke the RPC against
-- this business, and neither can read the private receipt table directly.
SELECT set_config('request.jwt.claim.sub',:'manager_id',true);
DO $$
BEGIN
 BEGIN
  PERFORM public.scheduling_create_foundation(
   current_setting('test.biz_a')::uuid,'availability_rule',gen_random_uuid(),
   '{"day_of_week":3}'::jsonb);
  RAISE EXCEPTION 'MANAGER_RPC_AUTHORIZED';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  PERFORM count(*) FROM public.scheduling_foundation_create_receipts;
  RAISE EXCEPTION 'RECEIPT_TABLE_PUBLICLY_READABLE';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
SELECT set_config('request.jwt.claim.sub',:'foreign_owner_id',true);
DO $$
BEGIN
 BEGIN
  PERFORM public.scheduling_create_foundation(
   current_setting('test.biz_a')::uuid,'availability_rule',gen_random_uuid(),
   '{"day_of_week":3}'::jsonb);
  RAISE EXCEPTION 'FOREIGN_OWNER_RPC_AUTHORIZED';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
-- Authenticated user without any café membership is not authorized.
SELECT set_config('request.jwt.claim.sub',:'stranger_id',true);
DO $$
BEGIN
 BEGIN
  PERFORM public.scheduling_create_foundation(
   current_setting('test.biz_a')::uuid,'availability_rule',gen_random_uuid(),
   '{"day_of_week":3}'::jsonb);
  RAISE EXCEPTION 'NON_MEMBER_RPC_AUTHORIZED';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
-- A valid owner of business B may use the SAME request UUID on its OWN tenant.
-- Receipt uniqueness must be tenant-scoped and must not expose business A.
SELECT set_config('request.jwt.claim.sub',:'foreign_owner_id',true);
SELECT public.scheduling_create_foundation(
 :'biz_b'::uuid,'availability_rule',:'same_key'::uuid,
 jsonb_build_object('employee_id',:'employee_b','day_of_week',3,
  'start_local','09:00','end_local','11:00','overnight',false,
  'effective_from','2026-10-14','source','owner_direct','confirmation','owner_confirmed')
 ) AS other_business_result \gset
SELECT set_config('test.other_business_result',:'other_business_result',true);
DO $$
BEGIN
 IF current_setting('test.other_business_result')::jsonb->>'id' IS NULL OR
    current_setting('test.other_business_result')::jsonb->>'id' =
    current_setting('test.original_receipt')::jsonb->>'id' THEN
   RAISE EXCEPTION 'CROSS_TENANT_SHARED_KEY_COLLISION';
 END IF;
 BEGIN
  PERFORM 1 FROM public.scheduling_foundation_create_receipts
   WHERE business_id=current_setting('test.biz_a')::uuid;
  RAISE EXCEPTION 'FOREIGN_OWNER_READ_RECEIPTS';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
-- Neither public/anon nor an unauthenticated JWT may reach the privileged RPC.
SET LOCAL ROLE anon;
DO $$
BEGIN
 BEGIN
  PERFORM public.scheduling_create_foundation(
    current_setting('test.biz_a')::uuid,'availability_rule',gen_random_uuid(),
    '{"day_of_week":3}'::jsonb);
  RAISE EXCEPTION 'ANON_RPC_AUTHORIZED';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
RESET ROLE;
DO $$
BEGIN
 IF (SELECT count(*) FROM public.scheduling_foundation_create_receipts
   WHERE business_id=current_setting('test.biz_a')::uuid)<>2 THEN
   RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_COUNT_MISMATCH';
 END IF;
 IF (SELECT count(*) FROM public.scheduling_foundation_audit_events
   WHERE operation='INSERT' AND record_id IN
    ((current_setting('test.original_receipt')::jsonb->>'id')::uuid,
     (current_setting('test.distinct_receipt')::jsonb->>'id')::uuid))<>2 THEN
   RAISE EXCEPTION 'RETRY_CREATED_ADDITIONAL_AUDIT_EVENT';
 END IF;
END $$;

ROLLBACK;
\echo Olivia PR 1A RLS/composite tenant/attestation/audit tests passed (rolled back)
