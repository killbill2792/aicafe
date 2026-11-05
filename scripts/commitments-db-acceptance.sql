\set ON_ERROR_STOP on
-- PR 3: real transactional/RLS acceptance against a disposable local Supabase.
-- This entire fixture rolls back; no production data, keys or AI API calls.
BEGIN;
SELECT gen_random_uuid() AS business_a,gen_random_uuid() AS business_b,
       gen_random_uuid() AS owner_a,gen_random_uuid() AS owner_b,
       gen_random_uuid() AS thread_a,gen_random_uuid() AS thread_b \gset

INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
VALUES
 (:'owner_a','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'commitment-owner-a@example.invalid','',now(),now()),
 (:'owner_b','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'commitment-owner-b@example.invalid','',now(),now());
INSERT INTO public.businesses(id,name,timezone,is_demo)
VALUES (:'business_a','Disposable reminder café','America/New_York',false),
       (:'business_b','Disposable second café','UTC',false);
INSERT INTO public.memberships(business_id,user_id,role)
VALUES (:'business_a',:'owner_a','owner'),
       (:'business_a',:'owner_b','owner'),
       (:'business_b',:'owner_b','owner');
INSERT INTO public.ai_threads(id,business_id,owner_user_id,client_request_id)
VALUES (:'thread_a',:'business_a',:'owner_a',gen_random_uuid()),
       (:'thread_b',:'business_b',:'owner_b',gen_random_uuid());

-- Owner website session: the real RPC, real RLS and café timezone.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'owner_a',true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT (public.create_operating_commitment(
  :'business_a'::uuid,:'owner_a'::uuid,:'thread_a'::uuid,
  'Call coffee supplier','owner_chat','2026-11-10',NULL)).id AS task_id \gset
SELECT (public.create_operating_commitment(
  :'business_a'::uuid,:'owner_a'::uuid,:'thread_a'::uuid,
  '  CALL  coffee   SUPPLIER  ','owner_chat','2026-11-10',NULL)).id AS repeated_id \gset

-- Psql's variables are not visible inside DO; stash only disposable values.
SELECT set_config('test.business_a',:'business_a',true);
SELECT set_config('test.business_b',:'business_b',true);
SELECT set_config('test.owner_a',:'owner_a',true);
SELECT set_config('test.owner_b',:'owner_b',true);
SELECT set_config('test.thread_a',:'thread_a',true);
SELECT set_config('test.task_id',:'task_id',true);
SELECT set_config('test.repeated_id',:'repeated_id',true);

DO $verify$
DECLARE t public.operating_tasks;
BEGIN
 IF current_setting('test.task_id')<>current_setting('test.repeated_id')
   THEN RAISE EXCEPTION 'Duplicate request changed its ID'; END IF;
 SELECT * INTO t FROM public.operating_tasks
  WHERE business_id=current_setting('test.business_a')::uuid
    AND id=current_setting('test.task_id');
 IF t.id IS NULL OR t.status<>'watching' OR t.owner_user_id<>current_setting('test.owner_a')::uuid
    OR t.origin<>'owner_chat' OR t.due_local_date<>date '2026-11-10'
    OR t.due_local_time IS NOT NULL OR t.due_timezone<>'America/New_York'
    OR t.due_at<>timestamptz '2026-11-10T05:00:00Z'
    OR t.payload->>'title'<>'Call coffee supplier'
 THEN RAISE EXCEPTION 'Date-only commitment missing or due incorrectly'; END IF;
 IF (SELECT count(*) FROM public.operating_tasks WHERE kind='commitment')<>1
 THEN RAISE EXCEPTION 'Repeated request created two tasks'; END IF;
END $verify$;

-- An owner who belongs to the SAME café cannot read or close the other owner's private task.
SELECT set_config('request.jwt.claim.sub',:'owner_b',true);
DO $verify$
BEGIN
 IF EXISTS (SELECT 1 FROM public.operating_tasks
     WHERE id=current_setting('test.task_id')) THEN
   RAISE EXCEPTION 'Owner B could read owner A reminder'; END IF;
 IF public.close_operating_commitment(current_setting('test.business_a')::uuid,
   current_setting('test.owner_b')::uuid,current_setting('test.task_id')) THEN
   RAISE EXCEPTION 'Owner B could close owner A reminder'; END IF;
END $verify$;

-- Another café's legitimate reminder uses its own timezone and independent identity.
SELECT (public.create_operating_commitment(
 :'business_b'::uuid,:'owner_b'::uuid,:'thread_b'::uuid,
 'Call coffee supplier','owner_chat','2026-11-10',NULL)).id AS other_task_id \gset
SELECT set_config('test.other_task_id',:'other_task_id',true);
DO $verify$
DECLARE t public.operating_tasks;
BEGIN
 SELECT * INTO t FROM public.operating_tasks
  WHERE business_id=current_setting('test.business_b')::uuid
    AND id=current_setting('test.other_task_id');
 IF t.id IS NULL OR t.due_at<>timestamptz '2026-11-10T00:00:00Z'
    OR t.due_timezone<>'UTC' THEN
    RAISE EXCEPTION 'Another café due timezone was hardcoded'; END IF;
END $verify$;

-- Owner A cannot use another owner's thread, even while legitimately signed in.
SELECT set_config('request.jwt.claim.sub',:'owner_a',true);
DO $verify$
BEGIN
 BEGIN
  PERFORM public.create_operating_commitment(
    current_setting('test.business_a')::uuid,current_setting('test.owner_a')::uuid,
    current_setting('test.thread_a')::uuid,'','owner_chat',date '2026-11-10',NULL);
  RAISE EXCEPTION 'Empty title was accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN
  PERFORM public.create_operating_commitment(
    current_setting('test.business_b')::uuid,current_setting('test.owner_a')::uuid,
    current_setting('test.thread_a')::uuid,'Wrong café','owner_chat',date '2026-11-10',NULL);
  RAISE EXCEPTION 'Wrong café was accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM public.create_operating_commitment(
    current_setting('test.business_a')::uuid,current_setting('test.owner_a')::uuid,
    current_setting('test.thread_a')::uuid,'Spring DST','owner_chat',
    date '2026-03-08',time '02:30');
  RAISE EXCEPTION 'Nonexistent spring-forward local time was accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $verify$;

-- Fallback's repeated 01:30 occurs once: stable ID and one UTC instant.
SELECT (public.create_operating_commitment(
  :'business_a'::uuid,:'owner_a'::uuid,:'thread_a'::uuid,
  'Fall clock change','supervisor_followup','2026-11-01','01:30')).id AS fall_id \gset
SELECT set_config('test.fall_id',:'fall_id',true);
SELECT (public.create_operating_commitment(
  :'business_a'::uuid,:'owner_a'::uuid,:'thread_a'::uuid,
  'FALL CLOCK CHANGE','supervisor_followup','2026-11-01','01:30')).id AS fall_retry_id \gset
SELECT set_config('test.fall_retry_id',:'fall_retry_id',true);
DO $verify$
DECLARE n integer;
BEGIN
 IF current_setting('test.fall_id')<>current_setting('test.fall_retry_id') THEN
  RAISE EXCEPTION 'Fall-back replay created another ID'; END IF;
 SELECT count(*) INTO n FROM public.operating_tasks
  WHERE id=current_setting('test.fall_id') AND kind='commitment';
 IF n<>1 THEN RAISE EXCEPTION 'Fall-back due stored twice'; END IF;
END $verify$;

-- Only the service role may deliver. Too early must be a non-write.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
DO $verify$
BEGIN
 IF public.deliver_due_operating_commitment(
  current_setting('test.business_a')::uuid,current_setting('test.owner_a')::uuid,
  current_setting('test.task_id'),timestamptz '2026-11-10T04:59:59Z')
 THEN RAISE EXCEPTION 'Premature delivery'; END IF;
END $verify$;

-- Crash between steps: the single transaction rolls back both chat and status.
SAVEPOINT simulate_crash;
SELECT public.deliver_due_operating_commitment(
 :'business_a'::uuid,:'owner_a'::uuid,:'task_id',
 '2026-11-10T05:00:00Z') AS first_claim \gset
ROLLBACK TO SAVEPOINT simulate_crash;
DO $verify$
BEGIN
 IF (SELECT status FROM public.operating_tasks
  WHERE id=current_setting('test.task_id'))<>'watching'
 OR EXISTS (SELECT 1 FROM public.ai_messages
  WHERE thread_id=current_setting('test.thread_a')::uuid AND role='supervisor')
 THEN RAISE EXCEPTION 'Crash left a partial reminder delivery'; END IF;
END $verify$;

-- Retry writes once, then the next cron tick does nothing.
SELECT public.deliver_due_operating_commitment(
 :'business_a'::uuid,:'owner_a'::uuid,:'task_id',
 '2026-11-10T05:00:00Z') AS delivered \gset
SELECT public.deliver_due_operating_commitment(
 :'business_a'::uuid,:'owner_a'::uuid,:'task_id',
 '2026-11-10T06:00:00Z') AS delivered_again \gset
DO $verify$
DECLARE t public.operating_tasks;
BEGIN
 SELECT * INTO t FROM public.operating_tasks
 WHERE id=current_setting('test.task_id');
 IF t.status<>'needs_owner' OR (SELECT count(*) FROM public.ai_messages
   WHERE business_id=current_setting('test.business_a')::uuid
     AND thread_id=current_setting('test.thread_a')::uuid
     AND role='supervisor'
     AND structured_content::text LIKE '%Call coffee supplier%')<>1
 THEN RAISE EXCEPTION 'Delivery did not create exactly one due chat + inbox task'; END IF;
END $verify$;

-- Closing is owner-only and terminal; an identical later request stays handled.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'owner_a',true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT public.close_operating_commitment(
 :'business_a'::uuid,:'owner_a'::uuid,:'task_id') AS closed \gset
SELECT public.close_operating_commitment(
 :'business_a'::uuid,:'owner_a'::uuid,:'task_id') AS closed_again \gset
SELECT (public.create_operating_commitment(
  :'business_a'::uuid,:'owner_a'::uuid,:'thread_a'::uuid,
  'Call coffee supplier','owner_chat','2026-11-10',NULL)).status AS replay_status \gset
DO $verify$
BEGIN
 IF (SELECT status FROM public.operating_tasks
   WHERE id=current_setting('test.task_id'))<>'handled'
 OR (SELECT count(*) FROM public.operating_tasks
   WHERE business_id=current_setting('test.business_a')::uuid
    AND id=current_setting('test.task_id'))<>1
 THEN RAISE EXCEPTION 'Owner close did not stay terminal'; END IF;
END $verify$;

-- RLS denies direct updates of commitment rows, even to their owner.
UPDATE public.operating_tasks SET status='watching'
 WHERE business_id=:'business_a'::uuid AND id=:'task_id';
DO $verify$
BEGIN
 IF (SELECT status FROM public.operating_tasks
   WHERE id=current_setting('test.task_id'))<>'handled'
 THEN RAISE EXCEPTION 'Legacy member-write policy reopened commitment'; END IF;
END $verify$;
ROLLBACK;
\echo COMMITMENT_DB_ACCEPTANCE_OK
