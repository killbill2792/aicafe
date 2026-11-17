\set ON_ERROR_STOP on
-- Task13D only; disposable fully migrated Supabase. Never touch production.
BEGIN;
SELECT gen_random_uuid() AS a, gen_random_uuid() AS b,
       gen_random_uuid() AS owner_a,gen_random_uuid() AS owner_b,
       gen_random_uuid() AS worker_user,gen_random_uuid() AS worker,
       gen_random_uuid() AS msg,gen_random_uuid() AS nonce_leave,
       gen_random_uuid() AS nonce_recruit,gen_random_uuid() AS nonce_onboard \gset
INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
VALUES
 (:'owner_a','00000000-0000-0000-0000-000000000000','authenticated','authenticated','13d-owner-a@example.invalid','',now(),now()),
 (:'owner_b','00000000-0000-0000-0000-000000000000','authenticated','authenticated','13d-owner-b@example.invalid','',now(),now()),
 (:'worker_user','00000000-0000-0000-0000-000000000000','authenticated','authenticated','13d-worker@example.invalid','',now(),now());
INSERT INTO public.businesses(id,name,timezone,currency,is_demo)
VALUES (:'a','13D isolated A','America/Los_Angeles','USD',false),
       (:'b','13D isolated B','Europe/London','GBP',false);
INSERT INTO public.memberships(business_id,user_id,role)
VALUES (:'a',:'owner_a','owner'),(:'b',:'owner_b','owner');
INSERT INTO public.employees(id,business_id,display_name,active,wage_period,wage_amount_cents)
VALUES (:'worker',:'a','13D worker',true,'hour',1600);
SELECT set_config('test.d.a',:'a',true);
SELECT set_config('test.d.b',:'b',true);
SELECT set_config('test.d.oa',:'owner_a',true);
SELECT set_config('test.d.ob',:'owner_b',true);
SELECT set_config('test.d.w',:'worker',true);
SELECT set_config('test.d.u',:'worker_user',true);
SELECT set_config('test.d.nl',:'nonce_leave',true);
SELECT set_config('test.d.nr',:'nonce_recruit',true);
SELECT set_config('test.d.no',:'nonce_onboard',true);

-- Real 13C source receipt creates an intake case but never an approved leave.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
INSERT INTO public.staff_communication_messages
 (id,business_id,employee_id,actor,response_code,body,channel,client_nonce)
VALUES (:'msg',:'a',:'worker','employee','report','I need leave next week','web',gen_random_uuid());
DO $t$
BEGIN
 IF (SELECT count(*) FROM public.staff_coordination_cases
     WHERE business_id=current_setting('test.d.a')::uuid
       AND source_kind='staff_message')<>1
 THEN RAISE EXCEPTION '13C message was not admitted once'; END IF;
 IF (SELECT state FROM public.staff_coordination_cases
     WHERE business_id=current_setting('test.d.a')::uuid
       AND source_kind='staff_message')<>'new'
 THEN RAISE EXCEPTION 'free text silently approved'; END IF;
 IF EXISTS (SELECT 1 FROM public.staff_availability_exceptions
     WHERE business_id=current_setting('test.d.a')::uuid)
 THEN RAISE EXCEPTION 'intake changed leave records'; END IF;
 IF EXISTS (SELECT 1 FROM public.staff_coordination_cases
     WHERE source_kind='staff_message' AND case_kind<>'intake')
 THEN RAISE EXCEPTION 'SQL invented semantic classification'; END IF;
 IF (SELECT count(*) FROM public.staff_coordination_evidence
   WHERE business_id=current_setting('test.d.a')::uuid
    AND source_kind='staff_message')<>1
 THEN RAISE EXCEPTION 'source reference not persisted'; END IF;
END $t$;

-- Staff cannot see or mutate coordination despite its own staff channel login.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub',:'worker_user',true);
DO $t$
DECLARE blocked boolean:=false;
BEGIN
 IF EXISTS(SELECT 1 FROM public.staff_coordination_cases) THEN
  RAISE EXCEPTION 'worker can see owner cases'; END IF;
 IF has_table_privilege('authenticated','staff_coordination_cases','INSERT') THEN
  RAISE EXCEPTION 'worker has direct case write'; END IF;
 IF has_table_privilege('authenticated','staff_coordination_evidence','INSERT') THEN
  RAISE EXCEPTION 'worker can forge source evidence'; END IF;
 BEGIN PERFORM public.staff_coordination_open(
    current_setting('test.d.a')::uuid,gen_random_uuid(),'leave',
    current_setting('test.d.w')::uuid,null,current_date,current_date,null);
 EXCEPTION WHEN OTHERS THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'worker spoofed owner leave case'; END IF;
END $t$;

-- Owner A is restricted to A; owner B does not see or decide A.
SELECT set_config('request.jwt.claim.sub',:'owner_b',true);
DO $t$
DECLARE blocked boolean:=false;
BEGIN
 IF EXISTS(SELECT 1 FROM public.staff_coordination_cases) THEN
  RAISE EXCEPTION 'other café owner reads a case'; END IF;
 BEGIN PERFORM public.staff_coordination_open(
   current_setting('test.d.a')::uuid,gen_random_uuid(),'recruitment',
   null,null,null,null,'barista');
 EXCEPTION WHEN OTHERS THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'other café owner opened case'; END IF;
END $t$;

SELECT set_config('request.jwt.claim.sub',:'owner_a',true);
SELECT public.staff_coordination_open(:'a',:'nonce_leave','leave',:'worker',null,
  current_date+2,current_date+3,null)->>'id' AS leave_id \gset
SELECT set_config('test.d.leave',:'leave_id',true);
DO $t$
DECLARE r jsonb; blocked boolean:=false;
BEGIN
 r:=public.staff_coordination_open(current_setting('test.d.a')::uuid,
  current_setting('test.d.nl')::uuid,'leave',current_setting('test.d.w')::uuid,
  null,current_date+2,current_date+3,null);
 IF r->>'id'<>current_setting('test.d.leave') OR r->>'revision'<>'1'
 THEN RAISE EXCEPTION 'owner replay created different case'; END IF;
 BEGIN
  PERFORM public.staff_coordination_open(current_setting('test.d.a')::uuid,
    current_setting('test.d.nl')::uuid,'leave',current_setting('test.d.w')::uuid,
    null,current_date+3,current_date+4,null);
 EXCEPTION WHEN OTHERS THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'nonce payload collision accepted'; END IF;
END $t$;
SELECT public.staff_coordination_decide(:'a',current_setting('test.d.leave')::uuid,1,'approve')->>'revision' AS decided_revision \gset
DO $t$
DECLARE blocked boolean:=false;
BEGIN
 IF (SELECT state FROM public.staff_coordination_cases
    WHERE id=current_setting('test.d.leave')::uuid)<>'approved'
 THEN RAISE EXCEPTION 'owner decision not recorded'; END IF;
 IF EXISTS(SELECT 1 FROM public.staff_availability_exceptions
    WHERE business_id=current_setting('test.d.a')::uuid)
 THEN RAISE EXCEPTION 'owner intent bypassed approval effect gateway'; END IF;
 BEGIN PERFORM public.staff_coordination_decide(
  current_setting('test.d.a')::uuid,current_setting('test.d.leave')::uuid,1,'decline');
 EXCEPTION WHEN OTHERS THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'stale owner decision overwritten'; END IF;
END $t$;
SELECT public.staff_coordination_open(:'a',:'nonce_onboard','onboarding',:'worker',null,
 null,null,null)->>'id' AS onboard_id \gset
SELECT public.staff_coordination_decide(:'a',:'onboard_id',1,'decline');
SELECT public.staff_coordination_open(:'a',:'nonce_recruit','recruitment',null,null,
 null,null,'barista')->>'id' AS recruit_id \gset
SELECT set_config('test.d.recruit',:'recruit_id',true);
SELECT public.staff_coordination_decide(:'a',current_setting('test.d.recruit')::uuid,1,'approve');

-- Reconciliation never executes as an employee/owner; only the existing worker.
DO $t$
DECLARE blocked boolean:=false;
BEGIN
 BEGIN PERFORM public.staff_coordination_reconcile(current_setting('test.d.a')::uuid);
 EXCEPTION WHEN OTHERS THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'owner bypassed service reconciliation'; END IF;
END $t$;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT public.staff_coordination_reconcile(:'a');
DO $t$
BEGIN
 IF (SELECT state FROM public.staff_coordination_cases
  WHERE id=current_setting('test.d.leave')::uuid)<>'waiting_evidence'
 THEN RAISE EXCEPTION 'owner approval falsely closed unverified leave'; END IF;
 IF (SELECT state FROM public.staff_coordination_cases
  WHERE id=current_setting('test.d.recruit')::uuid)='completed'
 THEN RAISE EXCEPTION 'recruitment falsely completed without applicant/receipt'; END IF;
END $t$;
INSERT INTO public.staff_availability_exceptions
 (business_id,employee_id,local_date,exception_type,source,
  confirmation,confirmed_at,confirmed_by)
VALUES
 (:'a',:'worker',current_date+2,'approved_leave','owner_direct','owner_confirmed',now(),:'owner_a');
-- One confirmed day of two is NOT enough.
UPDATE public.staff_coordination_cases SET next_check_at=now()
 WHERE business_id=:'a' AND id=current_setting('test.d.leave')::uuid;
SELECT public.staff_coordination_reconcile(:'a');
DO $t$
BEGIN
 IF (SELECT state FROM public.staff_coordination_cases WHERE id=current_setting('test.d.leave')::uuid)='completed'
 THEN RAISE EXCEPTION 'partial leave treated as complete'; END IF;
END $t$;
INSERT INTO public.staff_availability_exceptions
 (business_id,employee_id,local_date,exception_type,source,
  confirmation,confirmed_at,confirmed_by)
VALUES
 (:'a',:'worker',current_date+3,'approved_leave','owner_direct','owner_confirmed',now(),:'owner_a');
UPDATE public.staff_coordination_cases SET next_check_at=now()
 WHERE business_id=:'a' AND id=current_setting('test.d.leave')::uuid;
SELECT public.staff_coordination_reconcile(:'a');
DO $t$
BEGIN
 IF (SELECT state FROM public.staff_coordination_cases WHERE id=current_setting('test.d.leave')::uuid)<>'completed'
 THEN RAISE EXCEPTION 'canonical confirmed leave did not close case'; END IF;
 IF (SELECT count(*) FROM public.staff_coordination_evidence
   WHERE case_id=current_setting('test.d.leave')::uuid AND source_kind='availability_exception')<>1
 THEN RAISE EXCEPTION 'confirmed leave lacks source evidence'; END IF;
END $t$;
-- A later reversal invalidates the previously verified source. A closed case
-- must reopen rather than keep displaying verified completion forever.
DELETE FROM public.staff_availability_exceptions
 WHERE business_id=:'a' AND employee_id=:'worker'
   AND local_date=current_date+3 AND exception_type='approved_leave';
SELECT public.staff_coordination_reconcile(:'a');
DO $t$
BEGIN
 IF (SELECT state FROM public.staff_coordination_cases
   WHERE id=current_setting('test.d.leave')::uuid)<>'waiting_evidence'
 THEN RAISE EXCEPTION 'removed approved leave remained falsely completed'; END IF;
END $t$;
-- Expiring candidate source references scrubs even if the owner said yes.
UPDATE public.staff_coordination_cases SET retention_at=now()-interval '1 day'
 WHERE business_id=:'a' AND id=current_setting('test.d.recruit')::uuid;
SELECT public.staff_coordination_reconcile(:'a');
DO $t$
BEGIN
 IF (SELECT state FROM public.staff_coordination_cases WHERE id=current_setting('test.d.recruit')::uuid)<>'cancelled'
 THEN RAISE EXCEPTION 'recruitment retention policy ignored'; END IF;
 IF (SELECT source_key FROM public.staff_coordination_cases WHERE id=current_setting('test.d.recruit')::uuid)
   NOT LIKE 'expired:%'
 THEN RAISE EXCEPTION 'expired source reference retained'; END IF;
 IF EXISTS(SELECT 1 FROM public.staff_coordination_evidence WHERE case_id=current_setting('test.d.recruit')::uuid)
 THEN RAISE EXCEPTION 'expired candidate evidence retained'; END IF;
END $t$;
ROLLBACK;
\echo 'Task13D migrated DB assertions passed: auth/RLS, idempotency, decision/CAS, leave evidence, no automatic hire, retention'
