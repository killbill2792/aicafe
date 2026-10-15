-- Olivia PR3 manual legal-rule profile: owner must enter reviewed policy evidence.
-- No jurisdiction-specific law is inferred by the application.
-- All writes are service-role only after authenticated owner verification.
CREATE TABLE public.scheduling_labor_rule_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  profile jsonb NOT NULL CHECK(jsonb_typeof(profile)='object'),
  reviewed_by uuid NOT NULL REFERENCES auth.users(id),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(business_id)
);
CREATE TABLE public.scheduling_labor_rule_review_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  review_id uuid NOT NULL REFERENCES public.scheduling_labor_rule_reviews(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK(revision>0),
  profile jsonb NOT NULL,
  reviewed_by uuid NOT NULL REFERENCES auth.users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(business_id,review_id,revision)
);
ALTER TABLE public.scheduling_labor_rule_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduling_labor_rule_review_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scheduling_labor_rule_reviews,
  public.scheduling_labor_rule_review_audit FROM PUBLIC,anon,authenticated;
CREATE POLICY "owners read verified labor profile"
  ON public.scheduling_labor_rule_reviews FOR SELECT
  USING(public.scheduling_is_owner(business_id));
CREATE POLICY "owners read labor review audit"
  ON public.scheduling_labor_rule_review_audit FOR SELECT
  USING(public.scheduling_is_owner(business_id));
GRANT SELECT ON public.scheduling_labor_rule_reviews,
  public.scheduling_labor_rule_review_audit TO authenticated;

CREATE FUNCTION public.scheduling_save_labor_rule_review(
  p_business_id uuid,p_actor_id uuid,p_expected_revision integer,
  p_profile jsonb,p_request_key uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_review public.scheduling_labor_rule_reviews%ROWTYPE;
 v_next integer;v_fingerprint text;v_claim integer;v_receipt
   public.scheduling_plan_request_receipts%ROWTYPE;v_result jsonb;
BEGIN
  IF p_actor_id IS NULL OR p_request_key IS NULL OR
    p_expected_revision IS NULL OR p_expected_revision<0 OR
    jsonb_typeof(p_profile)<>'object' OR
    p_profile->>'verified' IS DISTINCT FROM 'true' OR
    p_profile->>'source' IS NULL OR
    length(btrim(p_profile->>'source'))<12 OR
    length(p_profile->>'source')>500 OR
    jsonb_typeof(p_profile->'jurisdictionByLocationId')<>'object' OR
    jsonb_typeof(p_profile->'classificationByEmployeeId')<>'object' OR
    p_profile->'overtime'->>'verified' IS DISTINCT FROM 'true'
    THEN RETURN jsonb_build_object('error','invalid_input'); END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.memberships m JOIN public.businesses b
      ON b.id=m.business_id
    WHERE m.business_id=p_business_id AND m.user_id=p_actor_id
      AND m.role='owner' AND b.is_demo=false
  ) THEN RETURN jsonb_build_object('error','unauthorized'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('olivia-'||p_business_id::text,0));
  v_fingerprint:=md5(jsonb_build_object('action','labor_review',
    'tenant',p_business_id,'actor',p_actor_id,'expected',p_expected_revision,
    'profile',p_profile)::text);
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
  SELECT * INTO v_review FROM public.scheduling_labor_rule_reviews
    WHERE business_id=p_business_id FOR UPDATE;
  IF FOUND AND v_review.revision<>p_expected_revision
    THEN RETURN jsonb_build_object('error','revision_conflict'); END IF;
  IF NOT FOUND AND p_expected_revision<>0
    THEN RETURN jsonb_build_object('error','revision_conflict'); END IF;
  v_next:=p_expected_revision+1;
  IF v_review.id IS NULL THEN
    INSERT INTO public.scheduling_labor_rule_reviews
      (business_id,revision,profile,reviewed_by)
      VALUES(p_business_id,v_next,p_profile,p_actor_id)
      RETURNING * INTO v_review;
  ELSE
    UPDATE public.scheduling_labor_rule_reviews SET
      revision=v_next,profile=p_profile,reviewed_by=p_actor_id,
      reviewed_at=now()
      WHERE business_id=p_business_id AND id=v_review.id RETURNING * INTO v_review;
  END IF;
  INSERT INTO public.scheduling_labor_rule_review_audit
    (business_id,review_id,revision,profile,reviewed_by)
    VALUES(p_business_id,v_review.id,v_next,p_profile,p_actor_id);
  v_result:=jsonb_build_object('revision',v_next,'id',v_review.id);
  UPDATE public.scheduling_plan_request_receipts SET result=v_result
    WHERE business_id=p_business_id AND request_key=p_request_key;
  RETURN v_result || jsonb_build_object('replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.scheduling_save_labor_rule_review(
  uuid,uuid,integer,jsonb,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.scheduling_save_labor_rule_review(
  uuid,uuid,integer,jsonb,uuid) TO service_role;
