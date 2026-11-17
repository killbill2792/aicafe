\set ON_ERROR_STOP on
-- Task13C: disposable migrated Supabase, authentic owner/employee JWT scopes.
BEGIN;
SELECT gen_random_uuid() AS biz_a,gen_random_uuid() AS biz_b,
 gen_random_uuid() AS owner_a,gen_random_uuid() AS owner_b,
 gen_random_uuid() AS staff_user_a,gen_random_uuid() AS staff_user_b,
 gen_random_uuid() AS manager_a,
 gen_random_uuid() AS staff_a,gen_random_uuid() AS staff_b,
 gen_random_uuid() AS staff_other,
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
   '13c-worker-b@example.invalid',now(),'',now(),now()),
 (:'manager_a','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   '13c-manager-a@example.invalid',now(),'',now(),now());
INSERT INTO public.businesses(id,name,timezone,currency,is_demo)
VALUES (:'biz_a','13c disposable A','America/Los_Angeles','USD',false),
 (:'biz_b','13c disposable B','Europe/London','GBP',false);
INSERT INTO public.memberships(business_id,user_id,role)
VALUES (:'biz_a',:'owner_a','owner'),(:'biz_b',:'owner_b','owner'),
 (:'biz_a',:'manager_a','manager');
INSERT INTO public.employees(id,business_id,display_name,active,wage_period,wage_amount_cents,phone_e164,whatsapp_opt_in)
VALUES
 (:'staff_a',:'biz_a','13c Staff A',true,'hour',1700,'+14155550901',true),
 (:'staff_b',:'biz_b','13c Staff B',true,'hour',1800,'+442079460901',true),
 (:'staff_other',:'biz_a','13c Staff Other',true,'hour',1700,'+14155550902',false);
INSERT INTO public.scheduled_shifts(id,business_id,employee_id,local_date,start_local,end_local,source,status)
VALUES
 (:'shift_a',:'biz_a',:'staff_a',current_date+2,'07:00','14:00','owner','sent'),
 (:'shift_b',:'biz_b',:'staff_b',current_date+2,'08:00','15:00','owner','sent');

SELECT set_config('test.task13c.biz_a',:'biz_a',true);
SELECT set_config('test.task13c.biz_b',:'biz_b',true);
SELECT set_config('test.task13c.staff_a',:'staff_a',true);
SELECT set_config('test.task13c.staff_other',:'staff_other',true);
SELECT set_config('test.task13c.staff_b',:'staff_b',true);
SELECT set_config('test.task13c.owner_a',:'owner_a',true);
SELECT set_config('test.task13c.owner_b',:'owner_b',true);
SELECT set_config('test.task13c.manager_a',:'manager_a',true);
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

-- A manager may edit ordinary employee details but cannot self-link to
-- another worker by bypassing the owner-only RPC through the broad old RLS.
SELECT set_config('request.jwt.claim.sub',:'manager_a',true);
DO $test$
DECLARE denied boolean:=false;
BEGIN
 BEGIN
  UPDATE public.employees SET staff_auth_user_id=current_setting('test.task13c.manager_a')::uuid
   WHERE business_id=current_setting('test.task13c.biz_a')::uuid
    AND id=current_setting('test.task13c.staff_other')::uuid;
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'manager directly linked own login to another employee'; END IF;
 IF public.staff_channel_is_employee(current_setting('test.task13c.biz_a')::uuid,
   current_setting('test.task13c.staff_other')::uuid)
 THEN RAISE EXCEPTION 'manager obtained private staff channel'; END IF;
 UPDATE public.employees SET display_name='13c Staff Other Updated'
  WHERE id=current_setting('test.task13c.staff_other')::uuid;
 IF NOT EXISTS(SELECT 1 FROM public.employees
  WHERE id=current_setting('test.task13c.staff_other')::uuid
    AND display_name='13c Staff Other Updated')
 THEN RAISE EXCEPTION 'guard blocked ordinary employee edits'; END IF;
 denied:=false;
 BEGIN
  PERFORM public.staff_link_existing_login(
    current_setting('test.task13c.biz_a')::uuid,
    current_setting('test.task13c.staff_other')::uuid,'13c-manager-a@example.invalid');
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'manager bypassed owner-only link RPC'; END IF;
END $test$;
SELECT set_config('request.jwt.claim.sub',:'owner_a',true);
DO $test$
DECLARE denied boolean:=false;
BEGIN
 BEGIN
  UPDATE public.employees SET staff_auth_user_id=null
   WHERE business_id=current_setting('test.task13c.biz_a')::uuid
     AND id=current_setting('test.task13c.staff_a')::uuid;
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'owner bypassed audited link RPC'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.employees
   WHERE id=current_setting('test.task13c.staff_a')::uuid
     AND staff_auth_user_id=current_setting('test.task13c.staff_user_a')::uuid)
 THEN RAISE EXCEPTION 'direct UPDATE changed a linked identity'; END IF;
END $test$;

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

-- Even a trusted service-role producer cannot attach another worker's
-- report to a request assigned to a different employee at the same café.
DO $test$
DECLARE denied boolean:=false;
BEGIN
 BEGIN
  INSERT INTO public.staff_communication_messages
    (business_id,employee_id,request_id,actor,response_code,body,channel,client_nonce)
  VALUES(current_setting('test.task13c.biz_a')::uuid,
    current_setting('test.task13c.staff_other')::uuid,
    current_setting('test.task13c.req_a')::uuid,
    'employee','message','Wrong worker assignment','web',gen_random_uuid());
 EXCEPTION WHEN foreign_key_violation THEN denied:=true; END;
 IF NOT denied THEN
  RAISE EXCEPTION 'same-cafe cross-employee assignment forged'; END IF;
END $test$;

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
 IF (SELECT count(*) FROM public.operating_tasks
   WHERE business_id=current_setting('test.task13c.biz_a')::uuid AND
    id LIKE 'staff-response:%' AND kind='staff_coverage')<>1
 THEN RAISE EXCEPTION 'checklist/report incorrectly classified as staffing coverage'; END IF;
 IF (SELECT count(*) FROM public.operating_tasks
   WHERE business_id=current_setting('test.task13c.biz_a')::uuid AND
    id LIKE 'staff-response:%' AND kind='data_quality')<>2
 THEN RAISE EXCEPTION 'general staff work/report notices missing'; END IF;
 IF EXISTS(SELECT 1 FROM public.staff_communication_messages WHERE business_id=current_setting('test.task13c.biz_b')::uuid)
 THEN RAISE EXCEPTION 'owner read foreign cafe staff message'; END IF;
END $test$;

-- Owner's explicit in-app Send is a staff-private message, not a worker
-- report, provider receipt, roster update or an implicit AI effect approval.
SELECT public.staff_channel_owner_send(:'staff_a',
 'Thanks for explaining. Can you confirm an eight o''clock start?',:'nonce_b')->>'id'
 AS owner_message \gset
SELECT set_config('test.task13c.owner_message',:'owner_message',true);
DO $test$
DECLARE receipt jsonb; denied boolean:=false;
BEGIN
 IF (SELECT count(*) FROM public.operating_tasks WHERE business_id=current_setting('test.task13c.biz_a')::uuid
   AND id LIKE 'staff-response:%')<>3
 THEN RAISE EXCEPTION 'owner message falsely created a new staff-response notification'; END IF;
 receipt:=public.staff_channel_owner_send(
  current_setting('test.task13c.staff_a')::uuid,
  'Thanks for explaining. Can you confirm an eight o''clock start?',
  current_setting('test.task13c.nonce_b')::uuid);
 IF receipt->>'replayed'<>'true' or receipt->>'id'<>
  current_setting('test.task13c.owner_message')
 THEN RAISE EXCEPTION 'owner retry sent duplicate staff message'; END IF;
 BEGIN PERFORM public.staff_channel_owner_send(
  current_setting('test.task13c.staff_a')::uuid,
  'Different text on same nonce',current_setting('test.task13c.nonce_b')::uuid);
 EXCEPTION WHEN OTHERS THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'owner nonce replay silently changed message'; END IF;
END $test$;
-- The same channel supports later PRs' owner-issued checklists and tasks.
SELECT gen_random_uuid() AS owner_assign_nonce \gset
SELECT public.staff_channel_owner_assign(:'staff_a','checklist',
 'Check opening equipment','Inspect grinder and log any problems',:'owner_assign_nonce')->>'id'
 AS owner_assign_id \gset
SELECT set_config('test.task13c.owner_assign_nonce',:'owner_assign_nonce',true);
SELECT set_config('test.task13c.owner_assign_id',:'owner_assign_id',true);
DO $test$
DECLARE receipt jsonb; denied boolean:=false;
BEGIN
 receipt:=public.staff_channel_owner_assign(
  current_setting('test.task13c.staff_a')::uuid,'checklist',
  'Check opening equipment','Inspect grinder and log any problems',
  current_setting('test.task13c.owner_assign_nonce')::uuid);
 IF receipt->>'replayed'<>'true' or receipt->>'id'<>
   current_setting('test.task13c.owner_assign_id') THEN
   RAISE EXCEPTION 'repeat owner assignment duplicated work'; END IF;
 BEGIN PERFORM public.staff_channel_owner_assign(
  current_setting('test.task13c.staff_a')::uuid,'task',
  'Different title','Different work',
  current_setting('test.task13c.owner_assign_nonce')::uuid);
 EXCEPTION WHEN OTHERS THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'assignment nonce changed worker task'; END IF;
END $test$;
SELECT set_config('request.jwt.claim.sub',:'owner_b',true);
DO $test$
DECLARE denied boolean:=false;
BEGIN
 BEGIN PERFORM public.staff_channel_owner_send(
  current_setting('test.task13c.staff_a')::uuid,
  'Foreign owner message',gen_random_uuid());
 EXCEPTION WHEN OTHERS THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'foreign cafe owner sent a staff message'; END IF;
END $test$;
SELECT set_config('request.jwt.claim.sub',:'staff_user_a',true);
DO $test$
DECLARE denied boolean:=false;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.staff_communication_messages
   WHERE id=current_setting('test.task13c.owner_message')::uuid
    AND actor='owner' and response_code='owner_message') THEN
   RAISE EXCEPTION 'worker cannot read the verified owner reply'; END IF;
 BEGIN PERFORM public.staff_channel_owner_send(
  current_setting('test.task13c.staff_a')::uuid,
  'Staff cannot impersonate owner',gen_random_uuid());
 EXCEPTION WHEN OTHERS THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'staff could send messages as an owner'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.staff_communication_requests
   WHERE id=current_setting('test.task13c.owner_assign_id')::uuid
    AND kind='checklist' AND title='Check opening equipment')
 THEN RAISE EXCEPTION 'employee cannot see their owner-issued checklist'; END IF;
 IF public.staff_channel_submit(current_setting('test.task13c.owner_assign_id')::uuid,
     'complete','Grinder inspected, everything looks okay',gen_random_uuid())->>'id' IS NULL
 THEN RAISE EXCEPTION 'owner-issued checklist did not accept worker text'; END IF;
END $test$;
SELECT set_config('request.jwt.claim.sub',:'staff_user_b',true);
DO $test$
BEGIN
 IF EXISTS(SELECT 1 FROM public.staff_communication_messages
  WHERE id=current_setting('test.task13c.owner_message')::uuid)
 THEN RAISE EXCEPTION 'another cafe staff saw private owner reply'; END IF;
 IF EXISTS(SELECT 1 FROM public.staff_communication_requests
   WHERE id=current_setting('test.task13c.owner_assign_id')::uuid)
 THEN RAISE EXCEPTION 'foreign worker saw private task'; END IF;
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

-- Revocation cannot let a disabled employee submit additional work.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
UPDATE public.employees SET active=false WHERE id=:'staff_a';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub',:'staff_user_a',true);
DO $test$
DECLARE denied boolean:=false;
BEGIN
 BEGIN PERFORM public.staff_channel_submit(NULL,'report',
  'This account should no longer submit',gen_random_uuid());
 EXCEPTION WHEN OTHERS THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'inactive worker submitted after revocation'; END IF;
END $test$;

-- The owner can revoke a linked login after deactivating the worker, but
-- cannot reactivate that login link while the worker remains inactive.
SELECT set_config('request.jwt.claim.sub',:'owner_a',true);
DO $test$
DECLARE res jsonb; denied boolean:=false;
BEGIN
 res:=public.staff_link_existing_login(
  current_setting('test.task13c.biz_a')::uuid,
  current_setting('test.task13c.staff_a')::uuid,NULL);
 IF res->>'linked'<>'false' or exists(
  select 1 from public.employees e
  where e.id=current_setting('test.task13c.staff_a')::uuid
    and e.staff_auth_user_id is not null)
 THEN RAISE EXCEPTION 'owner failed to disconnect disabled worker'; END IF;
 BEGIN
  PERFORM public.staff_link_existing_login(
   current_setting('test.task13c.biz_a')::uuid,
   current_setting('test.task13c.staff_a')::uuid,
   '13c-worker-a@example.invalid');
 EXCEPTION WHEN OTHERS THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'disabled employee was relinked'; END IF;
END $test$;

SELECT 'task13c employee isolation, free-text, dedupe, owner notice, stale revision PASS' AS proof;
ROLLBACK;
