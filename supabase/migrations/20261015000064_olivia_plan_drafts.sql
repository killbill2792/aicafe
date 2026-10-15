-- Olivia PR3, isolated draft-persistence slice (NOT approval or publication).
-- Additive/default-off. DO NOT apply in production before owner staging review.
-- The old staff_schedules/timecards/payroll tables are deliberately untouched.
CREATE TABLE public.scheduling_plan_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  horizon_start date NOT NULL,
  current_revision integer NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  published_revision integer,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id,id), UNIQUE (business_id,horizon_start),
  CHECK (extract(isodow from horizon_start) = 1),
  CHECK (published_revision IS NULL OR published_revision <= current_revision)
);

CREATE TABLE public.scheduling_plan_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  series_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','approved','published','superseded')),
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  planner_input jsonb NOT NULL CHECK (jsonb_typeof(planner_input) = 'object'),
  scenario jsonb NOT NULL CHECK (jsonb_typeof(scenario) = 'object'),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  approved_by uuid REFERENCES auth.users(id),
  approved_at timestamptz,
  published_by uuid REFERENCES auth.users(id),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id,id), UNIQUE (business_id,series_id,revision),
  FOREIGN KEY (business_id,series_id)
    REFERENCES public.scheduling_plan_series(business_id,id) ON DELETE CASCADE
);

CREATE TABLE public.scheduling_plan_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  plan_revision_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  location_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  paid_minutes integer NOT NULL CHECK (paid_minutes BETWEEN 0 AND 1440),
  breaks jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(breaks) = 'array'),
  pinned boolean NOT NULL DEFAULT false,
  CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '24 hours'),
  FOREIGN KEY (business_id,plan_revision_id)
    REFERENCES public.scheduling_plan_revisions(business_id,id) ON DELETE CASCADE,
  FOREIGN KEY (business_id,employee_id)
    REFERENCES public.employees(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id,location_id)
    REFERENCES public.locations(business_id,id) ON DELETE RESTRICT
);
CREATE INDEX scheduling_plan_assignments_lookup
  ON public.scheduling_plan_assignments(business_id,plan_revision_id,starts_at);

CREATE TABLE public.scheduling_plan_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  series_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('draft_created','draft_revised','approved','published','superseded')),
  actor uuid NOT NULL REFERENCES auth.users(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id,series_id)
    REFERENCES public.scheduling_plan_series(business_id,id) ON DELETE CASCADE,
  FOREIGN KEY (business_id,revision_id)
    REFERENCES public.scheduling_plan_revisions(business_id,id) ON DELETE CASCADE
);

CREATE TABLE public.scheduling_plan_request_receipts (
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  request_key uuid NOT NULL,
  fingerprint text NOT NULL,
  result jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id,request_key)
);

-- Nobody, including an authenticated client, may directly insert/update/delete
-- plan content, the current head, audit or receipts. Domain RPC is the sole writer.
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'scheduling_plan_series','scheduling_plan_revisions',
    'scheduling_plan_assignments','scheduling_plan_audit',
    'scheduling_plan_request_receipts'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',tbl);
  END LOOP;
END $$;

CREATE POLICY "owners read plan series" ON public.scheduling_plan_series
  FOR SELECT USING (public.scheduling_is_owner(business_id));
CREATE POLICY "owners read plan revisions" ON public.scheduling_plan_revisions
  FOR SELECT USING (public.scheduling_is_owner(business_id));
CREATE POLICY "owners read plan assignments" ON public.scheduling_plan_assignments
  FOR SELECT USING (public.scheduling_is_owner(business_id));
CREATE POLICY "owners read plan audit" ON public.scheduling_plan_audit
  FOR SELECT USING (public.scheduling_is_owner(business_id));
GRANT SELECT ON public.scheduling_plan_series,public.scheduling_plan_revisions,
 public.scheduling_plan_assignments,public.scheduling_plan_audit TO authenticated;
-- Receipts intentionally have no client read or write access.

-- This function persists only INERT drafts. Approval and publication are not
-- exposed until PR3 independently verifies hard constraints at the DB boundary.
-- An owner directly invoking this RPC can create a draft, never an official shift.
CREATE FUNCTION public.scheduling_create_plan_draft(
  p_business_id uuid, p_horizon_start date, p_expected_revision integer,
  p_source_digest text, p_planner_input jsonb, p_scenario jsonb,
  p_shifts jsonb, p_request_key uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
 v_series public.scheduling_plan_series%ROWTYPE;
 v_receipt public.scheduling_plan_request_receipts%ROWTYPE;
 v_revision_id uuid; v_revision integer; v_fingerprint text;
 v_claim integer; v_shift jsonb; v_result jsonb; v_employee uuid; v_location uuid;
BEGIN
 IF auth.uid() IS NULL OR NOT public.scheduling_is_owner(p_business_id)
   OR NOT EXISTS(SELECT 1 FROM public.businesses
     WHERE id=p_business_id AND is_demo=false) THEN
   RAISE EXCEPTION 'scheduling owner required' USING ERRCODE='42501';
 END IF;
 IF p_request_key IS NULL OR p_horizon_start IS NULL
   OR extract(isodow from p_horizon_start) <> 1
   OR p_expected_revision IS NULL OR p_expected_revision < 0
   OR p_source_digest IS NULL OR p_source_digest !~ '^[a-f0-9]{64}$'
   OR jsonb_typeof(p_planner_input) <> 'object'
   OR jsonb_typeof(p_scenario) <> 'object'
   OR jsonb_typeof(p_shifts) <> 'array'
   OR jsonb_array_length(p_shifts) > 200
   OR pg_column_size(p_planner_input) > 262144
   OR pg_column_size(p_scenario) > 262144
   OR pg_column_size(p_shifts) > 262144
   OR p_scenario->'shifts' IS DISTINCT FROM p_shifts
   OR p_planner_input->>'horizonStart' IS DISTINCT FROM p_horizon_start::text
   OR coalesce(p_scenario->>'objective','') NOT IN ('cash','owner_time','balanced') THEN
   RAISE EXCEPTION 'invalid draft request' USING ERRCODE='22023';
 END IF;
 v_fingerprint := md5(jsonb_build_object(
   'week',p_horizon_start,'expected',p_expected_revision,'source',p_source_digest,
   'input',p_planner_input,'scenario',p_scenario,'shifts',p_shifts)::text);
 INSERT INTO public.scheduling_plan_request_receipts
   (business_id,request_key,fingerprint)
 VALUES(p_business_id,p_request_key,v_fingerprint)
 ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS v_claim=ROW_COUNT;
 IF v_claim=0 THEN
   SELECT * INTO v_receipt FROM public.scheduling_plan_request_receipts
     WHERE business_id=p_business_id AND request_key=p_request_key;
   IF v_receipt.fingerprint IS DISTINCT FROM v_fingerprint OR v_receipt.result IS NULL THEN
     RETURN jsonb_build_object('conflict',true);
   END IF;
   RETURN v_receipt.result || jsonb_build_object('replayed',true);
 END IF;
 INSERT INTO public.scheduling_plan_series(business_id,horizon_start,created_by)
 VALUES(p_business_id,p_horizon_start,auth.uid())
 ON CONFLICT (business_id,horizon_start) DO NOTHING;
 SELECT * INTO v_series FROM public.scheduling_plan_series
   WHERE business_id=p_business_id AND horizon_start=p_horizon_start FOR UPDATE;
 IF v_series.current_revision <> p_expected_revision THEN
   v_result := jsonb_build_object('conflict',true);
 ELSE
   v_revision := v_series.current_revision + 1;
   INSERT INTO public.scheduling_plan_revisions(
     business_id,series_id,revision,source_digest,planner_input,scenario,created_by
   ) VALUES(p_business_id,v_series.id,v_revision,p_source_digest,
     p_planner_input,p_scenario,auth.uid()) RETURNING id INTO v_revision_id;
   FOR v_shift IN SELECT value FROM jsonb_array_elements(p_shifts) LOOP
     IF jsonb_typeof(v_shift)<>'object' THEN
       RAISE EXCEPTION 'invalid draft shift' USING ERRCODE='22023';
     END IF;
     IF EXISTS(SELECT 1 FROM jsonb_object_keys(v_shift) AS k(key_name)
       WHERE k.key_name NOT IN ('employeeId','locationId','startAt','endAt',
         'paidMinutes','breaks','pinned')) OR
       NOT (v_shift ?& ARRAY['employeeId','locationId','startAt','endAt',
         'paidMinutes','breaks','pinned']) OR
       jsonb_typeof(v_shift->'breaks') <> 'array' OR
       jsonb_array_length(v_shift->'breaks') > 24 THEN
       RAISE EXCEPTION 'invalid draft shift fields' USING ERRCODE='22023';
     END IF;
     v_employee := (v_shift->>'employeeId')::uuid;
     v_location := (v_shift->>'locationId')::uuid;
     INSERT INTO public.scheduling_plan_assignments (
       business_id,plan_revision_id,employee_id,location_id,
       starts_at,ends_at,paid_minutes,breaks,pinned
     ) VALUES (
       p_business_id,v_revision_id,v_employee,v_location,
       (v_shift->>'startAt')::timestamptz,(v_shift->>'endAt')::timestamptz,
       (v_shift->>'paidMinutes')::integer,
       coalesce(v_shift->'breaks','[]'::jsonb),
       coalesce((v_shift->>'pinned')::boolean,false)
     );
   END LOOP;
   -- Drafts are NOT verified/publishable records; SQL has no approval transition.
   -- Defense in depth for even inert client-submitted drafts.
   IF EXISTS (
     SELECT 1 FROM public.scheduling_plan_assignments x
     JOIN public.scheduling_plan_assignments y
       ON x.business_id=y.business_id AND x.plan_revision_id=y.plan_revision_id
       AND x.employee_id=y.employee_id AND x.id<y.id
       AND tstzrange(x.starts_at,x.ends_at,'[)') &&
           tstzrange(y.starts_at,y.ends_at,'[)')
     WHERE x.business_id=p_business_id AND x.plan_revision_id=v_revision_id
   ) THEN RAISE EXCEPTION 'overlapping draft shifts' USING ERRCODE='22023'; END IF;
   UPDATE public.scheduling_plan_series
     SET current_revision=v_revision,updated_at=now()
     WHERE business_id=p_business_id AND id=v_series.id;
   INSERT INTO public.scheduling_plan_audit
     (business_id,series_id,revision_id,event,actor)
   VALUES(p_business_id,v_series.id,v_revision_id,
     CASE WHEN v_revision=1 THEN 'draft_created' ELSE 'draft_revised' END,auth.uid());
   v_result:=jsonb_build_object('seriesId',v_series.id,
     'revisionId',v_revision_id,'revision',v_revision);
 END IF;
 UPDATE public.scheduling_plan_request_receipts SET result=v_result
   WHERE business_id=p_business_id AND request_key=p_request_key;
 RETURN v_result || jsonb_build_object('replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.scheduling_create_plan_draft(
 uuid,date,integer,text,jsonb,jsonb,jsonb,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.scheduling_create_plan_draft(
 uuid,date,integer,text,jsonb,jsonb,jsonb,uuid) TO authenticated;
