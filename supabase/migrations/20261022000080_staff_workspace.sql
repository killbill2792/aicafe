-- Owner-controlled dated schedule; no existing payroll facts are rewritten.
-- Allocate a fresh migration number if other PRs land before rebase.
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS phone_e164 text,
  ADD COLUMN IF NOT EXISTS min_weekly_minutes integer CHECK (min_weekly_minutes BETWEEN 0 AND 10080),
  ADD COLUMN IF NOT EXISTS max_weekly_minutes integer CHECK (max_weekly_minutes BETWEEN 0 AND 10080),
  ADD COLUMN IF NOT EXISTS available_days smallint[],
  ADD COLUMN IF NOT EXISTS color_index smallint CHECK (color_index BETWEEN 0 AND 15);
ALTER TABLE public.employees ADD CONSTRAINT employee_weekly_bounds
  CHECK (min_weekly_minutes IS NULL OR max_weekly_minutes IS NULL
    OR min_weekly_minutes <= max_weekly_minutes);
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
