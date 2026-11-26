-- POS0f final-schema NEGATIVE authority gate.
-- Run only against a disposable Supabase with every migration already applied.
-- No production writes, no migration replacement, and no diagnostic purge.
\set ON_ERROR_STOP on
BEGIN;
-- Exercise the regex under the production-default PostgreSQL string semantics.
SET LOCAL standard_conforming_strings = on;
CREATE FUNCTION pg_temp.pos0f_assert(ok boolean, detail text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'POS0f final-source proof failed: %', detail; END IF;
END $$;

-- Shared by real function/view lineage checks and the deliberate poison probes.
-- With standard_conforming_strings=on, regex word boundaries need ONE slash.
CREATE FUNCTION pg_temp.pos0f_reject_diagnostic_definition(definition text, detail text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.pos0f_assert(
    definition !~* '\mtoast_raw_samples(_latest)?\M', detail);
END $$;

-- Disposable function BODY reference (not a view dependency); this must be
-- rejected by the exact same definition check as the operational readers.
CREATE FUNCTION pg_temp.pos0f_poisoned_reader() RETURNS bigint
LANGUAGE sql AS $poison$
  SELECT count(*) FROM public.toast_raw_samples
$poison$;
CREATE VIEW pg_temp.pos0f_poisoned_view AS
  SELECT count(*) AS diagnostic_rows FROM public.toast_raw_samples;

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
  poisoned_function_rejected boolean := false;
  poisoned_view_rejected boolean := false;
  p record;
  result jsonb;
  bad_count integer;
  latency_started timestamptz;
  stock_p95 numeric;
  discovery_p95 numeric;
  sample_count integer;
BEGIN
  -- Behavioral negative regression: PostgreSQL must THROW for definitions
  -- actually containing a diagnostic table, including inside a function body.
  BEGIN
    PERFORM pg_temp.pos0f_reject_diagnostic_definition(
      pg_get_functiondef('pg_temp.pos0f_poisoned_reader()'::regprocedure),
      'deliberately contaminated function');
  EXCEPTION WHEN raise_exception THEN
    poisoned_function_rejected :=
      SQLERRM = 'POS0f final-source proof failed: deliberately contaminated function';
  END;
  PERFORM pg_temp.pos0f_assert(poisoned_function_rejected,
    'Function-body diagnostic reference was not rejected');

  BEGIN
    PERFORM pg_temp.pos0f_reject_diagnostic_definition(
      pg_get_viewdef('pg_temp.pos0f_poisoned_view'::regclass, true),
      'deliberately contaminated view');
  EXCEPTION WHEN raise_exception THEN
    poisoned_view_rejected :=
      SQLERRM = 'POS0f final-source proof failed: deliberately contaminated view';
  END;
  PERFORM pg_temp.pos0f_assert(poisoned_view_rejected,
    'View diagnostic reference was not rejected');

  -- Check final effective function definitions, not an old migration or diff.
  FOR p IN
    SELECT oid, proname
      FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname IN ('toast_records_for','toast_current_nonorders_for','supervisor_research_sql')
  LOOP
    PERFORM pg_temp.pos0f_reject_diagnostic_definition(
      pg_get_functiondef(p.oid),
      'Operational function still mentions diagnostic storage: '||p.proname);
  END LOOP;
  PERFORM pg_temp.pos0f_assert(
    to_regprocedure('public.toast_records_for(uuid,date,date)') IS NOT NULL
    AND to_regprocedure('public.toast_current_nonorders_for(uuid,date,date,text)') IS NOT NULL
    AND to_regprocedure('public.supervisor_research_sql(uuid,uuid,text)') IS NOT NULL
    AND to_regprocedure('public.ai_query_view(uuid,text,text[],jsonb,text[],jsonb,date,date,jsonb,integer)') IS NULL,
    'The single SQL research reader exists; the old RPC is retired');

  -- Inspect the final CREATE OR REPLACE definitions for every cv_* view.
  FOR p IN
    SELECT c.oid, c.relname
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace
     AND c.relkind IN ('v','m') AND left(c.relname,3)='cv_'
  LOOP
    PERFORM pg_temp.pos0f_reject_diagnostic_definition(
      pg_get_viewdef(p.oid, true),
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
  -- The SAME operational roster writer must not create a new current row
  -- or change-log event for an identical provider response. A real employee
  -- name edit must replace the one object and journal exactly its changed
  -- field, rather than overwrite unversioned history or hash the name.
  PERFORM pg_temp.pos0f_assert(
    public.toast_stage_employee_roster(a,restaurant_a,jsonb_build_array(
      jsonb_build_object('employee_guid',employee_a,'display_name','Nadia POS0f',
        'deleted',false)))=1,
    'Repeated identical provider roster response is accepted');
  PERFORM pg_temp.pos0f_assert(
    (SELECT count(*)=1 FROM public.toast_raw_records WHERE business_id=a
      AND restaurant_guid=restaurant_a AND entity='employee'
      AND entity_guid=employee_a)
    AND NOT EXISTS (SELECT 1 FROM public.toast_raw_changes
      WHERE business_id=a AND entity='employee' AND entity_guid=employee_a),
    'Identical roster fetch remains one current row with no artificial change');
  PERFORM pg_temp.pos0f_assert(
    public.toast_stage_employee_roster(a,restaurant_a,jsonb_build_array(
      jsonb_build_object('employee_guid',employee_a,'display_name','Nadia Updated',
        'deleted',false)))=1,
    'A genuine provider name edit is accepted by the existing writer');
  PERFORM pg_temp.pos0f_assert(
    (SELECT count(*)=1 AND max(payload->>'display_name')='Nadia Updated'
      FROM public.toast_raw_records WHERE business_id=a AND entity='employee'
      AND entity_guid=employee_a)
    AND (SELECT count(*)=1 FROM public.toast_raw_changes
      WHERE business_id=a AND entity='employee' AND entity_guid=employee_a
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(changes) d
          WHERE d->>'path'='.display_name' AND d->>'before'='Nadia POS0f'
            AND d->>'after'='Nadia Updated')),
    'Changed roster name is current once, with one exact before/after audit');
  PERFORM pg_temp.pos0f_assert(
    (SELECT count(*)=1 AND bool_and(data->>'display_name'='Nadia Updated')
     FROM public.toast_records_for(a,null,null)
     WHERE record_type='employee' AND record_ref=employee_a::text),
    'SQL returns real roster writer name by GUID');
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
       WHERE record_type='employee'),
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

  -- #564: same operational current-object projection for the stock view,
  -- retained field discovery and the original Toast source reader. A proof
  -- with null provider quantity stays null and no diagnostic record may enter.
  PERFORM pg_temp.pos0f_assert(
    (SELECT count(*)=1 FROM public.toast_current_nonorders_for(
      a,null,null,'stock/v1/inventory'))
    AND (SELECT count(*)=0 FROM public.toast_current_nonorders_for(
      b,null,null,'stock/v1/inventory'))
    AND NOT EXISTS (
      (SELECT r.source_ref,r.status,r.record_ref,r.business_date,r.data
       FROM public.toast_records_for(a,null,null) r
       WHERE r.record_type='stock/v1/inventory'
       EXCEPT
       SELECT c.source_ref,c.status,c.record_ref,c.business_date,c.data
       FROM public.toast_current_nonorders_for(
        a,null,null,'stock/v1/inventory') c)
      UNION ALL
      (SELECT c.source_ref,c.status,c.record_ref,c.business_date,c.data
       FROM public.toast_current_nonorders_for(
        a,null,null,'stock/v1/inventory') c
       EXCEPT
       SELECT r.source_ref,r.status,r.record_ref,r.business_date,r.data
       FROM public.toast_records_for(a,null,null) r
       WHERE r.record_type='stock/v1/inventory')),
    'stock-only shared current projection matches every operational Toast field without diagnostic or foreign data');
  PERFORM pg_temp.pos0f_assert(
    (SELECT count(*)>0 AND bool_and(jsonb_typeof(data->'status')='string'
       AND jsonb_typeof(data->'guid')='string'
       AND jsonb_typeof(data->'quantity') IS DISTINCT FROM 'number')
     FROM public.toast_records_for(a,null,null,ARRAY['stock/v1/inventory'])),
    'current stock SQL preserves string fields and never invents numeric evidence');
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
  -- Record-family pushdown returns exactly the rows the unfiltered reader returns for those families, nothing else.
  PERFORM pg_temp.pos0f_assert(
    (SELECT count(*) FROM public.toast_records_for(a,null,null,ARRAY['check']))
      =(SELECT count(*) FROM public.toast_records_for(a,null,null) WHERE record_type='check'),
    'pushdown check count');
  PERFORM pg_temp.pos0f_assert(
    (SELECT count(*) FROM public.toast_records_for(a,null,null,ARRAY['payment','item']))
      =(SELECT count(*) FROM public.toast_records_for(a,null,null) WHERE record_type IN ('payment','item')),
    'pushdown payment/item count');
  PERFORM pg_temp.pos0f_assert(
    (SELECT count(*) FROM public.toast_records_for(a,null,null,ARRAY['stock/v1/inventory']))
      =(SELECT count(*) FROM public.toast_records_for(a,null,null) WHERE record_type='stock/v1/inventory'),
    'pushdown nonorder count');
  PERFORM pg_temp.pos0f_assert(
    NOT EXISTS (SELECT 1 FROM public.toast_records_for(a,null,null,ARRAY['check']) WHERE record_type<>'check')
    AND (SELECT count(*) FROM public.toast_records_for(a,null,null,ARRAY['order']))
      =(SELECT count(*) FROM public.toast_records_for(a,null,null) WHERE record_type='order'),
    'pushdown exclusivity and order family');

  PERFORM pg_temp.pos0f_assert(
    (SELECT sum(amount_cents)=1250 FROM public.cv_cash WHERE business_id=a AND business_date='2026-10-26')
    AND (SELECT count(*)=1 AND bool_and(quantity IS NULL AND stock_status='QUANTITY')
      FROM public.cv_inventory WHERE business_id=a AND source='toast' AND business_date='2026-10-26')
    AND (SELECT count(*)=1 AND bool_and(dining_option_name='Patio' AND business_date IS NULL)
      FROM public.cv_dining_options WHERE business_id=a AND dining_option_ref='dining-current-a')
    AND (SELECT sum(amount_cents) IS NULL FROM public.cv_cash WHERE business_id=b),
    'SQL reads matching screen cash, unknown stock, undated dining and no foreign cash');

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
    AND (SELECT count(*)=0 FROM public.toast_current_nonorders_for(a,null,null,'stock/v1/inventory'))
    AND NOT has_table_privilege('public.toast_raw_records','SELECT'),
    'Nonmember cannot read A via the shared reader or direct current archive');
  PERFORM pg_temp.pos0f_assert(
    NOT EXISTS (SELECT 1 FROM public.cv_cash WHERE business_id=a),
    'Authenticated nonmember cannot obtain A cash');
  EXECUTE 'reset role';
  PERFORM set_config('request.jwt.claim.sub',owner_a::text,true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub',owner_a::text,'role','authenticated')::text,true);
  EXECUTE 'set local role authenticated';
  PERFORM pg_temp.pos0f_assert(
    (SELECT count(*)=5 FROM public.toast_records_for(a,null,null))
    AND (SELECT count(*)=0 FROM public.toast_records_for(b,null,null))
    AND (SELECT count(*)=1 FROM public.toast_current_nonorders_for(a,null,null,'stock/v1/inventory'))
    AND (SELECT count(*)=0 FROM public.toast_current_nonorders_for(b,null,null,'stock/v1/inventory')),
    'Member reads exact A current facts, never another café');
  PERFORM pg_temp.pos0f_assert(
    (SELECT sum(amount_cents)=1250 FROM public.cv_cash WHERE business_id=a AND business_date='2026-10-26'),
    'Authorized owner receives same 1250 screen cash cents');
  EXECUTE 'reset role';

  -- #564 production-size data shape, in this ROLLED BACK disposable DB only.
  -- Real café stock query timed out with 12,480 unrelated operational orders.
  -- Keep all 12,500 fixture orders: no history/date or field cutoff permitted.
  INSERT INTO public.toast_raw_records
   (business_id,restaurant_guid,entity,entity_guid,business_date,
    payload,payload_sha256,capture_key)
  SELECT a,restaurant_a,'order',gen_random_uuid(),'2026-10-25'::date,
   jsonb_build_object('guid',gen_random_uuid()::text,'checks',
    jsonb_build_array(
     jsonb_build_object('guid',gen_random_uuid()::text,'selections',
      jsonb_build_array(jsonb_build_object('guid',gen_random_uuid()::text,
       'item',jsonb_build_object('name','Unrelated order'),
       'price',9.99,'tax',0.67,'modifiers',jsonb_build_array(
        jsonb_build_object('guid',gen_random_uuid()::text,'name','Extra'))))))),
   md5(g.n::text)||md5(g.n::text),'live:stock-discovery-load:'||g.n::text
  FROM generate_series(1,12500) g(n);
  PERFORM pg_temp.pos0f_assert(
   (SELECT count(*)=12500 FROM public.toast_raw_records
    WHERE business_id=a AND entity='order'
      AND capture_key LIKE 'live:stock-discovery-load:%'),
   'stock field-discovery latency fixture includes 12,500 unrelated operational orders');
  CREATE TEMP TABLE pg_temp.pos0f_source_latency(kind text,ms numeric) ON COMMIT DROP;
  FOR sample_count IN 1..12 LOOP
    latency_started:=clock_timestamp();
    PERFORM count(*) FROM public.cv_inventory
     WHERE business_id=a AND source='toast';
    INSERT INTO pg_temp.pos0f_source_latency VALUES
     ('inventory',1000*extract(epoch from clock_timestamp()-latency_started));
    latency_started:=clock_timestamp();
    PERFORM data FROM public.toast_records_for(a,null,null,ARRAY['stock/v1/inventory']);
    INSERT INTO pg_temp.pos0f_source_latency VALUES
     ('fields',1000*extract(epoch from clock_timestamp()-latency_started));
  END LOOP;
  SELECT percentile_cont(0.95) WITHIN GROUP(ORDER BY ms)::numeric
   INTO stock_p95 FROM pg_temp.pos0f_source_latency WHERE kind='inventory';
  SELECT percentile_cont(0.95) WITHIN GROUP(ORDER BY ms)::numeric
   INTO discovery_p95 FROM pg_temp.pos0f_source_latency WHERE kind='fields';
  PERFORM pg_temp.pos0f_assert(
   stock_p95<2000 AND discovery_p95<2000,
   '12,500 unrelated orders must not make inventory/discovery timeout: stock p95='
     ||stock_p95||'ms, fields p95='||discovery_p95||'ms');
  RAISE NOTICE 'POS0f #564: 12,500-order scoped stock p95=% ms; stock field p95=% ms (12 reads each)',
    round(stock_p95,1),round(discovery_p95,1);
END $pos0f$;
ROLLBACK;
