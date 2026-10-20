-- Additive, nullable staffing policy; NULL retains prior headcount semantics.
-- These are owner staffing targets, not statutory break requirements.
ALTER TABLE public.scheduling_coverage_requirements
 ADD COLUMN min_headcount_during_break smallint
 CHECK (min_headcount_during_break BETWEEN 0 AND 50 AND
        min_headcount_during_break <= min_headcount);
COMMENT ON COLUMN public.scheduling_coverage_requirements.min_headcount_during_break
 IS 'Optional owner-specified coverage floor while a real duty-free break is taken; NULL uses min_headcount.';

-- Preserve the existing authorization, idempotency, receipts, RLS and audit
-- behavior; only extend the permitted typed coverage input allowlist.
CREATE OR REPLACE FUNCTION public.scheduling_create_foundation(
 p_business_id uuid, p_kind text, p_request_key uuid, p_record jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
 v_table text;
 v_allowed text[];
 v_columns text;
 v_values text;
 v_claim_count integer;
 v_kind text;
 v_payload jsonb;
 v_id uuid;
 v_revision integer;
BEGIN
 IF auth.uid() IS NULL OR NOT public.scheduling_is_owner(p_business_id)
    OR p_business_id = '11111111-1111-1111-1111-111111111111'::uuid
    OR NOT EXISTS (SELECT 1 FROM public.businesses
      WHERE id=p_business_id AND is_demo=false) THEN
    RAISE EXCEPTION 'scheduling owner authorization required' USING ERRCODE='42501';
 END IF;
 IF p_request_key IS NULL OR jsonb_typeof(p_record) IS DISTINCT FROM 'object'
    OR p_record='{}'::jsonb THEN
   RAISE EXCEPTION 'invalid create request' USING ERRCODE='22023';
 END IF;

 CASE p_kind
  WHEN 'availability_rule' THEN
   v_table:='staff_availability_rules';
   v_allowed:=ARRAY['employee_id','location_id','day_of_week','start_local','end_local',
    'overnight','effective_from','effective_to','source','confirmation'];
  WHEN 'availability_exception' THEN
   v_table:='staff_availability_exceptions';
   v_allowed:=ARRAY['employee_id','location_id','local_date','exception_type',
    'start_local','end_local','overnight','max_minutes','source','confirmation'];
  WHEN 'preferences' THEN
   v_table:='staff_scheduling_preferences';
   v_allowed:=ARRAY['employee_id','effective_from','effective_to','min_weekly_minutes',
    'desired_weekly_minutes','max_weekly_minutes','max_daily_minutes','unavailable_weekdays','source','confirmation'];
  WHEN 'preference_window' THEN
   v_table:='staff_preference_windows';
   v_allowed:=ARRAY['employee_id','day_of_week','start_local','end_local','overnight',
    'preference','strength','effective_from','effective_to','source','confirmation'];
  WHEN 'qualification_type' THEN
   v_table:='scheduling_qualification_types';
   v_allowed:=ARRAY['code','display_name','active'];
  WHEN 'qualification' THEN
   v_table:='staff_qualifications';
   v_allowed:=ARRAY['employee_id','location_id','qualification_code','valid_from','valid_to',
    'source','confirmation'];
  WHEN 'coverage' THEN
   v_table:='scheduling_coverage_requirements';
   v_allowed:=ARRAY['location_id','day_of_week','local_date','effective_from','effective_to',
    'start_local','end_local','overnight','min_headcount',
     'min_headcount_during_break','qualification_code',
    'min_overlap_minutes','priority','source','confirmation'];
  WHEN 'compensation' THEN
   v_table:='staff_scheduling_compensation';
   v_allowed:=ARRAY['employee_id','cash_cost_state','eligibility_reference'];
  ELSE
   RAISE EXCEPTION 'invalid scheduling record kind' USING ERRCODE='22023';
 END CASE;
 IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_record) AS k(field)
     WHERE NOT (k.field = ANY(v_allowed))) THEN
   RAISE EXCEPTION 'forbidden scheduling create column' USING ERRCODE='22023';
 END IF;

 -- Serialize individual recurring/date-specific creates against scope batches.
 -- The batch and this RPC both lock the canonical employee BEFORE claiming
 -- a request receipt; existing same-key retries remain idempotent.
 IF p_kind IN ('availability_rule','availability_exception') THEN
   PERFORM 1 FROM public.employees WHERE business_id=p_business_id
     AND id=(p_record->>'employee_id')::uuid FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'unknown availability employee'
      USING ERRCODE='23503'; END IF;
 END IF;

 -- The primary key (business_id, request_key) is independent of payload and
 -- kind: reusing a key for different work returns a typed conflict instead.
 -- PostgreSQL ON CONFLICT waits for the concurrent winner to commit/abort.
 INSERT INTO public.scheduling_foundation_create_receipts
  (business_id,request_key,kind,request_payload)
 VALUES(p_business_id,p_request_key,p_kind,p_record)
 ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS v_claim_count=ROW_COUNT;
 SELECT kind,request_payload,record_id,record_revision
 INTO v_kind,v_payload,v_id,v_revision
 FROM public.scheduling_foundation_create_receipts
 WHERE business_id=p_business_id AND request_key=p_request_key FOR UPDATE;
 IF v_claim_count=0 THEN
   IF v_kind IS DISTINCT FROM p_kind OR v_payload IS DISTINCT FROM p_record THEN
     RETURN jsonb_build_object('conflict',true);
   END IF;
   IF v_id IS NULL OR v_revision IS NULL THEN
     RAISE EXCEPTION 'unfinished scheduling create receipt' USING ERRCODE='40001';
   END IF;
   RETURN jsonb_build_object('id',v_id,'revision',v_revision,'replayed',true);
 END IF;

 -- No unversioned new create may append stale windows to a scope after a
 -- different owner committed its complete manifest-based replacement.
 IF p_kind IN ('availability_rule','availability_exception') AND EXISTS(
   SELECT 1 FROM public.scheduling_availability_batch_receipts receipt
   WHERE receipt.business_id=p_business_id
     AND receipt.employee_id=(p_record->>'employee_id')::uuid
     AND receipt.kind=p_kind
     AND receipt.location_id IS NOT DISTINCT FROM (p_record->>'location_id')::uuid
     AND receipt.result IS NOT NULL
     AND receipt.result->>'conflict' IS DISTINCT FROM 'true'
     AND ((p_kind='availability_rule'
        AND receipt.edit_scope->>'effective_from'=p_record->>'effective_from'
        AND receipt.edit_scope->>'effective_to' IS NOT DISTINCT FROM p_record->>'effective_to')
       OR (p_kind='availability_exception'
        AND receipt.edit_scope->>'local_date'=p_record->>'local_date'))
 ) THEN
   RAISE EXCEPTION 'availability scope requires versioned batch writes'
     USING ERRCODE='42501';
 END IF;

 SELECT string_agg(format('%I',field),',' ORDER BY field),
        string_agg(format('r.%I',field),',' ORDER BY field)
 INTO v_columns,v_values
 FROM jsonb_object_keys(p_record) AS k(field);

 -- The original source keys are whitelisted; populate the target row type to
 -- enforce Postgres casting and all original FK/check/stamp/audit triggers.
 EXECUTE format(
   'INSERT INTO public.%I (business_id,%s) SELECT $1,%s
      FROM jsonb_populate_record(NULL::public.%I,$2) AS r
      RETURNING id,revision',
    v_table,v_columns,v_values,v_table)
 USING p_business_id,p_record INTO v_id,v_revision;
 UPDATE public.scheduling_foundation_create_receipts
 SET record_id=v_id,record_revision=v_revision
 WHERE business_id=p_business_id AND request_key=p_request_key;
 RETURN jsonb_build_object('id',v_id,'revision',v_revision,'replayed',false);
END $$;
