-- Olivia PR4B-A: transactional multi-employee availability command.
-- New migration only. Never run against production without owner approval.
-- Uses PR1B's existing audited, revision-checked batch RPC for every scope.
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
  LOCK TABLE public.employees, public.locations, public.staff_availability_rules,
    public.staff_availability_exceptions, public.staff_scheduling_preferences,
    public.staff_preference_windows, public.scheduling_qualification_types,
    public.staff_qualifications, public.scheduling_coverage_requirements,
    public.staff_scheduling_compensation, public.staff_schedules,
    public.scheduling_labor_rule_reviews IN SHARE MODE;

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
  -- Lock all affected employee identities in stable order, including across
  -- location scopes. Missing/foreign employees are rejected before any write.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_batches) AS x(value)
     WHERE jsonb_typeof(x.value) IS DISTINCT FROM 'object'
       OR coalesce(x.value->>'employeeId','') !~
         '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}
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

       OR coalesce(x.value->>'requestKey','') !~
         '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}
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

       OR NOT (x.value ? 'locationId')
       OR (x.value->>'locationId' IS NOT NULL AND
           x.value->>'locationId' !~
             '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}
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
)
       OR coalesce(x.value->>'kind','') NOT IN
         ('availability_rule','availability_exception')
       OR jsonb_typeof(x.value->'scope') IS DISTINCT FROM 'object'
       OR jsonb_typeof(x.value->'expected') IS DISTINCT FROM 'array'
       OR jsonb_typeof(x.value->'desired') IS DISTINCT FROM 'array'
       OR jsonb_array_length(x.value->'expected') > 200
       OR jsonb_array_length(x.value->'desired') > 200) THEN
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
