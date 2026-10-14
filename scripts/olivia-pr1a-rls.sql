\set ON_ERROR_STOP on
-- Real database tests: execute only against disposable Supabase after migrations.
-- All inserts are wrapped in a rollback; no production data is accessed.
BEGIN;
SELECT gen_random_uuid() AS owner_id, gen_random_uuid() AS manager_id,
       gen_random_uuid() AS foreign_owner_id,
       gen_random_uuid() AS biz_a, gen_random_uuid() AS biz_b,
       gen_random_uuid() AS employee_a, gen_random_uuid() AS employee_b,
       gen_random_uuid() AS loc_a, gen_random_uuid() AS loc_b
\gset
INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
VALUES
 (:'owner_id','00000000-0000-0000-0000-000000000000','authenticated','authenticated','olivia-pr1a-owner@example.invalid','',now(),now()),
 (:'manager_id','00000000-0000-0000-0000-000000000000','authenticated','authenticated','olivia-pr1a-manager@example.invalid','',now(),now()),
 (:'foreign_owner_id','00000000-0000-0000-0000-000000000000','authenticated','authenticated','olivia-pr1a-other@example.invalid','',now(),now());
INSERT INTO businesses(id,name,is_demo) VALUES
 (:'biz_a','Olivia Test A',false),(:'biz_b','Olivia Test B',false);
INSERT INTO memberships(business_id,user_id,role) VALUES
 (:'biz_a',:'owner_id','owner'),(:'biz_a',:'manager_id','manager'),
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

-- Owner can record multiple separately attributed windows without worker IDs.
INSERT INTO staff_availability_rules
 (business_id,employee_id,day_of_week,start_local,end_local,effective_from,source,confirmation)
VALUES
 (:'biz_a',:'employee_a',3,'07:00','11:00','2026-10-14','worker_reported_by_owner','owner_confirmed'),
 (:'biz_a',:'employee_a',3,'16:00','20:00','2026-10-14','worker_reported_by_owner','owner_confirmed');
INSERT INTO staff_availability_exceptions
 (business_id,employee_id,local_date,exception_type,source,confirmation)
VALUES (:'biz_a',:'employee_a','2026-10-15','unavailable','owner_direct','owner_confirmed');
INSERT INTO staff_scheduling_preferences
 (business_id,employee_id,effective_from,min_weekly_minutes,desired_weekly_minutes,max_weekly_minutes,source,confirmation)
VALUES (:'biz_a',:'employee_a','2026-10-14',120,240,480,'owner_direct','owner_confirmed');
INSERT INTO scheduling_qualification_types(business_id,code,display_name)
VALUES (:'biz_a','opener','Opening qualified');
INSERT INTO staff_qualifications
 (business_id,employee_id,qualification_code,valid_from,source,confirmation)
VALUES (:'biz_a',:'employee_a','opener','2026-10-14','owner_direct','owner_confirmed');
INSERT INTO scheduling_coverage_requirements
 (business_id,location_id,day_of_week,effective_from,start_local,end_local,min_headcount,qualification_code,source,confirmation)
VALUES (:'biz_a',:'loc_a',3,'2026-10-14','07:00','11:00',1,'opener','owner_direct','owner_confirmed');
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
  INSERT INTO staff_availability_rules
    (business_id,employee_id,day_of_week,start_local,end_local,effective_from,source)
  VALUES (current_setting('test.biz_a')::uuid,current_setting('test.employee_b')::uuid,
    3,'09:00','17:00','2026-10-14','owner_direct');
  RAISE EXCEPTION 'CROSS_TENANT_EMPLOYEE_ACCEPTED';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
 BEGIN
  INSERT INTO scheduling_coverage_requirements
    (business_id,location_id,day_of_week,effective_from,start_local,end_local,min_headcount,source)
  VALUES (current_setting('test.biz_a')::uuid,current_setting('test.loc_b')::uuid,
    3,'2026-10-14','09:00','17:00',1,'owner_direct');
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
  INSERT INTO staff_scheduling_compensation
    (business_id,employee_id,cash_cost_state,eligibility_reference)
  VALUES (current_setting('test.biz_a')::uuid,current_setting('test.employee_a')::uuid,
   'known_eligible_zero','Owner reviewed classification and legal basis');
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
INSERT INTO staff_scheduling_compensation
 (business_id,employee_id,cash_cost_state,eligibility_reference)
VALUES (:'biz_b',:'employee_b','known_eligible_zero',
 'Owner reviewed and recorded statutory eligibility evidence');
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM staff_scheduling_compensation
     WHERE employee_id=current_setting('test.employee_b')::uuid
     AND cash_cost_state='known_eligible_zero'
     AND eligibility_verified_by=auth.uid()
     AND eligibility_verified_at IS NOT NULL) THEN
  RAISE EXCEPTION 'verified-zero provenance not captured';
 END IF;
END $;
RESET ROLE;
UPDATE employees SET wage_period='month',wage_amount_cents=200000,
 default_hourly_wage_cents=0 WHERE id=:'employee_b';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'foreign_owner_id',true);
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
END $;

ROLLBACK;
\echo Olivia PR 1A RLS/composite tenant/attestation/audit tests passed (rolled back)
