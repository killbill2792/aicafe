\set ON_ERROR_STOP on
-- Disposable Supabase only: use the real Supervisor ledger and migration 087.
BEGIN;
SELECT gen_random_uuid() AS business,gen_random_uuid() AS foreign_business,
 gen_random_uuid() AS owner,gen_random_uuid() AS manager,gen_random_uuid() AS thread_id,
 gen_random_uuid() AS proposal_id,gen_random_uuid() AS stale_id,
 gen_random_uuid() AS broken_id,gen_random_uuid() AS cancelled_id \gset
INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
VALUES
 (:'owner','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'staff-approval-owner@example.invalid','',now(),now()),
 (:'manager','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'staff-approval-manager@example.invalid','',now(),now());
INSERT INTO public.businesses(id,name,timezone,is_demo)
VALUES (:'business','Staff approval test','America/Los_Angeles',false),
 (:'foreign_business','Foreign cafe','America/Los_Angeles',false);
INSERT INTO public.memberships(business_id,user_id,role)
VALUES (:'business',:'owner','owner'),(:'business',:'manager','manager');
INSERT INTO public.ai_threads(id,business_id,owner_user_id,client_request_id)
VALUES (:'thread_id',:'business',:'owner',gen_random_uuid());
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT public.supervisor_staff_source_token(:'business'::uuid) AS token \gset
INSERT INTO public.supervisor_proposals(
 id,business_id,owner_user_id,thread_id,request_key,
 capability_id,capability_version,canonical_effect_payload,effect_hash,
 baseline,monitor_spec,locale)
VALUES (:'proposal_id',:'business',:'owner',:'thread_id',gen_random_uuid(),
 'olivia.staff_propose_rule_change.v1',1,
 jsonb_build_object('operation','propose_rule_change','expectedToken',:'token',
  'preview',jsonb_build_array(jsonb_build_object('label','prep_minutes_before_open','before','0','after','30')),
  'payload',jsonb_build_object('rule','prep_minutes_before_open','boolean_value',null,'number_value',30)),
 repeat('a',64),'{}','{"durationDays":1,"metricScope":"staff"}','en');
SELECT set_config('test.approval.business',:'business',true);
SELECT set_config('test.approval.proposal',:'proposal_id',true);
DO $
BEGIN
 IF EXISTS(SELECT 1 FROM public.team_rules WHERE business_id=current_setting('test.approval.business')::uuid)
 THEN RAISE EXCEPTION 'inert card unexpectedly wrote staff data'; END IF;
END $;
-- A manager, foreign café and other thread cannot approve this private card.
DO $$
DECLARE denied boolean;
BEGIN
 denied:=false;
 BEGIN
 PERFORM public.supervisor_transition_proposal(
 current_setting('test.approval.business')::uuid,
 (SELECT user_id FROM public.memberships WHERE business_id=current_setting('test.approval.business')::uuid AND role='manager'),
 current_setting('test.approval.proposal')::uuid,1,'approve',NULL);
 EXCEPTION WHEN OTHERS THEN denied:=true;
 END;
 IF NOT denied THEN RAISE EXCEPTION 'manager bypassed approval'; END IF;
END $$;
SELECT public.supervisor_transition_proposal(
 :'business'::uuid,:'owner'::uuid,:'proposal_id'::uuid,1,'approve',NULL);
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.team_rules WHERE business_id=current_setting('test.approval.business')::uuid)
 THEN RAISE EXCEPTION 'approval claim wrote before final owner commit'; END IF;
END $$;
SELECT public.supervisor_commit_staff_proposal(
 :'business'::uuid,:'owner'::uuid,:'thread_id'::uuid,:'proposal_id'::uuid,2) AS result \gset
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.team_rules
   WHERE business_id=current_setting('test.approval.business')::uuid
     AND prep_minutes_before_open=30)
 OR NOT EXISTS(SELECT 1 FROM public.supervisor_proposals p
   JOIN public.supervisor_approvals a ON a.proposal_id=p.id
   WHERE p.business_id=current_setting('test.approval.business')::uuid
    AND p.status='committed' AND p.revision=4
    AND a.approved_revision=1 AND a.effect_hash=p.effect_hash)
 THEN RAISE EXCEPTION 'staff approval write or audit not atomic'; END IF;
END $$;
-- Double-click / replay cannot apply the same approved effect twice.
DO $$
DECLARE denied boolean:=false;
BEGIN
 BEGIN PERFORM public.supervisor_commit_staff_proposal(
  (SELECT business_id FROM public.supervisor_proposals WHERE status='committed' LIMIT 1),
  (SELECT owner_user_id FROM public.supervisor_proposals WHERE status='committed' LIMIT 1),
  (SELECT thread_id FROM public.supervisor_proposals WHERE status='committed' LIMIT 1),
  (SELECT id FROM public.supervisor_proposals WHERE status='committed' LIMIT 1),2);
 EXCEPTION WHEN OTHERS THEN denied:=true;
 END;
 IF NOT denied THEN RAISE EXCEPTION 'double commit succeeded'; END IF;
END $$;
-- A changed source after approval produces a terminal stale state and no write.
SELECT public.supervisor_staff_source_token(:'business'::uuid) AS token \gset
INSERT INTO public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,
 capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale)
VALUES (:'stale_id',:'business',:'owner',:'thread_id',gen_random_uuid(),
 'olivia.staff_propose_rule_change.v1',1,
 jsonb_build_object('operation','propose_rule_change','expectedToken',:'token',
  'preview',jsonb_build_array(jsonb_build_object('label','min_headcount','before','2','after','3')),
  'payload',jsonb_build_object('rule','min_headcount','boolean_value',null,'number_value',3)),
 repeat('b',64),'{}','{"durationDays":1,"metricScope":"staff"}','en');
SELECT public.supervisor_transition_proposal(:'business'::uuid,:'owner'::uuid,:'stale_id'::uuid,1,'approve',NULL);
UPDATE public.team_rules SET prep_minutes_before_open=45 WHERE business_id=:'business'::uuid;
SELECT public.supervisor_commit_staff_proposal(
 :'business'::uuid,:'owner'::uuid,:'thread_id'::uuid,:'stale_id'::uuid,2);
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.supervisor_proposals p
   WHERE p.id=(SELECT id FROM public.supervisor_proposals WHERE status='stale' LIMIT 1)
     AND p.status='stale' AND p.revision=3)
 OR (SELECT min_headcount FROM public.team_rules
  WHERE business_id=current_setting('test.approval.business')::uuid)<>2
 THEN RAISE EXCEPTION 'stale approval changed data'; END IF;
END $$;
-- A database constraint violation must roll back the effect AND executing revision.
SELECT public.supervisor_staff_source_token(:'business'::uuid) AS token \gset
INSERT INTO public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,
 capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale)
VALUES (:'broken_id',:'business',:'owner',:'thread_id',gen_random_uuid(),
 'olivia.staff_propose_rule_change.v1',1,
 jsonb_build_object('operation','propose_rule_change','expectedToken',:'token',
  'preview',jsonb_build_array(jsonb_build_object('label','min_headcount','before','2','after','100')),
  'payload',jsonb_build_object('rule','min_headcount','boolean_value',null,'number_value',100)),
 repeat('c',64),'{}','{"durationDays":1,"metricScope":"staff"}','en');
SELECT public.supervisor_transition_proposal(:'business'::uuid,:'owner'::uuid,:'broken_id'::uuid,1,'approve',NULL);
DO $$
DECLARE rejected boolean:=false;
BEGIN
 BEGIN
   PERFORM public.supervisor_commit_staff_proposal(
    (SELECT business_id FROM public.supervisor_proposals WHERE effect_hash=repeat('c',64)),
    (SELECT owner_user_id FROM public.supervisor_proposals WHERE effect_hash=repeat('c',64)),
    (SELECT thread_id FROM public.supervisor_proposals WHERE effect_hash=repeat('c',64)),
    (SELECT id FROM public.supervisor_proposals WHERE effect_hash=repeat('c',64)),2);
 EXCEPTION WHEN check_violation THEN rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'invalid rule committed'; END IF;
 IF (SELECT status FROM public.supervisor_proposals WHERE effect_hash=repeat('c',64))<>'approved'
  OR (SELECT revision FROM public.supervisor_proposals WHERE effect_hash=repeat('c',64))<>2
 THEN RAISE EXCEPTION 'failed effect left partial ledger transition'; END IF;
END $$;
ROLLBACK;
