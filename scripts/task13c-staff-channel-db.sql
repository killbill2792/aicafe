\set ON_ERROR_STOP on
-- Task13C: disposable migrated Supabase, authentic owner/employee JWT scopes.
BEGIN;
SELECT gen_random_uuid() AS biz_a,gen_random_uuid() AS biz_b,
 gen_random_uuid() AS owner_a,gen_random_uuid() AS owner_b,
 gen_random_uuid() AS staff_user_a,gen_random_uuid() AS staff_user_b,
 gen_random_uuid() AS staff_a,gen_random_uuid() AS staff_b,
 gen_random_uuid() AS shift_a,gen_random_uuid() AS shift_b,
 gen_random_uuid() AS nonce_a,gen_random_uuid() AS nonce_b,
 gen_random_uuid() AS nonce_report,gen_random_uuid() AS nonce_checklist
\gset
INSERT INTO auth.users(id,instance_id,aud,role,email,email_confirmed_at,encrypted_password,created_at,updated_at)
VALUES
 (:'owner_a','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   '13c-owner-a@example.invalid',now(),'',now(),now()),
 (:'owner_b','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   '13c-owner-b@example.invalid',now(),'',now(),now()),
 (:'staff_user_a','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   '13c-worker-a@example.invalid',now(),'',now(),now()),
 (:'staff_user_b','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   '13c-worker-b@example.invalid',now(),'',now(),now());
INSERT INTO public.businesses(id,name,timezone,currency,is_demo)
VALUES (:'biz_a','13c disposable A','America/Los_Angeles','USD',false),
 (:'biz_b','13c disposable B','Europe/London','GBP',false);
INSERT INTO public.memberships(business_id,user_id,role)
VALUES (:'biz_a',:'owner_a','owner'),(:'biz_b',:'owner_b','owner');
INSERT INTO public.employees(id,business_id,display_name,active,wage_period,wage_amount_cents,phone_e164,whatsapp_opt_in)
VALUES
 (:'staff_a',:'biz_a','13c Staff A',true,'hour',1700,'+14155550901',true),
 (:'staff_b',:'biz_b','13c Staff B',true,'hour',1800,'+442079460901',true);
INSERT INTO public.scheduled_shifts(id,business_id,employee_id,local_date,start_local,end_local,source,status)
VALUES
 (:'shift_a',:'biz_a',:'staff_a',current_date+2,'07:00','14:00','owner','sent'),
 (:'shift_b',:'biz_b',:'staff_b',current_date+2,'08:00','15:00','owner','sent');

SELECT set_config('test.task13c.biz_a',:'biz_a',true);
SELECT set_config('test.task13c.biz_b',:'biz_b',true);
SELECT set_config('test.task13c.staff_a',:'staff_a',true);
SELECT set_config('test.task13c.staff_b',:'staff_b',true);
SELECT set_config('test.task13c.owner_a',:'owner_a',true);
SELECT set_config('test.task13c.owner_b',:'owner_b',true);
SELECT set_config('test.task13c.staff_user_a',:'staff_user_a',true);
SELECT set_config('test.task13c.staff_user_b',:'staff_user_b',true);
SELECT set_config('test.task13c.nonce_a',:'nonce_a',true);
SELECT set_config('test.task13c.nonce_b',:'nonce_b',true);
SELECT set_config('test.task13c.nonce_report',:'nonce_report',true);
SELECT set_config('test.task13c.nonce_checklist',:'nonce_checklist',true);

-- Authenticated owner links EXISTING confirmed accounts, not create accounts.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub',:'owner_a',true);
SELECT public.staff_link_existing_login(:'biz_a',:'staff_a','13c-worker-a@example.invalid');
DO $test$
DECLARE blocked boolean:=false;
BEGIN
 BEGIN PERFORM public.staff_link_existing_login(
    current_setting('test.task13c.biz_b')::uuid,current_setting('test.task13c.staff_b')::uuid,'13c-worker-a@example.invalid');
 EXCEPTION WHEN OTHERS THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'foreign owner linked another cafe employee'; END IF;
END $test$;
SELECT set_config('request.jwt.claim.sub',:'owner_b',true);
SELECT public.staff_link_existing_login(:'biz_b',:'staff_b','13c-worker-b@example.invalid');

-- Only the shared existing routine/service may issue requests.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT public.staff_channel_sync_shift_requests(:'biz_a') AS synced_a;
SELECT public.staff_channel_sync_shift_requests(:'biz_b') AS synced_b;
SELECT id AS req_a FROM public.staff_communication_requests
 WHERE business_id=:'biz_a' AND kind='shift_confirmation' \gset
SELECT id AS req_b FROM public.staff_communication_requests
 WHERE business_id=:'biz_b' AND kind='shift_confirmation' \gset
SELECT set_config('test.task13c.req_a',:'req_a',true);
SELECT set_config('test.task13c.req_b',:'req_b',true);
INSERT INTO public.staff_communication_requests
 (business_id,employee_id,kind,source_type,source_id,source_revision,title,prompt)
VALUES (:'biz_a',:'staff_a','checklist','owner_checklist','opening','revision-1',
 'Opening checklist','Please complete your assigned opening checks')
RETURNING id AS req_checklist \gset
SELECT set_config('test.task13c.req_checklist',:'req_checklist',true);

-- A worker has no business membership, no owner power and no access to
-- other cafés' records or messages; only their assigned request/message RLS.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub',:'staff_user_a',true);
DO $test$
BEGIN
 IF public.is_member(current_setting('test.task13c.biz_a')::uuid) OR public.scheduling_is_owner(current_setting('test.task13c.biz_a')::uuid)
 THEN RAISE EXCEPTION 'staff inherited management membership'; END IF;
 IF (SELECT count(*) FROM public.staff_communication_requests)<>2
 THEN RAISE EXCEPTION 'worker saw someone else request or lost own requests'; END IF;
 IF EXISTS(SELECT 1 FROM public.staff_communication_requests
   WHERE business_id=current_setting('test.task13c.biz_b')::uuid) THEN
   RAISE EXCEPTION 'cross-cafe request read'; END IF;
 IF has_table_privilege('authenticated','staff_communication_messages','INSERT')
 THEN RAISE EXCEPTION 'employee got raw insert access'; END IF;
 IF has_table_privilege('authenticated','staff_communication_requests','UPDATE')
 THEN RAISE EXCEPTION 'employee can change assignment state'; END IF;
END $test$;
SELECT public.staff_channel_submit(:'req_a','decline',
 'I cannot work 7 to 2; I can arrive at 8 instead.',:'nonce_a')->>'id' AS msg_a \gset
SELECT set_config('test.task13c.msg_a',:'msg_a',true);
DO $test$
BEGIN
 IF (SELECT body FROM public.staff_communication_messages WHERE id=current_setting('test.task13c.msg_a')::uuid)<>
  'I cannot work 7 to 2; I can arrive at 8 instead.'
 THEN RAISE EXCEPTION 'free-text explanation changed or lost'; END IF;
 IF (SELECT status FROM public.staff_communication_requests WHERE id=current_setting('test.task13c.req_a')::uuid)<>'responded'
 THEN RAISE EXCEPTION 'decline not recorded'; END IF;
 IF (SELECT count(*) FROM public.staff_communication_messages)<>1
 THEN RAISE EXCEPTION 'worker sees foreign reply'; END IF;
 IF EXISTS(SELECT 1 FROM public.scheduled_shifts WHERE business_id=current_setting('test.task13c.biz_a')::uuid and status<>'sent')
 THEN RAISE EXCEPTION 'decline silently edited a real roster'; END IF;
END $test$;
DO $test$
DECLARE r jsonb; rejected boolean:=false;
BEGIN
 r:=public.staff_channel_submit(current_setting('test.task13c.req_a')::uuid,'decline',
  'I cannot work 7 to 2; I can arrive at 8 instead.',current_setting('test.task13c.nonce_a')::uuid);
 IF r->>'replayed'<>'true' or r->>'id'<>current_setting('test.task13c.msg_a')
 THEN RAISE EXCEPTION 'idempotent staff response replay not confirmed'; END IF;
 BEGIN
  PERFORM public.staff_channel_submit(current_setting('test.task13c.req_b')::uuid,'confirm',null,gen_random_uuid());
 EXCEPTION WHEN OTHERS THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'cross-cafe staff accepted someone else shift'; END IF;
 rejected:=false;
 BEGIN
  PERFORM public.staff_channel_submit(current_setting('test.task13c.req_a')::uuid,'confirm',null,current_setting('test.task13c.nonce_a')::uuid);
 EXCEPTION WHEN OTHERS THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'reused nonce changed the recorded response'; END IF;
END $test$;
SELECT public.staff_channel_submit(:'req_checklist','complete',
 'All surfaces cleaned; freezer gauge checked.',:'nonce_checklist');
SELECT public.staff_channel_submit(NULL,'report',
 'The espresso machine makes a strange noise.',:'nonce_report');
DO $test$
BEGIN
 IF (SELECT count(*) FROM public.staff_communication_messages
   WHERE business_id=current_setting('test.task13c.biz_a')::uuid AND employee_id=current_setting('test.task13c.staff_a')::uuid)<>3
 THEN RAISE EXCEPTION 'checklist/report not reusable in same channel'; END IF;
END $test$;

-- Only owner sees the generated operational inbox, never an employee.
DO $test$
BEGIN
 IF EXISTS(SELECT 1 FROM public.operating_tasks WHERE id LIKE 'staff-response:%')
 THEN RAISE EXCEPTION 'staff read owner notification'; END IF;
END $test$;
SELECT set_config('request.jwt.claim.sub',:'owner_a',true);
DO $test$
BEGIN
 IF (SELECT count(*) FROM public.operating_tasks
   WHERE id LIKE 'staff-response:%' AND business_id=current_setting('test.task13c.biz_a')::uuid)<>3
 THEN RAISE EXCEPTION 'owner did not get exactly one task per staff message'; END IF;
 IF EXISTS(SELECT 1 FROM public.staff_communication_messages WHERE business_id=current_setting('test.task13c.biz_b')::uuid)
 THEN RAISE EXCEPTION 'owner read foreign cafe staff message'; END IF;
END $test$;

-- Changed source must invalidate the old shift request, while exact retry
-- of an already recorded message remains idempotently recoverable.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
UPDATE public.scheduled_shifts SET start_local='08:00',updated_at=now()+interval '2 seconds'
 WHERE business_id=:'biz_a' AND id=:'shift_a';
SELECT public.staff_channel_sync_shift_requests(:'biz_a');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub',:'staff_user_a',true);
DO $test$
DECLARE denied boolean:=false;r jsonb;
BEGIN
 BEGIN PERFORM public.staff_channel_submit(current_setting('test.task13c.req_a')::uuid,'message',
  'I could do the original hours',gen_random_uuid());
 EXCEPTION WHEN OTHERS THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'stale shift request accepted new reply'; END IF;
 r:=public.staff_channel_submit(current_setting('test.task13c.req_a')::uuid,'decline',
  'I cannot work 7 to 2; I can arrive at 8 instead.',current_setting('test.task13c.nonce_a')::uuid);
 IF r->>'replayed'<>'true' THEN RAISE EXCEPTION 'retry receipt lost after source change'; END IF;
END $test$;

SELECT 'task13c employee isolation, free-text, dedupe, owner notice, stale revision PASS' AS proof;
ROLLBACK;
