\set ON_ERROR_STOP on
-- Task 13B migrated disposable Supabase ONLY; every business, receipt and send is rolled back.
BEGIN;
SELECT gen_random_uuid() AS cafe_a,gen_random_uuid() AS cafe_b,
 gen_random_uuid() AS owner_a,gen_random_uuid() AS owner_b,gen_random_uuid() AS thread_a,
 gen_random_uuid() AS worker_a,gen_random_uuid() AS worker_b,
 gen_random_uuid() AS proposal_a,gen_random_uuid() AS proposal_b,gen_random_uuid() AS legacy_id \gset
INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
VALUES (:'owner_a','00000000-0000-0000-0000-000000000000','authenticated','authenticated','task13b-a@example.invalid','',now(),now()),
 (:'owner_b','00000000-0000-0000-0000-000000000000','authenticated','authenticated','task13b-b@example.invalid','',now(),now());
INSERT INTO public.businesses(id,name,timezone,currency,is_demo)
VALUES (:'cafe_a','13b disposable A','America/Los_Angeles','USD',false),
 (:'cafe_b','13b disposable B','America/New_York','EUR',false);
INSERT INTO public.memberships(business_id,user_id,role)
VALUES (:'cafe_a',:'owner_a','owner'),(:'cafe_b',:'owner_b','owner');
INSERT INTO public.ai_threads(id,business_id,owner_user_id,client_request_id)
VALUES (:'thread_a',:'cafe_a',:'owner_a',gen_random_uuid());
INSERT INTO public.employees(id,business_id,display_name,active,wage_period,wage_amount_cents,phone_e164,whatsapp_opt_in)
VALUES (:'worker_a',:'cafe_a','Worker A',true,'hour',1700,'+14155550123',true),
 (:'worker_b',:'cafe_a','Worker B',true,'hour',1700,'+14155550124',true);
SELECT date_trunc('week',current_date+interval '14 days')::date AS week \gset
INSERT INTO public.scheduled_shifts(business_id,employee_id,local_date,start_local,end_local,source,status)
VALUES (:'cafe_a',:'worker_a',:'week','09:00','15:00','olivia','draft'),
 (:'cafe_a',:'worker_b',:'week','10:00','16:00','olivia','draft');
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
INSERT INTO public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,
 capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale,status)
VALUES (:'proposal_a',:'cafe_a',:'owner_a',:'thread_a',gen_random_uuid(),
 'olivia.staff_propose_send_schedule.v2',2,
 jsonb_build_object('operation','propose_send_schedule',
  'payload',jsonb_build_object('week_start',:'week','publish_and_notify',true)),
 repeat('a',64),'{}','{}','en','committed'),
 (:'proposal_b',:'cafe_a',:'owner_a',:'thread_a',gen_random_uuid(),
 'olivia.staff_propose_send_schedule.v2',2,
 jsonb_build_object('operation','propose_send_schedule',
  'payload',jsonb_build_object('week_start',:'week','publish_and_notify',true)),
 repeat('b',64),'{}','{}','en','committed'),
 (:'legacy_id',:'cafe_a',:'owner_a',:'thread_a',gen_random_uuid(),
 'olivia.staff_propose_send_schedule.v2',2,
 jsonb_build_object('operation','propose_send_schedule',
  'payload',jsonb_build_object('week_start',:'week')),
 repeat('c',64),'{}','{}','en','committed');
INSERT INTO public.supervisor_approvals(business_id,proposal_id,owner_user_id,approved_revision,effect_hash)
VALUES (:'cafe_a',:'proposal_a',:'owner_a',1,repeat('a',64)),
 (:'cafe_a',:'proposal_b',:'owner_a',1,repeat('b',64)),
 (:'cafe_a',:'legacy_id',:'owner_a',1,repeat('c',64));
INSERT INTO public.staff_schedule_handoff_snapshots(business_id,proposal_id,week_start,shifts)
SELECT :'cafe_a',id,:'week',public.staff_handoff_week_shifts(:'cafe_a',:'week')
 FROM public.supervisor_proposals WHERE id IN (:'proposal_a',:'proposal_b',:'legacy_id');
INSERT INTO public.staff_schedule_deliveries(business_id,proposal_id,employee_id,recipient_e164,status)
VALUES (:'cafe_a',:'proposal_a',:'worker_a','+14155550123','prepared'),
 (:'cafe_a',:'proposal_a',:'worker_b','+14155550124','prepared');
SELECT set_config('test.t13b.cafe',:'cafe_a',true);
SELECT set_config('test.t13b.foreign',:'cafe_b',true);
SELECT set_config('test.t13b.owner',:'owner_a',true);
SELECT set_config('test.t13b.other',:'owner_b',true);
SELECT set_config('test.t13b.proposal',:'proposal_a',true);
SELECT set_config('test.t13b.legacy',:'legacy_id',true);
SELECT set_config('test.t13b.second',:'proposal_b',true);
SELECT set_config('test.t13b.worker_a',:'worker_a',true);
SELECT set_config('test.t13b.worker_b',:'worker_b',true);

DO $test$
DECLARE denied boolean:=false;
BEGIN
 BEGIN
  PERFORM public.staff_schedule_publish(current_setting('test.t13b.cafe')::uuid,
    current_setting('test.t13b.owner')::uuid,current_setting('test.t13b.legacy')::uuid);
 EXCEPTION WHEN OTHERS THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION '13B retroactive copy-only approval became publication'; END IF;
 denied:=false;
 BEGIN
  PERFORM public.staff_schedule_publish(current_setting('test.t13b.foreign')::uuid,
   current_setting('test.t13b.other')::uuid,current_setting('test.t13b.proposal')::uuid);
 EXCEPTION WHEN OTHERS THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION '13B foreign cafe published a roster'; END IF;
END $test$;

SELECT public.staff_schedule_publish(:'cafe_a',:'owner_a',:'proposal_a')->>'id' AS publication_id \gset
SELECT set_config('test.t13b.pub',:'publication_id',true);
DO $test$
DECLARE r jsonb; denied boolean:=false;
BEGIN
 r:=public.staff_schedule_publish(current_setting('test.t13b.cafe')::uuid,
   current_setting('test.t13b.owner')::uuid,current_setting('test.t13b.proposal')::uuid);
 IF r->>'replayed'<>'true' OR r->>'id'<>current_setting('test.t13b.pub')
   OR (SELECT count(*) FROM public.staff_schedule_publications)<>1
 THEN RAISE EXCEPTION '13B idempotent publication lost identity'; END IF;
 IF (SELECT count(*) FROM public.staff_schedule_deliveries
   WHERE publication_id=current_setting('test.t13b.pub')::uuid)<>2
 THEN RAISE EXCEPTION '13B per-worker delivery records not bound'; END IF;
 BEGIN PERFORM public.staff_schedule_publish(current_setting('test.t13b.cafe')::uuid,
  current_setting('test.t13b.owner')::uuid,current_setting('test.t13b.second')::uuid);
 EXCEPTION WHEN OTHERS THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION '13B different approval published same week'; END IF;
 IF EXISTS(SELECT 1 FROM public.timecards WHERE business_id=current_setting('test.t13b.cafe')::uuid)
 THEN RAISE EXCEPTION '13B publication fabricated attendance'; END IF;
END $test$;

-- Double claim and forged attempt cannot send twice. Provider accepted != delivered.
SELECT public.staff_schedule_claim_delivery(:'publication_id',:'worker_a')->>'attemptToken' AS token_a \gset
SELECT public.staff_schedule_claim_delivery(:'publication_id',:'worker_a') AS no_replay;
DO $test$
DECLARE d public.staff_schedule_deliveries%rowtype; token uuid;
BEGIN
 SELECT * INTO d FROM public.staff_schedule_deliveries
  WHERE publication_id=current_setting('test.t13b.pub')::uuid
    AND employee_id=current_setting('test.t13b.worker_a')::uuid;
 IF d.status<>'sending' OR d.attempt_token IS NULL
   OR public.staff_schedule_claim_delivery(current_setting('test.t13b.pub')::uuid,
      current_setting('test.t13b.worker_a')::uuid) IS NOT NULL
 THEN RAISE EXCEPTION '13B second delivery claim escaped'; END IF;
 IF public.staff_schedule_finish_delivery(d.id,gen_random_uuid(),'sent','wamid.abc',null)
 THEN RAISE EXCEPTION '13B forged token succeeded'; END IF;
 IF NOT public.staff_schedule_can_send(d.id,d.attempt_token) THEN
   RAISE EXCEPTION '13B final original approved source was unexpectedly denied'; END IF;
 UPDATE public.scheduled_shifts SET start_local='09:30' WHERE
   business_id=current_setting('test.t13b.cafe')::uuid AND
   employee_id=current_setting('test.t13b.worker_a')::uuid;
 IF public.staff_schedule_can_send(d.id,d.attempt_token) THEN
   RAISE EXCEPTION '13B final send check ignored a changed roster after claim'; END IF;
 UPDATE public.scheduled_shifts SET start_local='09:00' WHERE
   business_id=current_setting('test.t13b.cafe')::uuid AND
   employee_id=current_setting('test.t13b.worker_a')::uuid;
 IF NOT public.staff_schedule_can_send(d.id,d.attempt_token) THEN
   RAISE EXCEPTION '13B final send check did not recover the verified source'; END IF;
 IF NOT public.staff_schedule_finish_delivery(d.id,d.attempt_token,'sent','wamid.abc',null)
 THEN RAISE EXCEPTION '13B accepted receipt not stored'; END IF;
 IF (SELECT status FROM public.staff_schedule_deliveries WHERE id=d.id)<>'sent'
 THEN RAISE EXCEPTION '13B provider acceptance mislabeled delivery'; END IF;
 IF NOT public.staff_schedule_record_provider_status('wamid.abc','delivered') THEN
   RAISE EXCEPTION '13B signed delivered status missing'; END IF;
 IF (SELECT status FROM public.staff_schedule_deliveries WHERE id=d.id)<>'delivered' THEN
   RAISE EXCEPTION '13B signed delivered status not applied'; END IF;
 IF NOT public.staff_schedule_record_provider_status('wamid.abc','read') THEN
   RAISE EXCEPTION '13B signed read status missing'; END IF;
 IF (SELECT status FROM public.staff_schedule_deliveries WHERE id=d.id)<>'read' THEN
   RAISE EXCEPTION '13B signed read status not applied'; END IF;
 IF NOT public.staff_schedule_record_provider_status('wamid.abc','sent') THEN
   RAISE EXCEPTION '13B duplicate sent status missing'; END IF;
 IF (SELECT status FROM public.staff_schedule_deliveries WHERE id=d.id)<>'read' THEN
   RAISE EXCEPTION '13B signed status demoted a read receipt'; END IF;
END $test$;

-- A WhatsApp opt-in does not override SMS channel preference or
-- Spanish-language preference when only an English template is approved.
UPDATE public.employees SET preferred_schedule_channel='sms' WHERE id=:'worker_b';
DO $test$
BEGIN
 IF public.staff_schedule_claim_delivery(current_setting('test.t13b.pub')::uuid,
  current_setting('test.t13b.worker_b')::uuid) IS NOT NULL THEN
   RAISE EXCEPTION '13B SMS-preferred employee was messaged through WhatsApp'; END IF;
END $test$;
UPDATE public.employees SET preferred_schedule_channel='whatsapp',
 preferred_language='es' WHERE id=:'worker_b';
UPDATE public.staff_schedule_deliveries SET status='prepared',error_code=null
 WHERE publication_id=:'publication_id' AND employee_id=:'worker_b';
DO $test$
BEGIN
 IF public.staff_schedule_claim_delivery(current_setting('test.t13b.pub')::uuid,
  current_setting('test.t13b.worker_b')::uuid) IS NOT NULL THEN
   RAISE EXCEPTION '13B Spanish-preferred employee got unsupported English template'; END IF;
END $test$;
UPDATE public.employees SET preferred_language='en' WHERE id=:'worker_b';
UPDATE public.staff_schedule_deliveries SET status='prepared',error_code=null
 WHERE publication_id=:'publication_id' AND employee_id=:'worker_b';

-- Live consent or roster edits revoke pending recipient effects.
UPDATE public.employees SET whatsapp_opt_in=false WHERE id=:'worker_b';
DO $test$
DECLARE d public.staff_schedule_deliveries%rowtype;
BEGIN
 IF public.staff_schedule_claim_delivery(current_setting('test.t13b.pub')::uuid,
   current_setting('test.t13b.worker_b')::uuid) IS NOT NULL THEN
   RAISE EXCEPTION '13B opt-out was ignored'; END IF;
 SELECT * INTO d FROM public.staff_schedule_deliveries WHERE
  publication_id=current_setting('test.t13b.pub')::uuid AND
  employee_id=current_setting('test.t13b.worker_b')::uuid;
 IF d.status<>'failed' OR d.error_code<>'recipient_revoked' THEN
  RAISE EXCEPTION '13B opt-out not durably blocked'; END IF;
END $test$;

-- A click-authenticated cancellation blocks new claims and preserves previously
-- accepted truth. A correction needs a new proposal and an incremented revision.
DO $test$
DECLARE r jsonb; renewed jsonb;
BEGIN
 r:=public.staff_schedule_cancel_publication(
  current_setting('test.t13b.cafe')::uuid,current_setting('test.t13b.owner')::uuid,
  current_setting('test.t13b.pub')::uuid);
 IF r->>'state'<>'cancelled' OR (r->>'alreadyAccepted')::int<1 THEN
  RAISE EXCEPTION '13B cancellation pretended accepted sends can be unsent'; END IF;
 IF public.staff_schedule_claim_delivery(current_setting('test.t13b.pub')::uuid,
    current_setting('test.t13b.worker_b')::uuid) IS NOT NULL THEN
  RAISE EXCEPTION '13B cancellation allowed a new send claim'; END IF;
 IF (SELECT status FROM public.staff_schedule_publications
     WHERE id=current_setting('test.t13b.pub')::uuid)<>'cancelled' THEN
  RAISE EXCEPTION '13B cancellation not persisted'; END IF;
 renewed:=public.staff_schedule_publish(current_setting('test.t13b.cafe')::uuid,
  current_setting('test.t13b.owner')::uuid,current_setting('test.t13b.second')::uuid);
 IF renewed->>'state'<>'published' OR (renewed->>'publicationRevision')::int<>2
 OR (SELECT count(*) FROM public.staff_schedule_publications
    WHERE business_id=current_setting('test.t13b.cafe')::uuid)<>2 THEN
  RAISE EXCEPTION '13B fresh approval did not create a distinct correction revision'; END IF;
END $test$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub',:'owner_b',true);
DO $test$
DECLARE denied boolean:=false;
BEGIN
 IF EXISTS(SELECT 1 FROM public.staff_schedule_publications
  WHERE business_id=current_setting('test.t13b.cafe')::uuid)
 OR EXISTS(SELECT 1 FROM public.staff_schedule_deliveries
  WHERE business_id=current_setting('test.t13b.cafe')::uuid)
 THEN RAISE EXCEPTION '13B foreign cafe could read private roster or messages'; END IF;
 BEGIN
  PERFORM public.staff_schedule_publish(current_setting('test.t13b.cafe')::uuid,
    current_setting('test.t13b.owner')::uuid,current_setting('test.t13b.proposal')::uuid);
 EXCEPTION WHEN insufficient_privilege OR undefined_function THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION '13B authenticated actor directly called service RPC'; END IF;
END $test$;
ROLLBACK;
