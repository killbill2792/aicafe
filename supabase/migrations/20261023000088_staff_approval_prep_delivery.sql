-- Staff readiness: additive per-café prep/cleanup and consented delivery ledger.
-- Safe to re-run. No sending or modification of existing rosters.
ALTER TABLE public.team_rules
 ADD COLUMN IF NOT EXISTS prep_minutes_before_open integer NOT NULL DEFAULT 0
   CHECK (prep_minutes_before_open BETWEEN 0 AND 240),
 ADD COLUMN IF NOT EXISTS prep_minutes_after_close integer NOT NULL DEFAULT 0
   CHECK (prep_minutes_after_close BETWEEN 0 AND 240);
ALTER TABLE public.employees
 ADD COLUMN IF NOT EXISTS whatsapp_opt_in boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS public.staff_schedule_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 proposal_id uuid NOT NULL,
 employee_id uuid NOT NULL,
 recipient_e164 text NOT NULL CHECK(recipient_e164 ~ '^\+[1-9][0-9]{1,14}$'),
 status text NOT NULL DEFAULT 'prepared'
   CHECK(status IN ('prepared','sending','sent','failed','delivered')),
 meta_message_id text,
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (business_id,proposal_id,employee_id),
 FOREIGN KEY (business_id,proposal_id) REFERENCES public.supervisor_proposals(business_id,id) ON DELETE CASCADE,
 FOREIGN KEY (business_id,employee_id) REFERENCES public.employees(business_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS staff_schedule_deliveries_meta
 ON public.staff_schedule_deliveries(meta_message_id) WHERE meta_message_id IS NOT NULL;
ALTER TABLE public.staff_schedule_deliveries ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
  AND tablename='staff_schedule_deliveries' AND policyname='owner read deliveries') THEN
  CREATE POLICY "owner read deliveries" ON public.staff_schedule_deliveries
   FOR SELECT TO authenticated USING (public.scheduling_is_owner(business_id));
 END IF;
END $$;
REVOKE ALL ON public.staff_schedule_deliveries FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.staff_schedule_deliveries TO authenticated;
GRANT ALL ON public.staff_schedule_deliveries TO service_role;

-- Staff approvals extend the SAME immutable Supervisor proposal and approval
-- ledger from migrations 074/083. Source CAS, staff writes and final status
-- live in one transaction; no partial multi-row schedules or autonomous retries.
CREATE OR REPLACE FUNCTION public.supervisor_staff_source_token(p_business_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE t text; rows jsonb:='{}'::jsonb; part jsonb;
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service_role_only'; END IF;
 FOREACH t IN ARRAY ARRAY[
   'employees','scheduled_shifts','team_rules','staff_availability_rules',
   'staff_availability_exceptions','staff_scheduling_preferences',
   'staff_custom_rules','locations'
 ] LOOP
   EXECUTE format(
     'select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),''[]''::jsonb)
        from public.%I r where r.business_id=$1',t) INTO part USING p_business_id;
   rows:=rows || jsonb_build_object(t,part);
 END LOOP;
 RETURN md5(jsonb_build_object('rows',rows,'cafe_date',
   (now() AT TIME ZONE (SELECT b.timezone FROM public.businesses b WHERE b.id=p_business_id))::date,
   'timezone',(SELECT b.timezone FROM public.businesses b WHERE b.id=p_business_id))::text);
END $$;
REVOKE ALL ON FUNCTION public.supervisor_staff_source_token(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.supervisor_staff_source_token(uuid) TO service_role;

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
  OR p.capability_version<>1 OR p.capability_id NOT IN (
   'olivia.staff_propose_schedule.v1',
   'olivia.staff_propose_shift_change.v1',
   'olivia.staff_propose_add_staff.v1',
   'olivia.staff_propose_staff_change.v1',
   'olivia.staff_propose_availability_change.v1',
   'olivia.staff_propose_rule_change.v1',
   'olivia.staff_propose_send_schedule.v1')
 THEN RAISE EXCEPTION 'proposal_revision_conflict' USING ERRCODE='P0001'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.supervisor_approvals a
  WHERE a.business_id=p_business_id AND a.proposal_id=p.id
    AND a.owner_user_id=p_owner_user_id AND a.approved_revision=p.revision-1
    AND a.effect_hash=p.effect_hash)
 THEN RAISE EXCEPTION 'staff_approval_missing' USING ERRCODE='42501'; END IF;

 e:=p.canonical_effect_payload;
 v_kind:=e->>'operation';d:=e->'payload';
 IF p.capability_id IS DISTINCT FROM 'olivia.staff_'||v_kind||'.v1'
    OR jsonb_typeof(d) IS DISTINCT FROM 'object'
    OR jsonb_typeof(e->'preview') IS DISTINCT FROM 'array'
    OR (e->>'expectedToken') !~ '^[a-f0-9]{32}$'
 THEN RAISE EXCEPTION 'invalid_staff_effect' USING ERRCODE='22023'; END IF;
 IF e->>'expectedToken' IS DISTINCT FROM public.supervisor_staff_source_token(p_business_id) THEN
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
       IF EXISTS(SELECT 1 FROM public.staff_availability_exceptions
          WHERE business_id=p_business_id AND employee_id=v_staff
            AND local_date=v_day AND source='owner_direct'
            AND exception_type='unavailable')
       THEN RAISE EXCEPTION 'absence_already_recorded' USING ERRCODE='P0001'; END IF;
       INSERT INTO public.staff_availability_exceptions(business_id,employee_id,
          local_date,exception_type,overnight,source,confirmation,confirmed_at,confirmed_by,created_by)
       VALUES(p_business_id,v_staff,v_day,'unavailable',false,'owner_direct',
         'owner_confirmed',now(),p_owner_user_id,p_owner_user_id);
     END LOOP;
   ELSE
     v_day:=(d->>'effective_from')::date;
     IF v_day < v_today THEN
       RAISE EXCEPTION 'availability_effective_date_expired' USING ERRCODE='P0001'; END IF;
     UPDATE public.staff_availability_rules SET effective_to=v_day-1
       WHERE business_id=p_business_id AND employee_id=v_staff
         AND source='owner_direct' AND effective_from<v_day
         AND (effective_to IS NULL OR effective_to>=v_day);
     DELETE FROM public.staff_availability_rules WHERE business_id=p_business_id
       AND employee_id=v_staff AND source='owner_direct' AND effective_from>=v_day;
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
   ON CONFLICT (business_id,proposal_id,employee_id) DO NOTHING;
 ELSE
   RAISE EXCEPTION 'unrecognized_staff_operation' USING ERRCODE='22023';
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


-- Step 3: owner-initiated external app compose. Never an automated send.
ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS preferred_schedule_channel text
  NOT NULL DEFAULT 'whatsapp' CHECK (preferred_schedule_channel IN ('whatsapp','sms'));
ALTER TABLE public.staff_schedule_deliveries ADD COLUMN IF NOT EXISTS plan_revision_id uuid;
ALTER TABLE public.staff_schedule_deliveries ADD COLUMN IF NOT EXISTS channel text
  NOT NULL DEFAULT 'whatsapp' CHECK(channel IN ('whatsapp','sms'));
ALTER TABLE public.staff_schedule_deliveries ADD COLUMN IF NOT EXISTS sent_by uuid
  REFERENCES auth.users(id);
ALTER TABLE public.staff_schedule_deliveries ADD COLUMN IF NOT EXISTS sent_at timestamptz;
ALTER TABLE public.staff_schedule_deliveries ALTER COLUMN proposal_id DROP NOT NULL;
ALTER TABLE public.staff_schedule_deliveries
  DROP CONSTRAINT IF EXISTS staff_schedule_deliveries_status_check;
ALTER TABLE public.staff_schedule_deliveries ADD CONSTRAINT staff_schedule_deliveries_status_check
  CHECK (status IN ('prepared','sending','sent','failed','delivered','sent_by_owner'));
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='staff_schedule_deliveries_source_check') THEN
    ALTER TABLE public.staff_schedule_deliveries ADD CONSTRAINT staff_schedule_deliveries_source_check
      CHECK ((proposal_id IS NULL) <> (plan_revision_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='staff_schedule_deliveries_plan_fk') THEN
    ALTER TABLE public.staff_schedule_deliveries ADD CONSTRAINT staff_schedule_deliveries_plan_fk
      FOREIGN KEY (business_id,plan_revision_id)
        REFERENCES public.scheduling_plan_revisions(business_id,id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS staff_schedule_deliveries_plan_unique
  ON public.staff_schedule_deliveries(business_id,plan_revision_id,employee_id)
  WHERE plan_revision_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS staff_schedule_deliveries_owner_recent
  ON public.staff_schedule_deliveries(business_id,sent_at DESC)
  WHERE status='sent_by_owner';
-- Privileged, atomic ledger transition. The browser supplies neither recipient,
-- message text nor actor. Validate a COMMITTED proposal or APPROVED/PUBLISHED plan
-- and the current employee's consent/phone under row locks, then record tap.
CREATE OR REPLACE FUNCTION public.staff_mark_owner_delivery(
 p_business_id uuid,p_owner_user_id uuid,p_employee_id uuid,
 p_channel text,p_proposal_id uuid DEFAULT NULL,p_plan_revision_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
 v_employee public.employees%rowtype;
 v_proposal public.supervisor_proposals%rowtype;
 v_revision public.scheduling_plan_revisions%rowtype;
 v_series public.scheduling_plan_series%rowtype;
 v_delivery public.staff_schedule_deliveries%rowtype;
 v_week date;v_operation text;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN
   RAISE EXCEPTION 'service_role_only' USING ERRCODE='42501'; END IF;
 IF p_channel NOT IN ('whatsapp','sms')
   OR (p_proposal_id IS NULL)=(p_plan_revision_id IS NULL)
   OR NOT EXISTS(SELECT 1 FROM public.memberships m
     JOIN public.businesses b ON b.id=m.business_id
     WHERE m.business_id=p_business_id AND m.user_id=p_owner_user_id
       AND m.role='owner' AND b.is_demo=false) THEN
   RAISE EXCEPTION 'delivery_unauthorized' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(
   'owner-delivery:'||p_business_id::text||':'||
   coalesce(p_proposal_id,p_plan_revision_id)::text||':'||p_employee_id::text,0));
 SELECT * INTO v_employee FROM public.employees WHERE business_id=p_business_id
   AND id=p_employee_id AND active FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'staff_not_found' USING ERRCODE='P0002'; END IF;
 IF v_employee.phone_e164 IS NULL
   OR v_employee.phone_e164 !~ '^\+[1-9][0-9]{1,14}$'
   OR (p_channel='whatsapp' AND v_employee.whatsapp_opt_in IS NOT TRUE) THEN
   RAISE EXCEPTION 'recipient_not_eligible' USING ERRCODE='P0001'; END IF;
 IF p_proposal_id IS NOT NULL THEN
   SELECT * INTO v_proposal FROM public.supervisor_proposals
      WHERE id=p_proposal_id AND business_id=p_business_id
        AND status='committed' AND capability_id IN (
          'olivia.staff_propose_schedule.v1','olivia.staff_propose_send_schedule.v1')
      FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'schedule_not_approved' USING ERRCODE='P0001'; END IF;
   v_operation:=v_proposal.canonical_effect_payload->>'operation';
   v_week:=(v_proposal.canonical_effect_payload->'payload'->>'week_start')::date;
   IF v_operation='propose_schedule' THEN
     IF NOT EXISTS(SELECT 1 FROM public.scheduled_shifts s
       WHERE s.business_id=p_business_id AND s.proposal_id=p_proposal_id
         AND s.employee_id=p_employee_id AND s.deleted_at IS NULL
         AND s.local_date BETWEEN v_week AND v_week+6)
     THEN RAISE EXCEPTION 'schedule_changed' USING ERRCODE='P0001'; END IF;
   ELSIF NOT EXISTS(SELECT 1 FROM public.scheduled_shifts s
       WHERE s.business_id=p_business_id AND s.employee_id=p_employee_id
         AND s.deleted_at IS NULL AND s.local_date BETWEEN v_week AND v_week+6
         AND s.updated_at <= v_proposal.committed_at)
   THEN RAISE EXCEPTION 'schedule_changed' USING ERRCODE='P0001'; END IF;
   SELECT * INTO v_delivery FROM public.staff_schedule_deliveries
     WHERE business_id=p_business_id AND proposal_id=p_proposal_id
       AND employee_id=p_employee_id FOR UPDATE;
 ELSE
   SELECT * INTO v_revision FROM public.scheduling_plan_revisions
     WHERE business_id=p_business_id AND id=p_plan_revision_id
       AND status IN ('approved','published') FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'schedule_not_approved' USING ERRCODE='P0001'; END IF;
   SELECT * INTO v_series FROM public.scheduling_plan_series
     WHERE business_id=p_business_id AND id=v_revision.series_id FOR SHARE;
   IF NOT FOUND OR NOT (
       (v_revision.status='approved' AND v_series.current_revision=v_revision.revision)
       OR (v_revision.status='published' AND v_series.published_revision=v_revision.revision))
   THEN RAISE EXCEPTION 'schedule_superseded' USING ERRCODE='P0001'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.scheduling_plan_assignments a
       WHERE a.business_id=p_business_id AND a.plan_revision_id=p_plan_revision_id
         AND a.employee_id=p_employee_id)
   THEN RAISE EXCEPTION 'staff_not_scheduled' USING ERRCODE='P0001'; END IF;
   SELECT * INTO v_delivery FROM public.staff_schedule_deliveries
     WHERE business_id=p_business_id AND plan_revision_id=p_plan_revision_id
       AND employee_id=p_employee_id FOR UPDATE;
 END IF;
 IF v_delivery.id IS NOT NULL THEN
   IF v_delivery.status='sent_by_owner' THEN
     RETURN jsonb_build_object('state','already_opened','channel',v_delivery.channel,
       'at',v_delivery.sent_at); END IF;
   IF v_delivery.status<>'prepared' THEN
     RAISE EXCEPTION 'delivery_conflict' USING ERRCODE='P0001'; END IF;
   UPDATE public.staff_schedule_deliveries
     SET status='sent_by_owner',channel=p_channel,recipient_e164=v_employee.phone_e164,
       sent_at=now(),sent_by=p_owner_user_id,updated_at=now()
     WHERE id=v_delivery.id;
 ELSE
   INSERT INTO public.staff_schedule_deliveries(business_id,proposal_id,plan_revision_id,
     employee_id,recipient_e164,status,channel,sent_at,sent_by)
   VALUES(p_business_id,p_proposal_id,p_plan_revision_id,p_employee_id,
     v_employee.phone_e164,'sent_by_owner',p_channel,now(),p_owner_user_id);
 END IF;
 RETURN jsonb_build_object('state','opened','channel',p_channel);
END $$;
REVOKE ALL ON FUNCTION public.staff_mark_owner_delivery(
 uuid,uuid,uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.staff_mark_owner_delivery(
 uuid,uuid,uuid,text,uuid,uuid) TO service_role;
