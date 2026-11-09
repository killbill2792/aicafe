-- POS0b: preserve legitimate Toast time-entry revisions without rewriting identical
-- provider versions. The existing stage trigger captures only INSERT/UPDATE,
-- so unchanged modified-scan replays must not manufacture new archive snapshots.
-- Scope is existing time-entry staging; no second importer/reader/cron.
CREATE OR REPLACE FUNCTION public.toast_stage_labor_entries(
 p_business_id uuid,p_restaurant_guid uuid,p_location_id uuid,p_rows jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n integer;
BEGIN
 IF jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows)>100
 OR NOT EXISTS (
   SELECT 1 FROM public.toast_location_mappings
   WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
     AND location_id=p_location_id AND verified_at IS NOT NULL
 ) THEN RAISE EXCEPTION 'invalid labor batch'; END IF;
 INSERT INTO public.toast_labor_entries(
  business_id,restaurant_guid,location_id,external_time_entry_id,external_employee_id,
  clock_in,clock_out,hourly_wage_cents,wage_status,breaks,deleted,
  provider_modified_at,fetched_at,provider_regular_hours,provider_overtime_hours
 )
 SELECT p_business_id,p_restaurant_guid,p_location_id,t.external_time_entry_id,
  t.external_employee_id,t.clock_in,t.clock_out,t.hourly_wage_cents,
  t.wage_status,t.breaks,t.deleted,t.provider_modified_at,now(),
  t.provider_regular_hours,t.provider_overtime_hours
 FROM jsonb_to_recordset(p_rows) AS t(
  external_time_entry_id uuid,external_employee_id uuid,clock_in timestamptz,
  clock_out timestamptz,hourly_wage_cents bigint,wage_status text,breaks jsonb,
  deleted boolean,provider_modified_at timestamptz,
  provider_regular_hours numeric,provider_overtime_hours numeric
 )
 ON CONFLICT (business_id,restaurant_guid,external_time_entry_id) DO UPDATE SET
  external_employee_id=EXCLUDED.external_employee_id,
  clock_in=EXCLUDED.clock_in,clock_out=EXCLUDED.clock_out,
  hourly_wage_cents=EXCLUDED.hourly_wage_cents,wage_status=EXCLUDED.wage_status,
  breaks=EXCLUDED.breaks,deleted=EXCLUDED.deleted,
  provider_modified_at=EXCLUDED.provider_modified_at,fetched_at=now(),
  provider_regular_hours=EXCLUDED.provider_regular_hours,
  provider_overtime_hours=EXCLUDED.provider_overtime_hours
 WHERE (
  (EXCLUDED.provider_modified_at IS NOT NULL AND
   (toast_labor_entries.provider_modified_at IS NULL OR
    EXCLUDED.provider_modified_at >= toast_labor_entries.provider_modified_at))
  OR (EXCLUDED.provider_modified_at IS NULL AND
      toast_labor_entries.provider_modified_at IS NULL)
 ) AND ROW(
  toast_labor_entries.external_employee_id,toast_labor_entries.clock_in,
  toast_labor_entries.clock_out,toast_labor_entries.hourly_wage_cents,
  toast_labor_entries.wage_status,toast_labor_entries.breaks,
  toast_labor_entries.deleted,toast_labor_entries.provider_modified_at,
  toast_labor_entries.provider_regular_hours,toast_labor_entries.provider_overtime_hours
 ) IS DISTINCT FROM ROW(
  EXCLUDED.external_employee_id,EXCLUDED.clock_in,EXCLUDED.clock_out,
  EXCLUDED.hourly_wage_cents,EXCLUDED.wage_status,EXCLUDED.breaks,
  EXCLUDED.deleted,EXCLUDED.provider_modified_at,
  EXCLUDED.provider_regular_hours,EXCLUDED.provider_overtime_hours
 );
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.toast_stage_labor_entries(uuid,uuid,uuid,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.toast_stage_labor_entries(uuid,uuid,uuid,jsonb)
 TO service_role;
