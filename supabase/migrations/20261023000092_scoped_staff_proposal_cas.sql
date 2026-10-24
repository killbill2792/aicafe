-- Service-only, stable row-scope snapshots. Legacy v1 remains café-wide.
CREATE OR REPLACE FUNCTION public.supervisor_staff_scoped_token(p_business_id uuid,p_scope jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE kind text; emp uuid; day date; week date; rule_name text;
 snapshot jsonb:='{}'::jsonb; rows jsonb;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role_only'; END IF;
 IF p_scope->>'version' IS DISTINCT FROM '2' THEN RAISE EXCEPTION 'invalid_scope_version'; END IF;
 kind:=p_scope->>'kind';
 IF kind NOT IN ('staff_change','add_staff','shift_change','schedule','send_schedule','availability','rule')
 THEN RAISE EXCEPTION 'unknown_scope'; END IF;
 IF kind IN ('staff_change','shift_change','availability') THEN
   emp:=(p_scope->>'employeeId')::uuid;
   IF emp IS NULL THEN RAISE EXCEPTION 'missing_employee'; END IF;
 END IF;
 IF kind IN ('schedule','send_schedule') THEN
   week:=(p_scope->>'weekStart')::date;
   IF week IS NULL THEN RAISE EXCEPTION 'missing_week'; END IF;
 END IF;
 IF kind='shift_change' THEN
   day:=(p_scope->>'date')::date;
   IF day IS NULL THEN RAISE EXCEPTION 'missing_date'; END IF;
 END IF;
 IF kind='rule' THEN
   rule_name:=p_scope->>'rule';
   IF rule_name IS NULL OR rule_name !~ '^[a-z_]+$'
   THEN RAISE EXCEPTION 'invalid_rule'; END IF;
 END IF;
 IF kind IN ('staff_change','add_staff') THEN
   SELECT coalesce(jsonb_agg(lower(e.display_name) ORDER BY lower(e.display_name)),'[]'::jsonb)
   INTO rows FROM public.employees e WHERE e.business_id=p_business_id AND e.active
    AND (kind='add_staff' OR e.id<>emp);
   snapshot:=snapshot||jsonb_build_object('active_names',rows);
 END IF;
 IF kind='staff_change' THEN
   SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]'::jsonb)
   INTO rows FROM public.employees e WHERE e.business_id=p_business_id AND e.id=emp;
   snapshot:=snapshot||jsonb_build_object('employee',rows);
 ELSIF kind IN ('shift_change','availability') THEN
   SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'active',e.active) ORDER BY e.id),'[]'::jsonb)
   INTO rows FROM public.employees e WHERE e.business_id=p_business_id AND e.id=emp;
   snapshot:=snapshot||jsonb_build_object('employee',rows);
 END IF;
 IF kind='shift_change' THEN
   SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb)
   INTO rows FROM public.scheduled_shifts s WHERE s.business_id=p_business_id
    AND s.employee_id=emp AND s.deleted_at IS NULL AND s.local_date BETWEEN day-1 AND day+1;
   snapshot:=snapshot||jsonb_build_object('shifts',rows);
 ELSIF kind IN ('schedule','send_schedule') THEN
   SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb)
   INTO rows FROM public.scheduled_shifts s WHERE s.business_id=p_business_id
    AND s.deleted_at IS NULL AND s.local_date BETWEEN week AND week+6;
   snapshot:=snapshot||jsonb_build_object('shifts',rows);
   IF kind='schedule' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'active',e.active) ORDER BY e.id),'[]'::jsonb)
    INTO rows FROM public.employees e WHERE e.business_id=p_business_id AND e.id IN
      (SELECT (value #>> '{}')::uuid FROM jsonb_array_elements(coalesce(p_scope->'staffIds','[]'::jsonb)));
    snapshot:=snapshot||jsonb_build_object('employees',rows);
   END IF;
 ELSIF kind='availability' THEN
   SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb)
   INTO rows FROM public.staff_availability_rules s WHERE s.business_id=p_business_id AND s.employee_id=emp;
   snapshot:=snapshot||jsonb_build_object('availability',rows);
   SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb)
   INTO rows FROM public.staff_availability_exceptions s WHERE s.business_id=p_business_id AND s.employee_id=emp;
   snapshot:=snapshot||jsonb_build_object('exceptions',rows);
 ELSIF kind='rule' THEN
   SELECT coalesce(jsonb_agg(to_jsonb(r)->rule_name),'[]'::jsonb)
   INTO rows FROM public.team_rules r WHERE r.business_id=p_business_id;
   snapshot:=snapshot||jsonb_build_object('rule',rows);
 END IF;
 RETURN md5(jsonb_build_object('scope',p_scope,'rows',snapshot,
   'cafe_date',(now() AT TIME ZONE (SELECT timezone FROM public.businesses WHERE id=p_business_id))::date,
   'timezone',(SELECT timezone FROM public.businesses WHERE id=p_business_id))::text);
END $$;
REVOKE ALL ON FUNCTION public.supervisor_staff_scoped_token(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.supervisor_staff_scoped_token(uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.supervisor_commit_staff_proposal(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_proposal_id uuid,p_revision integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
 p public.supervisor_proposals;
 e jsonb; d jsonb; v_kind text; v_row jsonb; v_staff uuid; v_day date;
 v_week date; v_shift uuid; v_rule text; v_old int; v_actor uuid;
 v_changed integer; v_today date; v_seen text[]:='{}';
 v_bool boolean; v_number int;
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_only'; END IF;
 IF p_business_id IS NULL OR p_owner_user_id IS NULL OR p_thread_id IS NULL
   OR p_proposal_id IS NULL OR p_revision IS NULL
   OR NOT EXISTS(SELECT 1 FROM public.memberships m
       JOIN public.businesses b ON b.id=m.business_id
       WHERE m.business_id=p_business_id AND m.user_id=p_owner_user_id
        AND m.role='owner' AND b.is_demo=false)
 THEN RAISE EXCEPTION 'staff_owner_required' USING ERRCODE='42501'; END IF;
 -- Authenticated actor provenance in existing foundation triggers uses auth.uid().
 -- This transaction-local claim is installed ONLY after the service-only RPC
 -- independently verifies p_owner_user_id is an actual owner of this cafe.
 PERFORM set_config('request.jwt.claim.sub',p_owner_user_id::text,true);

 SELECT (now() AT TIME ZONE b.timezone)::date INTO v_today
   FROM public.businesses b WHERE b.id=p_business_id;
 IF v_today IS NULL THEN RAISE EXCEPTION 'cafe_timezone_missing' USING ERRCODE='22023'; END IF;
 -- Take Olivia's existing source-write advisory lock first; the table locks
 -- then serialize even writers that do not use the advisory protocol.
 PERFORM pg_advisory_xact_lock(hashtextextended('olivia-'||p_business_id::text,0));
 LOCK TABLE public.employees, public.scheduled_shifts, public.team_rules,
   public.staff_availability_rules, public.staff_availability_exceptions,
   public.staff_scheduling_preferences, public.staff_custom_rules, public.locations
   IN SHARE ROW EXCLUSIVE MODE;

 SELECT * INTO p FROM public.supervisor_proposals
  WHERE business_id=p_business_id AND owner_user_id=p_owner_user_id
   AND thread_id=p_thread_id AND id=p_proposal_id FOR UPDATE;
 IF p.id IS NULL OR p.revision<>p_revision OR p.status<>'approved'
  OR p.capability_version NOT IN (1,2) OR p.capability_id NOT IN (
   'olivia.staff_propose_schedule.v1','olivia.staff_propose_schedule.v2',
   'olivia.staff_propose_shift_change.v1','olivia.staff_propose_shift_change.v2',
   'olivia.staff_propose_add_staff.v1','olivia.staff_propose_add_staff.v2',
   'olivia.staff_propose_staff_change.v1','olivia.staff_propose_staff_change.v2',
   'olivia.staff_propose_availability_change.v1','olivia.staff_propose_availability_change.v2',
   'olivia.staff_propose_rule_change.v1','olivia.staff_propose_rule_change.v2',
   'olivia.staff_propose_send_schedule.v1','olivia.staff_propose_send_schedule.v2')
 THEN RAISE EXCEPTION 'proposal_revision_conflict' USING ERRCODE='P0001'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.supervisor_approvals a
  WHERE a.business_id=p_business_id AND a.proposal_id=p.id
    AND a.owner_user_id=p_owner_user_id AND a.approved_revision=p.revision-1
    AND a.effect_hash=p.effect_hash)
 THEN RAISE EXCEPTION 'staff_approval_missing' USING ERRCODE='42501'; END IF;

 e:=p.canonical_effect_payload;
 v_kind:=e->>'operation';d:=e->'payload';
 IF p.capability_id IS DISTINCT FROM 'olivia.staff_'||v_kind||'.v'||p.capability_version::text
    OR jsonb_typeof(d) IS DISTINCT FROM 'object'
    OR jsonb_typeof(e->'preview') IS DISTINCT FROM 'array'
    OR (e->>'expectedToken') !~ '^[a-f0-9]{32}$'
 THEN RAISE EXCEPTION 'invalid_staff_effect' USING ERRCODE='22023'; END IF;
 IF (p.capability_version=1 AND e->>'expectedToken' IS DISTINCT FROM public.supervisor_staff_source_token(p_business_id))
   OR (p.capability_version=2 AND (
    e->>'scopeVersion' IS DISTINCT FROM '2'
    OR e->'dependencyScope'->>'version' IS DISTINCT FROM '2'
    OR e->'dependencyScope'->>'kind' IS DISTINCT FROM
      CASE v_kind WHEN 'propose_staff_change' THEN 'staff_change'
      WHEN 'propose_add_staff' THEN 'add_staff'
      WHEN 'propose_shift_change' THEN 'shift_change'
      WHEN 'propose_schedule' THEN 'schedule'
      WHEN 'propose_send_schedule' THEN 'send_schedule'
      WHEN 'propose_availability_change' THEN 'availability'
      WHEN 'propose_rule_change' THEN 'rule' END
    OR (v_kind IN ('propose_staff_change','propose_availability_change') AND
     e->'dependencyScope'->>'employeeId' IS DISTINCT FROM d->>'employee_id')
    OR (v_kind='propose_rule_change' AND e->'dependencyScope'->>'rule' IS DISTINCT FROM d->>'rule')
    OR (v_kind IN ('propose_schedule','propose_send_schedule') AND
     e->'dependencyScope'->>'weekStart' IS DISTINCT FROM d->>'week_start')
    OR (v_kind='propose_shift_change' AND (
       e->'dependencyScope'->>'employeeId' IS DISTINCT FROM d->'shift'->>'employee_id'
       OR e->'dependencyScope'->>'date' IS DISTINCT FROM d->'shift'->>'date'
       OR e->'dependencyScope'->>'shiftId' IS DISTINCT FROM d->>'shift_id'))
    OR e->>'expectedToken' IS DISTINCT FROM public.supervisor_staff_scoped_token(p_business_id,e->'dependencyScope')
   )) THEN
   UPDATE public.supervisor_proposals SET status='stale',
       revision=revision+1,updated_at=now() WHERE id=p.id RETURNING * INTO p;
   RETURN jsonb_build_object('state','stale','proposal',to_jsonb(p));
 END IF;

 -- Two audited revision steps in THIS SAME transaction; on any SQL failure
 -- neither the source effect nor the ledger transition can commit.
 UPDATE public.supervisor_proposals SET status='executing',
   revision=revision+1,updated_at=now() WHERE id=p.id;

 IF v_kind='propose_schedule' THEN
   v_week:=(d->>'week_start')::date;
   IF extract(isodow FROM v_week)<>1 OR v_week < v_today
      OR jsonb_typeof(d->'shifts') IS DISTINCT FROM 'array'
      OR jsonb_array_length(d->'shifts')>60 THEN
     RAISE EXCEPTION 'invalid_schedule' USING ERRCODE='22023'; END IF;
   IF EXISTS(SELECT 1 FROM public.scheduled_shifts s
     WHERE s.business_id=p_business_id AND s.deleted_at IS NULL AND s.status='sent'
      AND s.local_date BETWEEN v_week AND v_week+6)
   THEN RAISE EXCEPTION 'published_schedule_conflict' USING ERRCODE='P0001'; END IF;
   FOR v_row IN SELECT value FROM jsonb_array_elements(d->'shifts') LOOP
     v_staff:=(v_row->>'employee_id')::uuid;
     v_day:=(v_row->>'date')::date;
     IF v_day NOT BETWEEN v_week AND v_week+6 OR
       v_row->>'start' IS NULL OR v_row->>'end' IS NULL OR
       v_row->>'start'=v_row->>'end' OR
       (v_row->>'break_minutes')::int NOT BETWEEN 0 AND 240 OR
       NOT EXISTS (SELECT 1 FROM public.employees
         WHERE id=v_staff AND business_id=p_business_id AND active)
     THEN RAISE EXCEPTION 'invalid_schedule_shift' USING ERRCODE='22023'; END IF;
     IF (v_staff::text||v_day::text||(v_row->>'start'))=ANY(v_seen)
     THEN RAISE EXCEPTION 'duplicate_schedule_shift' USING ERRCODE='22023'; END IF;
     v_seen:=array_append(v_seen,(v_staff::text||v_day::text||(v_row->>'start')));
   END LOOP;
   UPDATE public.scheduled_shifts SET deleted_at=now(),updated_at=now()
     WHERE business_id=p_business_id AND local_date BETWEEN v_week AND v_week+6
       AND deleted_at IS NULL AND status='draft';
   FOR v_row IN SELECT value FROM jsonb_array_elements(d->'shifts') LOOP
     INSERT INTO public.scheduled_shifts(
       business_id,employee_id,local_date,start_local,end_local,overnight,
       break_minutes,break_source,status,source,proposal_id,created_by)
     VALUES (p_business_id,(v_row->>'employee_id')::uuid,(v_row->>'date')::date,
       (v_row->>'start')::time,(v_row->>'end')::time,
       (v_row->>'end')<(v_row->>'start'),(v_row->>'break_minutes')::int,
       'owner','draft','olivia',p.id,p_owner_user_id);
   END LOOP;
 ELSIF v_kind='propose_shift_change' THEN
   v_row:=d->'shift';v_staff:=(v_row->>'employee_id')::uuid;
   v_day:=(v_row->>'date')::date;
   IF v_day < v_today OR v_row->>'start'=v_row->>'end' OR
     (v_row->>'break_minutes')::int NOT BETWEEN 0 AND 240 OR
     NOT EXISTS(SELECT 1 FROM public.employees WHERE business_id=p_business_id
       AND id=v_staff AND active) THEN
       RAISE EXCEPTION 'invalid_shift' USING ERRCODE='22023'; END IF;
   IF d->>'shift_id' IS NOT NULL THEN
     v_shift:=(d->>'shift_id')::uuid;
     IF NOT EXISTS(SELECT 1 FROM public.scheduled_shifts WHERE business_id=p_business_id
       AND id=v_shift AND employee_id=v_staff AND local_date=v_day
       AND deleted_at IS NULL AND status='draft') THEN
       RAISE EXCEPTION 'shift_changed' USING ERRCODE='P0001'; END IF;
   ELSIF (d->>'remove')::boolean THEN
     RAISE EXCEPTION 'cannot_remove_missing_shift' USING ERRCODE='22023';
   END IF;
   IF (d->>'remove')::boolean THEN
     UPDATE public.scheduled_shifts SET deleted_at=now(),updated_at=now()
       WHERE id=v_shift AND business_id=p_business_id;
   ELSIF v_shift IS NULL THEN
     INSERT INTO public.scheduled_shifts(business_id,employee_id,local_date,
       start_local,end_local,overnight,break_minutes,break_source,status,
       source,proposal_id,created_by)
     VALUES(p_business_id,v_staff,v_day,(v_row->>'start')::time,(v_row->>'end')::time,
       (v_row->>'end')<(v_row->>'start'),(v_row->>'break_minutes')::int,
       'owner','draft','olivia',p.id,p_owner_user_id);
   ELSE
     UPDATE public.scheduled_shifts SET start_local=(v_row->>'start')::time,
       end_local=(v_row->>'end')::time,overnight=(v_row->>'end')<(v_row->>'start'),
       break_minutes=(v_row->>'break_minutes')::int,break_source='owner',
       proposal_id=p.id,updated_at=now() WHERE business_id=p_business_id AND id=v_shift;
   END IF;
 ELSIF v_kind='propose_add_staff' THEN
   IF length(btrim(d->>'name')) NOT BETWEEN 1 AND 80 OR
      (d->>'wage_cents')::bigint NOT BETWEEN 1 AND 10000000 OR
      EXISTS(SELECT 1 FROM public.employees WHERE business_id=p_business_id
       AND active AND lower(display_name)=lower(btrim(d->>'name'))) THEN
       RAISE EXCEPTION 'invalid_or_duplicate_staff' USING ERRCODE='22023'; END IF;
   INSERT INTO public.employees(business_id,display_name,role,wage_period,
      wage_amount_cents,default_hourly_wage_cents,phone_e164,active,whatsapp_opt_in)
   VALUES(p_business_id,btrim(d->>'name'),nullif(btrim(d->>'role'),''),
     'hour',(d->>'wage_cents')::bigint,(d->>'wage_cents')::bigint,
     nullif(d->>'phone',''),true,false);
 ELSIF v_kind='propose_staff_change' THEN
   v_staff:=(d->>'employee_id')::uuid;
   UPDATE public.employees SET display_name=btrim(d->>'name'),
     role=nullif(btrim(d->>'role'),''),
     wage_amount_cents=(d->>'wage_cents')::bigint,
     default_hourly_wage_cents=(d->>'wage_cents')::bigint,
     phone_e164=nullif(d->>'phone',''),active=(d->>'active')::boolean
   WHERE business_id=p_business_id AND id=v_staff AND wage_period='hour'
     AND (d->>'wage_cents')::bigint BETWEEN 1 AND 10000000;
   GET DIAGNOSTICS v_changed=ROW_COUNT;
   IF v_changed<>1 THEN RAISE EXCEPTION 'staff_changed_or_not_hourly' USING ERRCODE='P0001'; END IF;
 ELSIF v_kind='propose_availability_change' THEN
   v_staff:=(d->>'employee_id')::uuid;
   IF NOT EXISTS(SELECT 1 FROM public.employees WHERE id=v_staff
      AND business_id=p_business_id AND active) THEN
     RAISE EXCEPTION 'staff_changed' USING ERRCODE='P0001'; END IF;
   IF jsonb_typeof(d->'off_dates') IS DISTINCT FROM 'array' OR
      jsonb_typeof(d->'availability') IS DISTINCT FROM 'array' OR
      jsonb_array_length(d->'availability')>7 OR jsonb_array_length(d->'off_dates')>7
   THEN RAISE EXCEPTION 'invalid_availability' USING ERRCODE='22023'; END IF;
   IF jsonb_array_length(d->'off_dates')>0 THEN
     FOR v_row IN SELECT value FROM jsonb_array_elements(d->'off_dates') LOOP
       v_day:=(trim(both '"' from v_row::text))::date;
       IF v_day < v_today THEN
         RAISE EXCEPTION 'dated_absence_expired' USING ERRCODE='P0001'; END IF;
       -- A confirmed full-day closure already satisfies the approved request.
       -- Partial or unconfirmed absences never block a new owner-approved day off.
       -- Replace them atomically, regardless of where they were reported.
       DELETE FROM public.staff_availability_exceptions
        WHERE business_id=p_business_id AND employee_id=v_staff
         AND local_date=v_day AND exception_type='unavailable'
         AND (confirmation IS DISTINCT FROM 'owner_confirmed'
              OR start_local IS NOT NULL OR end_local IS NOT NULL);
       IF NOT EXISTS(SELECT 1 FROM public.staff_availability_exceptions
          WHERE business_id=p_business_id AND employee_id=v_staff
           AND local_date=v_day AND exception_type='unavailable'
           AND confirmation='owner_confirmed'
           AND start_local IS NULL AND end_local IS NULL) THEN
         INSERT INTO public.staff_availability_exceptions(business_id,employee_id,
          local_date,exception_type,overnight,source,confirmation,confirmed_at,confirmed_by,created_by)
         VALUES(p_business_id,v_staff,v_day,'unavailable',false,'owner_direct',
          'owner_confirmed',now(),p_owner_user_id,p_owner_user_id);
       END IF;
     END LOOP;
   ELSE
     v_day:=(d->>'effective_from')::date;
     IF v_day < v_today THEN
       RAISE EXCEPTION 'availability_effective_date_expired' USING ERRCODE='P0001'; END IF;
     UPDATE public.staff_availability_rules SET effective_to=v_day-1
       WHERE business_id=p_business_id AND employee_id=v_staff
         AND effective_from<v_day
         AND (effective_to IS NULL OR effective_to>=v_day);
     DELETE FROM public.staff_availability_rules WHERE business_id=p_business_id
       AND employee_id=v_staff AND effective_from>=v_day;
     FOR v_row IN SELECT value FROM jsonb_array_elements(d->'availability') LOOP
       IF (v_row->>'day')::int NOT BETWEEN 0 AND 6
         OR (v_row->>'start') IS NULL OR (v_row->>'end') IS NULL
         OR (v_row->>'start')=(v_row->>'end') OR
         (v_row->>'day')=ANY(v_seen) THEN
         RAISE EXCEPTION 'invalid_availability_window' USING ERRCODE='22023'; END IF;
       v_seen:=array_append(v_seen,v_row->>'day');
       INSERT INTO public.staff_availability_rules(business_id,employee_id,
         day_of_week,start_local,end_local,overnight,effective_from,source,
         confirmation,confirmed_at,confirmed_by,created_by)
       VALUES(p_business_id,v_staff,(v_row->>'day')::smallint,
         (v_row->>'start')::time,(v_row->>'end')::time,
         (v_row->>'end')<(v_row->>'start'),v_day,'owner_direct',
         'owner_confirmed',now(),p_owner_user_id,p_owner_user_id);
     END LOOP;
     UPDATE public.employees SET available_days=ARRAY(
       SELECT (x.value->>'day')::smallint FROM jsonb_array_elements(d->'availability') x(value)
       ORDER BY (x.value->>'day')::int) WHERE business_id=p_business_id AND id=v_staff;
   END IF;
 ELSIF v_kind='propose_rule_change' THEN
   v_rule:=d->>'rule';
   IF v_rule NOT IN (
    'meal_break_enabled','meal_break_minutes','meal_break_after_minutes',
    'rest_break_enabled','rest_break_minutes','rest_break_every_minutes',
    'weekly_ot_enabled','weekly_ot_after_minutes','ot_multiplier_bp',
    'daily_ot_enabled','daily_ot_after_minutes','max_shift_enabled','max_shift_minutes',
    'min_shift_enabled','min_shift_minutes','min_rest_enabled','min_rest_minutes',
    'coverage_enabled','min_headcount','prep_minutes_before_open','prep_minutes_after_close')
   THEN RAISE EXCEPTION 'unrecognized_staff_rule' USING ERRCODE='22023'; END IF;
   INSERT INTO public.team_rules(business_id) VALUES(p_business_id)
      ON CONFLICT(business_id) DO NOTHING;
   IF right(v_rule,8)='_enabled' THEN
     IF jsonb_typeof(d->'boolean_value') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(d->'number_value') IS DISTINCT FROM 'null' THEN
       RAISE EXCEPTION 'invalid_boolean_rule' USING ERRCODE='22023'; END IF;
     v_bool:=(d->>'boolean_value')::boolean;
     EXECUTE format('UPDATE public.team_rules SET %I=$1,
        owner_set=array_append(array_remove(owner_set,$2),$2),
        updated_by=$3,updated_at=now() WHERE business_id=$4',v_rule)
       USING v_bool,v_rule,p_owner_user_id,p_business_id;
   ELSE
     IF jsonb_typeof(d->'number_value') IS DISTINCT FROM 'number'
        OR jsonb_typeof(d->'boolean_value') IS DISTINCT FROM 'null' THEN
        RAISE EXCEPTION 'invalid_numeric_rule' USING ERRCODE='22023'; END IF;
     v_number:=(d->>'number_value')::int;
     EXECUTE format('UPDATE public.team_rules SET %I=$1,
        owner_set=array_append(array_remove(owner_set,$2),$2),
        updated_by=$3,updated_at=now() WHERE business_id=$4',v_rule)
       USING v_number,v_rule,p_owner_user_id,p_business_id;
   END IF;
 ELSIF v_kind='propose_send_schedule' THEN
   -- Step 1 approves only the PREPARED messages. Never call WhatsApp here
   -- and never mark dated shifts 'sent' until the separate delivery stage.
   v_week:=(d->>'week_start')::date;
   IF extract(isodow FROM v_week)<>1 THEN
     RAISE EXCEPTION 'invalid_week' USING ERRCODE='22023'; END IF;
   INSERT INTO public.staff_schedule_deliveries(
      business_id,proposal_id,employee_id,recipient_e164,status)
   SELECT DISTINCT p_business_id,p.id,s.employee_id,e2.phone_e164,'prepared'
    FROM public.scheduled_shifts s JOIN public.employees e2
      ON e2.business_id=s.business_id AND e2.id=s.employee_id
   WHERE s.business_id=p_business_id AND s.local_date BETWEEN v_week AND v_week+6
      AND s.deleted_at IS NULL AND e2.active
      AND e2.phone_e164 IS NOT NULL AND e2.whatsapp_opt_in IS TRUE
       AND e2.phone_e164 ~ '^\+[1-9][0-9]{1,14}$'
   ON CONFLICT (business_id,proposal_id,employee_id) DO NOTHING;
 ELSE
   RAISE EXCEPTION 'unrecognized_staff_operation' USING ERRCODE='22023';
 END IF;


 -- Final transactional invariant, including retained Sunday/Monday overnight
 -- shifts. SHARE ROW EXCLUSIVE lock above prevents concurrent roster writers.
 IF v_kind IN ('propose_schedule','propose_shift_change') AND EXISTS(
  SELECT 1 FROM public.scheduled_shifts a JOIN public.scheduled_shifts b
   ON b.business_id=a.business_id AND b.employee_id=a.employee_id
   AND b.id<>a.id AND b.deleted_at IS NULL
  WHERE a.business_id=p_business_id AND a.proposal_id=p.id
    AND a.deleted_at IS NULL
    AND tsrange(a.local_date+a.start_local,
       a.local_date+a.end_local+
         CASE WHEN a.end_local<=a.start_local THEN interval '1 day' ELSE interval '0 day' END,'[)')
       && tsrange(b.local_date+b.start_local,
       b.local_date+b.end_local+
         CASE WHEN b.end_local<=b.start_local THEN interval '1 day' ELSE interval '0 day' END,'[)')
 ) THEN RAISE EXCEPTION 'overlapping_staff_shifts' USING ERRCODE='P0001'; END IF;
 IF v_kind IN ('propose_schedule','propose_send_schedule') THEN
   INSERT INTO public.staff_schedule_handoff_snapshots(business_id,proposal_id,week_start,shifts)
   VALUES(p_business_id,p.id,v_week,public.staff_handoff_week_shifts(p_business_id,v_week));
   IF v_kind='propose_send_schedule' AND
      (SELECT jsonb_array_length(shifts) FROM public.staff_schedule_handoff_snapshots
       WHERE business_id=p_business_id AND proposal_id=p.id)=0
   THEN RAISE EXCEPTION 'empty_schedule' USING ERRCODE='P0001'; END IF;
 END IF;
 UPDATE public.supervisor_proposals SET status='committed',revision=revision+1,
   committed_at=now(),monitoring_start_date=v_today+1,updated_at=now()
   WHERE id=p.id RETURNING * INTO p;
 RETURN jsonb_build_object('state','applied','proposal',to_jsonb(p));
END $$;
REVOKE ALL ON FUNCTION public.supervisor_commit_staff_proposal(
 uuid,uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.supervisor_commit_staff_proposal(
 uuid,uuid,uuid,uuid,integer) TO service_role;


