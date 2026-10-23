-- Harden the existing staff workspace RPC at the SQL trust boundary.
-- The server's Zod validation is not sufficient: authenticated owners can call RPC
-- directly. Reject missing/incorrect JSON field types before any data changes.
-- Does not rewrite existing employee, payroll, availability or shift records.
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
  v_change_availability boolean;
  v_windows jsonb;
BEGIN
  IF p_business_id IS NULL OR auth.uid() IS NULL
     OR NOT public.scheduling_is_owner(p_business_id)
     OR NOT EXISTS (SELECT 1 FROM public.businesses
                    WHERE id=p_business_id AND is_demo=false) THEN
    RAISE EXCEPTION 'owner authorization required' USING ERRCODE='42501';
  END IF;

  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid person request' USING ERRCODE='22023';
  END IF;
  v_change_availability := coalesce(jsonb_typeof(p_payload->'availability')='array',false);
  IF NOT v_change_availability AND
     (p_id IS NULL OR jsonb_typeof(p_payload->'availability') IS DISTINCT FROM 'null') THEN
    RAISE EXCEPTION 'invalid availability request' USING ERRCODE='22023';
  END IF;
  v_windows := CASE WHEN v_change_availability
                    THEN p_payload->'availability' ELSE '[]'::jsonb END;

  -- Validate type *and* value: PostgreSQL's NULL-valued comparisons inside a
  -- compound IF can otherwise let incomplete JSON skip the entire guard.
  IF jsonb_typeof(p_payload->'name') IS DISTINCT FROM 'string'
     OR length(btrim(p_payload->>'name')) NOT BETWEEN 1 AND 80
     OR coalesce(jsonb_typeof(p_payload->'role'),'null') NOT IN ('string','null')
     OR length(coalesce(p_payload->>'role','')) > 60
     OR coalesce(jsonb_typeof(p_payload->'phone'),'null') NOT IN ('string','null')
     OR (jsonb_typeof(p_payload->'phone')='string' AND
         (p_payload->>'phone') !~ '^[+][1-9][0-9]{1,14}$')
     OR coalesce(jsonb_typeof(p_payload->'wageCents'),'null') NOT IN ('number','null')
     OR (jsonb_typeof(p_payload->'wageCents')='number' AND
         (p_payload->>'wageCents') !~ '^[1-9][0-9]{0,15}$')
     OR coalesce(jsonb_typeof(p_payload->'minWeeklyMinutes'),'null') NOT IN ('number','null')
     OR coalesce(jsonb_typeof(p_payload->'maxWeeklyMinutes'),'null') NOT IN ('number','null')
     OR (jsonb_typeof(p_payload->'minWeeklyMinutes')='number' AND
         (p_payload->>'minWeeklyMinutes') !~ '^(0|[1-9][0-9]{0,4})$')
     OR (jsonb_typeof(p_payload->'maxWeeklyMinutes')='number' AND
         (p_payload->>'maxWeeklyMinutes') !~ '^(0|[1-9][0-9]{0,4})$')
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) AS k(key)
                WHERE k.key NOT IN ('name','role','wageCents','phone',
                  'minWeeklyMinutes','maxWeeklyMinutes','availability'))
     OR jsonb_array_length(v_windows) > 7 THEN
    RAISE EXCEPTION 'invalid person request' USING ERRCODE='22023';
  END IF;

  -- These casts are safe only AFTER the numeric syntax checks above.
  IF coalesce((p_payload->>'minWeeklyMinutes')::integer > 10080,false)
     OR coalesce((p_payload->>'maxWeeklyMinutes')::integer > 10080,false)
     OR ((p_payload->>'minWeeklyMinutes') IS NOT NULL
       AND (p_payload->>'maxWeeklyMinutes') IS NOT NULL
       AND (p_payload->>'minWeeklyMinutes')::integer >
           (p_payload->>'maxWeeklyMinutes')::integer) THEN
    RAISE EXCEPTION 'invalid weekly limits' USING ERRCODE='22023';
  END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_windows) AS a(value)
             WHERE jsonb_typeof(a.value) IS DISTINCT FROM 'object') THEN
    RAISE EXCEPTION 'invalid availability window' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_windows) AS a(value)
    WHERE EXISTS (SELECT 1 FROM jsonb_object_keys(a.value) AS k(key)
                  WHERE k.key NOT IN ('day','start','end'))
       OR jsonb_typeof(a.value->'day') IS DISTINCT FROM 'number'
       OR (a.value->>'day') !~ '^[0-6]$'
       OR coalesce(jsonb_typeof(a.value->'start'),'missing') NOT IN ('string','null')
       OR coalesce(jsonb_typeof(a.value->'end'),'missing') NOT IN ('string','null')
       OR ((a.value->>'start') IS NULL) <> ((a.value->>'end') IS NULL)
       OR (a.value->>'start') IS NOT NULL AND (
           (a.value->>'start') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
           OR (a.value->>'end') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
           OR (a.value->>'start')=(a.value->>'end'))
  ) OR (SELECT count(*) FROM jsonb_array_elements(v_windows))
       <> (SELECT count(DISTINCT a.value->>'day')
           FROM jsonb_array_elements(v_windows) AS a(value)) THEN
    RAISE EXCEPTION 'invalid availability window' USING ERRCODE='22023';
  END IF;

  PERFORM 1 FROM public.businesses WHERE id=p_business_id FOR SHARE;
  SELECT (now() AT TIME ZONE b.timezone)::date INTO v_today
    FROM public.businesses b WHERE b.id=p_business_id;
  v_previous := v_today - 1;

  IF v_change_availability THEN
    -- A day with both hours NULL means unavailable, not an available day.
    SELECT coalesce(array_agg((a.value->>'day')::smallint
                              ORDER BY (a.value->>'day')::smallint),
                    ARRAY[]::smallint[])
      INTO v_days
      FROM jsonb_array_elements(v_windows) AS a(value)
      WHERE a.value->>'start' IS NOT NULL;
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.employees (
      business_id,display_name,role,wage_period,wage_amount_cents,
      default_hourly_wage_cents,phone_e164,min_weekly_minutes,
      max_weekly_minutes,available_days,active
    ) VALUES (
      p_business_id,btrim(p_payload->>'name'),nullif(btrim(p_payload->>'role'),''),
      'hour',(p_payload->>'wageCents')::bigint,(p_payload->>'wageCents')::bigint,
      nullif(p_payload->>'phone',''),(p_payload->>'minWeeklyMinutes')::integer,
      (p_payload->>'maxWeeklyMinutes')::integer,v_days,true
    ) RETURNING id INTO v_id;
  ELSE
    PERFORM 1 FROM public.employees
      WHERE business_id=p_business_id AND id=p_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'employee not found' USING ERRCODE='P0002';
    END IF;
    v_id := p_id;
    UPDATE public.employees SET
      display_name=btrim(p_payload->>'name'),
      role=nullif(btrim(p_payload->>'role'),''),
      -- A derived hourly rate must never overwrite canonical salary.
      wage_amount_cents=CASE WHEN wage_period='hour'
        THEN (p_payload->>'wageCents')::bigint ELSE wage_amount_cents END,
      default_hourly_wage_cents=CASE WHEN wage_period='hour'
        THEN (p_payload->>'wageCents')::bigint ELSE default_hourly_wage_cents END,
      phone_e164=nullif(p_payload->>'phone',''),
      min_weekly_minutes=(p_payload->>'minWeeklyMinutes')::integer,
      max_weekly_minutes=(p_payload->>'maxWeeklyMinutes')::integer,
      available_days=CASE WHEN v_change_availability THEN v_days ELSE available_days END
      WHERE business_id=p_business_id AND id=v_id;
  END IF;

  -- Preserve historical rules, the employee-lock trigger, revisions and audit.
  -- This transaction either updates all today's owner windows or none.
  IF v_change_availability THEN
    UPDATE public.staff_availability_rules SET effective_to=v_previous
     WHERE business_id=p_business_id AND employee_id=v_id
       AND source='owner_direct' AND effective_from < v_today
       AND (effective_to IS NULL OR effective_to >= v_today);
    DELETE FROM public.staff_availability_rules
     WHERE business_id=p_business_id AND employee_id=v_id
       AND source='owner_direct' AND effective_from >= v_today;
    FOR v_day IN SELECT value FROM jsonb_array_elements(v_windows) LOOP
      v_start := v_day->>'start';
      v_end := v_day->>'end';
      IF v_start IS NOT NULL THEN
        INSERT INTO public.staff_availability_rules
          (business_id,employee_id,day_of_week,start_local,end_local,
           overnight,effective_from,effective_to,source,confirmation)
        VALUES (p_business_id,v_id,(v_day->>'day')::smallint,
          v_start::time,v_end::time,(v_end < v_start),v_today,NULL,
          'owner_direct','unconfirmed');
      END IF;
    END LOOP;
  END IF;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.staff_write_person(uuid,uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.staff_write_person(uuid,uuid,jsonb) TO authenticated;
