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
     AND c.relkind IN ('v','m') AND c.relname LIKE 'cv\\_%' ESCAPE '\\'
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
  WHERE v.relnamespace='public'::regnamespace AND v.relname LIKE 'cv\\_%' ESCAPE '\\'
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
    (SELECT count(*)=4 FROM public.toast_records_for(a,'2026-10-26','2026-10-26'))
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
  result := public.ai_query_view(b,'cv_cash',null::text[],'[]'::jsonb,
    null::text[],'[{"fn":"sum","column":"amount_cents"}]'::jsonb,
    '2026-10-26','2026-10-26',null,20);
  PERFORM pg_temp.pos0f_assert(
    jsonb_array_length(result->'rows')=0
      OR (result->'rows'->0->>'sum_amount_cents') IS NULL,
    'Foreign/diagnostic-only café has no current cash sum');
END $pos0f$;
ROLLBACK;
