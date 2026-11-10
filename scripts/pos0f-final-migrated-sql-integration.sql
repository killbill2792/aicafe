-- POS0f final-schema NEGATIVE authority gate.
-- Run only against a disposable Supabase with every migration already applied.
-- No production writes, no migration replacement, and no diagnostic purge.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.pos0f_assert(ok boolean, detail text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'POS0f final-source proof failed: %', detail; END IF;
END $$;

DO $pos0f$
DECLARE
  a uuid := 'a3a3a3a3-3333-4333-8333-333333333333';
  b uuid := 'b4b4b4b4-4444-4444-8444-444444444444';
  restaurant_a uuid := 'c3c3c3c3-3333-4333-8333-333333333333';
  restaurant_b uuid := 'd4d4d4d4-4444-4444-8444-444444444444';
  employee_a uuid := 'e7e7e7e7-7777-4777-8777-777777777777';
  owner_a uuid := 'f5f5f5f5-5555-4555-8555-555555555555';
  outsider uuid := 'f6f6f6f6-6666-4666-8666-666666666666';
  forbidden_stage boolean := false;
  p record;
  result jsonb;
  bad_count integer;
BEGIN
  -- Check final effective function definitions, not an old migration or diff.
  FOR p IN
    SELECT oid, proname
      FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname IN ('toast_records_for','ai_toast_fields','ai_query_view')
  LOOP
    PERFORM pg_temp.pos0f_assert(
      pg_get_functiondef(p.oid) !~* '\\mtoast_raw_samples(_latest)?\\M',
      'Operational function still mentions diagnostic storage: '||p.proname);
  END LOOP;
  PERFORM pg_temp.pos0f_assert(
    to_regprocedure('public.toast_records_for(uuid,date,date)') IS NOT NULL
    AND to_regprocedure('public.ai_toast_fields(uuid,text)') IS NOT NULL
    AND to_regprocedure('public.ai_query_view(uuid,text,text[],jsonb,text[],jsonb,date,date,jsonb,integer)') IS NOT NULL,
    'The one existing registered SQL reader and field/query functions must exist');

  -- Inspect the final CREATE OR REPLACE definitions for every cv_* view.
  FOR p IN
    SELECT c.oid, c.relname
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace
     AND c.relkind IN ('v','m') AND left(c.relname,3)='cv_'
  LOOP
    PERFORM pg_temp.pos0f_assert(
      pg_get_viewdef(p.oid, true) !~* '\\mtoast_raw_samples(_latest)?\\M',
      'Final operational view still mentions diagnostics: '||p.relname);
  END LOOP;

  -- Direct or transitive view dependency on any diagnostic table is forbidden.
  WITH RECURSIVE depends_on(view_oid, referenced_oid) AS (
    SELECT rw.ev_class, dep.refobjid
    FROM pg_rewrite rw JOIN pg_depend dep
      ON dep.classid='pg_rewrite'::regclass AND dep.objid=rw.oid
    WHERE rw.ev_class IN (
      SELECT oid FROM pg_class
       WHERE relnamespace='public'::regnamespace AND relkind IN ('v','m'))
      AND dep.refclassid='pg_class'::regclass AND dep.refobjid<>rw.ev_class
    UNION
    SELECT d.view_oid, dep.refobjid
    FROM depends_on d
    JOIN pg_rewrite rw ON rw.ev_class=d.referenced_oid
    JOIN pg_depend dep ON dep.classid='pg_rewrite'::regclass AND dep.objid=rw.oid
    WHERE dep.refclassid='pg_class'::regclass AND dep.refobjid<>rw.ev_class
  )
  SELECT count(*) INTO bad_count
  FROM depends_on d JOIN pg_class v ON v.oid=d.view_oid
   JOIN pg_class source ON source.oid=d.referenced_oid
  WHERE v.relnamespace='public'::regnamespace AND left(v.relname,3)='cv_'
    AND source.relnamespace='public'::regnamespace
    AND source.relname IN ('toast_raw_samples','toast_raw_samples_latest');
  PERFORM pg_temp.pos0f_assert(bad_count=0,
    'Canonical views transitively depend on diagnostic capture: '||bad_count);

  PERFORM pg_temp.pos0f_assert(
    NOT has_table_privilege('authenticated','public.toast_raw_records','SELECT')
    AND NOT has_table_privilege('anon','public.toast_raw_samples','SELECT'),
    'Raw operational and diagnostic storage cannot be directly browsed by ordinary clients');

  INSERT INTO public.businesses(id,name,is_demo)
    VALUES (a,'POS0f disposable café A',false),(b,'POS0f disposable café B',false);

  -- Independent source-family writer proof: use the same authorized roster
  -- staging RPC as operationalStaging.ts, not invented direct archive rows.
  -- Restaurant B deliberately has no provider verification; its staged data
  -- cannot become trusted current café evidence.
  INSERT INTO public.locations(id,business_id,name) VALUES
    ('a7a7a7a7-7777-4777-8777-777777777777',a,'POS0f source restaurant A'),
    ('b8b8b8b8-8888-4888-8888-888888888888',b,'POS0f unverified restaurant B');
  INSERT INTO public.toast_api_credentials
    (business_id,api_origin,client_id,client_secret_enc) VALUES
    (a,'https://synthetic.invalid','pos0f-a','synthetic-not-real'),
    (b,'https://synthetic.invalid','pos0f-b','synthetic-not-real');
  INSERT INTO public.toast_location_mappings
    (business_id,location_id,restaurant_guid,verified_at,info_refreshed_at) VALUES
    (a,'a7a7a7a7-7777-4777-8777-777777777777',restaurant_a,now(),now()),
    (b,'b8b8b8b8-8888-4888-8888-888888888888',restaurant_b,null,null);
  PERFORM pg_temp.pos0f_assert(
    public.toast_stage_employee_roster(a,restaurant_a,jsonb_build_array(
      jsonb_build_object('employee_guid',employee_a,'display_name','Nadia POS0f',
        'deleted',false)))=1,
    'Actual verified-source roster writer must stage one permitted employee');
  PERFORM pg_temp.pos0f_assert(
    (SELECT count(*)=1 FROM public.toast_employee_directory
      WHERE business_id=a AND restaurant_guid=restaurant_a
        AND employee_guid=employee_a AND display_name='Nadia POS0f'),
    'Source writer must retain un-hashed staff name and immutable provider GUID');
  PERFORM pg_temp.pos0f_assert(
    (SELECT count(*)=1 FROM public.toast_raw_records
      WHERE business_id=a AND restaurant_guid=restaurant_a AND entity='employee'
        AND payload->>'display_name'='Nadia POS0f'),
    'Actual roster writer/trigger must retain exactly one current object');
  PERFORM pg_temp.pos0f_assert(
    public.ai_toast_fields(a,'employee') @>
      '[{"field":"data.display_name","type":"string"}]'::jsonb,
    'Existing describe_data SQL field discovery exposes actual written staff name');
  result := public.ai_query_view(a,'cv_toast_records',ARRAY['data.display_name']::text[],
    jsonb_build_array(
      jsonb_build_object('column','record_type','op','=','value','employee'),
      jsonb_build_object('column','record_ref','op','=','value',employee_a::text)),
    null::text[],null::jsonb,'2026-10-26','2026-10-26',null,10);
  PERFORM pg_temp.pos0f_assert(
    jsonb_array_length(result->'rows')=1
      AND result->'rows'->0->>'data.display_name'='Nadia POS0f',
    'Registered existing query_data SQL must return real roster writer name by GUID');
  BEGIN
    PERFORM public.toast_stage_employee_roster(b,restaurant_b,jsonb_build_array(
      jsonb_build_object('employee_guid',employee_a,'display_name','Foreign unverified',
        'deleted',false)));
  EXCEPTION WHEN OTHERS THEN
    forbidden_stage := sqlerrm='invalid Toast roster';
  END;
  PERFORM pg_temp.pos0f_assert(forbidden_stage,
    'Unverified café must reject a forged source-roster staging attempt');
  PERFORM pg_temp.pos0f_assert(
    NOT EXISTS (SELECT 1 FROM public.toast_records_for(b,null,null)
       WHERE record_type='employee')
    AND public.ai_toast_fields(b,'employee')='[]'::jsonb,
    'Other café has no provider-verified staff discovery or data');

  -- Same restaurant-scoped current writer/storage shape as POS0e. A deliberately
  -- contradictory diagnostic capture must never replace or add to these facts.
  INSERT INTO public.toast_raw_records
    (business_id,restaurant_guid,entity,entity_guid,business_date,payload,payload_sha256,capture_key)
  VALUES
    (a,restaurant_a,'cashmgmt/v1/entries',
     'e3e3e3e3-3333-4333-8333-333333333333','2026-10-26',
     '{"guid":"cash-current-a","type":"CASH_IN","amount":12.50}',repeat('a',64),'pos0f:cash'),
    (a,restaurant_a,'stock/v1/inventory',
     'e4e4e4e4-4444-4444-8444-444444444444','2026-10-26',
     '{"guid":"stock-current-a","status":"QUANTITY","quantity":null}',repeat('b',64),'pos0f:stock'),
    (a,restaurant_a,'kitchen/v1/export/itemFulfillments',
     'e5e5e5e5-5555-4555-8555-555555555555','2026-10-26',
     '{"guid":"kds-current-a","ticketGuid":"ticket-current-a"}',repeat('c',64),'pos0f:kitchen'),
    (a,restaurant_a,'config/v2/diningOptions',
     'e6e6e6e6-6666-4666-8666-666666666666',null,
     '{"guid":"dining-current-a","name":"Patio","behavior":"DINE_IN"}',repeat('d',64),'pos0f:config');

  INSERT INTO public.toast_raw_samples
    (business_id,restaurant_guid,endpoint,business_date,fetched_at,
     http_status,item_count,sample,field_paths,capture_id,error_code)
  VALUES
    (a,restaurant_a,'cashmgmt/v1/entries','2026-10-26',now(),200,1,
     '[{"guid":"cash-diagnostic-poison","amount":99999.00}]'::jsonb,
     ARRAY['guid','amount'],gen_random_uuid(),null),
    (a,restaurant_a,'stock/v1/inventory','2026-10-26',now(),200,1,
     '[{"guid":"stock-diagnostic-poison","quantity":99999}]'::jsonb,
     ARRAY['guid','quantity'],gen_random_uuid(),null),
    (a,restaurant_a,'kitchen/v1/export/itemFulfillments','2026-10-26',now(),200,1,
     '[{"guid":"kds-diagnostic-poison","ticketGuid":"ticket-diagnostic-poison"}]'::jsonb,
     ARRAY['guid','ticketGuid'],gen_random_uuid(),null),
    (a,restaurant_a,'config/v2/diningOptions',null,now(),200,1,
     '[{"guid":"dining-diagnostic-poison","name":"Fake VIP"}]'::jsonb,
     ARRAY['guid','name'],gen_random_uuid(),null),
    (b,restaurant_b,'cashmgmt/v1/entries','2026-10-26',now(),200,1,
     '[{"guid":"foreign-diagnostic-poison","amount":22222.00}]'::jsonb,
     ARRAY['guid','amount'],gen_random_uuid(),null);

  PERFORM pg_temp.pos0f_assert(
    (SELECT count(*)=1 AND sum(amount_cents)=1250
      FROM public.cv_cash WHERE business_id=a),
    'Current cash must equal 1250 cents, never 99999 diagnostic dollars');
  PERFORM pg_temp.pos0f_assert(
    (SELECT count(*)=1 AND bool_and(quantity IS NULL)
      FROM public.cv_inventory WHERE business_id=a AND source='toast'),
    'NULL stock quantity remains unknown, never synthetic or zero');
  PERFORM pg_temp.pos0f_assert(
    (SELECT count(*)=1 FROM public.cv_kitchen
      WHERE business_id=a AND ticket_ref='ticket-current-a')
    AND NOT EXISTS (SELECT 1 FROM public.cv_kitchen
      WHERE ticket_ref='ticket-diagnostic-poison'),
    'Only current kitchen evidence may reach screens');
  PERFORM pg_temp.pos0f_assert(
    (SELECT count(*)=1 FROM public.cv_dining_options
      WHERE business_id=a AND dining_option_ref='dining-current-a')
    AND NOT EXISTS (SELECT 1 FROM public.cv_dining_options
      WHERE dining_option_ref='dining-diagnostic-poison'),
    'Only current published dining configuration may reach screens');
  PERFORM pg_temp.pos0f_assert(
    (SELECT count(*)=5 FROM public.toast_records_for(a,'2026-10-26','2026-10-26'))
    AND (SELECT count(*)=0 FROM public.toast_records_for(b,'2026-10-26','2026-10-26'))
    AND NOT EXISTS (SELECT 1 FROM public.toast_records_for(a,null,null)
      WHERE data->>'guid' LIKE '%diagnostic-poison'),
    'Shared reader returns current A records once and refuses foreign/diagnostic-only rows');

  result := public.ai_query_view(a,'cv_cash',null::text[],'[]'::jsonb,
    null::text[],'[{"fn":"sum","column":"amount_cents"}]'::jsonb,
    '2026-10-26','2026-10-26',null,20);
  PERFORM pg_temp.pos0f_assert(
    (result->'rows'->0->>'sum_amount_cents')::integer=1250
    AND (result->>'truncated')::boolean=false,
    'Existing query_data RPC must retrieve exactly the current cash screen cents');
  -- Match another relevant screen (stock) and an undated configuration
  -- through the *same* registered query function, preserving NULL as unknown.
  result := public.ai_query_view(a,'cv_inventory',ARRAY['quantity','stock_status']::text[],
    '[{"column":"source","op":"=","value":"toast"}]'::jsonb,
    null::text[],null::jsonb,'2026-10-26','2026-10-26',null,10);
  PERFORM pg_temp.pos0f_assert(
    jsonb_array_length(result->'rows')=1
    AND result->'rows'->0->>'quantity' IS NULL
    AND result->'rows'->0->>'stock_status'='QUANTITY',
    'query_data and stock screen must agree quantity is unknown, not zero');
  result := public.ai_query_view(a,'cv_dining_options',
    ARRAY['dining_option_name','business_date']::text[],
    '[{"column":"dining_option_ref","op":"=","value":"dining-current-a"}]'::jsonb,
    null::text[],null::jsonb,'2026-10-26','2026-10-26',null,10);
  PERFORM pg_temp.pos0f_assert(
    jsonb_array_length(result->'rows')=1
    AND result->'rows'->0->>'dining_option_name'='Patio'
    AND result->'rows'->0->>'business_date' IS NULL,
    'Published undated dining option remains queryable without invented date');

  result := public.ai_query_view(b,'cv_cash',null::text[],'[]'::jsonb,
    null::text[],'[{"fn":"sum","column":"amount_cents"}]'::jsonb,
    '2026-10-26','2026-10-26',null,20);
  PERFORM pg_temp.pos0f_assert(
    jsonb_array_length(result->'rows')=0
      OR (result->'rows'->0->>'sum_amount_cents') IS NULL,
    'Foreign/diagnostic-only café has no current cash sum');

  -- Real PostgreSQL JWT/role isolation: the existence of source rows must
  -- not give an unrelated authenticated account access to either the archive
  -- or the registered reader. An owner may query A only, not B.
  INSERT INTO auth.users
    (id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
  VALUES
    (owner_a,'00000000-0000-0000-0000-000000000000','authenticated',
      'authenticated','pos0f-owner@example.invalid','',now(),now()),
    (outsider,'00000000-0000-0000-0000-000000000000','authenticated',
      'authenticated','pos0f-outsider@example.invalid','',now(),now());
  INSERT INTO public.memberships(business_id,user_id,role)
    VALUES (a,owner_a,'owner');
  PERFORM set_config('request.jwt.claim.sub',outsider::text,true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub',outsider::text,'role','authenticated')::text,true);
  EXECUTE 'set local role authenticated';
  PERFORM pg_temp.pos0f_assert(
    (SELECT count(*)=0 FROM public.toast_records_for(a,null,null))
    AND NOT has_table_privilege('public.toast_raw_records','SELECT'),
    'Nonmember cannot read A via the shared reader or direct current archive');
  result := public.ai_query_view(a,'cv_cash',null::text[],'[]'::jsonb,
    null::text[],'[{"fn":"sum","column":"amount_cents"}]'::jsonb,
    '2026-10-26','2026-10-26',null,20);
  PERFORM pg_temp.pos0f_assert(
    jsonb_array_length(result->'rows')=0 OR
    result->'rows'->0->>'sum_amount_cents' IS NULL,
    'Authenticated nonmember must not obtain A cash through registered query_data');
  EXECUTE 'reset role';
  PERFORM set_config('request.jwt.claim.sub',owner_a::text,true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub',owner_a::text,'role','authenticated')::text,true);
  EXECUTE 'set local role authenticated';
  PERFORM pg_temp.pos0f_assert(
    (SELECT count(*)=5 FROM public.toast_records_for(a,null,null))
    AND (SELECT count(*)=0 FROM public.toast_records_for(b,null,null)),
    'Member reads exact A current facts, never another café');
  result := public.ai_query_view(a,'cv_cash',null::text[],'[]'::jsonb,
    null::text[],'[{"fn":"sum","column":"amount_cents"}]'::jsonb,
    '2026-10-26','2026-10-26',null,20);
  PERFORM pg_temp.pos0f_assert(
    (result->'rows'->0->>'sum_amount_cents')::integer=1250,
    'Authorized owner receives same 1250 screen/query cash cents');
  EXECUTE 'reset role';
END $pos0f$;
ROLLBACK;
