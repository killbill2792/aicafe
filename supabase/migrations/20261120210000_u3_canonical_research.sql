-- U3: one governed, SQL-native business research boundary.
-- A business/owner/lease-bound capability is minted by verified service work,
-- and rechecked by RLS on every SQL statement. The model never sees this token.
-- All research roles are NOLOGIN until a separately provisioned private
-- read-only database credential exists; a migration never stores passwords.
BEGIN;

DO $u3_roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aicafe_research') THEN
    CREATE ROLE aicafe_research NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aicafe_research_view_owner') THEN
    CREATE ROLE aicafe_research_view_owner NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('aicafe_research','aicafe_research_view_owner')
    AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole))
  THEN RAISE EXCEPTION 'U3 roles must never bypass row security'; END IF;
END
$u3_roles$;

CREATE SCHEMA IF NOT EXISTS u3_research;
CREATE SCHEMA IF NOT EXISTS u3_research_private;
REVOKE ALL ON SCHEMA u3_research FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SCHEMA u3_research_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA u3_research TO aicafe_research;
GRANT CREATE,USAGE ON SCHEMA u3_research TO aicafe_research_view_owner;
GRANT USAGE ON SCHEMA u3_research_private TO aicafe_research_view_owner;

-- One private signing key, not one entitlement row per model call. Its random
-- value is never emitted to service/browser/model, including via error output.
CREATE TABLE IF NOT EXISTS u3_research_private.signing_key(
  singleton smallint PRIMARY KEY CHECK(singleton=1),
  secret bytea NOT NULL CHECK(octet_length(secret)>=32)
);
ALTER TABLE u3_research_private.signing_key ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON u3_research_private.signing_key FROM PUBLIC,anon,authenticated,
  aicafe_research,aicafe_research_view_owner;
INSERT INTO u3_research_private.signing_key(singleton,secret)
VALUES(1,extensions.gen_random_bytes(32))
ON CONFLICT(singleton) DO NOTHING;

-- Called solely by the verified existing application service client. The
-- token holds no business record values and expires quickly. Issuance does not
-- confer effect authorization, expand a member's rights, or impersonate owner.
CREATE OR REPLACE FUNCTION public.u3_issue_research_scope(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,
  p_mode text,p_source_type text DEFAULT NULL,p_source_id text DEFAULT NULL,
  p_run_id uuid DEFAULT NULL,p_lease_token uuid DEFAULT NULL
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path='' AS $u3_issue$
DECLARE
  payload jsonb;
  secret bytea;
  issued_at bigint;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role'
     OR p_business_id IS NULL OR p_owner_user_id IS NULL OR p_thread_id IS NULL
     OR NOT public.supervisor_routine_owner_authorized(
       p_business_id,p_owner_user_id,p_thread_id)
  THEN RAISE EXCEPTION 'research_scope_denied' USING ERRCODE='42501'; END IF;
  IF p_mode NOT IN ('owner','investigation','durable')
  THEN RAISE EXCEPTION 'research_scope_denied' USING ERRCODE='42501'; END IF;
  IF p_mode='investigation' AND NOT EXISTS (
    SELECT 1 FROM public.supervisor_investigations s
    WHERE s.business_id=p_business_id AND s.owner_user_id=p_owner_user_id
      AND s.thread_id=p_thread_id AND s.source_type=p_source_type
      AND s.source_id=p_source_id AND s.lease_token=p_lease_token
      AND s.lease_until>statement_timestamp()
      AND s.phase IN ('investigate','awaiting_owner')
  ) THEN RAISE EXCEPTION 'research_scope_denied' USING ERRCODE='42501'; END IF;
  IF p_mode='durable' AND NOT
    public.supervisor_owner_job_fence_v2(
      p_business_id,p_owner_user_id,p_thread_id,p_run_id,p_lease_token)
  THEN RAISE EXCEPTION 'research_scope_denied' USING ERRCODE='42501'; END IF;
  IF p_mode='owner' AND (p_source_type IS NOT NULL OR p_source_id IS NOT NULL
     OR p_run_id IS NOT NULL OR p_lease_token IS NOT NULL)
  THEN RAISE EXCEPTION 'research_scope_denied' USING ERRCODE='42501'; END IF;
  issued_at:=extract(epoch FROM statement_timestamp())::bigint;
  payload:=jsonb_build_object(
    'business',p_business_id,'owner',p_owner_user_id,'thread',p_thread_id,
    'mode',p_mode,'source_type',p_source_type,'source_id',p_source_id,
    'run',p_run_id,'lease',p_lease_token,
    'issued',issued_at,'expires',issued_at+45,
    'nonce',encode(extensions.gen_random_bytes(16),'hex')
  );
  SELECT k.secret INTO STRICT secret FROM u3_research_private.signing_key k
  WHERE k.singleton=1;
  RETURN encode(convert_to(payload::text,'UTF8'),'base64')||'.'||
    encode(extensions.hmac(convert_to(payload::text,'UTF8'),secret,'sha256'),'hex');
END
$u3_issue$;
REVOKE ALL ON FUNCTION public.u3_issue_research_scope(
  uuid,uuid,uuid,text,text,text,uuid,uuid
) FROM PUBLIC,anon,authenticated,aicafe_research,aicafe_research_view_owner;
GRANT EXECUTE ON FUNCTION public.u3_issue_research_scope(
  uuid,uuid,uuid,text,text,text,uuid,uuid
) TO service_role;

-- The only SQL-side scope verifier. The model can set arbitrary GUC strings,
-- but cannot forge an HMAC; a naked research credential never grants any row.
-- Membership, original thread and active worker lease are checked on every
-- statement, including after an owner revokes an authorization.
CREATE OR REPLACE FUNCTION u3_research_private.scope()
RETURNS TABLE(business_id uuid,owner_user_id uuid,mode text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $u3_verify$
DECLARE
  token text;
  payload_text text;
  payload jsonb;
  secret bytea;
  mac text;
  now_epoch bigint;
  b uuid;
  o uuid;
  t uuid;
  m text;
  lease uuid;
  run uuid;
BEGIN
  token:=nullif(current_setting('aicafe.u3_research_scope',true),'');
  IF token IS NULL OR length(token)>4096 OR length(token)<75
     OR length(token)-length(replace(token,'.',''))<>1 THEN RETURN; END IF;
  payload_text:=convert_from(decode(split_part(token,'.',1),'base64'),'UTF8');
  payload:=payload_text::jsonb;
  SELECT k.secret INTO STRICT secret FROM u3_research_private.signing_key k
    WHERE k.singleton=1;
  mac:=encode(extensions.hmac(convert_to(payload_text,'UTF8'),secret,'sha256'),'hex');
  IF mac<>split_part(token,'.',2) THEN RETURN; END IF;
  now_epoch:=extract(epoch FROM statement_timestamp())::bigint;
  IF (payload->>'issued')::bigint>now_epoch+1
     OR (payload->>'issued')::bigint<now_epoch-60
     OR (payload->>'expires')::bigint<=now_epoch
     OR (payload->>'expires')::bigint>(payload->>'issued')::bigint+45
  THEN RETURN; END IF;
  b:=(payload->>'business')::uuid;
  o:=(payload->>'owner')::uuid;
  t:=(payload->>'thread')::uuid;
  m:=payload->>'mode';
  IF m NOT IN ('owner','investigation','durable')
    OR NOT EXISTS (SELECT 1 FROM public.memberships a
      WHERE a.business_id=b AND a.user_id=o AND a.role='owner')
    OR NOT EXISTS (SELECT 1 FROM public.ai_threads a
      WHERE a.id=t AND a.business_id=b AND a.owner_user_id=o)
  THEN RETURN; END IF;
  lease:=nullif(payload->>'lease','')::uuid;
  IF m='investigation' AND NOT EXISTS (
    SELECT 1 FROM public.supervisor_investigations s
    WHERE s.business_id=b AND s.owner_user_id=o AND s.thread_id=t
      AND s.source_type=payload->>'source_type'
      AND s.source_id=payload->>'source_id'
      AND s.lease_token=lease AND s.lease_until>statement_timestamp()
      AND s.phase IN ('investigate','awaiting_owner')
  ) THEN RETURN; END IF;
  IF m='durable' THEN
    run:=nullif(payload->>'run','')::uuid;
    IF NOT EXISTS (
      SELECT 1 FROM public.supervisor_runs r
      JOIN public.supervisor_run_steps s ON s.business_id=r.business_id
        AND s.run_id=r.id AND s.step_key='owner_turn'
      WHERE r.id=run AND r.business_id=b AND r.owner_user_id=o AND r.thread_id=t
        AND r.execution_version=2 AND r.status='running'
        AND s.status='leased' AND s.claim_token=lease
        AND s.lease_until>statement_timestamp()
        AND NOT (r.input_attachment_version_hash IS DISTINCT FROM
          public.supervisor_owner_attachment_fingerprint_v2(
            r.business_id,r.owner_user_id,r.thread_id,r.input_attachment_ids))
    ) THEN RETURN; END IF;
  END IF;
  RETURN QUERY SELECT b,o,m;
EXCEPTION WHEN others THEN
  -- No raw PostgreSQL error, JWT, membership or business identifier is
  -- surfaced to a research query or an end-user model.
  RETURN;
END
$u3_verify$;
REVOKE ALL ON FUNCTION u3_research_private.scope() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.scope() TO aicafe_research_view_owner;

CREATE OR REPLACE FUNCTION u3_research_private.business_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $u3_business$ SELECT s.business_id FROM u3_research_private.scope() s LIMIT 1 $u3_business$;
CREATE OR REPLACE FUNCTION u3_research_private.mode()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $u3_mode$ SELECT s.mode FROM u3_research_private.scope() s LIMIT 1 $u3_mode$;
REVOKE ALL ON FUNCTION u3_research_private.business_id() FROM PUBLIC,anon,authenticated,aicafe_research;
REVOKE ALL ON FUNCTION u3_research_private.mode() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.business_id() TO aicafe_research_view_owner;
GRANT EXECUTE ON FUNCTION u3_research_private.mode() TO aicafe_research_view_owner;

-- Every selected field and indirect parent edge is individually reviewed.
-- This is a source/field admission contract, NOT a library of owner-question
-- templates. New fields are denied until the generated physical census and
-- semantic/permission review admit them, then they work with every SQL form.
-- No raw Toast archive, credentials, diagnostics or free-text payload admitted.
DO $u3_views$
DECLARE
  cfg jsonb;
  rel text;
  field text;
  fields text[];
  sensitive text[];
  projection text;
  all_grants text;
  predicate text;
  missing text;
BEGIN
  FOR cfg IN SELECT value FROM jsonb_array_elements($u3_sources$[
    {"table":"daily_rollups","fields":["business_date","net_sales_cents","orders_count","drinks_count","ingredients_cents","staff_wages_cents","staff_tax_cents","card_fees_cents","voids_cents","sales_data_status","staff_tax_status","labor_wage_status"]},
    {"table":"hourly_sales_rollup","fields":["business_date","location_id","hour_local","net_sales_cents","orders_count"]},
    {"table":"orders","fields":["id","location_id","pos_order_id","business_date","closed_at","gross_sales_cents","discounts_cents","refunds_cents","tax_cents","tip_cents","processing_fee_cents","net_sales_cents","employee_id","dining_option","source_channel","guest_count","toast_excluded","superseded_by"],"sensitive":["employee_id"]},
    {"table":"order_lines","parent":"orders","parent_fk":"order_id","fields":["id","order_id","menu_item_id","pos_item_id","name","quantity","net_sales_cents","voided","category","ordered_at","fulfillment_status"]},
    {"table":"menu_items","fields":["id","pos_item_id","name","price_cents","category","is_active","base_name","size_label","catalog_source","catalog_last_synced_at","menu_group","pos_visibility","toast_publication_state","toast_publication_version","toast_publication_observed_at"]},
    {"table":"ingredients","fields":["id","name","base_unit","category","archived_at"]},
    {"table":"recipe_lines","parent":"menu_items","parent_fk":"menu_item_id","fields":["menu_item_id","ingredient_id","quantity","display_unit","display_quantity","sort_order"]},
    {"table":"ingredient_prices","parent":"ingredients","parent_fk":"ingredient_id","fields":["id","ingredient_id","effective_from","cost_per_base_unit_micros","source","pack_quantity","pack_unit","pack_cost_cents","recorded_at"]},
    {"table":"ingredient_unit_conversions","parent":"ingredients","parent_fk":"ingredient_id","fields":["id","ingredient_id","unit","base_units_per_unit","created_at"]},
    {"table":"expenses","fields":["id","spent_on","amount_cents","vendor","category_code","source","status","confidence","created_at"]},
    {"table":"expense_lines","parent":"expenses","parent_fk":"expense_id","fields":["id","expense_id","quantity","unit","amount_cents","ingredient_id","receipt_line_index"]},
    {"table":"employees","fields":["id","display_name","role","active","default_hourly_wage_cents","wage_period","wage_amount_cents","pos_last_synced_at"],"sensitive":["id","display_name","default_hourly_wage_cents","wage_amount_cents"]},
    {"table":"timecards","fields":["id","employee_id","clock_in","clock_out","hourly_wage_cents","source_type","source_provider","wage_source","pos_last_synced_at","provider_regular_hours","provider_overtime_hours"],"sensitive":["id","employee_id","hourly_wage_cents"]},
    {"table":"scheduled_shifts","fields":["id","employee_id","local_date","start_local","end_local","overnight","break_minutes","role","status","source","deleted_at"],"sensitive":["id","employee_id"]},
    {"table":"locations","fields":["id","name","city","region","country_code","timezone"]},
    {"table":"purchase_orders","fields":["id","supplier_id","supplier_name_snapshot","status","revision","currency_code","needed_by","subtotal_cents","shipping_cents","tax_cents","total_cents","approved_at","created_at"]},
    {"table":"purchase_order_lines","fields":["id","purchase_order_id","ingredient_id","item_name_snapshot","needed_base_quantity","base_unit","packs","pack_quantity","pack_unit","unit_price_cents","subtotal_cents","quoted_on","delivery_on"]},
    {"table":"purchase_receipts","fields":["id","purchase_order_id","supplier_id","receiving_reference","revision","received_on","verification_kind","verified_at","created_at"]},
    {"table":"supplier_invoices","fields":["id","purchase_order_id","supplier_id","revision","issued_on","due_on","currency_code","subtotal_cents","tax_cents","freight_cents","discount_cents","total_cents","canonical_expense_id","recognized_expense_on"]},
    {"table":"cafe_events","fields":["id","name","kind","start_date","end_date","start_time","end_time","area_label","source_url","status","last_verified_at"]},
    {"table":"cafe_decisions","fields":["id","type","entity_type","entity_id","confidence","status","created_at","updated_at"]}
  ]$u3_sources$::jsonb) LOOP
    rel:=cfg->>'table';
    SELECT array_agg(value) INTO fields FROM jsonb_array_elements_text(cfg->'fields');
    SELECT coalesce(array_agg(value),ARRAY[]::text[]) INTO sensitive
      FROM jsonb_array_elements_text(coalesce(cfg->'sensitive','[]'::jsonb));
    SELECT string_agg(f,'.' ORDER BY f) INTO missing FROM unnest(fields) f
      WHERE NOT EXISTS(SELECT 1 FROM pg_attribute a
        WHERE a.attrelid=format('public.%I',rel)::regclass
          AND a.attname=f AND a.attnum>0 AND NOT a.attisdropped);
    IF missing IS NOT NULL THEN RAISE EXCEPTION 'U3 source field drift: % / %',rel,missing; END IF;
    SELECT string_agg(format('%I',f),', ') INTO all_grants FROM unnest(fields) f;
    -- RLS needs the tenant field or an exact, unique parent ID even though the
    -- model is not allowed to override the externally verified café scope.
    IF cfg ? 'parent' THEN
      predicate:=format('EXISTS(SELECT 1 FROM public.%I u3_parent WHERE u3_parent.id = %I AND u3_parent.business_id = (SELECT u3_research_private.business_id()))',
        cfg->>'parent',cfg->>'parent_fk');
    ELSE
      predicate:='business_id = (SELECT u3_research_private.business_id())';
    END IF;
    EXECUTE format('GRANT SELECT (%s) ON public.%I TO aicafe_research_view_owner',
      all_grants,rel);
    IF NOT(cfg ? 'parent') THEN
      EXECUTE format('GRANT SELECT (business_id) ON public.%I TO aicafe_research_view_owner',rel);
    ELSE
      EXECUTE format('GRANT SELECT (%I) ON public.%I TO aicafe_research_view_owner',
        cfg->>'parent_fk',rel);
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS u3_research_scoped_select ON public.%I',rel);
    EXECUTE format('CREATE POLICY u3_research_scoped_select ON public.%I FOR SELECT TO aicafe_research_view_owner USING (%s)',
      rel,predicate);
    SELECT string_agg(
      CASE WHEN f=ANY(sensitive) THEN
        format('CASE WHEN u3_research_private.mode() = ''owner'' THEN src.%I ELSE NULL END AS %I',f,f)
      ELSE format('src.%I',f) END, ', ' ORDER BY ord
    ) INTO projection FROM unnest(fields) WITH ORDINALITY t(f,ord);
    EXECUTE format(
      'CREATE OR REPLACE VIEW u3_research.%I WITH (security_barrier=true) AS SELECT %s FROM public.%I src',
      rel,projection,rel);
    EXECUTE format('ALTER VIEW u3_research.%I OWNER TO aicafe_research_view_owner',rel);
    EXECUTE format('REVOKE ALL ON u3_research.%I FROM PUBLIC,anon,authenticated',rel);
    EXECUTE format('GRANT SELECT ON u3_research.%I TO aicafe_research',rel);
  END LOOP;
END
$u3_views$;

-- No ability to execute an unrestricted model query through PostgREST, the
-- app's admin client or a public SECURITY DEFINER SQL function is introduced.
-- Dedicated-role LOGIN/password and private connection are provisioned only
-- after fully migrated role, canonical parity and attacker-path acceptance.
COMMIT;
