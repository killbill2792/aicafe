-- POS0e current-reader contract. Synthetic records ROLLBACK; disposable PostgreSQL only.
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
 employee_a uuid:='d1d1d1d1-1111-4111-8111-111111111111';
 d date:='2026-10-26'; response jsonb; p text; n int;
BEGIN
 INSERT INTO public.businesses(id,name,is_demo) VALUES
 (a,'POS0e synthetic A',false),(b,'POS0e synthetic B',false);
 PERFORM pg_temp.pos0e_assert(
  pg_get_functiondef('public.toast_records_for(uuid,date,date)'::regprocedure)
   NOT ILIKE '%toast_raw_sam%' AND
  pg_get_functiondef('public.ai_toast_fields(uuid,text)'::regprocedure)
   NOT ILIKE '%toast_raw_sam%',
  'active operational reader functions must exclude diagnostic snapshots');
 FOR p IN SELECT viewname FROM pg_views WHERE schemaname='public' AND left(viewname,3)='cv_'
 LOOP
  PERFORM pg_temp.pos0e_assert(
   pg_get_viewdef(('public.'||p)::regclass,true) NOT ILIKE '%toast_raw_sam%',
   'active canonical view must exclude diagnostic snapshots: '||p);
 END LOOP;
 PERFORM pg_temp.pos0e_assert(
  NOT has_table_privilege('authenticated','public.toast_raw_records','SELECT'),
  'client role cannot directly read retained raw objects');
 INSERT INTO public.toast_raw_records(
  business_id,restaurant_guid,entity,business_date,payload,payload_sha256,capture_key)
 VALUES
 (a,rest_a,'cashmgmt/v1/entries',d,
  '{"guid":"cash-current-A","amount":12.50,"type":"CASH_IN",
    "cardNumber":"4111111111111111","employee":{"guid":"employee-A","firstName":"Ava"},
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
 -- Same current stored typed employee record used by the registered
 -- Supervisor reader, not labor/v1/employees or diagnostic samples.
 INSERT INTO public.toast_raw_records(
  business_id,restaurant_guid,entity,entity_guid,business_date,payload,payload_sha256,capture_key)
 VALUES (a,rest_a,'employee',employee_a,d,
  jsonb_build_object('employee_guid',employee_a::text,'display_name','Nadia Rao','deleted',false),
  repeat('f',64),'pos0e:employee-a');
 PERFORM pg_temp.pos0e_assert(
  (SELECT count(*)=1 FROM public.toast_records_for(a,d,d)
   WHERE record_type='employee' AND record_ref=employee_a::text
    AND data->>'display_name'='Nadia Rao' AND data->>'firstName' IS NULL),
  'current retained employee identity must be available by record_ref GUID');
  -- Retained provider identity is durable after config re-save; a mirrored
  -- staged row without a provider-identity GET is never operational evidence.
  INSERT INTO public.locations(id,business_id,name) VALUES
   ('a1a1a1a1-1111-4111-8111-111111111111',a,'Verified Toast source'),
   ('b1b1b1b1-2222-4222-8222-222222222222',b,'Mirrored fixture');
  -- Each mapping needs a credential FK parent; these are inert test values.
  INSERT INTO public.toast_api_credentials
   (business_id,api_origin,client_id,client_secret_enc) VALUES
   (a,'https://synthetic.example','fixture-a','never-real'),
   (b,'https://synthetic.example','fixture-b','never-real');
  INSERT INTO public.toast_location_mappings
   (business_id,location_id,restaurant_guid,verified_at,info_refreshed_at) VALUES
   (a,'a1a1a1a1-1111-4111-8111-111111111111',rest_a,now(),now()),
   (b,'b1b1b1b1-2222-4222-8222-222222222222',rest_b,null,null);
  INSERT INTO public.toast_raw_records
   (business_id,restaurant_guid,entity,business_date,payload,payload_sha256,capture_key)
  VALUES
   (a,rest_a,'job',d,'{"guid":"source-job-A","name":"Shift leader"}',
    repeat('1',64),'stage:toast_job_directory:key:source-job-A'),
   (b,rest_b,'job',d,'{"guid":"fixture-job-B","name":"Copied fixture"}',
    repeat('2',64),'stage:toast_job_directory:key:fixture-job-B');
  PERFORM pg_temp.pos0e_assert(
   (SELECT count(*)=1 FROM public.toast_records_for(a,d,d)
    WHERE record_type='job' and data->>'name'='Shift leader'),
   'authentic staged source job visible before config re-save');
  -- The first verified sync can precede the optional restaurant-info GET.
  -- Current verification by itself must continue to authorize genuine stage.
  UPDATE public.toast_location_mappings SET info_refreshed_at=NULL
   WHERE business_id=a AND restaurant_guid=rest_a;
  PERFORM pg_temp.pos0e_assert(
   (SELECT count(*)=1 FROM public.toast_records_for(a,d,d)
    WHERE record_type='job' and data->>'name'='Shift leader'),
   'active verified mapping remains readable before restaurant info refresh');
  UPDATE public.toast_location_mappings SET info_refreshed_at=now()
   WHERE business_id=a AND restaurant_guid=rest_a;
  PERFORM pg_temp.pos0e_assert(
   (SELECT count(*)=0 FROM public.toast_records_for(b,d,d)
    WHERE record_type='job'),
   'copied stage fixture has no provider-identity evidence');
  PERFORM public.toast_save_configuration(a,'https://ws-api.toasttab.com',
   'synthetic_client','synthetic_ciphertext',jsonb_build_array(jsonb_build_object(
    'location_id','a1a1a1a1-1111-4111-8111-111111111111',
    'restaurant_guid',rest_a)));
  PERFORM pg_temp.pos0e_assert(
   (SELECT verified_at IS NULL AND info_refreshed_at IS NOT NULL
    FROM public.toast_location_mappings WHERE business_id=a AND restaurant_guid=rest_a),
   'config re-save clears active verification, not durable provider identity');
  PERFORM pg_temp.pos0e_assert(
   (SELECT count(*)=1 FROM public.toast_records_for(a,d,d)
    WHERE record_type='job' and data->>'name'='Shift leader'),
   'genuine retained job remains readable after failed verification');
  PERFORM pg_temp.pos0e_assert(
   public.ai_toast_fields(a,'job') @>
    '[{"field":"data.name","type":"string"}]'::jsonb,
   'retained staged job is still discoverable');
  response:=public.ai_query_view(a,'cv_toast_records',array['data.name']::text[],
   '[{"column":"record_type","op":"=","value":"job"}]'::jsonb,
   null::text[],null::jsonb,d,d,null,10);
  PERFORM pg_temp.pos0e_assert(
   response->'rows'->0->>'data.name'='Shift leader' and
    jsonb_array_length(response->'rows')=1,
   'registered query retains the authenticated job after reset');
  PERFORM pg_temp.pos0e_assert(
   (SELECT count(*)=0 FROM public.toast_records_for(b,d,d)
    WHERE record_type='job'),
   'mirror still excluded after real cafe re-verification reset');
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
 -- Test the same registered query_data SQL function for real cash amounts,
 -- independently of Luna model decisions or direct cv_cash SELECTs.
 response:=public.ai_query_view(a,'cv_cash',null::text[],
  '[]'::jsonb,null::text[],
  '[{"fn":"sum","column":"amount_cents"}]'::jsonb,d,d,null,100);
 PERFORM pg_temp.pos0e_assert(
  (response->'rows'->0->>'sum_amount_cents')::numeric=1250
  AND (response->>'truncated')::boolean=false,
  'current Toast cash cents must be accessible through canonical query_data RPC');
 -- Exercise the exact GUID-filtered named JSON field that Luna needs:
 -- current employee uses record_type=employee, NOT labor/v1/employees.
 response:=public.ai_query_view(a,'cv_toast_records',ARRAY['data.display_name']::text[],
  jsonb_build_array(
   jsonb_build_object('column','record_type','op','=','value','employee'),
   jsonb_build_object('column','record_ref','op','=','value',employee_a::text)),
  null::text[],null::jsonb,d,d,null,10);
 PERFORM pg_temp.pos0e_assert(
  response->'rows'->0->>'data.display_name'='Nadia Rao'
  AND jsonb_array_length(response->'rows')=1,
  'registered canonical query_data must return current employee by GUID and permitted named field');


 PERFORM pg_temp.pos0e_assert(
  public.ai_toast_fields(a,'cashmgmt/v1/entries') @>
   '[{"field":"data.extra.nested.1.lateOptional","type":"string"}]'::jsonb,
  'describe_data must preserve later array indices');
  PERFORM pg_temp.pos0e_assert(
   NOT (public.ai_toast_fields(a,'cashmgmt/v1/entries') @>
    '[{"field":"data.extra.nested.0.lateOptional"}]'::jsonb),
   'later array-only path must not be mislabelled index zero');
  response:=public.ai_query_view(a,'cv_toast_records',
   array['data.extra.nested.1.lateOptional']::text[],
   '[{"column":"record_type","op":"=","value":"cashmgmt/v1/entries"}]'::jsonb,
   null::text[],null::jsonb,d,d,null,10);
  PERFORM pg_temp.pos0e_assert(
   response->'rows'->0->>'data.extra.nested.1.lateOptional'='present-in-second-element'
    and jsonb_array_length(response->'rows')=1,
   'registered query retrieves the exact advertised array element');

 PERFORM pg_temp.pos0e_assert(
  public.ai_query_path('data.customer.email')=ARRAY['customer','email']::text[]
   and public.ai_query_path('data.cardNumber') is null
   and public.ai_query_path('data.employee.apiKey') is null
   and public.ai_query_path('data.cardInfo') is null
   and public.ai_query_path('data.customer.paymentMethod.value') is null,
  'SQL keeps permitted contact paths while denying credential paths');
 PERFORM pg_temp.pos0e_assert(
  not (public.ai_toast_fields(a,'cashmgmt/v1/entries') @>
    '[{"field":"data.cardNumber"}]'::jsonb),
  'legacy credential must not be described even when it exists in a retained row');
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
