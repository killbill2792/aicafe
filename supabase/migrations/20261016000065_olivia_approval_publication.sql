-- Olivia PR3: guarded owner approval and publication. No legacy table writes.
-- Apply only in reviewed staging; publication feature flag remains OFF by default.
-- The service_role-only RPCs MUST be called after authenticated server-side
-- feasibility/policy revalidation. They are not exposed to browser sessions.

CREATE FUNCTION public.scheduling_pr3_source_token_internal(p_business_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_table text; v_rows jsonb := '{}'::jsonb; v_batch jsonb;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'employees','locations','staff_availability_rules',
    'staff_availability_exceptions','staff_scheduling_preferences',
    'staff_preference_windows','scheduling_qualification_types',
    'staff_qualifications','scheduling_coverage_requirements',
    'staff_scheduling_compensation','staff_schedules',
    'scheduling_labor_rule_reviews'
  ] LOOP
    EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id::text), ''[]''::jsonb)
                    FROM public.%I r WHERE r.business_id=$1', v_table)
      INTO v_batch USING p_business_id;
    v_rows := v_rows || jsonb_build_object(v_table,v_batch);
  END LOOP;
  RETURN md5(jsonb_build_object(
    'business_id',p_business_id,
    'business_timezone',(SELECT timezone FROM public.businesses WHERE id=p_business_id),
    'rows',v_rows
  )::text);
END $$;
REVOKE ALL ON FUNCTION public.scheduling_pr3_source_token_internal(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.scheduling_pr3_source_token_internal(uuid)
  TO service_role;

CREATE FUNCTION public.scheduling_owner_source_token(p_business_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.scheduling_is_owner(p_business_id)
    OR NOT EXISTS(SELECT 1 FROM public.businesses
      WHERE id=p_business_id AND is_demo=false) THEN
    RAISE EXCEPTION 'scheduling owner required' USING ERRCODE='42501';
  END IF;
  RETURN public.scheduling_pr3_source_token_internal(p_business_id);
END $$;
REVOKE ALL ON FUNCTION public.scheduling_owner_source_token(uuid)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.scheduling_owner_source_token(uuid)
  TO authenticated;

CREATE FUNCTION public.scheduling_pr3_approve(
  p_business_id uuid,p_actor_id uuid,p_revision_id uuid,
  p_expected_revision integer,p_source_digest text,p_source_token text,
  p_request_key uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_series public.scheduling_plan_series%ROWTYPE;
  v_revision public.scheduling_plan_revisions%ROWTYPE;
  v_receipt public.scheduling_plan_request_receipts%ROWTYPE;
  v_fingerprint text;v_result jsonb;v_claim integer;
BEGIN
  IF p_actor_id IS NULL OR p_request_key IS NULL OR p_revision_id IS NULL OR
    p_expected_revision IS NULL OR p_expected_revision < 1 OR
    p_source_digest IS NULL OR p_source_digest !~ '^[a-f0-9]{64}$' OR
    p_source_token IS NULL OR p_source_token !~ '^[a-f0-9]{32}$' THEN
    RETURN jsonb_build_object('error','invalid_input');
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.memberships m
    JOIN public.businesses b ON b.id=m.business_id
    WHERE m.user_id=p_actor_id AND m.business_id=p_business_id
      AND m.role='owner' AND b.is_demo=false
  ) THEN RETURN jsonb_build_object('error','unauthorized'); END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('olivia-'||p_business_id::text,0));
  -- Hold source-table SHARE locks through commit so any concurrent staffing
  -- mutation cannot slip between token comparison and the approval update.
  LOCK TABLE public.employees,public.locations,public.staff_availability_rules,
    public.staff_availability_exceptions,public.staff_scheduling_preferences,
    public.staff_preference_windows,public.scheduling_qualification_types,
    public.staff_qualifications,public.scheduling_coverage_requirements,
    public.staff_scheduling_compensation,public.staff_schedules IN SHARE MODE;
  IF public.scheduling_pr3_source_token_internal(p_business_id) IS DISTINCT FROM
    p_source_token THEN RETURN jsonb_build_object('error','source_changed'); END IF;

  SELECT s.* INTO v_series FROM public.scheduling_plan_series s
    JOIN public.scheduling_plan_revisions r
      ON r.business_id=s.business_id AND r.series_id=s.id
    WHERE s.business_id=p_business_id AND r.id=p_revision_id
    FOR UPDATE OF s;
  IF NOT FOUND OR v_series.current_revision<>p_expected_revision
    THEN RETURN jsonb_build_object('error','revision_conflict'); END IF;
  SELECT * INTO v_revision FROM public.scheduling_plan_revisions
    WHERE business_id=p_business_id AND series_id=v_series.id
      AND id=p_revision_id AND revision=p_expected_revision FOR UPDATE;
  IF NOT FOUND OR v_revision.source_digest<>p_source_digest
    THEN RETURN jsonb_build_object('error','revision_conflict'); END IF;
  IF v_revision.status='approved' AND v_revision.approved_by IS NOT NULL
    THEN RETURN jsonb_build_object('revisionId',p_revision_id,
      'revision',p_expected_revision,'status','approved','replayed',true); END IF;
  IF v_revision.status<>'draft'
    THEN RETURN jsonb_build_object('error','revision_conflict'); END IF;
  IF (v_revision.scenario->>'completeCoverage') IS DISTINCT FROM 'true'
    OR (v_revision.scenario->>'hardConstraintsSatisfied') IS DISTINCT FROM 'true'
    OR (v_revision.scenario->>'legalReview') IS DISTINCT FROM 'verified_profile'
    THEN RETURN jsonb_build_object('error','policy_unverified'); END IF;

  v_fingerprint := md5(jsonb_build_object(
    'action','approve','tenant',p_business_id,'actor',p_actor_id,
    'revision',p_revision_id,'version',p_expected_revision,
    'source',p_source_digest,'token',p_source_token)::text);
  INSERT INTO public.scheduling_plan_request_receipts
    (business_id,request_key,fingerprint)
    VALUES(p_business_id,p_request_key,v_fingerprint)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_claim=ROW_COUNT;
  IF v_claim=0 THEN
    SELECT * INTO v_receipt FROM public.scheduling_plan_request_receipts
      WHERE business_id=p_business_id AND request_key=p_request_key;
    IF v_receipt.fingerprint IS DISTINCT FROM v_fingerprint
      OR v_receipt.result IS NULL
      THEN RETURN jsonb_build_object('error','conflict'); END IF;
    RETURN v_receipt.result || jsonb_build_object('replayed',true);
  END IF;
  UPDATE public.scheduling_plan_revisions
    SET status='approved',approved_by=p_actor_id,approved_at=now()
    WHERE business_id=p_business_id AND id=p_revision_id;
  INSERT INTO public.scheduling_plan_audit
    (business_id,series_id,revision_id,event,actor)
    VALUES(p_business_id,v_series.id,p_revision_id,'approved',p_actor_id);
  v_result:=jsonb_build_object('revisionId',p_revision_id,'revision',
    p_expected_revision,'status','approved');
  UPDATE public.scheduling_plan_request_receipts SET result=v_result
    WHERE business_id=p_business_id AND request_key=p_request_key;
  RETURN v_result || jsonb_build_object('replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.scheduling_pr3_approve(
  uuid,uuid,uuid,integer,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.scheduling_pr3_approve(
  uuid,uuid,uuid,integer,text,text,uuid) TO service_role;

CREATE FUNCTION public.scheduling_pr3_publish(
  p_business_id uuid,p_actor_id uuid,p_revision_id uuid,
  p_expected_revision integer,p_source_digest text,p_source_token text,
  p_request_key uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_series public.scheduling_plan_series%ROWTYPE;
  v_revision public.scheduling_plan_revisions%ROWTYPE;
  v_old_revision uuid;v_receipt public.scheduling_plan_request_receipts%ROWTYPE;
  v_fingerprint text;v_result jsonb;v_claim integer;
BEGIN
  IF p_actor_id IS NULL OR p_request_key IS NULL OR p_revision_id IS NULL OR
    p_expected_revision IS NULL OR p_expected_revision < 1 OR
    p_source_digest IS NULL OR p_source_digest !~ '^[a-f0-9]{64}$' OR
    p_source_token IS NULL OR p_source_token !~ '^[a-f0-9]{32}$' THEN
    RETURN jsonb_build_object('error','invalid_input');
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.memberships m
    JOIN public.businesses b ON b.id=m.business_id
    WHERE m.user_id=p_actor_id AND m.business_id=p_business_id
      AND m.role='owner' AND b.is_demo=false
  ) THEN RETURN jsonb_build_object('error','unauthorized'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('olivia-'||p_business_id::text,0));
  LOCK TABLE public.employees,public.locations,public.staff_availability_rules,
    public.staff_availability_exceptions,public.staff_scheduling_preferences,
    public.staff_preference_windows,public.scheduling_qualification_types,
    public.staff_qualifications,public.scheduling_coverage_requirements,
    public.staff_scheduling_compensation,public.staff_schedules IN SHARE MODE;
  IF public.scheduling_pr3_source_token_internal(p_business_id) IS DISTINCT FROM
    p_source_token THEN RETURN jsonb_build_object('error','source_changed'); END IF;
  SELECT s.* INTO v_series FROM public.scheduling_plan_series s
    JOIN public.scheduling_plan_revisions r
      ON r.business_id=s.business_id AND r.series_id=s.id
    WHERE s.business_id=p_business_id AND r.id=p_revision_id FOR UPDATE OF s;
  IF NOT FOUND OR v_series.current_revision<>p_expected_revision
    THEN RETURN jsonb_build_object('error','revision_conflict'); END IF;
  SELECT * INTO v_revision FROM public.scheduling_plan_revisions
    WHERE business_id=p_business_id AND series_id=v_series.id
      AND id=p_revision_id AND revision=p_expected_revision FOR UPDATE;
  IF NOT FOUND OR v_revision.source_digest<>p_source_digest
    THEN RETURN jsonb_build_object('error','revision_conflict'); END IF;
  IF v_series.published_revision=p_expected_revision AND
    v_revision.status='published'
    THEN RETURN jsonb_build_object('revisionId',p_revision_id,'revision',
      p_expected_revision,'status','published','replayed',true); END IF;
  IF v_revision.status<>'approved' OR v_revision.approved_by IS NULL OR
    v_revision.approved_at IS NULL
    THEN RETURN jsonb_build_object('error','not_approved'); END IF;
  IF (v_revision.scenario->>'completeCoverage') IS DISTINCT FROM 'true'
    OR (v_revision.scenario->>'hardConstraintsSatisfied') IS DISTINCT FROM 'true'
    OR (v_revision.scenario->>'legalReview') IS DISTINCT FROM 'verified_profile'
    THEN RETURN jsonb_build_object('error','policy_unverified'); END IF;
  IF EXISTS(
    SELECT 1 FROM public.scheduling_plan_assignments a
    WHERE a.business_id=p_business_id AND a.plan_revision_id=p_revision_id
      AND a.starts_at<=now()
  ) THEN RETURN jsonb_build_object('error','past_shift'); END IF;
  -- One café-wide advisory lock serializes separate weekly publication even
  -- when a worker crosses a week boundary or changes locations.
  IF EXISTS(
    SELECT 1 FROM public.scheduling_plan_assignments incoming
    JOIN public.scheduling_plan_assignments prior
      ON incoming.business_id=prior.business_id
      AND incoming.employee_id=prior.employee_id
      AND tstzrange(incoming.starts_at,incoming.ends_at,'[)') &&
          tstzrange(prior.starts_at,prior.ends_at,'[)')
    JOIN public.scheduling_plan_revisions old_rev
      ON old_rev.id=prior.plan_revision_id AND old_rev.business_id=prior.business_id
    JOIN public.scheduling_plan_series old_series
      ON old_series.id=old_rev.series_id AND
         old_series.business_id=old_rev.business_id
    WHERE incoming.business_id=p_business_id AND
      incoming.plan_revision_id=p_revision_id
      AND old_series.id<>v_series.id
      AND old_series.published_revision=old_rev.revision
      AND old_rev.status='published'
  ) THEN RETURN jsonb_build_object('error','published_overlap'); END IF;
  -- Conservatively block any active legacy recurring assignment for a
  -- worker in the publishing week or immediately before it (overnight spill).
  -- This avoids duplicating predicted legacy timecards and future Olivia plans
  -- without altering the existing payroll/materializer source of truth.
  IF EXISTS(
    SELECT 1 FROM public.scheduling_plan_assignments a
    JOIN public.staff_schedules legacy
      ON legacy.business_id=a.business_id AND legacy.employee_id=a.employee_id
        AND legacy.active=true
    WHERE a.business_id=p_business_id AND a.plan_revision_id=p_revision_id
      AND legacy.effective_from <= v_series.horizon_start + 6
      AND (legacy.effective_to IS NULL OR
        legacy.effective_to >= v_series.horizon_start - 1)
  ) THEN RETURN jsonb_build_object('error','legacy_conflict'); END IF;
  v_fingerprint:=md5(jsonb_build_object(
    'action','publish','tenant',p_business_id,'actor',p_actor_id,
    'revision',p_revision_id,'version',p_expected_revision,
    'source',p_source_digest,'token',p_source_token)::text);
  INSERT INTO public.scheduling_plan_request_receipts
    (business_id,request_key,fingerprint)
    VALUES(p_business_id,p_request_key,v_fingerprint)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_claim=ROW_COUNT;
  IF v_claim=0 THEN
    SELECT * INTO v_receipt FROM public.scheduling_plan_request_receipts
      WHERE business_id=p_business_id AND request_key=p_request_key;
    IF v_receipt.fingerprint IS DISTINCT FROM v_fingerprint
      OR v_receipt.result IS NULL THEN
      RETURN jsonb_build_object('error','conflict'); END IF;
    RETURN v_receipt.result || jsonb_build_object('replayed',true);
  END IF;

  IF v_series.published_revision IS NOT NULL THEN
    SELECT id INTO v_old_revision FROM public.scheduling_plan_revisions
      WHERE business_id=p_business_id AND series_id=v_series.id
        AND revision=v_series.published_revision AND status='published'
      FOR UPDATE;
    IF v_old_revision IS NOT NULL THEN
      UPDATE public.scheduling_plan_revisions SET status='superseded'
        WHERE id=v_old_revision AND business_id=p_business_id;
      INSERT INTO public.scheduling_plan_audit
        (business_id,series_id,revision_id,event,actor)
        VALUES(p_business_id,v_series.id,v_old_revision,'superseded',p_actor_id);
    END IF;
  END IF;
  UPDATE public.scheduling_plan_revisions SET
    status='published',published_by=p_actor_id,published_at=now()
    WHERE id=p_revision_id AND business_id=p_business_id;
  UPDATE public.scheduling_plan_series SET
    published_revision=p_expected_revision,updated_at=now()
    WHERE id=v_series.id AND business_id=p_business_id;
  INSERT INTO public.scheduling_plan_audit
    (business_id,series_id,revision_id,event,actor)
    VALUES(p_business_id,v_series.id,p_revision_id,'published',p_actor_id);
  v_result:=jsonb_build_object('revisionId',p_revision_id,
    'revision',p_expected_revision,'status','published');
  UPDATE public.scheduling_plan_request_receipts SET result=v_result
    WHERE business_id=p_business_id AND request_key=p_request_key;
  RETURN v_result || jsonb_build_object('replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.scheduling_pr3_publish(
  uuid,uuid,uuid,integer,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.scheduling_pr3_publish(
  uuid,uuid,uuid,integer,text,text,uuid) TO service_role;
