-- Owner-controlled dated schedule; no existing payroll facts are rewritten.
-- Allocate a fresh migration number if other PRs land before rebase.
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS phone_e164 text,
  ADD COLUMN IF NOT EXISTS min_weekly_minutes integer CHECK (min_weekly_minutes BETWEEN 0 AND 10080),
  ADD COLUMN IF NOT EXISTS max_weekly_minutes integer CHECK (max_weekly_minutes BETWEEN 0 AND 10080),
  ADD COLUMN IF NOT EXISTS available_days smallint[],
  ADD COLUMN IF NOT EXISTS color_index smallint CHECK (color_index BETWEEN 0 AND 15);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.employees'::regclass AND conname='employee_weekly_bounds') THEN
    ALTER TABLE public.employees ADD CONSTRAINT employee_weekly_bounds
      CHECK (min_weekly_minutes IS NULL OR max_weekly_minutes IS NULL
        OR min_weekly_minutes <= max_weekly_minutes);
  END IF;
END $$;
ALTER TABLE public.staff_schedules ALTER COLUMN hourly_wage_cents DROP NOT NULL;

CREATE TABLE public.team_rules (
  business_id uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  meal_break_enabled boolean NOT NULL DEFAULT true,
  meal_break_minutes integer NOT NULL DEFAULT 30 CHECK (meal_break_minutes BETWEEN 0 AND 240),
  meal_break_after_minutes integer NOT NULL DEFAULT 300 CHECK (meal_break_after_minutes BETWEEN 0 AND 1440),
  rest_break_enabled boolean NOT NULL DEFAULT true,
  rest_break_minutes integer NOT NULL DEFAULT 10 CHECK (rest_break_minutes BETWEEN 0 AND 60),
  rest_break_every_minutes integer NOT NULL DEFAULT 240 CHECK (rest_break_every_minutes BETWEEN 60 AND 1440),
  weekly_ot_enabled boolean NOT NULL DEFAULT true,
  weekly_ot_after_minutes integer NOT NULL DEFAULT 2400 CHECK (weekly_ot_after_minutes BETWEEN 0 AND 10080),
  ot_multiplier_bp integer NOT NULL DEFAULT 15000 CHECK (ot_multiplier_bp BETWEEN 10000 AND 50000),
  daily_ot_enabled boolean NOT NULL DEFAULT false,
  daily_ot_after_minutes integer NOT NULL DEFAULT 480 CHECK (daily_ot_after_minutes BETWEEN 0 AND 1440),
  max_shift_enabled boolean NOT NULL DEFAULT true,
  max_shift_minutes integer NOT NULL DEFAULT 600 CHECK (max_shift_minutes BETWEEN 30 AND 1440),
  min_shift_enabled boolean NOT NULL DEFAULT true,
  min_shift_minutes integer NOT NULL DEFAULT 180 CHECK (min_shift_minutes BETWEEN 0 AND 1440),
  min_rest_enabled boolean NOT NULL DEFAULT true,
  min_rest_minutes integer NOT NULL DEFAULT 600 CHECK (min_rest_minutes BETWEEN 0 AND 1440),
  coverage_enabled boolean NOT NULL DEFAULT true,
  min_headcount smallint NOT NULL DEFAULT 2 CHECK (min_headcount BETWEEN 1 AND 30),
  owner_set text[] NOT NULL DEFAULT '{}',
  updated_by uuid REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.team_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "team rules members read" ON public.team_rules
 FOR SELECT TO authenticated USING (public.is_member(business_id));
CREATE POLICY "team rules owners write" ON public.team_rules
 FOR ALL TO authenticated USING (public.scheduling_is_owner(business_id))
 WITH CHECK (public.scheduling_is_owner(business_id));

CREATE TABLE public.staff_custom_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 rule_text text NOT NULL CHECK (char_length(btrim(rule_text)) BETWEEN 1 AND 500),
 active boolean NOT NULL DEFAULT true,
 created_by uuid REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (business_id,id)
);
ALTER TABLE public.staff_custom_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "custom rules members read" ON public.staff_custom_rules FOR SELECT TO authenticated
 USING (public.is_member(business_id));
CREATE POLICY "custom rules owners write" ON public.staff_custom_rules FOR ALL TO authenticated
 USING (public.scheduling_is_owner(business_id)) WITH CHECK (public.scheduling_is_owner(business_id));

CREATE TABLE public.scheduled_shifts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 employee_id uuid NOT NULL,
 local_date date NOT NULL,
 start_local time NOT NULL, end_local time NOT NULL,
 overnight boolean NOT NULL DEFAULT false,
 break_minutes integer NOT NULL DEFAULT 0 CHECK (break_minutes BETWEEN 0 AND 240),
 break_source text NOT NULL DEFAULT 'rule' CHECK (break_source IN ('rule','owner')),
 role text,
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent')),
 source text NOT NULL DEFAULT 'owner' CHECK (source IN ('owner','olivia','copied','repeat')),
 repeat_schedule_id uuid REFERENCES public.staff_schedules(id) ON DELETE SET NULL,
 proposal_id uuid,
 created_by uuid REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (business_id,employee_id) REFERENCES public.employees(business_id,id) ON DELETE CASCADE,
 UNIQUE (business_id,id),
 CONSTRAINT scheduled_shift_nonzero CHECK (start_local <> end_local AND overnight = (end_local < start_local))
);
CREATE INDEX scheduled_shifts_week_idx ON public.scheduled_shifts(business_id,local_date,employee_id);
ALTER TABLE public.scheduled_shifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "scheduled shifts members read" ON public.scheduled_shifts FOR SELECT TO authenticated
 USING (public.is_member(business_id));
CREATE POLICY "scheduled shifts owners write" ON public.scheduled_shifts FOR ALL TO authenticated
 USING (public.scheduling_is_owner(business_id)) WITH CHECK (public.scheduling_is_owner(business_id));

-- Durable owner alerts; delivery metadata is a future WhatsApp integration hook, not a sender.
CREATE TABLE public.staff_rule_alerts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 timecard_id uuid NOT NULL REFERENCES public.timecards(id) ON DELETE CASCADE,
 employee_id uuid NOT NULL,
 rule_key text NOT NULL CHECK (rule_key IN ('meal','rest_break','weekly_overtime','daily_overtime','short_rest')),
 message text NOT NULL,
 status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','seen','dismissed')),
 staff_notification_status text NOT NULL DEFAULT 'not_requested'
   CHECK (staff_notification_status IN ('not_requested','queued','sent','failed')),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (business_id,timecard_id,rule_key),
 FOREIGN KEY (business_id,employee_id) REFERENCES public.employees(business_id,id) ON DELETE CASCADE
);
CREATE INDEX staff_rule_alerts_recent_idx ON public.staff_rule_alerts(business_id,created_at DESC);
ALTER TABLE public.staff_rule_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff rule alerts owner read" ON public.staff_rule_alerts FOR SELECT TO authenticated
 USING (public.scheduling_is_owner(business_id));
CREATE POLICY "staff rule alerts owner write" ON public.staff_rule_alerts FOR ALL TO authenticated
 USING (public.scheduling_is_owner(business_id)) WITH CHECK (public.scheduling_is_owner(business_id));

-- An id-only shift Undo keeps the original trusted row on the server.
ALTER TABLE public.scheduled_shifts ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS scheduled_shifts_not_deleted_idx
 ON public.scheduled_shifts(business_id,local_date) WHERE deleted_at IS NULL;

-- One transaction covers a person's profile and their complete weekly availability.
-- The current availability foundation keeps audit/revision triggers active.
CREATE OR REPLACE FUNCTION public.staff_write_person(
 p_business_id uuid, p_id uuid, p_payload jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
 v_id uuid;
 v_today date;
 v_previous date;
 v_day jsonb;
 v_days smallint[];
 v_start text;
 v_end text;
BEGIN
 IF p_business_id IS NULL OR p_payload IS NULL OR
    NOT public.scheduling_is_owner(p_business_id) OR
    NOT EXISTS(SELECT 1 FROM public.businesses
     WHERE id=p_business_id AND is_demo=false) THEN
   RAISE EXCEPTION 'owner authorization required' USING ERRCODE='42501';
 END IF;
 IF jsonb_typeof(p_payload)<>'object' OR
   jsonb_typeof(p_payload->'availability')<>'array' OR
   jsonb_array_length(p_payload->'availability')>7 OR
   length(btrim(p_payload->>'name')) NOT BETWEEN 1 AND 80 OR
   length(coalesce(p_payload->>'role',''))>60 OR
   length(coalesce(p_payload->>'phone',''))>32 OR
   EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) as k(key)
     WHERE k.key NOT IN ('name','role','wageCents','phone',
       'minWeeklyMinutes','maxWeeklyMinutes','availability')) OR
   EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload->'availability') a
     WHERE jsonb_typeof(a)<>'object'
        OR (a->>'day') !~ '^[0-6]$'
        OR jsonb_typeof(a->'start') NOT IN ('string','null')
        OR jsonb_typeof(a->'end') NOT IN ('string','null')
        OR (a->>'start') IS NULL AND (a->>'end') IS NOT NULL
        OR (a->>'start') IS NOT NULL AND (a->>'end') IS NULL
        OR ((a->>'start') IS NOT NULL AND (
          (a->>'start') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' OR
          (a->>'end') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' OR
          (a->>'start')=(a->>'end'))))
   ) OR
   (SELECT count(*) FROM jsonb_array_elements(p_payload->'availability')) <>
   (SELECT count(DISTINCT a->>'day')
      FROM jsonb_array_elements(p_payload->'availability') a) THEN
  RAISE EXCEPTION 'invalid person request' USING ERRCODE='22023';
 END IF;
 PERFORM 1 FROM public.businesses WHERE id=p_business_id FOR SHARE;
 SELECT (now() AT TIME ZONE b.timezone)::date INTO v_today
 FROM public.businesses b WHERE b.id=p_business_id;
 v_previous := v_today - 1;
 SELECT coalesce(array_agg((a->>'day')::smallint),ARRAY[]::smallint[])
 INTO v_days FROM jsonb_array_elements(p_payload->'availability') a;
 IF p_id IS NULL THEN
  INSERT INTO public.employees(business_id,display_name,role,
   wage_period,wage_amount_cents,default_hourly_wage_cents,
   phone_e164,min_weekly_minutes,max_weekly_minutes,available_days,active)
  VALUES(p_business_id,btrim(p_payload->>'name'),nullif(btrim(p_payload->>'role'),''),
   'hour',(p_payload->>'wageCents')::bigint,(p_payload->>'wageCents')::bigint,
   nullif(p_payload->>'phone',''),(p_payload->>'minWeeklyMinutes')::int,
   (p_payload->>'maxWeeklyMinutes')::int,v_days,true) RETURNING id INTO v_id;
 ELSE
  PERFORM 1 FROM public.employees
   WHERE business_id=p_business_id AND id=p_id FOR UPDATE;
  IF NOT FOUND THEN
   RAISE EXCEPTION 'employee not found' USING ERRCODE='P0002';
  END IF;
  v_id:=p_id;
  UPDATE public.employees SET display_name=btrim(p_payload->>'name'),
   role=nullif(btrim(p_payload->>'role'),''),
   wage_period='hour',
   wage_amount_cents=(p_payload->>'wageCents')::bigint,
   default_hourly_wage_cents=(p_payload->>'wageCents')::bigint,
   phone_e164=nullif(p_payload->>'phone',''),
   min_weekly_minutes=(p_payload->>'minWeeklyMinutes')::int,
   max_weekly_minutes=(p_payload->>'maxWeeklyMinutes')::int,
   available_days=v_days
   WHERE business_id=p_business_id AND id=v_id;
 END IF;
 -- Retain historical rules, replacing only active/future owner-set windows.
 -- Existing availability audit triggers still run in this transaction.
 UPDATE public.staff_availability_rules
 SET effective_to=v_previous
 WHERE business_id=p_business_id AND employee_id=v_id
   AND source='owner_direct' AND effective_from < v_today
   AND (effective_to IS NULL OR effective_to>=v_today);
 DELETE FROM public.staff_availability_rules
 WHERE business_id=p_business_id AND employee_id=v_id
   AND source='owner_direct' AND effective_from>=v_today;
 FOR v_day IN SELECT value FROM jsonb_array_elements(p_payload->'availability') LOOP
  v_start:=v_day->>'start'; v_end:=v_day->>'end';
  IF v_start IS NOT NULL THEN
   INSERT INTO public.staff_availability_rules
    (business_id,employee_id,day_of_week,start_local,end_local,
     overnight,effective_from,effective_to,source,confirmation)
   VALUES (p_business_id,v_id,(v_day->>'day')::smallint,
      v_start::time,v_end::time,(v_end < v_start),v_today,NULL,
      'owner_direct','unconfirmed');
  END IF;
 END LOOP;
 RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.staff_write_person(uuid,uuid,jsonb) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.staff_write_person(uuid,uuid,jsonb) TO authenticated;
