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
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.team_rules WHERE business_id=current_setting('test.approval.business')::uuid)
 THEN RAISE EXCEPTION 'inert card unexpectedly wrote staff data'; END IF;
END $$;
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

-- Exercise actual trigger actor propagation (service_role has no request user),
-- SQL-level cross-week overlap exclusion, and immutable approved handoff.
SELECT gen_random_uuid() AS employee_id,gen_random_uuid() AS avail_id,
       gen_random_uuid() AS replace_id,gen_random_uuid() AS send_id \gset
INSERT INTO public.employees(
  id,business_id,display_name,role,wage_period,wage_amount_cents,
  default_hourly_wage_cents,phone_e164,active,whatsapp_opt_in)
VALUES(:'employee_id',:'business','Tester','Barista','hour',1800,1800,'+14155550123',true,true);

SELECT public.supervisor_staff_source_token(:'business'::uuid) AS token \gset
INSERT INTO public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,
 capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale)
VALUES(:'avail_id',:'business',:'owner',:'thread_id',gen_random_uuid(),
 'olivia.staff_propose_availability_change.v1',1,
 jsonb_build_object('operation','propose_availability_change','expectedToken',:'token',
   'preview',jsonb_build_array(jsonb_build_object('label','Tester','before','None','after','Monday')),
   'payload',jsonb_build_object('employee_id',:'employee_id','availability',
     jsonb_build_array(jsonb_build_object('day',1,'start','09:00','end','17:00')),
     'off_dates','[]'::jsonb,'effective_from',
     (now() AT TIME ZONE 'America/Los_Angeles')::date)),
 repeat('d',64),'{}','{"durationDays":1,"metricScope":"staff"}','en');
SELECT public.supervisor_transition_proposal(
 :'business'::uuid,:'owner'::uuid,:'avail_id'::uuid,1,'approve',NULL);
SELECT set_config('request.jwt.claim.sub','',true);
SELECT public.supervisor_commit_staff_proposal(
 :'business'::uuid,:'owner'::uuid,:'thread_id'::uuid,:'avail_id'::uuid,2);
DO $actor$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.staff_availability_rules r
   WHERE r.business_id=current_setting('test.approval.business')::uuid
    AND r.confirmation='owner_confirmed'
    AND r.confirmed_by=(SELECT owner_user_id FROM public.supervisor_proposals
                         WHERE effect_hash=repeat('d',64))
    AND r.created_by=r.confirmed_by)
 OR NOT EXISTS(SELECT 1 FROM public.scheduling_foundation_audit_events a
   WHERE a.business_id=current_setting('test.approval.business')::uuid
     AND a.table_name='staff_availability_rules'
     AND a.actor_user_id=(SELECT owner_user_id FROM public.supervisor_proposals
                         WHERE effect_hash=repeat('d',64)))
 THEN RAISE EXCEPTION 'service role lost validated owner attestation'; END IF;
END $actor$;

-- This Sunday overnight shift is RETAINED when Monday's week is replaced.
SELECT (date_trunc('week',(now() AT TIME ZONE 'America/Los_Angeles')::date)::date + 7)
  AS target_monday \gset
INSERT INTO public.scheduled_shifts(
  business_id,employee_id,local_date,start_local,end_local,overnight,
  break_minutes,break_source,status,source,created_by)
VALUES(:'business',:'employee_id',:'target_monday'::date-1,
  '20:00','02:00',true,30,'owner','draft','owner',:'owner');
SELECT public.supervisor_staff_source_token(:'business'::uuid) AS token \gset
INSERT INTO public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,
 capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale)
VALUES(:'replace_id',:'business',:'owner',:'thread_id',gen_random_uuid(),
 'olivia.staff_propose_schedule.v1',1,
 jsonb_build_object('operation','propose_schedule','expectedToken',:'token',
  'preview',jsonb_build_array(jsonb_build_object('label','Week','before','None','after','Monday')),
  'payload',jsonb_build_object('week_start',:'target_monday',
   'shifts',jsonb_build_array(jsonb_build_object(
    'employee_id',:'employee_id','date',:'target_monday',
    'start','01:00','end','09:00','break_minutes',30)))),
 repeat('e',64),'{}','{"durationDays":1,"metricScope":"staff"}','en');
SELECT public.supervisor_transition_proposal(
 :'business'::uuid,:'owner'::uuid,:'replace_id'::uuid,1,'approve',NULL);
DO $overlap$
DECLARE blocked boolean:=false;
BEGIN
 BEGIN
  PERFORM public.supervisor_commit_staff_proposal(
   current_setting('test.approval.business')::uuid,
   (SELECT owner_user_id FROM public.supervisor_proposals WHERE effect_hash=repeat('e',64)),
   (SELECT thread_id FROM public.supervisor_proposals WHERE effect_hash=repeat('e',64)),
   (SELECT id FROM public.supervisor_proposals WHERE effect_hash=repeat('e',64)),2);
 EXCEPTION WHEN SQLSTATE 'P0001' THEN blocked:=true;
 END;
 IF NOT blocked OR
  (SELECT status FROM public.supervisor_proposals WHERE effect_hash=repeat('e',64))<>'approved'
  OR EXISTS(SELECT 1 FROM public.scheduled_shifts
   WHERE proposal_id=(SELECT id FROM public.supervisor_proposals WHERE effect_hash=repeat('e',64)))
 THEN RAISE EXCEPTION 'cross-week overlapping shift committed'; END IF;
END $overlap$;

-- Full source is frozen on an approved send; editing any single shift invalidates.
INSERT INTO public.scheduled_shifts(
 business_id,employee_id,local_date,start_local,end_local,overnight,
 break_minutes,break_source,status,source,created_by)
VALUES(:'business',:'employee_id',:'target_monday','08:00','16:00',false,
 30,'owner','draft','owner',:'owner');
SELECT public.supervisor_staff_source_token(:'business'::uuid) AS token \gset
INSERT INTO public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,
 capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale)
VALUES(:'send_id',:'business',:'owner',:'thread_id',gen_random_uuid(),
 'olivia.staff_propose_send_schedule.v1',1,
 jsonb_build_object('operation','propose_send_schedule','expectedToken',:'token',
  'preview',jsonb_build_array(jsonb_build_object('label','Week','before','None','after','Prepared')),
  'payload',jsonb_build_object('week_start',:'target_monday')),
 repeat('f',64),'{}','{"durationDays":1,"metricScope":"staff"}','en');
SELECT public.supervisor_transition_proposal(
 :'business'::uuid,:'owner'::uuid,:'send_id'::uuid,1,'approve',NULL);
SELECT public.supervisor_commit_staff_proposal(
 :'business'::uuid,:'owner'::uuid,:'thread_id'::uuid,:'send_id'::uuid,2);
DO $snapshot$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.staff_schedule_handoff_snapshots
  WHERE proposal_id=(SELECT id FROM public.supervisor_proposals WHERE effect_hash=repeat('f',64)))
 THEN RAISE EXCEPTION 'approved schedule missing immutable snapshot'; END IF;
END $snapshot$;
UPDATE public.scheduled_shifts SET start_local='09:00',updated_at=now()
 WHERE business_id=:'business' AND employee_id=:'employee_id'
 AND local_date=:'target_monday'::date;
DO $stale$
DECLARE blocked boolean:=false;
BEGIN
 BEGIN
  PERFORM public.staff_mark_owner_delivery(
    current_setting('test.approval.business')::uuid,
    (SELECT owner_user_id FROM public.supervisor_proposals WHERE effect_hash=repeat('f',64)),
    (SELECT employee_id FROM public.scheduled_shifts
     WHERE business_id=current_setting('test.approval.business')::uuid
      AND local_date=(SELECT week_start FROM public.staff_schedule_handoff_snapshots
       WHERE proposal_id=(SELECT id FROM public.supervisor_proposals WHERE effect_hash=repeat('f',64))) LIMIT 1),
    'whatsapp','+14155550123',
    (SELECT id FROM public.supervisor_proposals WHERE effect_hash=repeat('f',64)),NULL);
 EXCEPTION WHEN SQLSTATE 'P0001' THEN blocked:=true;
 END;
 IF NOT blocked OR EXISTS(SELECT 1 FROM public.staff_schedule_deliveries
    WHERE business_id=current_setting('test.approval.business')::uuid
      AND status='sent_by_owner')
 THEN RAISE EXCEPTION 'modified schedule allowed owner handoff'; END IF;
END $stale$;


-- A changed recipient is NOT allowed, even with an otherwise unchanged roster.
UPDATE public.scheduled_shifts SET start_local='08:00',updated_at=now()
 WHERE business_id=:'business' AND employee_id=:'employee_id'
 AND local_date=:'target_monday'::date;
UPDATE public.employees SET phone_e164='+14155550124'
 WHERE business_id=:'business' AND id=:'employee_id';
DO $changedphone$
DECLARE rejected boolean:=false;
BEGIN
 BEGIN
  PERFORM public.staff_mark_owner_delivery(
    current_setting('test.approval.business')::uuid,
    (SELECT owner_user_id FROM public.supervisor_proposals WHERE effect_hash=repeat('f',64)),
    (SELECT employee_id FROM public.scheduled_shifts
      WHERE proposal_id IS NULL AND local_date=(
        SELECT week_start FROM public.staff_schedule_handoff_snapshots
        WHERE proposal_id=(SELECT id FROM public.supervisor_proposals WHERE effect_hash=repeat('f',64)))
        LIMIT 1),
    'sms','+14155550123',
    (SELECT id FROM public.supervisor_proposals WHERE effect_hash=repeat('f',64)),NULL);
 EXCEPTION WHEN SQLSTATE 'P0001' THEN rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'old phone was accepted'; END IF;
END $changedphone$;

-- An unchanged phone and roster may record one OWNER-OPENED handoff; a second
-- click is idempotent and cannot duplicate or change the audit.
UPDATE public.employees SET phone_e164='+14155550123'
 WHERE business_id=:'business' AND id=:'employee_id';
SELECT public.staff_mark_owner_delivery(
 :'business'::uuid,:'owner'::uuid,:'employee_id'::uuid,'sms','+14155550123',
 :'send_id'::uuid,NULL);
DO $ledger$
DECLARE replay jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.staff_schedule_deliveries
   WHERE business_id=current_setting('test.approval.business')::uuid
     AND proposal_id=(SELECT id FROM public.supervisor_proposals WHERE effect_hash=repeat('f',64))
     AND status='sent_by_owner' AND channel='sms' AND sent_at IS NOT NULL
     AND sent_by=(SELECT owner_user_id FROM public.supervisor_proposals WHERE effect_hash=repeat('f',64)))
 THEN RAISE EXCEPTION 'owner handoff ledger missing actor, channel or time'; END IF;
 replay:=public.staff_mark_owner_delivery(
  current_setting('test.approval.business')::uuid,
  (SELECT owner_user_id FROM public.supervisor_proposals WHERE effect_hash=repeat('f',64)),
  (SELECT employee_id FROM public.staff_schedule_deliveries
    WHERE proposal_id=(SELECT id FROM public.supervisor_proposals WHERE effect_hash=repeat('f',64)) LIMIT 1),
  'sms','+14155550123',
  (SELECT id FROM public.supervisor_proposals WHERE effect_hash=repeat('f',64)),NULL);
 IF replay->>'state'<>'already_opened'
 OR (SELECT count(*) FROM public.staff_schedule_deliveries WHERE
      proposal_id=(SELECT id FROM public.supervisor_proposals WHERE effect_hash=repeat('f',64)))<>1
 THEN RAISE EXCEPTION 'owner handoff replay was not idempotent'; END IF;
END $ledger$;

-- Replacement is authoritative across BOTH previously attested source types.
SELECT gen_random_uuid() AS override_id,gen_random_uuid() AS dayoff_id \gset
SELECT set_config('request.jwt.claim.sub',:'owner',true);
INSERT INTO public.staff_availability_rules(
 business_id,employee_id,day_of_week,start_local,end_local,overnight,
 effective_from,source,confirmation)
VALUES(:'business',:'employee_id',2,'09:00','17:00',false,
 :'target_monday'::date-8,'worker_reported_by_owner','owner_confirmed');
SELECT public.supervisor_staff_source_token(:'business'::uuid) AS token \gset
INSERT INTO public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,
 capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale)
VALUES(:'override_id',:'business',:'owner',:'thread_id',gen_random_uuid(),
 'olivia.staff_propose_availability_change.v1',1,
 jsonb_build_object('operation','propose_availability_change','expectedToken',:'token',
  'preview',jsonb_build_array(jsonb_build_object('label','Tester','before','Tue','after','Mon')),
  'payload',jsonb_build_object('employee_id',:'employee_id',
   'availability',jsonb_build_array(jsonb_build_object('day',1,'start','08:00','end','12:00')),
   'off_dates','[]'::jsonb,'effective_from',:'target_monday')),
 repeat('1',64),'{}','{"durationDays":1,"metricScope":"staff"}','en');
SELECT public.supervisor_transition_proposal(
 :'business'::uuid,:'owner'::uuid,:'override_id'::uuid,1,'approve',NULL);
SELECT public.supervisor_commit_staff_proposal(
 :'business'::uuid,:'owner'::uuid,:'thread_id'::uuid,:'override_id'::uuid,2);
DO $supersede$
BEGIN
 IF EXISTS(SELECT 1 FROM public.staff_availability_rules
  WHERE business_id=current_setting('test.approval.business')::uuid
   AND source='worker_reported_by_owner' AND day_of_week=2
   AND (effective_to IS NULL OR effective_to >=
     (SELECT (canonical_effect_payload->'payload'->>'effective_from')::date
      FROM public.supervisor_proposals WHERE effect_hash=repeat('1',64))))
 OR NOT EXISTS(SELECT 1 FROM public.staff_availability_rules
  WHERE business_id=current_setting('test.approval.business')::uuid
   AND source='owner_direct' AND day_of_week=1 AND start_local='08:00'::time
   AND effective_from=(SELECT (canonical_effect_payload->'payload'->>'effective_from')::date
    FROM public.supervisor_proposals WHERE effect_hash=repeat('1',64)))
 THEN RAISE EXCEPTION 'recurring replacement did not supersede worker-reported hours'; END IF;
END $supersede$;

-- An approved full day off replaces partial and unconfirmed absences (including
-- worker-reported exceptions), but never creates two confirmed closures.
INSERT INTO public.staff_availability_exceptions(
 business_id,employee_id,local_date,exception_type,start_local,end_local,overnight,
 source,confirmation)
VALUES
 (:'business',:'employee_id',:'target_monday'::date+2,'unavailable',
   '11:00','13:00',false,'owner_direct','owner_confirmed'),
 (:'business',:'employee_id',:'target_monday'::date+2,'unavailable',
   '14:00','15:00',false,'worker_reported_by_owner','unconfirmed');
SELECT public.supervisor_staff_source_token(:'business'::uuid) AS token \gset
INSERT INTO public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,
 capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale)
VALUES(:'dayoff_id',:'business',:'owner',:'thread_id',gen_random_uuid(),
 'olivia.staff_propose_availability_change.v1',1,
 jsonb_build_object('operation','propose_availability_change','expectedToken',:'token',
  'preview',jsonb_build_array(jsonb_build_object('label','Tester','before','Partial','after','Off all day')),
  'payload',jsonb_build_object('employee_id',:'employee_id','availability','[]'::jsonb,
   'off_dates',jsonb_build_array((:'target_monday'::date+2)::text),
   'effective_from',:'target_monday')),
 repeat('2',64),'{}','{"durationDays":1,"metricScope":"staff"}','en');
SELECT public.supervisor_transition_proposal(
 :'business'::uuid,:'owner'::uuid,:'dayoff_id'::uuid,1,'approve',NULL);
SELECT public.supervisor_commit_staff_proposal(
 :'business'::uuid,:'owner'::uuid,:'thread_id'::uuid,:'dayoff_id'::uuid,2);
DO $fullabsence$
BEGIN
 IF (SELECT count(*) FROM public.staff_availability_exceptions
   WHERE business_id=current_setting('test.approval.business')::uuid
    AND local_date=(SELECT ((canonical_effect_payload->'payload'->'off_dates'->>0)::date)
     FROM public.supervisor_proposals WHERE effect_hash=repeat('2',64))
    AND exception_type='unavailable')<>1
 OR NOT EXISTS(SELECT 1 FROM public.staff_availability_exceptions
   WHERE business_id=current_setting('test.approval.business')::uuid
    AND local_date=(SELECT ((canonical_effect_payload->'payload'->'off_dates'->>0)::date)
     FROM public.supervisor_proposals WHERE effect_hash=repeat('2',64))
    AND start_local IS NULL AND end_local IS NULL
    AND confirmation='owner_confirmed' AND confirmed_by=
     (SELECT owner_user_id FROM public.supervisor_proposals WHERE effect_hash=repeat('2',64)))
 THEN RAISE EXCEPTION 'approved day off did not supersede partial or unconfirmed windows'; END IF;
END $fullabsence$;
ROLLBACK;
