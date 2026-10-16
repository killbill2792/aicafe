-- Olivia PR4B-A: transactional multi-employee availability command.
-- New migration only. Never run against production without owner approval.
-- Uses PR1B's existing audited, revision-checked batch RPC for every scope.
-- Preserve PR1B's full-scope CAS, per-batch receipts and positional row
-- receipts while avoiding revision/audit churn on unchanged desired rows.
-- This is an additive PR4B migration; the original PR1B migration is untouched.
CREATE OR REPLACE FUNCTION public.scheduling_save_availability_batch(
 p_business_id uuid, p_employee_id uuid, p_location_id uuid, p_kind text,
 p_scope jsonb, p_expected jsonb, p_desired jsonb, p_request_key uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
 v_table text; v_keys text[];
 v_affected int; v_receipt public.scheduling_availability_batch_receipts%ROWTYPE;
 v_actual jsonb; v_expected jsonb; v_result jsonb:='[]'::jsonb;
 v_item jsonb; v_record jsonb; v_old jsonb;
 v_id uuid; v_rev integer;
 v_set_clause text; v_columns text; v_values text;

BEGIN
 IF p_business_id IS NULL OR auth.uid() IS NULL
   OR NOT public.scheduling_is_owner(p_business_id)
   OR NOT EXISTS(SELECT 1 FROM public.businesses
                  WHERE id=p_business_id AND is_demo=false) THEN
   RAISE EXCEPTION 'scheduling owner authorization required' USING ERRCODE='42501';
 END IF;
 IF p_request_key IS NULL OR p_employee_id IS NULL
    OR jsonb_typeof(p_scope)<>'object' OR jsonb_typeof(p_expected)<>'array'
    OR jsonb_typeof(p_desired)<>'array'
    OR jsonb_array_length(p_expected)>200 OR jsonb_array_length(p_desired)>200 THEN
   RAISE EXCEPTION 'invalid batch request' USING ERRCODE='22023';
 END IF;
 IF p_kind='availability_rule' THEN
   v_table:='staff_availability_rules';
   IF (p_scope ? 'effective_from') IS NOT TRUE OR
      EXISTS(SELECT 1 FROM jsonb_object_keys(p_scope) AS k(x)
             WHERE k.x NOT IN('effective_from','effective_to')) THEN
     RAISE EXCEPTION 'invalid recurring scope' USING ERRCODE='22023';
   END IF;
   v_keys:=ARRAY['employee_id','location_id','day_of_week','start_local','end_local',
     'overnight','effective_from','effective_to','source','confirmation'];
 ELSEIF p_kind='availability_exception' THEN
   v_table:='staff_availability_exceptions';
   IF (SELECT count(*) FROM jsonb_object_keys(p_scope))<>1 OR NOT (p_scope ? 'local_date') THEN
     RAISE EXCEPTION 'invalid exception scope' USING ERRCODE='22023';
   END IF;
   v_keys:=ARRAY['employee_id','location_id','local_date','exception_type',
     'start_local','end_local','overnight','max_minutes','source','confirmation'];
 ELSE
   RAISE EXCEPTION 'invalid availability batch kind' USING ERRCODE='22023';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.employees
               WHERE business_id=p_business_id AND id=p_employee_id) THEN
   RAISE EXCEPTION 'employee not found' USING ERRCODE='23503';
 END IF;

 -- Lock canonical employee row: per-record trigger acquires same row lock.
 PERFORM 1 FROM public.employees
  WHERE business_id=p_business_id AND id=p_employee_id FOR UPDATE;
 -- Claim receipt under PostgreSQL's UNIQUE locking; concurrent same-key
 -- requests wait for winner and return its immutable original result.
 INSERT INTO public.scheduling_availability_batch_receipts
  (business_id,request_key,kind,employee_id,location_id,edit_scope,expected,desired)
 VALUES(p_business_id,p_request_key,p_kind,p_employee_id,p_location_id,
        p_scope,p_expected,p_desired)
 ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS v_affected=ROW_COUNT;
 SELECT * INTO v_receipt
 FROM public.scheduling_availability_batch_receipts
 WHERE business_id=p_business_id AND request_key=p_request_key FOR UPDATE;
 IF v_affected=0 THEN
   IF v_receipt.kind<>p_kind OR v_receipt.employee_id<>p_employee_id OR
     v_receipt.location_id IS DISTINCT FROM p_location_id OR
     v_receipt.edit_scope<>p_scope OR v_receipt.expected<>p_expected OR
     v_receipt.desired<>p_desired THEN
     RETURN jsonb_build_object('conflict',true);
   END IF;
   IF v_receipt.result IS NULL THEN
     RAISE EXCEPTION 'incomplete batch receipt' USING ERRCODE='40001';
   END IF;
   IF v_receipt.result->>'conflict'='true' THEN
     RETURN jsonb_build_object('conflict',true);
   END IF;
   RETURN jsonb_build_object('replayed',true,'records',v_receipt.result);
 END IF;

 -- Verify exact scope contents, including phantom additions/deletions, BEFORE
 -- any change. Sorting canonicalizes expected record ordering.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_expected) AS e(value)
           WHERE jsonb_typeof(e.value)<>'object' OR NOT (e.value ? 'id') OR NOT (e.value ? 'revision')) THEN
   RAISE EXCEPTION 'invalid expected manifest' USING ERRCODE='22023';
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'id', e.value->>'id', 'revision',(e.value->>'revision')::integer) ORDER BY e.value->>'id'),'[]'::jsonb)
 INTO v_expected FROM jsonb_array_elements(p_expected) AS e(value);
 IF p_kind='availability_rule' THEN
   SELECT coalesce(jsonb_agg(jsonb_build_object('id',id::text,'revision',revision)
       ORDER BY id::text),'[]'::jsonb)
   INTO v_actual FROM public.staff_availability_rules
   WHERE business_id=p_business_id AND employee_id=p_employee_id
     AND location_id IS NOT DISTINCT FROM p_location_id
     AND effective_from=(p_scope->>'effective_from')::date
     AND effective_to IS NOT DISTINCT FROM (p_scope->>'effective_to')::date;
 ELSE
   SELECT coalesce(jsonb_agg(jsonb_build_object('id',id::text,'revision',revision)
       ORDER BY id::text),'[]'::jsonb)
   INTO v_actual FROM public.staff_availability_exceptions
   WHERE business_id=p_business_id AND employee_id=p_employee_id
     AND location_id IS NOT DISTINCT FROM p_location_id
     AND local_date=(p_scope->>'local_date')::date;
 END IF;
 IF v_actual<>v_expected THEN
   -- Terminal CAS conflict: replaying the same request must report the same
   -- conflict, not an unfinished receipt/internal DB exception.
   UPDATE public.scheduling_availability_batch_receipts
    SET result='{"conflict":true}'::jsonb
    WHERE business_id=p_business_id AND request_key=p_request_key;
   RETURN jsonb_build_object('conflict',true);
 END IF;

 -- Every desired item is {id?:existingId,data:completeRecord}. Existing IDs
 -- must appear exactly once in current manifest; creates may not supply IDs.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_desired) AS e(value)
   WHERE jsonb_typeof(e.value)<>'object' OR jsonb_typeof(e.value->'data')<>'object'
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(e) k(x) WHERE k.x NOT IN ('id','data')))
   OR (SELECT count(*) FROM jsonb_array_elements(p_desired) AS e(value) WHERE e.value ? 'id')
     <> (SELECT count(DISTINCT e.value->>'id') FROM jsonb_array_elements(p_desired) AS e(value) WHERE e.value ? 'id') THEN
   RAISE EXCEPTION 'invalid desired record list' USING ERRCODE='22023';
 END IF;
 FOR v_item IN SELECT value FROM jsonb_array_elements(p_desired) LOOP
   v_record:=v_item->'data';
   IF EXISTS(SELECT 1 FROM jsonb_object_keys(v_record) AS k(x)
             WHERE NOT k.x=ANY(v_keys)) THEN
     RAISE EXCEPTION 'forbidden batch record key' USING ERRCODE='22023';
   END IF;
   IF v_record->>'employee_id' IS DISTINCT FROM p_employee_id::text
     OR ((v_record ? 'location_id') AND
         (v_record->>'location_id') IS DISTINCT FROM p_location_id::text)
     OR (p_location_id IS NOT NULL AND
         v_record->>'location_id' IS DISTINCT FROM p_location_id::text) THEN
     RAISE EXCEPTION 'batch employee/location mismatch' USING ERRCODE='22023';
   END IF;
   IF (p_kind='availability_rule' AND (
        v_record->>'effective_from' IS DISTINCT FROM p_scope->>'effective_from' OR
        coalesce(v_record->>'effective_to','') IS DISTINCT FROM coalesce(p_scope->>'effective_to','')))
     OR (p_kind='availability_exception' AND
        v_record->>'local_date' IS DISTINCT FROM p_scope->>'local_date') THEN
     RAISE EXCEPTION 'batch date scope mismatch' USING ERRCODE='22023';
   END IF;
   IF v_item ? 'id' THEN
     v_id:=(v_item->>'id')::uuid;
     IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_expected) AS e(value)
                   WHERE e.value->>'id'=v_id::text) THEN
       RAISE EXCEPTION 'record outside expected scope' USING ERRCODE='22023';
     END IF;
     SELECT string_agg(format('%I = r.%I',k,k),', ' ORDER BY k)
     INTO v_set_clause FROM jsonb_object_keys(v_record) AS j(k);
     -- PR4B correction: SQL record normalization compares typed values
     -- (time 08:00 vs 08:00:00) and avoids UPDATE triggers for true no-ops.
     -- The exact full-scope CAS above still guards all preserved row revisions.
     EXECUTE format(
        'UPDATE public.%I t SET %s FROM jsonb_populate_record(NULL::public.%I,$1) r
         WHERE t.business_id=$2 AND t.id=$3
         AND EXISTS (SELECT 1 FROM jsonb_object_keys($1) AS f(key)
           WHERE to_jsonb(t)->f.key IS DISTINCT FROM to_jsonb(r)->f.key)
         RETURNING t.id,t.revision',
         v_table,v_set_clause,v_table)
       USING v_record,p_business_id,v_id INTO v_id,v_rev;
     IF v_id IS NULL THEN
       -- No-op row: return its original revision in positional receipt,
       -- without touching revision, confirmed timestamp, or audit history.
       EXECUTE format('SELECT id,revision FROM public.%I
         WHERE business_id=$1 AND id=$2',v_table)
         USING p_business_id,(v_item->>'id')::uuid INTO v_id,v_rev;
       IF v_id IS NULL THEN
         RAISE EXCEPTION 'stale batch record' USING ERRCODE='40001';
       END IF;
     END IF;
   ELSE
     -- Batch writes use their OWN idempotent receipt and underlying audited
     -- triggers; the legacy unversioned single CREATE is forbidden after
     -- a scope has a committed batch receipt.
     SELECT string_agg(format('%I',key),',' ORDER BY key),
       string_agg(format('r.%I',key),',' ORDER BY key)
       INTO v_columns,v_values FROM jsonb_object_keys(v_record) AS fields(key);
     EXECUTE format(
       'INSERT INTO public.%I (business_id,%s) SELECT $1,%s
        FROM jsonb_populate_record(NULL::public.%I,$2) r
        RETURNING id,revision',v_table,v_columns,v_values,v_table)
       USING p_business_id,v_record INTO v_id,v_rev;
   END IF;
   v_result:=v_result||jsonb_build_array(jsonb_build_object('id',v_id,'revision',v_rev));
 END LOOP;

 -- Delete only expected records excluded from desired; verified scope and
 -- employee lock ensure no stale/foreign deletion, preserve per-row audit.
 FOR v_old IN SELECT value FROM jsonb_array_elements(p_expected) LOOP
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_desired) AS e(value)
                 WHERE e.value->>'id'=v_old->>'id') THEN
     EXECUTE format('DELETE FROM public.%I WHERE business_id=$1 AND id=$2',v_table)
       USING p_business_id,(v_old->>'id')::uuid;
   END IF;
 END LOOP;
 UPDATE public.scheduling_availability_batch_receipts
 SET result=v_result WHERE business_id=p_business_id AND request_key=p_request_key;
 RETURN jsonb_build_object('replayed',false,'records',v_result);
END $$;

-- Every table contributing to the PR3 scheduling source token obtains the
-- same café-scoped advisory transaction lock on writes. PR4B can then check
-- its source token without holding a table-wide SHARE lock across all cafés.
CREATE FUNCTION public.scheduling_olivia_source_write_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid;
BEGIN
  IF TG_OP='INSERT' THEN
    v_id:=NEW.business_id;
  ELSIF TG_OP='DELETE' THEN
    v_id:=OLD.business_id;
  ELSE
    -- Tenant moves are blocked by existing RLS/FKs for these source tables.
    IF OLD.business_id IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'cross-cafe scheduling source move denied' USING ERRCODE='42501';
    END IF;
    v_id:=NEW.business_id;
  END IF;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'missing scheduling source café' USING ERRCODE='23502';
  END IF;
  -- Multiple ordinary writers take compatible SHARED locks: preserve PR1B
  -- concurrent create/CAS behavior. Olivia PR3/PR4B takes EXCLUSIVE lock.
  -- DML may already hold row/table locks at this point, so fail fast instead
  -- of waiting for PR3's table SHARE lock (which could otherwise deadlock).
  -- The whole failed source write rolls back; callers can retry safely.
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('olivia-'||v_id::text,0)) THEN
    RAISE EXCEPTION 'Olivia scheduling source is busy; retry'
      USING ERRCODE='55P03';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION public.scheduling_olivia_source_write_guard()
  FROM PUBLIC,anon,authenticated;

DO $$
DECLARE v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'employees','locations','staff_availability_rules',
    'staff_availability_exceptions','staff_scheduling_preferences',
    'staff_preference_windows','scheduling_qualification_types',
    'staff_qualifications','scheduling_coverage_requirements',
    'staff_scheduling_compensation','staff_schedules',
    'scheduling_labor_rule_reviews'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER scheduling_olivia_source_write_guard
       BEFORE INSERT OR UPDATE OR DELETE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION public.scheduling_olivia_source_write_guard()',
      v_table);
  END LOOP;
END $$;

CREATE TABLE public.scheduling_olivia_command_receipts (
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  request_key uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES auth.users(id),
  payload jsonb NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, request_key)
);
ALTER TABLE public.scheduling_olivia_command_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scheduling_olivia_command_receipts FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.scheduling_olivia_commit_availability(
  p_business_id uuid, p_source_token text, p_request_key uuid, p_batches jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_receipt public.scheduling_olivia_command_receipts%ROWTYPE;
  v_payload jsonb; v_batch jsonb; v_item jsonb;
  v_claim integer; v_results jsonb := '[]'::jsonb;
  v_result jsonb; v_index integer := 0;
BEGIN
  IF v_actor IS NULL OR p_business_id IS NULL OR p_request_key IS NULL OR
     p_source_token IS NULL OR p_source_token !~ '^[a-f0-9]{32}$' OR
     jsonb_typeof(p_batches) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('error','invalid_input');
  END IF;
  IF jsonb_array_length(p_batches) NOT BETWEEN 1 AND 40 OR
     pg_column_size(p_batches) > 262144 THEN
    RETURN jsonb_build_object('error','invalid_input');
  END IF;
  IF NOT public.scheduling_is_owner(p_business_id) OR
     NOT EXISTS(SELECT 1 FROM public.businesses WHERE id=p_business_id
       AND is_demo=false) THEN
    RETURN jsonb_build_object('error','unauthorized');
  END IF;
  -- Match PR3's ownership and source lock ordering. A concurrent owner role
  -- removal or source edit cannot pass the source check and then race a write.
  PERFORM 1 FROM public.memberships WHERE business_id=p_business_id
    AND user_id=v_actor AND role='owner' FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','unauthorized'); END IF;
  PERFORM 1 FROM public.businesses WHERE id=p_business_id AND is_demo=false FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','unauthorized'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('olivia-'||p_business_id::text,0));
  -- Source writes to this café now share our advisory transaction lock.
  -- Unrelated cafés continue normal INSERT/UPDATE/DELETE without table locks.

  -- Reject malformed JSON/UUIDs and foreign café employees before claiming a
  -- receipt. An invalid input must never strand a NULL-result command receipt.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_batches) AS x(value)
    WHERE jsonb_typeof(x.value) IS DISTINCT FROM 'object'
      OR coalesce(x.value->>'employeeId','') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR coalesce(x.value->>'requestKey','') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR NOT (x.value ? 'locationId')
      OR (x.value->>'locationId' IS NOT NULL AND
          x.value->>'locationId' !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      OR coalesce(x.value->>'kind','') NOT IN
        ('availability_rule','availability_exception')
      OR jsonb_typeof(x.value->'scope') IS DISTINCT FROM 'object'
      OR jsonb_typeof(x.value->'expected') IS DISTINCT FROM 'array'
      OR jsonb_typeof(x.value->'desired') IS DISTINCT FROM 'array'
      OR CASE WHEN jsonb_typeof(x.value->'expected')='array'
           THEN jsonb_array_length(x.value->'expected')>200 ELSE true END
      OR CASE WHEN jsonb_typeof(x.value->'desired')='array'
           THEN jsonb_array_length(x.value->'desired')>200 ELSE true END) THEN
    RETURN jsonb_build_object('error','invalid_input');
  END IF;
  IF (SELECT count(*) FROM (
    SELECT DISTINCT (x.value->>'employeeId')::uuid AS id
    FROM jsonb_array_elements(p_batches) AS x(value)
  ) selected JOIN public.employees e ON e.business_id=p_business_id
    AND e.id=selected.id) IS DISTINCT FROM
  (SELECT count(DISTINCT x.value->>'employeeId')
   FROM jsonb_array_elements(p_batches) AS x(value)) THEN
    RETURN jsonb_build_object('error','invalid_input');
  END IF;

  v_payload:=jsonb_build_object('token',p_source_token,'batches',p_batches);
  INSERT INTO public.scheduling_olivia_command_receipts
    (business_id,request_key,actor_id,payload)
    VALUES(p_business_id,p_request_key,v_actor,v_payload)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_claim=ROW_COUNT;
  SELECT * INTO v_receipt FROM public.scheduling_olivia_command_receipts
    WHERE business_id=p_business_id AND request_key=p_request_key FOR UPDATE;
  IF v_claim=0 THEN
    IF v_receipt.actor_id IS DISTINCT FROM v_actor OR
       v_receipt.payload IS DISTINCT FROM v_payload OR v_receipt.result IS NULL
      THEN RETURN jsonb_build_object('error','conflict'); END IF;
    RETURN v_receipt.result || jsonb_build_object('replayed',true);
  END IF;

  IF public.scheduling_pr3_source_token_internal(p_business_id)
      IS DISTINCT FROM p_source_token THEN
    v_result:=jsonb_build_object('error','source_changed');
    UPDATE public.scheduling_olivia_command_receipts SET result=v_result
      WHERE business_id=p_business_id AND request_key=p_request_key;
    RETURN v_result;
  END IF;
  -- Lock affected employees in a stable order, after validating the payload.
  PERFORM 1 FROM public.employees
    WHERE business_id=p_business_id
      AND id IN (SELECT DISTINCT (x.value->>'employeeId')::uuid
        FROM jsonb_array_elements(p_batches) AS x(value))
    ORDER BY id FOR UPDATE;

  FOR v_batch IN SELECT value FROM jsonb_array_elements(p_batches) LOOP
    -- Existing PR1B RPC already validates exact full-scope manifest,
    -- revision/CAS, immutable receipt, tenant/actor, triggers and audit.
    v_item:=public.scheduling_save_availability_batch(
      p_business_id, (v_batch->>'employeeId')::uuid,
      (v_batch->>'locationId')::uuid, v_batch->>'kind',
      v_batch->'scope', v_batch->'expected', v_batch->'desired',
      (v_batch->>'requestKey')::uuid
    );
    IF v_item IS NULL OR v_item->>'conflict'='true' OR
       jsonb_typeof(v_item->'records') IS DISTINCT FROM 'array' THEN
      -- A typed conflict aborts the ENTIRE SQL transaction, including earlier
      -- employee edits/audit/receipts. No partial multi-employee commits.
      RAISE EXCEPTION 'Olivia availability revision conflict' USING ERRCODE='P4B01';
    END IF;
    v_results:=v_results||jsonb_build_array(jsonb_build_object(
      'batchIndex',v_index,'records',v_item->'records'));
    v_index:=v_index+1;
  END LOOP;
  v_result:=jsonb_build_object('batches',v_results,'actorId',v_actor);
  UPDATE public.scheduling_olivia_command_receipts SET result=v_result
    WHERE business_id=p_business_id AND request_key=p_request_key;
  RETURN v_result||jsonb_build_object('replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.scheduling_olivia_commit_availability(
  uuid,text,uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.scheduling_olivia_commit_availability(
  uuid,text,uuid,jsonb) TO authenticated;
