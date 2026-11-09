-- POS0e actual migrated-schema reader proof. Execute ONLY in disposable PostgreSQL
-- after every current migration. Synthetic cafés/records and intentional poison
-- diagnostics are rolled back; never run this against production.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.pos0e_assert(ok boolean,description text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'POS0e FAIL: %',description; END IF;
END $$;

DO $pos0e$
DECLARE
 a uuid:='f1f1f1f1-1111-4111-8111-111111111111';
 b uuid:='f2f2f2f2-2222-4222-8222-222222222222';
 rest_a uuid:='e1e1e1e1-1111-4111-8111-111111111111';
 rest_b uuid:='e2e2e2e2-2222-4222-8222-222222222222';
 d date:='2026-10-26'; response jsonb; p text; n int;
BEGIN
 INSERT INTO public.businesses(id,name,is_demo) VALUES
 (a,'POS0e synthetic A',false),(b,'POS0e synthetic B',false);
 -- Direct and transitive migrated SQL lineage: active reader/view definitions
 -- must not mention diagnostics, not only the new source file text.
 PERFORM pg_temp.pos0e_assert(
  pg_get_functiondef('public.toast_records_for(uuid,date,date)'::regprocedure)
   NOT ILIKE '%toast_raw_samples%' AND
  pg_get_functiondef('public.ai_toast_fields(uuid,text)'::regprocedure)
   NOT ILIKE '%toast_raw_samples%',
  'active operational reader functions must exclude diagnostic snapshots');
 FOREACH p IN ARRAY ARRAY['cv_cash','cv_inventory','cv_kitchen','cv_dining_options','cv_toast_records']
 LOOP
  PERFORM pg_temp.pos0e_assert(
   pg_get_viewdef(('public.'||p)::regclass,true) NOT ILIKE '%toast_raw_samples%',
   'active canonical view must exclude diagnostic snapshots: '||p);
 END LOOP;
 PERFORM pg_temp.pos0e_assert(
  NOT has_table_privilege('authenticated','public.toast_raw_records','SELECT'),
  'client role cannot directly read retained raw objects');
 -- Good current-source events, including incomplete/null business facts, and
 -- a second café with a distinct cash amount.
 INSERT INTO public.toast_raw_records(
  business_id,restaurant_guid,entity,business_date,payload,payload_sha256,capture_key)
 VALUES
 (a,rest_a,'cashmgmt/v1/entries',d,
  '{"guid":"cash-current-A","amount":12.50,"type":"CASH_IN",
    "employee":{"guid":"employee-A","firstName":"Ava"},
    "extra":{"nested":[{"common":true},{"lateOptional":"present-in-second-element"}]}}',
  repeat('a',64),'pos0e:cash-a'),
 (a,rest_a,'stock/v1/inventory',d,
  '{"guid":"menu-item-A","status":"QUANTITY","quantity":null}',
  repeat('b',64),'pos0e:stock-a'),
 (a,rest_a,'kitchen/v1/export/itemFulfillments',d,
  '{"guid":"kds-A","orderGuid":"order-A","ticketGuid":"ticket-A",
    "itemStartedAt":null,"itemFulfilledAt":null}',
  repeat('c',64),'pos0e:kds-a'),
 (a,rest_a,'config/v2/diningOptions',null,
  '{"guid":"dine-A","name":"Patio","behavior":"DINE_IN"}',
  repeat('d',64),'pos0e:dine-a'),
 (b,rest_b,'cashmgmt/v1/entries',d,
  '{"guid":"cash-current-B","amount":83.00,"type":"CASH_IN"}',
  repeat('e',64),'pos0e:cash-b');

 -- Historical diagnostic capture claims 9999.00 and different stock/KDS/menu.
 -- None of these claims may influence any operational reader or query.
 INSERT INTO public.toast_raw_samples(
  business_id,restaurant_guid,endpoint,business_date,http_status,
  item_count,sample,field_paths) VALUES
 (a,rest_a::text,'cashmgmt/v1/entries',d,200,1,
  '[{"guid":"cash-poison","amount":9999}]','{}'),
 (a,rest_a::text,'stock/v1/inventory',d,200,1,
  '[{"guid":"stock-poison","quantity":0}]','{}'),
 (a,rest_a::text,'kitchen/v1/export/itemFulfillments',d,200,1,
  '[{"ticketGuid":"ticket-poison"}]','{}'),
 (a,rest_a::text,'config/v2/diningOptions',d,200,1,
  '[{"guid":"dine-poison","name":"Diagnostic"}]','{}');

 PERFORM pg_temp.pos0e_assert(
  (SELECT count(*)=1 AND sum(amount_cents)=1250 FROM public.cv_cash WHERE business_id=a),
  'cash must equal retained operational A object, not the poisoned sample');
 PERFORM pg_temp.pos0e_assert(
  (SELECT count(*)=1 AND every(quantity IS NULL)
   FROM public.cv_inventory WHERE business_id=a AND source='toast'),
  'unknown stock quantity must remain NULL, not zero');
 PERFORM pg_temp.pos0e_assert(
  (SELECT count(*)=1 FROM public.cv_kitchen WHERE business_id=a AND ticket_ref='ticket-A')
  AND NOT EXISTS(SELECT 1 FROM public.cv_kitchen WHERE business_id=a AND ticket_ref='ticket-poison'),
  'kitchen must never consume diagnostic-only fulfillments');
 PERFORM pg_temp.pos0e_assert(
  (SELECT count(*)=1 FROM public.cv_dining_options WHERE business_id=a AND dining_option_ref='dine-A')
  AND NOT EXISTS(SELECT 1 FROM public.cv_dining_options WHERE business_id=a AND dining_option_ref='dine-poison'),
  'dining options must never consume diagnostic-only names');
 PERFORM pg_temp.pos0e_assert(
  (SELECT count(*)=1 FROM public.toast_records_for(a,d,d) r
   WHERE record_type='cashmgmt/v1/entries' AND data->>'guid'='cash-current-A'),
  'shared reader must expose A only once');
 PERFORM pg_temp.pos0e_assert(
  (SELECT count(*)=1 FROM public.toast_records_for(b,d,d) r
   WHERE record_type='cashmgmt/v1/entries' AND data->>'guid'='cash-current-B'),
  'shared reader must isolate B');
 PERFORM pg_temp.pos0e_assert(
  (SELECT count(*)=0 FROM public.toast_records_for(a,d,d) r
   WHERE data->>'guid' IN ('cash-current-B','cash-poison','dine-poison')),
  'neither another café nor diagnostics may appear through A reader');
 response:=public.ai_query_view(a,'cv_toast_records',null::text[],
  '[{"column":"record_type","op":"=","value":"cashmgmt/v1/entries"}]'::jsonb,
  null::text[],'[{"fn":"count","column":"source_ref"}]'::jsonb,d,d,null,100);
 PERFORM pg_temp.pos0e_assert(
  response->'rows'->0->>'count_source_ref'='1' AND response->>'truncated'='false',
  'bounded query_data must count one retained current event');
 PERFORM pg_temp.pos0e_assert(
  public.ai_toast_fields(a,'cashmgmt/v1/entries') @>
   '[{"field":"data.extra.nested.0.lateOptional","type":"string"}]'::jsonb,
  'describe_data must inspect later array elements and nested optional fields');
 -- Large historical capture cannot silently disappear at an arbitrary 30-row
 -- or 200-path limit. This fixture is still small and rolls back.
 FOR n IN 1..36 LOOP
  INSERT INTO public.toast_raw_records(business_id,restaurant_guid,entity,business_date,
   payload,payload_sha256,capture_key)
  VALUES (a,rest_a,'labor/v1/timeEntries',d,
   jsonb_build_object('guid','time-'||n,'regularHours',n,
    'lateOnly',CASE WHEN n=36 THEN 'visible' ELSE null END),
   repeat('f',64),'pos0e:time:'||n);
 END LOOP;
 PERFORM pg_temp.pos0e_assert(
  public.ai_toast_fields(a,'labor/v1/timeEntries') @>
    '[{"field":"data.lateOnly","type":"string"}]'::jsonb,
  'field discovery must see later retained rows');
END $pos0e$;
ROLLBACK;
