-- Olivia PR 1A: additive, manual-first scheduling inputs only. Do not modify
-- staff_schedules (assigned shifts), timecards, employee wage values or POS facts.
-- Apply to disposable/staging DB only after migration-ledger review.
--
-- Authority: an owner may confirm information REPORTED by a worker, but that
-- does not prove authenticated worker consent/acceptance.
CREATE OR REPLACE FUNCTION public.scheduling_is_owner(p_business_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS (SELECT 1 FROM public.memberships
    WHERE business_id=p_business_id AND user_id=auth.uid() AND role='owner');
$$;
REVOKE ALL ON FUNCTION public.scheduling_is_owner(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.scheduling_is_owner(uuid) TO authenticated;

CREATE TABLE public.staff_availability_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 employee_id uuid NOT NULL, location_id uuid,
 day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
 start_local time NOT NULL, end_local time NOT NULL,
 overnight boolean NOT NULL DEFAULT false,
 effective_from date NOT NULL, effective_to date,
 source text NOT NULL CHECK (source IN ('owner_direct','worker_reported_by_owner')),
 confirmation text NOT NULL DEFAULT 'unconfirmed' CHECK (confirmation IN ('unconfirmed','owner_confirmed')),
 confirmed_at timestamptz, confirmed_by uuid REFERENCES auth.users(id),
 revision int NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_by uuid, updated_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (business_id,employee_id) REFERENCES public.employees(business_id,id) ON DELETE CASCADE,
 FOREIGN KEY (business_id,location_id) REFERENCES public.locations(business_id,id) ON DELETE RESTRICT,
 CHECK (effective_to IS NULL OR effective_to >= effective_from),
 CHECK (start_local <> end_local AND (overnight = (end_local < start_local))),
 CHECK ((confirmation='unconfirmed' AND confirmed_at IS NULL AND confirmed_by IS NULL)
     OR (confirmation='owner_confirmed' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL))
);

CREATE TABLE public.staff_availability_exceptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 employee_id uuid NOT NULL, location_id uuid,
 local_date date NOT NULL,
 exception_type text NOT NULL CHECK (exception_type IN ('unavailable','approved_leave','replace_day','add_available','hours_cap')),
 start_local time, end_local time, overnight boolean NOT NULL DEFAULT false,
 max_minutes int CHECK (max_minutes BETWEEN 0 AND 1440),
 source text NOT NULL CHECK (source IN ('owner_direct','worker_reported_by_owner')),
 confirmation text NOT NULL DEFAULT 'unconfirmed' CHECK (confirmation IN ('unconfirmed','owner_confirmed')),
 confirmed_at timestamptz, confirmed_by uuid REFERENCES auth.users(id),
 revision int NOT NULL DEFAULT 1 CHECK (revision>0),
 created_by uuid, updated_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (business_id,employee_id) REFERENCES public.employees(business_id,id) ON DELETE CASCADE,
 FOREIGN KEY (business_id,location_id) REFERENCES public.locations(business_id,id) ON DELETE RESTRICT,
 CHECK (
   (exception_type='hours_cap' AND max_minutes IS NOT NULL AND start_local IS NULL AND end_local IS NULL)
   OR (exception_type='approved_leave' AND max_minutes IS NULL AND start_local IS NULL AND end_local IS NULL)
   OR (exception_type='unavailable' AND max_minutes IS NULL AND ((start_local IS NULL AND end_local IS NULL) OR (start_local IS NOT NULL AND end_local IS NOT NULL)))
   OR (exception_type IN ('replace_day','add_available') AND max_minutes IS NULL AND start_local IS NOT NULL AND end_local IS NOT NULL)
 ),
 CHECK (start_local IS NULL OR (start_local <> end_local AND (overnight=(end_local < start_local)))),
 CHECK ((confirmation='unconfirmed' AND confirmed_at IS NULL AND confirmed_by IS NULL)
     OR (confirmation='owner_confirmed' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL))
);
-- A date's confirmed replace_day rows form its complete replacement set;
-- a full-day unavailable / approved_leave takes priority over ALL windows.

CREATE TABLE public.staff_scheduling_preferences (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 employee_id uuid NOT NULL,
 effective_from date NOT NULL, effective_to date,
 min_weekly_minutes int NOT NULL DEFAULT 0 CHECK (min_weekly_minutes BETWEEN 0 AND 10080),
 desired_weekly_minutes int CHECK (desired_weekly_minutes BETWEEN 0 AND 10080),
 max_weekly_minutes int CHECK (max_weekly_minutes BETWEEN 0 AND 10080),
 max_daily_minutes int CHECK (max_daily_minutes BETWEEN 0 AND 1440),
 source text NOT NULL CHECK (source IN ('owner_direct','worker_reported_by_owner')),
 confirmation text NOT NULL DEFAULT 'unconfirmed' CHECK (confirmation IN ('unconfirmed','owner_confirmed')),
 confirmed_at timestamptz, confirmed_by uuid REFERENCES auth.users(id),
 revision int NOT NULL DEFAULT 1 CHECK (revision>0),
 created_by uuid, updated_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (business_id,employee_id) REFERENCES public.employees(business_id,id) ON DELETE CASCADE,
 CHECK (effective_to IS NULL OR effective_to >= effective_from),
 CHECK (max_weekly_minutes IS NULL OR max_weekly_minutes >= min_weekly_minutes),
 CHECK (desired_weekly_minutes IS NULL OR desired_weekly_minutes >= min_weekly_minutes),
 CHECK (desired_weekly_minutes IS NULL OR max_weekly_minutes IS NULL OR desired_weekly_minutes <= max_weekly_minutes),
 CHECK ((confirmation='unconfirmed' AND confirmed_at IS NULL AND confirmed_by IS NULL)
     OR (confirmation='owner_confirmed' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL))
);

CREATE TABLE public.staff_preference_windows (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 employee_id uuid NOT NULL, day_of_week smallint NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
 start_local time NOT NULL, end_local time NOT NULL, overnight boolean NOT NULL DEFAULT false,
 preference text NOT NULL CHECK (preference IN ('prefer','avoid')),
 strength text NOT NULL CHECK (strength IN ('soft','hard')),
 effective_from date NOT NULL, effective_to date,
 source text NOT NULL CHECK (source IN ('owner_direct','worker_reported_by_owner')),
 confirmation text NOT NULL DEFAULT 'unconfirmed' CHECK (confirmation IN ('unconfirmed','owner_confirmed')),
 confirmed_at timestamptz, confirmed_by uuid REFERENCES auth.users(id),
 revision int NOT NULL DEFAULT 1 CHECK (revision>0),
 created_by uuid, updated_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (business_id,employee_id) REFERENCES public.employees(business_id,id) ON DELETE CASCADE,
 CHECK (strength='soft' OR preference='avoid'),
 CHECK (effective_to IS NULL OR effective_to >= effective_from),
 CHECK (start_local <> end_local AND (overnight = (end_local < start_local))),
 CHECK ((confirmation='unconfirmed' AND confirmed_at IS NULL AND confirmed_by IS NULL)
     OR (confirmation='owner_confirmed' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL))
);

CREATE TABLE public.scheduling_qualification_types (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,39}$'),
 display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 80),
 active boolean NOT NULL DEFAULT true,
 revision int NOT NULL DEFAULT 1 CHECK (revision>0),
 created_by uuid, updated_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (business_id,code)
);

CREATE TABLE public.staff_qualifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 employee_id uuid NOT NULL, location_id uuid,
 qualification_code text NOT NULL,
 valid_from date NOT NULL, valid_to date,
 source text NOT NULL CHECK (source IN ('owner_direct','worker_reported_by_owner')),
 confirmation text NOT NULL DEFAULT 'unconfirmed' CHECK (confirmation IN ('unconfirmed','owner_confirmed')),
 confirmed_at timestamptz, confirmed_by uuid REFERENCES auth.users(id),
 revision int NOT NULL DEFAULT 1 CHECK (revision>0),
 created_by uuid, updated_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (business_id,employee_id) REFERENCES public.employees(business_id,id) ON DELETE CASCADE,
 FOREIGN KEY (business_id,location_id) REFERENCES public.locations(business_id,id) ON DELETE RESTRICT,
 FOREIGN KEY (business_id,qualification_code) REFERENCES public.scheduling_qualification_types(business_id,code) ON DELETE RESTRICT,
 CHECK (valid_to IS NULL OR valid_to >= valid_from),
 CHECK ((confirmation='unconfirmed' AND confirmed_at IS NULL AND confirmed_by IS NULL)
     OR (confirmation='owner_confirmed' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL))
);

CREATE TABLE public.scheduling_coverage_requirements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 location_id uuid NOT NULL,
 day_of_week smallint CHECK(day_of_week BETWEEN 0 AND 6),
 local_date date,
 effective_from date, effective_to date,
 start_local time NOT NULL, end_local time NOT NULL, overnight boolean NOT NULL DEFAULT false,
 min_headcount smallint NOT NULL CHECK (min_headcount BETWEEN 0 AND 50),
 qualification_code text, min_overlap_minutes int NOT NULL DEFAULT 0 CHECK (min_overlap_minutes BETWEEN 0 AND 1440),
 priority text NOT NULL DEFAULT 'required' CHECK (priority IN ('required','advisory')),
 source text NOT NULL CHECK (source IN ('owner_direct','worker_reported_by_owner')),
 confirmation text NOT NULL DEFAULT 'unconfirmed' CHECK (confirmation IN ('unconfirmed','owner_confirmed')),
 confirmed_at timestamptz, confirmed_by uuid REFERENCES auth.users(id),
 revision int NOT NULL DEFAULT 1 CHECK (revision>0),
 created_by uuid, updated_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (business_id,location_id) REFERENCES public.locations(business_id,id) ON DELETE RESTRICT,
 FOREIGN KEY (business_id,qualification_code) REFERENCES public.scheduling_qualification_types(business_id,code) ON DELETE RESTRICT,
 CHECK ((day_of_week IS NULL) <> (local_date IS NULL)),
 CHECK (local_date IS NOT NULL OR effective_from IS NOT NULL),
 CHECK (effective_to IS NULL OR (effective_from IS NOT NULL AND effective_to>=effective_from)),
 CHECK (start_local <> end_local AND (overnight = (end_local < start_local))),
 CHECK ((confirmation='unconfirmed' AND confirmed_at IS NULL AND confirmed_by IS NULL)
     OR (confirmation='owner_confirmed' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL))
);

CREATE TABLE public.staff_scheduling_compensation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 employee_id uuid NOT NULL,
 cash_cost_state text NOT NULL CHECK (cash_cost_state IN ('unknown','known_paid','salary_conversion_pending','known_eligible_zero')),
 eligibility_reference text, eligibility_verified_by uuid REFERENCES auth.users(id), eligibility_verified_at timestamptz,
 revision int NOT NULL DEFAULT 1 CHECK (revision>0),
 created_by uuid, updated_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (business_id,employee_id),
 FOREIGN KEY (business_id,employee_id) REFERENCES public.employees(business_id,id) ON DELETE CASCADE,
 CHECK (cash_cost_state <> 'known_eligible_zero' OR
    (length(btrim(coalesce(eligibility_reference,''))) BETWEEN 8 AND 240 AND eligibility_verified_by IS NOT NULL AND eligibility_verified_at IS NOT NULL)),
 CHECK (cash_cost_state='known_eligible_zero' OR
    (eligibility_reference IS NULL AND eligibility_verified_by IS NULL AND eligibility_verified_at IS NULL))
);
-- No backfill: an absent row means UNKNOWN, even if legacy cached wages = 0.
-- 'known_eligible_zero' means documented OWNER attestation, NOT legal adjudication.

CREATE TABLE public.scheduling_foundation_audit_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 table_name text NOT NULL, record_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')),
 actor_user_id uuid, before_value jsonb, after_value jsonb,
 recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_availability_rules_lookup_idx ON public.staff_availability_rules(business_id,employee_id,day_of_week,effective_from);
CREATE INDEX staff_availability_exceptions_lookup_idx ON public.staff_availability_exceptions(business_id,employee_id,local_date);
CREATE INDEX staff_preferences_lookup_idx ON public.staff_scheduling_preferences(business_id,employee_id,effective_from);
CREATE INDEX staff_preference_windows_lookup_idx ON public.staff_preference_windows(business_id,employee_id,day_of_week);
CREATE INDEX staff_qualifications_lookup_idx ON public.staff_qualifications(business_id,employee_id,qualification_code);
CREATE INDEX coverage_requirements_lookup_idx ON public.scheduling_coverage_requirements(business_id,location_id,local_date,day_of_week);
CREATE INDEX scheduling_foundation_audit_idx ON public.scheduling_foundation_audit_events(business_id,table_name,record_id,recorded_at DESC);

-- Attestation status cannot silently override a real positive wage or mistake
-- an unconverted salary for free labor. No legacy salary/wage rows are changed.
CREATE FUNCTION public.scheduling_check_compensation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE e record;
BEGIN
 -- Lock the employee while validating an attestation. Without this lock a
 -- concurrent employee wage UPDATE could finish before the attestation commits,
 -- leaving a zero-cost row that escaped the wage-change trigger.
 SELECT wage_period,wage_amount_cents,default_hourly_wage_cents
 INTO e FROM public.employees
 WHERE business_id=NEW.business_id AND id=NEW.employee_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'employee not in business'; END IF;
 IF NEW.cash_cost_state='known_eligible_zero' THEN
   IF coalesce(e.wage_amount_cents,0)>0 OR coalesce(e.default_hourly_wage_cents,0)>0 THEN
     RAISE EXCEPTION 'positive recorded wage cannot be marked zero';
   END IF;
   NEW.eligibility_verified_by := auth.uid();
   NEW.eligibility_verified_at := now();
   IF NEW.eligibility_verified_by IS NULL THEN RAISE EXCEPTION 'owner attestation required'; END IF;
 ELSIF NEW.cash_cost_state='salary_conversion_pending' THEN
   IF e.wage_period NOT IN ('month','year') OR coalesce(e.wage_amount_cents,0)<=0
       OR coalesce(e.default_hourly_wage_cents,0)>0 THEN
     RAISE EXCEPTION 'salary conversion status disagrees with employee wage fields';
   END IF;
   NEW.eligibility_reference:=NULL; NEW.eligibility_verified_by:=NULL; NEW.eligibility_verified_at:=NULL;
 ELSIF NEW.cash_cost_state='known_paid' THEN
   IF coalesce(e.wage_amount_cents,0)<=0 OR
       (e.wage_period IN ('month','year') AND coalesce(e.default_hourly_wage_cents,0)<=0) THEN
     RAISE EXCEPTION 'paid wage is missing or salary conversion pending';
   END IF;
   NEW.eligibility_reference:=NULL; NEW.eligibility_verified_by:=NULL; NEW.eligibility_verified_at:=NULL;
 ELSE
   NEW.eligibility_reference:=NULL; NEW.eligibility_verified_by:=NULL; NEW.eligibility_verified_at:=NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER scheduling_validate_compensation BEFORE INSERT OR UPDATE ON public.staff_scheduling_compensation
FOR EACH ROW EXECUTE FUNCTION public.scheduling_check_compensation();

-- Every change to canonical employee wage fields (including the existing
-- Manage Staff updateEmployee() action, legacy importers and direct tenant-scoped
-- writes) invalidates a previously attested zero cash cost once a positive wage
-- is recorded. Do NOT change employee wages, timecards, assigned shifts, or
-- existing financial calculations here. Changing only the name/role is inert.
-- The compensation stamp/audit triggers below record the invalidation with a
-- fresh revision, remove eligibility evidence, and keep the wage update atomic.
CREATE FUNCTION public.scheduling_invalidate_zero_on_employee_wage_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF coalesce(NEW.wage_amount_cents,0)>0
    OR coalesce(NEW.default_hourly_wage_cents,0)>0 THEN
   UPDATE public.staff_scheduling_compensation
      SET cash_cost_state='unknown',
          eligibility_reference=NULL, eligibility_verified_by=NULL,
          eligibility_verified_at=NULL
    WHERE business_id=NEW.business_id AND employee_id=NEW.id
      AND cash_cost_state='known_eligible_zero';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER scheduling_invalidate_zero_on_employee_wage_change
AFTER UPDATE OF wage_period, wage_amount_cents, default_hourly_wage_cents
ON public.employees FOR EACH ROW
WHEN (OLD.wage_period IS DISTINCT FROM NEW.wage_period
   OR OLD.wage_amount_cents IS DISTINCT FROM NEW.wage_amount_cents
   OR OLD.default_hourly_wage_cents IS DISTINCT FROM NEW.default_hourly_wage_cents)
EXECUTE FUNCTION public.scheduling_invalidate_zero_on_employee_wage_change();
REVOKE ALL ON FUNCTION public.scheduling_invalidate_zero_on_employee_wage_change()
FROM PUBLIC,anon,authenticated;

-- Consistent provenance and immutable identity, incrementing revision on change.
CREATE FUNCTION public.scheduling_stamp_foundation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF TG_OP='INSERT' THEN
   NEW.created_by := auth.uid(); NEW.updated_by := auth.uid();
   NEW.revision := 1; NEW.created_at := now(); NEW.updated_at := now();
 ELSE
   IF NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.id IS DISTINCT FROM OLD.id THEN
     RAISE EXCEPTION 'cannot change scheduling record identity';
   END IF;
   NEW.created_by := OLD.created_by; NEW.created_at := OLD.created_at;
   NEW.updated_by := auth.uid(); NEW.updated_at := now(); NEW.revision := OLD.revision+1;
 END IF;

 RETURN NEW;
END $$;
-- Use a separate trigger for confirmation-bearing rows because PostgreSQL
-- records have table-specific fields; qualification types/compensation lack them.
CREATE FUNCTION public.scheduling_stamp_confirmation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NEW.confirmation='owner_confirmed' THEN
   NEW.confirmed_by := auth.uid();
   NEW.confirmed_at := CASE WHEN TG_OP='UPDATE' AND OLD.confirmation='owner_confirmed'
     THEN OLD.confirmed_at ELSE now() END;
 ELSE
   NEW.confirmed_by := NULL; NEW.confirmed_at := NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION public.scheduling_log_foundation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 -- Parent-business cascades must not attempt to resurrect an audit FK row.
 IF TG_OP='DELETE' AND NOT EXISTS
   (SELECT 1 FROM public.businesses WHERE id=OLD.business_id) THEN
   RETURN NULL;
 END IF;
 IF TG_OP='INSERT' THEN
   INSERT INTO public.scheduling_foundation_audit_events
   (business_id,table_name,record_id,operation,actor_user_id,after_value)
   VALUES (NEW.business_id,TG_TABLE_NAME,NEW.id,TG_OP,auth.uid(),to_jsonb(NEW));
 ELSIF TG_OP='UPDATE' THEN
   INSERT INTO public.scheduling_foundation_audit_events
   (business_id,table_name,record_id,operation,actor_user_id,before_value,after_value)
   VALUES (NEW.business_id,TG_TABLE_NAME,NEW.id,TG_OP,auth.uid(),to_jsonb(OLD),to_jsonb(NEW));
 ELSE
   INSERT INTO public.scheduling_foundation_audit_events
   (business_id,table_name,record_id,operation,actor_user_id,before_value)
   VALUES (OLD.business_id,TG_TABLE_NAME,OLD.id,TG_OP,auth.uid(),to_jsonb(OLD));
 END IF;
 RETURN NULL;
END $$;
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY[
  'staff_availability_rules','staff_availability_exceptions',
  'staff_scheduling_preferences','staff_preference_windows',
  'scheduling_qualification_types','staff_qualifications',
  'scheduling_coverage_requirements','staff_scheduling_compensation'
 ] LOOP
  EXECUTE format('CREATE TRIGGER scheduling_stamp BEFORE INSERT OR UPDATE ON public.%I
    FOR EACH ROW EXECUTE FUNCTION public.scheduling_stamp_foundation()',t);
  EXECUTE format('CREATE TRIGGER scheduling_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I
    FOR EACH ROW EXECUTE FUNCTION public.scheduling_log_foundation()',t);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY "owner reads" ON public.%I FOR SELECT USING (public.scheduling_is_owner(business_id))',t);
  EXECUTE format('CREATE POLICY "owner inserts" ON public.%I FOR INSERT WITH CHECK (public.scheduling_is_owner(business_id))',t);
  EXECUTE format('CREATE POLICY "owner updates" ON public.%I FOR UPDATE USING (public.scheduling_is_owner(business_id)) WITH CHECK (public.scheduling_is_owner(business_id))',t);
  EXECUTE format('CREATE POLICY "owner deletes" ON public.%I FOR DELETE USING (public.scheduling_is_owner(business_id))',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO authenticated',t);
 END LOOP;
END $$;
-- Only owner may see the private append-only audit; no direct user writes.
ALTER TABLE public.scheduling_foundation_audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads" ON public.scheduling_foundation_audit_events
 FOR SELECT USING (public.scheduling_is_owner(business_id));
REVOKE ALL ON public.scheduling_foundation_audit_events FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.scheduling_foundation_audit_events TO authenticated;
REVOKE ALL ON FUNCTION public.scheduling_check_compensation() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.scheduling_stamp_foundation() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.scheduling_stamp_confirmation() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.scheduling_log_foundation() FROM PUBLIC,anon,authenticated;
-- Confirmation stamping AFTER generic revision stamping (trigger alphabetical order).
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY[
  'staff_availability_rules','staff_availability_exceptions',
  'staff_scheduling_preferences','staff_preference_windows',
  'staff_qualifications','scheduling_coverage_requirements'
 ] LOOP
  EXECUTE format('CREATE TRIGGER scheduling_stamp_confirmation BEFORE INSERT OR UPDATE ON public.%I
    FOR EACH ROW EXECUTE FUNCTION public.scheduling_stamp_confirmation()',t);
 END LOOP;
END $$;
