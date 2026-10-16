\set ON_ERROR_STOP on
-- Disposable-only Olivia PR3 transactional approval/publication acceptance test.
-- Runs inside one transaction, rolls back ALL fixtures, never touches production.
BEGIN;
SELECT gen_random_uuid() AS business,gen_random_uuid() AS owner,
  gen_random_uuid() AS manager,gen_random_uuid() AS employee,
  gen_random_uuid() AS location \gset
INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
VALUES
 (:'owner','00000000-0000-0000-0000-000000000000','authenticated','authenticated','olivia3-owner@example.invalid','',now(),now()),
 (:'manager','00000000-0000-0000-0000-000000000000','authenticated','authenticated','olivia3-manager@example.invalid','',now(),now());
INSERT INTO public.businesses(id,name,is_demo,timezone)
VALUES(:'business','Olivia PR3 disposable',false,'America/Los_Angeles');
INSERT INTO public.memberships(business_id,user_id,role)
VALUES(:'business',:'owner','owner'),(:'business',:'manager','manager');
INSERT INTO public.locations(id,business_id,name,timezone)
VALUES(:'location',:'business','Test café','America/Los_Angeles');
INSERT INTO public.employees(id,business_id,display_name,active)
VALUES(:'employee',:'business','Disposable worker',true);
INSERT INTO public.scheduling_labor_rule_reviews
 (business_id,revision,profile,reviewed_by)
VALUES(:'business',1,
 jsonb_build_object('verified',true,'source','Reviewed disposable fixture only',
   'minRestBetweenShiftsMinutes',600,'overtime',jsonb_build_object('verified',true),
   'jurisdictionByLocationId',jsonb_build_object(:'location','Test region'),
   'classificationByEmployeeId',jsonb_build_object(:'employee','Test employee')),
 :'owner');
SELECT public.scheduling_pr3_source_token_internal(:'business'::uuid) AS token \gset
-- Independent Monday week 1, near the next-week boundary in café-local time.
INSERT INTO public.scheduling_plan_series
 (business_id,horizon_start,created_by)
VALUES(:'business','2099-01-05',:'owner') RETURNING id AS series1 \gset
INSERT INTO public.scheduling_plan_revisions
 (business_id,series_id,revision,source_digest,planner_input,scenario,created_by)
VALUES(:'business',:'series1',1,repeat('a',64),
 '{"horizonStart":"2099-01-05"}'::jsonb,
 '{"objective":"balanced","completeCoverage":true,"hardConstraintsSatisfied":true,"legalReview":"verified_profile","shifts":[]}'::jsonb,
 :'owner') RETURNING id AS revision1 \gset
UPDATE public.scheduling_plan_series SET current_revision=1 WHERE id=:'series1';
INSERT INTO public.scheduling_plan_assignments
 (business_id,plan_revision_id,employee_id,location_id,
  starts_at,ends_at,paid_minutes,breaks,pinned)
VALUES(:'business',:'revision1',:'employee',:'location',
 '2099-01-12T07:00:00Z','2099-01-12T09:00:00Z',120,'[]',false);
-- Future week 2 assignment starts six hours after last week's shift ends,
-- violating the ten-hour owner-reviewed rest minimum without overlapping.
INSERT INTO public.scheduling_plan_series
 (business_id,horizon_start,created_by)
VALUES(:'business','2099-01-12',:'owner') RETURNING id AS series2 \gset
INSERT INTO public.scheduling_plan_revisions
 (business_id,series_id,revision,source_digest,planner_input,scenario,created_by)
VALUES(:'business',:'series2',1,repeat('a',64),
 '{"horizonStart":"2099-01-12"}'::jsonb,
 '{"objective":"balanced","completeCoverage":true,"hardConstraintsSatisfied":true,"legalReview":"verified_profile","shifts":[]}'::jsonb,
 :'owner') RETURNING id AS revision2 \gset
UPDATE public.scheduling_plan_series SET current_revision=1 WHERE id=:'series2';
INSERT INTO public.scheduling_plan_assignments
 (business_id,plan_revision_id,employee_id,location_id,
  starts_at,ends_at,paid_minutes,breaks,pinned)
VALUES(:'business',:'revision2',:'employee',:'location',
 '2099-01-12T15:00:00Z','2099-01-12T17:00:00Z',120,'[]',false);
-- Authenticated owners cannot call privileged approval/publication RPCs
-- or write directly, even after we have committed a draft.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'owner',true);
DO $$
BEGIN
  BEGIN
    PERFORM public.scheduling_pr3_approve(
      current_setting('test.olivia3_biz',true)::uuid,gen_random_uuid(),
      gen_random_uuid(),1,repeat('a',64),repeat('b',32),gen_random_uuid());
    RAISE EXCEPTION 'authenticated client invoked service-only approval';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
-- Capture test UUIDs for inside-DO assertions.
SELECT set_config('test.olivia3_biz',:'business',true);
SELECT set_config('test.olivia3_owner',:'owner',true);
SELECT set_config('test.olivia3_manager',:'manager',true);
SELECT set_config('test.olivia3_r1',:'revision1',true);
SELECT set_config('test.olivia3_r2',:'revision2',true);
SELECT set_config('test.olivia3_s1',:'series1',true);
SELECT set_config('test.olivia3_s2',:'series2',true);
SELECT set_config('test.olivia3_token',:'token',true);
DO $$
DECLARE
 b uuid:=current_setting('test.olivia3_biz')::uuid;
 actor uuid:=current_setting('test.olivia3_owner')::uuid;
 manager uuid:=current_setting('test.olivia3_manager')::uuid;
 r1 uuid:=current_setting('test.olivia3_r1')::uuid;
 r2 uuid:=current_setting('test.olivia3_r2')::uuid;
 source text:=current_setting('test.olivia3_token');
 response jsonb;
BEGIN
  SELECT public.scheduling_pr3_approve(b,manager,r1,1,repeat('a',64),source,
    gen_random_uuid()) INTO response;
  IF response->>'error'<>'unauthorized' THEN
    RAISE EXCEPTION 'manager approved without owner authorization: %',response;
  END IF;
  SELECT public.scheduling_pr3_publish(b,actor,r1,1,repeat('a',64),source,
    gen_random_uuid()) INTO response;
  IF response->>'error'<>'not_approved' THEN
    RAISE EXCEPTION 'published unapproved revision: %',response;
  END IF;
  SELECT public.scheduling_pr3_approve(b,actor,r1,1,repeat('a',64),source,
    gen_random_uuid()) INTO response;
  IF response->>'status'<>'approved' THEN
    RAISE EXCEPTION 'owner approval failed: %',response;
  END IF;
  SELECT public.scheduling_pr3_publish(b,actor,r1,1,repeat('a',64),source,
    gen_random_uuid()) INTO response;
  IF response->>'status'<>'published' OR response->>'replayed'<>'false' THEN
    RAISE EXCEPTION 'owner publication failed: %',response;
  END IF;
  SELECT public.scheduling_pr3_publish(b,actor,r1,1,repeat('a',64),source,
    gen_random_uuid()) INTO response;
  IF response->>'status'<>'published' OR response->>'replayed'<>'true' THEN
    RAISE EXCEPTION 'different-key repeated publication duplicated effect: %',response;
  END IF;
  IF (SELECT count(*) FROM public.scheduling_plan_audit
      WHERE business_id=b AND revision_id=r1 AND event='published')<>1 OR
     (SELECT published_revision FROM public.scheduling_plan_series
      WHERE id=current_setting('test.olivia3_s1')::uuid)<>1 THEN
    RAISE EXCEPTION 'publication pointer or audit was not exactly once';
  END IF;
  SELECT public.scheduling_pr3_approve(b,actor,r2,1,repeat('a',64),source,
    gen_random_uuid()) INTO response;
  IF response->>'status'<>'approved' THEN
    RAISE EXCEPTION 'second week approval failed: %',response;
  END IF;
  SELECT public.scheduling_pr3_publish(b,actor,r2,1,repeat('a',64),source,
    gen_random_uuid()) INTO response;
  IF response->>'error'<>'published_overlap' THEN
    RAISE EXCEPTION 'cross-week required rest was not enforced: %',response;
  END IF;
  IF (SELECT published_revision FROM public.scheduling_plan_series
      WHERE id=current_setting('test.olivia3_s2')::uuid) IS NOT NULL OR
     (SELECT count(*) FROM public.timecards WHERE business_id=b)<>0 OR
     (SELECT count(*) FROM public.staff_schedules WHERE business_id=b)<>0 THEN
    RAISE EXCEPTION 'blocked publication altered official pointers, attendance or legacy assignments';
  END IF;
END $$;
-- Republish after a shift has started: identical historical commitments survive,
-- future edits may proceed, but dropping or rewriting old planned shifts is denied.
INSERT INTO public.scheduling_plan_series
 (business_id,horizon_start,current_revision,published_revision,created_by)
VALUES(:'business','2020-01-06',2,1,:'owner') RETURNING id AS series3 \gset
INSERT INTO public.scheduling_plan_revisions
 (business_id,series_id,revision,status,source_digest,planner_input,scenario,
  created_by,approved_by,approved_at,published_by,published_at)
VALUES(:'business',:'series3',1,'published',repeat('a',64),
 '{"horizonStart":"2020-01-06"}',
 '{"objective":"balanced","completeCoverage":true,"hardConstraintsSatisfied":true,"legalReview":"verified_profile","shifts":[]}',
 :'owner',:'owner',now(),:'owner',now()) RETURNING id AS old3 \gset
INSERT INTO public.scheduling_plan_revisions
 (business_id,series_id,revision,status,source_digest,planner_input,scenario,
  created_by,approved_by,approved_at)
VALUES(:'business',:'series3',2,'approved',repeat('a',64),
 '{"horizonStart":"2020-01-06"}',
 '{"objective":"balanced","completeCoverage":true,"hardConstraintsSatisfied":true,"legalReview":"verified_profile","shifts":[]}',
 :'owner',:'owner',now()) RETURNING id AS new3 \gset
INSERT INTO public.scheduling_plan_assignments
 (business_id,plan_revision_id,employee_id,location_id,
  starts_at,ends_at,paid_minutes,breaks,pinned)
VALUES
 (:'business',:'old3',:'employee',:'location',
  '2020-01-07T09:00:00Z','2020-01-07T11:00:00Z',120,'[]',false),
 (:'business',:'new3',:'employee',:'location',
  '2020-01-07T09:00:00Z','2020-01-07T11:00:00Z',120,'[]',false);
SELECT set_config('test.olivia3_s3',:'series3',true);
SELECT set_config('test.olivia3_old3',:'old3',true);
SELECT set_config('test.olivia3_new3',:'new3',true);
DO $$
DECLARE
 b uuid:=current_setting('test.olivia3_biz')::uuid;
 actor uuid:=current_setting('test.olivia3_owner')::uuid;
 token text:=current_setting('test.olivia3_token');
 response jsonb;
BEGIN
 SELECT public.scheduling_pr3_publish(b,actor,
  current_setting('test.olivia3_new3')::uuid,2,repeat('a',64),token,
  gen_random_uuid()) INTO response;
 IF response->>'status'<>'published' THEN
   RAISE EXCEPTION 'republishing unchanged started shifts failed: %',response;
 END IF;
 IF (SELECT published_revision FROM public.scheduling_plan_series
    WHERE id=current_setting('test.olivia3_s3')::uuid)<>2 OR
    (SELECT status FROM public.scheduling_plan_revisions
    WHERE id=current_setting('test.olivia3_old3')::uuid)<>'superseded' THEN
   RAISE EXCEPTION 'republish did not atomically supersede prior official version';
 END IF;
END $$;
INSERT INTO public.scheduling_plan_revisions
 (business_id,series_id,revision,status,source_digest,planner_input,scenario,
  created_by,approved_by,approved_at)
VALUES(:'business',:'series3',3,'approved',repeat('a',64),
 '{"horizonStart":"2020-01-06"}',
 '{"objective":"balanced","completeCoverage":true,"hardConstraintsSatisfied":true,"legalReview":"verified_profile","shifts":[]}',
 :'owner',:'owner',now()) RETURNING id AS removed3 \gset
UPDATE public.scheduling_plan_series SET current_revision=3 WHERE id=:'series3';
SELECT set_config('test.olivia3_removed3',:'removed3',true);
DO $$
DECLARE
 b uuid:=current_setting('test.olivia3_biz')::uuid;
 actor uuid:=current_setting('test.olivia3_owner')::uuid;
 response jsonb;
BEGIN
 SELECT public.scheduling_pr3_publish(b,actor,
   current_setting('test.olivia3_removed3')::uuid,3,repeat('a',64),
   current_setting('test.olivia3_token'),gen_random_uuid()) INTO response;
 IF response->>'error'<>'past_shift' THEN
   RAISE EXCEPTION 'republishing deleted already-started planned shift: %',response;
 END IF;
 IF (SELECT published_revision FROM public.scheduling_plan_series
    WHERE id=current_setting('test.olivia3_s3')::uuid)<>2
    THEN RAISE EXCEPTION 'rejected edit changed official version'; END IF;
END $$;
-- Version 501 must be forbidden by the database, not merely by UI forms.
DO $$
DECLARE
  blocked_series boolean:=false;
  blocked_revision boolean:=false;
BEGIN
  BEGIN
    UPDATE public.scheduling_plan_series SET current_revision=501
      WHERE id=current_setting('test.olivia3_s3')::uuid;
  EXCEPTION WHEN check_violation THEN blocked_series:=true;
  END;
  BEGIN
    UPDATE public.scheduling_plan_revisions SET revision=501
      WHERE id=current_setting('test.olivia3_removed3')::uuid;
  EXCEPTION WHEN check_violation THEN blocked_revision:=true;
  END;
  IF NOT blocked_series OR NOT blocked_revision THEN
    RAISE EXCEPTION 'Olivia revision cap not enforced in PostgreSQL';
  END IF;
END $$;
-- A legacy recurring commitment stays authoritative for predicted timecards.
-- Olivia must refuse a second official plan without changing that source or
-- creating attendance, even if the proposed shift happens at another hour.
INSERT INTO public.staff_schedules
 (business_id,employee_id,day_of_week,start_time,end_time,
  hourly_wage_cents,effective_from,effective_to,active)
VALUES(:'business',:'employee',1,'08:00','12:00',1800,
 '2099-02-01','2099-02-07',true) RETURNING id AS legacy_schedule \gset
INSERT INTO public.scheduling_plan_series
 (business_id,horizon_start,current_revision,created_by)
VALUES(:'business','2099-02-02',1,:'owner') RETURNING id AS legacy_series \gset
INSERT INTO public.scheduling_plan_revisions
 (business_id,series_id,revision,status,source_digest,planner_input,scenario,
  created_by,approved_by,approved_at)
VALUES(:'business',:'legacy_series',1,'approved',repeat('a',64),
 '{"horizonStart":"2099-02-02"}',
 '{"objective":"balanced","completeCoverage":true,"hardConstraintsSatisfied":true,"legalReview":"verified_profile","shifts":[]}',
 :'owner',:'owner',now()) RETURNING id AS legacy_revision \gset
INSERT INTO public.scheduling_plan_assignments
 (business_id,plan_revision_id,employee_id,location_id,
  starts_at,ends_at,paid_minutes,breaks,pinned)
VALUES(:'business',:'legacy_revision',:'employee',:'location',
 '2099-02-02T20:00:00Z','2099-02-02T22:00:00Z',120,'[]',false);
SELECT set_config('test.olivia3_legacy_series',:'legacy_series',true);
SELECT set_config('test.olivia3_legacy_revision',:'legacy_revision',true);
SELECT set_config('test.olivia3_legacy_schedule',:'legacy_schedule',true);
DO $$
DECLARE
 b uuid:=current_setting('test.olivia3_biz')::uuid;
 actor uuid:=current_setting('test.olivia3_owner')::uuid;
 r uuid:=current_setting('test.olivia3_legacy_revision')::uuid;
 original_token text:=current_setting('test.olivia3_token');
 fresh_token text;
 response jsonb;
BEGIN
 SELECT public.scheduling_pr3_source_token_internal(b) INTO fresh_token;
 IF fresh_token=original_token THEN
   RAISE EXCEPTION 'legacy scheduling source change was not fingerprinted';
 END IF;
 SELECT public.scheduling_pr3_publish(b,actor,r,1,repeat('a',64),
   original_token,gen_random_uuid()) INTO response;
 IF response->>'error'<>'source_changed' THEN
   RAISE EXCEPTION 'stale token bypassed legacy source change: %',response;
 END IF;
 SELECT public.scheduling_pr3_publish(b,actor,r,1,repeat('a',64),
   fresh_token,gen_random_uuid()) INTO response;
 IF response->>'error'<>'legacy_conflict' THEN
   RAISE EXCEPTION 'legacy recurring schedule publication was not blocked: %',response;
 END IF;
 IF (SELECT published_revision FROM public.scheduling_plan_series
      WHERE id=current_setting('test.olivia3_legacy_series')::uuid) IS NOT NULL
    OR (SELECT count(*) FROM public.staff_schedules
      WHERE id=current_setting('test.olivia3_legacy_schedule')::uuid)<>1
    OR (SELECT count(*) FROM public.timecards WHERE business_id=b)<>0
    OR (SELECT count(*) FROM public.scheduling_plan_audit
      WHERE business_id=b AND revision_id=r AND event='published')<>0 THEN
   RAISE EXCEPTION 'legacy publication blocker mutated schedule or attendance';
 END IF;
END $$;
ROLLBACK;
\echo Olivia PR3 disposable approval/publication/RLS tests passed
