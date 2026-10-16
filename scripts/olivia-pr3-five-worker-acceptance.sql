\set ON_ERROR_STOP on
-- Olivia PR89: disposable five-worker owner workflow/database safety acceptance.
-- Service-level policy checks are tested separately in Vitest; this checks
-- actual PostgreSQL persistence/RLS/transitions and financial non-mutation.
-- Never point this script at staging or production. It rolls back all fixtures.
BEGIN;
DO $$
DECLARE
 b uuid:=gen_random_uuid();
 actor uuid:=gen_random_uuid();
 stranger uuid:=gen_random_uuid();
 loc_a uuid:=gen_random_uuid();
 loc_b uuid:=gen_random_uuid();
 staff uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),
                       gen_random_uuid(),gen_random_uuid()];
 one uuid;
 shifts jsonb;
 scenario jsonb;
 planner jsonb;
 response jsonb;
 rev1 uuid;
 rev2 uuid;
 plan_series uuid;
 token text;
 source_digest text:=repeat('a',64);
 snapshot jsonb;
 current_snapshot jsonb;
 i integer;
BEGIN
 INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
 VALUES(actor,'00000000-0000-0000-0000-000000000000','authenticated',
        'authenticated','olivia89-owner@example.invalid','',now(),now()),
       (stranger,'00000000-0000-0000-0000-000000000000','authenticated',
        'authenticated','olivia89-stranger@example.invalid','',now(),now());
 INSERT INTO public.businesses(id,name,is_demo,timezone)
   VALUES(b,'Olivia five-worker disposable acceptance',false,'America/Los_Angeles');
 INSERT INTO public.memberships(business_id,user_id,role)
   VALUES(b,actor,'owner'),(b,stranger,'manager');
 INSERT INTO public.locations(id,business_id,name,timezone)
   VALUES(loc_a,b,'Morning cafe','America/Los_Angeles'),
         (loc_b,b,'Evening cafe','America/Los_Angeles');
 FOR i IN 1..5 LOOP
   one:=staff[i];
   INSERT INTO public.employees
     (id,business_id,display_name,active,wage_period,wage_amount_cents,
      default_hourly_wage_cents)
   VALUES(one,b,'Olivia fixture employee '||i,true,'hour',
          CASE WHEN i=5 THEN NULL ELSE 2000+i*100 END,
          CASE WHEN i=5 THEN NULL ELSE 2000+i*100 END);
   INSERT INTO public.staff_availability_rules
     (business_id,employee_id,day_of_week,start_local,end_local,overnight,
      effective_from,source,confirmation,confirmed_at,confirmed_by)
   VALUES(b,one,CASE WHEN i=1 THEN 1 ELSE 2 END,'08:00','17:00',false,
          '2099-04-06','owner_direct','owner_confirmed',now(),actor);
   INSERT INTO public.staff_scheduling_preferences
     (business_id,employee_id,effective_from,min_weekly_minutes,
      desired_weekly_minutes,max_weekly_minutes,max_daily_minutes,
      source,confirmation,confirmed_at,confirmed_by)
   VALUES(b,one,'2099-04-06',0,240,1200,480,
          'owner_direct','owner_confirmed',now(),actor);
   INSERT INTO public.staff_scheduling_compensation
     (business_id,employee_id,cash_cost_state)
   VALUES(b,one,CASE WHEN i=5 THEN 'unknown' ELSE 'known_paid' END);
 END LOOP;
 INSERT INTO public.staff_availability_exceptions
   (business_id,employee_id,local_date,exception_type,source,
    confirmation,confirmed_at,confirmed_by)
 VALUES(b,staff[5],'2099-04-09','approved_leave','owner_direct',
        'owner_confirmed',now(),actor);
 INSERT INTO public.scheduling_qualification_types
   (business_id,code,display_name,active)
 VALUES(b,'opener','Opener',true),(b,'closer','Closer',true);
 INSERT INTO public.staff_qualifications
   (business_id,employee_id,location_id,qualification_code,valid_from,
    source,confirmation,confirmed_at,confirmed_by)
 VALUES(b,staff[1],loc_a,'opener','2099-04-06',
        'owner_direct','owner_confirmed',now(),actor),
       (b,staff[2],loc_b,'closer','2099-04-06',
        'owner_direct','owner_confirmed',now(),actor);
 INSERT INTO public.scheduling_coverage_requirements
   (business_id,location_id,day_of_week,effective_from,start_local,end_local,
    min_headcount,qualification_code,priority,source,confirmation,
    confirmed_at,confirmed_by)
 VALUES(b,loc_a,1,'2099-04-06','09:00','11:00',1,'opener','required',
        'owner_direct','owner_confirmed',now(),actor),
       (b,loc_b,2,'2099-04-06','15:00','17:00',1,'closer','required',
        'owner_direct','owner_confirmed',now(),actor);
 INSERT INTO public.scheduling_labor_rule_reviews
   (business_id,revision,profile,reviewed_by)
 VALUES(b,1,jsonb_build_object(
    'verified',true,'source','Five-worker reviewed disposable test profile',
    'minRestBetweenShiftsMinutes',600,
    'overtime',jsonb_build_object('verified',true),
    'jurisdictionByLocationId',jsonb_build_object(loc_a::text,'Test region',
                                                    loc_b::text,'Test region'),
    'classificationByEmployeeId',jsonb_build_object(
      staff[1]::text,'Hourly',staff[2]::text,'Hourly',
      staff[3]::text,'Hourly',staff[4]::text,'Hourly',
      staff[5]::text,'Unknown rate')),actor);
 -- Historical actual labor is independent of Olivia's schedule pointers.
 INSERT INTO public.timecards(business_id,employee_id,pos_timecard_id,
    clock_in,clock_out,hourly_wage_cents,breaks,source_type,source_provider)
 VALUES(b,staff[1],'csv-olivia89-actual',
        '2099-04-01T16:00:00Z','2099-04-01T20:00:00Z',2100,'[]'::jsonb,
        'imported','CSV');
 SELECT jsonb_build_object(
   'actualTimecards',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id)
     FROM public.timecards t WHERE business_id=b),
   'employeeWages',(SELECT jsonb_agg(jsonb_build_object(
      'employee',e.id,'wage',e.wage_amount_cents,
      'default',e.default_hourly_wage_cents) ORDER BY e.id)
      FROM public.employees e WHERE business_id=b),
   'cashWageBaseline',(SELECT sum(hourly_wage_cents) FROM public.timecards
     WHERE business_id=b))
 INTO snapshot;
 IF (SELECT count(*) FROM public.employees WHERE business_id=b)<>5
    OR (SELECT count(*) FROM public.staff_availability_rules WHERE business_id=b)<>5
    OR (SELECT count(*) FROM public.staff_scheduling_preferences WHERE business_id=b)<>5
    OR (SELECT count(*) FROM public.scheduling_coverage_requirements WHERE business_id=b)<>2
    OR (SELECT count(*) FROM public.staff_availability_exceptions
        WHERE business_id=b AND exception_type='approved_leave')<>1
    OR (SELECT cash_cost_state FROM public.staff_scheduling_compensation
      WHERE business_id=b AND employee_id=staff[5])<>'unknown' THEN
   RAISE EXCEPTION 'five-worker source fixture missing confirmed or unknown facts';
 END IF;
 SELECT public.scheduling_pr3_source_token_internal(b) INTO token;
 PERFORM set_config('request.jwt.claim.sub', actor::text, true);
 planner:=jsonb_build_object('horizonStart','2099-04-06','employees',to_jsonb(staff));
 shifts:=jsonb_build_array(
    jsonb_build_object('employeeId',staff[1],'locationId',loc_a,
      'startAt','2099-04-06T16:00:00Z','endAt','2099-04-06T18:00:00Z',
      'paidMinutes',120,'breaks','[]'::jsonb,'pinned',false),
    jsonb_build_object('employeeId',staff[2],'locationId',loc_b,
      'startAt','2099-04-07T22:00:00Z','endAt','2099-04-08T00:00:00Z',
      'paidMinutes',120,'breaks','[]'::jsonb,'pinned',false));
 scenario:=jsonb_build_object('objective','balanced','shifts',shifts,
    'completeCoverage',true,'hardConstraintsSatisfied',true,
    'legalReview','verified_profile');
 SELECT public.scheduling_create_plan_draft(b,'2099-04-06',0,
    source_digest,planner,scenario,shifts,gen_random_uuid()) INTO response;
 IF response->>'revision'<>'1' THEN
   RAISE EXCEPTION 'authenticated owner did not save first draft: %',response;
 END IF;
 rev1:=(response->>'revisionId')::uuid;
 plan_series:=(response->>'seriesId')::uuid;
 -- A manager cannot create a different owner schedule.
 PERFORM set_config('request.jwt.claim.sub',stranger::text,true);
 BEGIN
   PERFORM public.scheduling_create_plan_draft(b,'2099-04-06',1,
     source_digest,planner,scenario,shifts,gen_random_uuid());
   RAISE EXCEPTION 'manager created an owner-only Olivia draft';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 SELECT public.scheduling_pr3_publish(b,actor,rev1,1,
    source_digest,token,gen_random_uuid()) INTO response;
 IF response->>'error'<>'not_approved' THEN
   RAISE EXCEPTION 'draft published without owner approval: %',response;
 END IF;
 SELECT public.scheduling_pr3_approve(b,actor,rev1,1,
    source_digest,token,gen_random_uuid()) INTO response;
 IF response->>'status'<>'approved' THEN
   RAISE EXCEPTION 'owner approval denied: %',response;
 END IF;
 SELECT public.scheduling_pr3_publish(b,actor,rev1,1,
    source_digest,token,gen_random_uuid()) INTO response;
 IF response->>'status'<>'published' THEN
   RAISE EXCEPTION 'first owner publication failed: %',response;
 END IF;
 -- A draft revision is immutable: a second version must be a separate row.
 shifts:=jsonb_build_array(
    jsonb_build_object('employeeId',staff[1],'locationId',loc_a,
      'startAt','2099-04-06T16:30:00Z','endAt','2099-04-06T18:30:00Z',
      'paidMinutes',120,'breaks','[]'::jsonb,'pinned',false),
    jsonb_build_object('employeeId',staff[2],'locationId',loc_b,
      'startAt','2099-04-07T22:00:00Z','endAt','2099-04-08T00:00:00Z',
      'paidMinutes',120,'breaks','[]'::jsonb,'pinned',false));
 scenario:=jsonb_set(scenario,'{shifts}',shifts);
 SELECT public.scheduling_create_plan_draft(b,'2099-04-06',1,
    source_digest,planner,scenario,shifts,gen_random_uuid()) INTO response;
 IF response->>'revision'<>'2' THEN
   RAISE EXCEPTION 'owner did not save immutable second version: %',response;
 END IF;
 rev2:=(response->>'revisionId')::uuid;
 IF rev2=rev1 OR (SELECT count(*) FROM public.scheduling_plan_assignments
      WHERE business_id=b AND plan_revision_id=rev1)<>2 THEN
   RAISE EXCEPTION 'initial published assignments overwritten';
 END IF;
 SELECT public.scheduling_pr3_approve(b,actor,rev2,2,
    source_digest,token,gen_random_uuid()) INTO response;
 IF response->>'status'<>'approved' THEN
   RAISE EXCEPTION 'revised owner approval failed: %',response;
 END IF;
 SELECT public.scheduling_pr3_publish(b,actor,rev2,2,
    source_digest,token,gen_random_uuid()) INTO response;
 IF response->>'status'<>'published' THEN
   RAISE EXCEPTION 'owner republish failed: %',response;
 END IF;
 IF (SELECT current_revision FROM public.scheduling_plan_series
       WHERE id=plan_series)<>2 OR
    (SELECT published_revision FROM public.scheduling_plan_series
       WHERE id=plan_series)<>2 OR
    (SELECT status FROM public.scheduling_plan_revisions
       WHERE id=rev1)<>'superseded' OR
    (SELECT status FROM public.scheduling_plan_revisions
       WHERE id=rev2)<>'published' OR
    (SELECT count(*) FROM public.scheduling_plan_audit
       WHERE business_id=b AND event='published')<>2 OR
    (SELECT count(*) FROM public.scheduling_plan_audit
       WHERE business_id=b AND event='superseded')<>1 THEN
   RAISE EXCEPTION 'immutable revision, pointer or publication audit inconsistent';
 END IF;
 -- Idempotent publish is a readback, not another official version.
 SELECT public.scheduling_pr3_publish(b,actor,rev2,2,
    source_digest,token,gen_random_uuid()) INTO response;
 IF response->>'replayed'<>'true' THEN
   RAISE EXCEPTION 'repeat owner publication was not idempotent: %',response;
 END IF;
 SELECT jsonb_build_object(
   'actualTimecards',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id)
     FROM public.timecards t WHERE business_id=b),
   'employeeWages',(SELECT jsonb_agg(jsonb_build_object(
      'employee',e.id,'wage',e.wage_amount_cents,
      'default',e.default_hourly_wage_cents) ORDER BY e.id)
      FROM public.employees e WHERE business_id=b),
   'cashWageBaseline',(SELECT sum(hourly_wage_cents) FROM public.timecards
     WHERE business_id=b))
 INTO current_snapshot;
 IF current_snapshot IS DISTINCT FROM snapshot OR
    (SELECT count(*) FROM public.staff_schedules WHERE business_id=b)<>0 OR
    (SELECT count(*) FROM public.timecards WHERE business_id=b)<>1 THEN
   RAISE EXCEPTION 'Olivia altered historical actual attendance, wages or legacy schedules';
 END IF;
 RAISE NOTICE 'PASS: five-worker owner draft, approval, publication, revise, republish, unknown wages, leave, qualifications, RLS and unchanged actual labor baseline';
END $$;
ROLLBACK;
\echo Olivia PR89 disposable five-worker owner database acceptance passed
