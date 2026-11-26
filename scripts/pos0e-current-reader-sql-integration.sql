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
 cohort_run uuid:=gen_random_uuid(); cohort_guest uuid:=gen_random_uuid(); cohort_other uuid:=gen_random_uuid();
 cadence_guest uuid:=gen_random_uuid(); lapse_guest uuid:=gen_random_uuid();
 cohort_order uuid:=gen_random_uuid(); cohort_return uuid:=gen_random_uuid(); cohort_check uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.businesses(id,name,is_demo) VALUES
 (a,'POS0e synthetic A',false),(b,'POS0e synthetic B',false);
 PERFORM pg_temp.pos0e_assert(
  pg_get_functiondef('public.toast_records_for(uuid,date,date)'::regprocedure)
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
    "cardNumber":"4111111111111111","access_token":"synthetic-no-real-credential",
    "employee":{"guid":"employee-A","firstName":"Ava"},
    "customer":{"firstName":"Ava","email":"synthetic@example.invalid",
      "phone":"5550100","loyalty":{"guid":"loyalty-A"},
      "access_token":"synthetic-not-real","refreshToken":"synthetic-not-real",
      "API_KEY":"synthetic-not-real"},
    "payments":[{"amount":5,"payment_token":"synthetic-not-real",
      "last4":"0000","expiration_month":12,"NETWORK_ID":"synthetic-id"}],
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
  -- Exercise the ACTUAL typed roster writer and archive trigger, rather
  -- than inventing an Orders-style firstName object in toast_raw_records.
  PERFORM pg_temp.pos0e_assert(
   public.toast_stage_employee_roster(a,rest_a,jsonb_build_array(
    jsonb_build_object('employee_guid',employee_a,'display_name','Nadia Rao',
     'deleted',false)))=1,
   'trusted Toast roster writer accepted the employee');
  PERFORM pg_temp.pos0e_assert(
   (SELECT count(*)=1 FROM public.toast_employee_directory
    WHERE business_id=a AND restaurant_guid=rest_a
     AND employee_guid=employee_a AND display_name='Nadia Rao')
   AND (SELECT count(*)=1 FROM public.toast_records_for(a,d,d)
    WHERE record_type='employee' AND record_ref=employee_a::text
     AND data->>'display_name'='Nadia Rao' AND data->>'firstName' IS NULL),
   'actual roster writer archives accessible un-hashed display name by GUID');

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
   (SELECT count(*)=1 AND bool_and(jsonb_typeof(data->'name')='string')
    FROM public.toast_records_for(a,d,d) WHERE record_type='job' AND data->>'name'='Shift leader'),
   'retained staged job remains discoverable and readable after reset');
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
 -- Undated configuration is a timeless reference fact.
 PERFORM pg_temp.pos0e_assert(
  (SELECT count(*)=1 AND bool_and(dining_option_name='Patio' AND business_date IS NULL)
   FROM public.cv_dining_options WHERE business_id=a AND dining_option_ref='dine-A')
  AND NOT EXISTS (SELECT 1 FROM public.cv_dining_options WHERE business_id=b),
  'undated configuration remains café-scoped, without fabricated dates');
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
 PERFORM pg_temp.pos0e_assert(
  (SELECT count(source_ref)=1 FROM public.toast_records_for(a,d,d)
   WHERE record_type='cashmgmt/v1/entries')
  AND (SELECT sum(amount_cents)=1250 FROM public.cv_cash WHERE business_id=a AND business_date=d),
  'current cash counts and exact cents are available in SQL');
 PERFORM pg_temp.pos0e_assert(
  (SELECT count(*)=1 AND bool_and(data->>'display_name'='Nadia Rao')
   FROM public.toast_records_for(a,d,d) WHERE record_type='employee' AND record_ref=employee_a::text),
  'SQL returns current employee by GUID and permitted field');
 PERFORM pg_temp.pos0e_assert(
  (SELECT count(*)=1 AND bool_and(data#>>'{extra,nested,1,lateOptional}'='present-in-second-element'
    AND data#>'{extra,nested,0,lateOptional}' IS NULL)
   FROM public.toast_records_for(a,d,d) WHERE record_type='cashmgmt/v1/entries'),
  'SQL preserves the exact later array element');

 PERFORM pg_temp.pos0e_assert(
  public.ai_query_path('data.customer.email')=ARRAY['customer','email']::text[]
   and public.ai_query_path('data.cardNumber') is null
   and public.ai_query_path('data.employee.apiKey') is null
   and public.ai_query_path('data.cardInfo') is null
   and public.ai_query_path('data.customer.paymentMethod.value') is null,
  'SQL keeps permitted contact paths while denying credential paths');
 PERFORM pg_temp.pos0e_assert(
  public.ai_query_path('data.customer.access_token') is null
   and public.ai_query_path('data.customer.refresh_token') is null
   and public.ai_query_path('data.payments.0.payment_token') is null
   and public.ai_query_path('data.customer.API_KEY') is null
   and public.ai_query_path('data.customer.session_token') is null
   and public.ai_query_path('data.customer.authorization_token') is null
   and public.ai_query_path('data.customer.private_key') is null
   and public.ai_query_path('data.customer.oauth_token') is null
   and public.ai_query_path('data.customer.bearer_token') is null
   and public.ai_query_path('data.customer.card_info') is null
   and public.ai_query_path('data.payments.0.last4') is null
   and public.ai_query_path('data.payments.0.first_five') is null
   and public.ai_query_path('data.payments.0.exp_month') is null
   and public.ai_query_path('data.payments.0.card_expiration_year') is null
   and public.ai_query_path('data.payments.0.NETWORK_ID') is null
   and public.ai_query_path('data.customer.first_name') is not null
   and public.ai_query_path('data.customer.loyalty_guid') is not null,
  'old retained token keys denied in SQL, normal customer/loyalty keys retained');
 -- The entire retained JSON object must be sanitized, even when queried directly.
 PERFORM pg_temp.pos0e_assert(
  (SELECT count(*)=1 AND bool_and(
   data->>'guid'='cash-current-A'
   AND data#>>'{customer,email}'='synthetic@example.invalid'
   AND data#>>'{customer,phone}'='5550100'
   AND data#>>'{customer,loyalty,guid}'='loyalty-A'
   AND data#>>'{payments,0,amount}'='5'
   AND data#>>'{employee,guid}'='employee-A'
   AND NOT (data ? 'cardNumber') AND NOT (data ? 'access_token')
   AND NOT (data->'customer' ? 'access_token')
   AND NOT (data->'customer' ? 'refreshToken')
   AND NOT (data->'customer' ? 'API_KEY')
   AND NOT (data#>'{payments,0}' ? 'payment_token')
   AND NOT (data#>'{payments,0}' ? 'last4')
   AND NOT (data#>'{payments,0}' ? 'expiration_month')
   AND NOT (data#>'{payments,0}' ? 'NETWORK_ID'))
   FROM public.toast_records_for(a,d,d) WHERE record_type='cashmgmt/v1/entries'),
  'full-object SQL preserves permitted values but excludes all credential keys');

 FOR n IN 1..36 LOOP
  INSERT INTO public.toast_raw_records(business_id,restaurant_guid,entity,business_date,
   payload,payload_sha256,capture_key)
  VALUES (a,rest_a,'labor/v1/timeEntries',d,
   jsonb_build_object('guid','time-'||n,'regularHours',n,
    'lateOnly',CASE WHEN n=36 THEN 'visible' ELSE null END),
   repeat('f',64),'pos0e:time:'||n);
 END LOOP;
 PERFORM pg_temp.pos0e_assert(
  EXISTS(SELECT 1 FROM public.toast_records_for(a,d,d)
   WHERE record_type='labor/v1/timeEntries' AND data->>'lateOnly'='visible'),
  'SQL reads optional fields in later retained rows');

 PERFORM pg_temp.pos0e_assert(
  public.ai_customer_discount_participation('{"appliedDiscounts":[],"selections":[{"appliedDiscounts":[{"processingState":"VOID"}]}]}'::jsonb)=0
   and public.ai_customer_discount_participation('{"appliedDiscounts":[],"selections":[{"appliedDiscounts":[{"processingState":"APPLIED"}]}]}'::jsonb)=1
   and public.ai_customer_discount_participation('{"appliedDiscounts":[],"selections":[{}]}'::jsonb) is null,
  'discount participation distinguishes actual use, explicit nonuse and missing records');
 -- Source check rows: repeat ID, split checks/tenders, same-name distinct ID,
 -- unknown and conflicting names, foreign tenant, reserved-field spoof.
 INSERT INTO public.toast_raw_records(business_id,restaurant_guid,entity,business_date,payload,payload_sha256,capture_key)
 VALUES
 (a,rest_a,'order',d,'{"guid":"11111111-1111-4111-8111-111111111111","source":"Online","openedDate":"2026-10-26T15:30:00Z","closedDate":"2026-10-26T15:45:00Z","diningOption":{"guid":"61111111-1111-4111-8111-111111111111"},"checks":[
  {"guid":"21111111-1111-4111-8111-111111111111","amount":20,"tabName":"Alax",
   "customer":{"guid":"31111111-1111-4111-8111-111111111111","firstName":"Alex","lastName":"Smith"},
   "payments":[{"guid":"41111111-1111-4111-8111-111111111111","type":"CREDIT","paymentStatus":"CAPTURED",
    "cardInfo":{"holderName":"Alexander Smith","cardNumber":"4111111111111111","cvv":"123"},"refund":{"refundAmount":2}},
    {"guid":"41111111-1111-4111-8111-111111111112","type":"CASH","amount":5}],
   "selections":[{"guid":"51111111-1111-4111-8111-111111111111","displayName":"Latte","item":{"guid":"71111111-1111-4111-8111-111111111111"},"quantity":2,"price":18},
    {"guid":"51111111-1111-4111-8111-111111111112","deferred":true,"price":3}],
   "appliedServiceCharges":[{"serviceChargeCategory":"FUNDRAISING_CAMPAIGN","chargeAmount":1}]},
  {"guid":"21111111-1111-4111-8111-111111111112","amount":5,"tabName":"Alex",
   "customer":{"guid":"31111111-1111-4111-8111-111111111111"},
   "payments":[{"guid":"41111111-1111-4111-8111-111111111113","type":"CASH","amount":5}]}]}',
 repeat('a',64),'live:pos0ef-order-1'),
 (a,rest_a,'order',d,'{"guid":"11111111-1111-4111-8111-111111111112","checks":[
  {"guid":"21111111-1111-4111-8111-111111111113","amount":10,"tabName":"Alex",
   "customer":{"guid":"31111111-1111-4111-8111-111111111111"},
   "payments":[{"type":"CREDIT","cardholderName":"Alexander Smith"}]},
  {"guid":"21111111-1111-4111-8111-111111111114","amount":4,"tabName":"Alex",
   "customer":{"guid":"31111111-1111-4111-8111-111111111112"},
   "payments":[{"type":"CREDIT","cardholderName":"Alexander Smith"}]},
  {"guid":"21111111-1111-4111-8111-111111111115","amount":6,"tabName":"Alex",
   "payments":[{"type":"CREDIT","cardholderName":"4111111111111111"},
    {"type":"CREDIT","cardholderName":"First Payer"},{"type":"CREDIT","cardholderName":"Second Payer"}],
   "aiCafeCustomer":{"identityRef":"forged"}}]}',
 repeat('b',64),'live:pos0ef-order-2'),
 (b,rest_b,'order',d,'{"guid":"11111111-1111-4111-8111-111111111113","checks":[
  {"guid":"21111111-1111-4111-8111-111111111116","amount":7,
   "customer":{"guid":"31111111-1111-4111-8111-111111111111"},
   "payments":[{"type":"CASH"}]}]}',repeat('c',64),'live:pos0ef-order-b');
 PERFORM pg_temp.pos0e_assert(
  (SELECT count(*)=5 AND count(data#>>'{aiCafeCustomer,identityRef}')=4
   AND count(distinct data#>>'{aiCafeCustomer,identityRef}')=2
   AND count(distinct data#>>'{aiCafeCustomer,visitRef}')=3
   AND sum((data#>>'{aiCafeCustomer,netSalesCents}')::bigint)=3900
   FROM public.toast_records_for(a,d,d) WHERE record_type='check' AND counts_in_sales),
  'customer checks/observed references/visits/net reconcile without split-tender or split-check duplication');
 PERFORM pg_temp.pos0e_assert(
  (SELECT data#>>'{aiCafeCustomer,displayName}'='Alexander Smith'
     AND data#>>'{aiCafeCustomer,displayNameSource}'='cardholder'
     AND data#>>'{aiCafeCustomer,netSalesCents}'='1400'
   FROM public.toast_records_for(a,d,d) WHERE record_type='check'
    AND record_ref='21111111-1111-4111-8111-111111111111'),
  'nested permitted payer label beats tab; cents subtract refund/fundraiser/deferred once');
 PERFORM pg_temp.pos0e_assert(
  (select data#>>'{aiCafeCustomer,recordedRefundCents}'='200' and data#>'{aiCafeCustomer,discountParticipation}'='null'::jsonb
   from public.toast_records_for(a,d,d) where record_type='check' and record_ref='21111111-1111-4111-8111-111111111111'),
  'refund shares canonical check arithmetic and missing discount arrays remain unknown');
 PERFORM pg_temp.pos0e_assert(
  (select count(order_duration_seconds)=1 and sum(order_duration_seconds)=900 from public.customer_visits_for(a,d,d)),
  'order duration is not multiplied by split checks');
 PERFORM pg_temp.pos0e_assert(
  (SELECT data#>>'{aiCafeCustomer,identityRef}' IS NULL
   AND data#>>'{aiCafeCustomer,displayName}'='Alex'
   AND data#>>'{aiCafeCustomer,payerNameConflict}'='true'
   AND data#>>'{aiCafeCustomer,displayNameSource}'='tab_label'
   FROM public.toast_records_for(a,d,d) WHERE record_type='check'
     AND record_ref='21111111-1111-4111-8111-111111111115'),
  'conflicting payers and forged projection do not become customer identity');
 PERFORM pg_temp.pos0e_assert(
  (SELECT count(*)=1 AND bool_and(data#>>'{aiCafeCustomer,identityRef}' IS NOT NULL)
   AND bool_and(data#>'{aiCafeCustomer,netSalesCents}' IS NULL)
   AND bool_and(data#>'{aiCafeCustomer,displayName}' IS NULL)
   FROM public.toast_records_for(a,d,d) WHERE record_type='item' AND counts_in_sales),
  'product row shares identity, not check money or name');
 PERFORM pg_temp.pos0e_assert(
  (select count(*)=1 and bool_and(data#>>'{aiCafeCustomer,orderChannel}'='online')
   and bool_and(data#>>'{aiCafeCustomer,diningOptionRef}'='61111111-1111-4111-8111-111111111111')
   and bool_and((data#>>'{aiCafeCustomer,localHour}')::int=
    extract(hour from '2026-10-26T15:30:00Z'::timestamptz at time zone (select timezone from public.businesses where id=a))::int)
   and bool_and(data#>>'{aiCafeCustomer,businessWeekday}'='1')
   from public.toast_records_for(a,d,d) where record_type='item' and counts_in_sales),
  'item source supports stable product, recorded ordering mode, café-local hour and weekday');
 PERFORM pg_temp.pos0e_assert(
  (SELECT count(DISTINCT data#>>'{aiCafeCustomer,visitRef}')=1
    AND sum((data->>'quantity')::numeric)=2
    AND bool_and(data#>>'{item,guid}'='71111111-1111-4111-8111-111111111111')
    AND bool_and(data#>>'{aiCafeCustomer,orderChannel}'='online')
   FROM public.toast_records_for(a,d,d) WHERE record_type='item'
    AND counts_in_sales AND data#>>'{aiCafeCustomer,identityRef}' IS NOT NULL),
  'product, channel and linked-visit aggregation use SQL');
 PERFORM pg_temp.pos0e_assert(
  not exists(select 1 from public.toast_records_for(a,d,d) r
    where r.record_type in ('check','payment') and r.data::text like '%4111111111111111%')
  and public.ai_query_path('data.cardInfo.holderName') is null,
  'payment parent stays blocked and credential-shaped name values are suppressed');
 PERFORM pg_temp.pos0e_assert(
  (SELECT data#>>'{aiCafeCustomer,identityRef}' FROM public.toast_records_for(b,d,d)
   WHERE record_type='check') is distinct from
  (SELECT data#>>'{aiCafeCustomer,identityRef}' FROM public.toast_records_for(a,d,d)
   WHERE record_type='check' AND record_ref='21111111-1111-4111-8111-111111111111'),
  'same GUID never links across cafes');
 PERFORM pg_temp.pos0e_assert(
  (SELECT count(source_ref)=5 AND count(data#>>'{aiCafeCustomer,identityRef}')=4
   AND count(DISTINCT data#>>'{aiCafeCustomer,visitRef}')=3
   AND sum((data#>>'{aiCafeCustomer,netSalesCents}')::numeric)=3900
   FROM public.toast_records_for(a,d,d) WHERE record_type='check' AND counts_in_sales),
  'SQL aggregates derived customer evidence');
 PERFORM pg_temp.pos0e_assert(
  EXISTS(SELECT 1 FROM public.toast_records_for(a,d,d)
   WHERE record_type='check' AND jsonb_typeof(data#>'{aiCafeCustomer,identityRef}')='string')
  AND not has_function_privilege('authenticated','public.ai_customer_check_evidence(uuid,uuid,text,jsonb,boolean)','EXECUTE'),
  'identity is accessible through safe records, internal helper is not exposed');

 -- Visit projection deduplicates checks within one observed account/order.
 PERFORM pg_temp.pos0e_assert(
  (select count(*)=3 and count(distinct identity_ref)=2
   and sum(net_sales_cents)=3300 and sum(first_observed_visit)=2
   and sum(returning_visit)=1 and count(observed_return_7d)=0
   from public.customer_visits_for(a,d,d)),
  'linked visit timeline deduplicates split checks, excludes unknowns, labels provisional cohorts immature');
 PERFORM pg_temp.pos0e_assert(
  (select count(*)=1 and sum(net_sales_cents)=700 from public.customer_visits_for(b,d,d)),
  'visit source remains cafe-scoped');
 response:=public.customer_query_coverage(a,d,d);
 PERFORM pg_temp.pos0e_assert(
  response->>'eligibleChecks'='5' AND response->>'linkedChecks'='4'
   AND response->>'recordedNetCents'='3900' AND response->>'linkedRecordedNetCents'='3300'
   AND response->>'complete'='false',
  'full selected-period denominator and provisional warning remain available');
 PERFORM pg_temp.pos0e_assert(
  not has_table_privilege('anon','public.cv_customer_visits','SELECT')
  and not has_function_privilege('anon','public.customer_visits_for(uuid,date,date)','EXECUTE'),
  'anonymous callers cannot read derived visits');

 -- The same canonical timeline yields account-level spend and linked concentration
 -- exactly once per scoped account, despite repeated visits.
 PERFORM pg_temp.pos0e_assert(
  (select count(period_account_visits)=2 and sum(period_account_visits)=3
   and count(period_account_net_sales_cents)=2 and sum(period_account_net_sales_cents)=3300
   and max(period_account_net_sales_cents)=2900
   and abs(sum(period_account_revenue_share)-1)<0.00000001
   and abs(sum(period_account_revenue_share_squared)-(29::numeric/33)^2-(4::numeric/33)^2)<0.00000001
   and count(observed_lapse_gap_ratio)=0
   from public.customer_visits_for(a,d,d)),
  'account spend and concentration are once per selected account, never per visit');

 -- Imported, elapsed 7-day cohort using actual current-run membership.
 INSERT INTO public.toast_sync_runs(id,business_id,restaurant_guid,kind,state)
 VALUES(cohort_run,a,rest_a,'backfill','running');
 INSERT INTO public.toast_day_status(business_id,restaurant_guid,business_date,import_state,
  recon_state,coverage_complete,unparsed_count,last_import_run_id)
 SELECT a,rest_a,d-45+g.offset_day,'imported','checked_internal',true,0,cohort_run FROM generate_series(0,7) AS g(offset_day);
 INSERT INTO public.toast_raw_records(business_id,restaurant_guid,entity,business_date,payload,payload_sha256,capture_key,run_id)
 VALUES
 (a,rest_a,'order',d-45,jsonb_build_object('guid',cohort_order,'checks',jsonb_build_array(
  jsonb_build_object('guid',cohort_check,'amount',12,'customer',jsonb_build_object('guid',cohort_guest,'visitPreference',jsonb_build_object('favoriteDrink','fixture-latte'))),
  jsonb_build_object('guid',gen_random_uuid(),'amount',8,'customer',jsonb_build_object('guid',cohort_other)))),
  repeat('d',64),'pos0ef:cohort-first',cohort_run),
 (a,rest_a,'order',d-42,jsonb_build_object('guid',cohort_return,'checks',jsonb_build_array(
  jsonb_build_object('guid',gen_random_uuid(),'amount',10,'customer',jsonb_build_object('guid',cohort_guest)))),
  repeat('e',64),'pos0ef:cohort-return',cohort_run);
 PERFORM pg_temp.pos0e_assert(
  (select count(*)=2 and sum(observed_return_7d)=1 and count(observed_return_7d)=2
   and count(observed_return_30d)=0 and sum(net_sales_cents)=2000
   from public.customer_visits_for(a,d-45,d-38) where business_date=d-45),
  'elapsed complete cohort: one of two observed references returns; longer horizon unknown');
 PERFORM pg_temp.pos0e_assert(
  (select count(*)=2 and count(next_observed_date)=0 and count(observed_return_7d)=0
   from public.customer_visits_for(a,d-45,d-44)),
  'historical as-of query excludes future visit evidence');
 UPDATE public.toast_day_status SET coverage_complete=false WHERE business_id=a AND restaurant_guid=rest_a AND business_date=d-41;
 PERFORM pg_temp.pos0e_assert(
  (select count(observed_return_7d)=0 from public.customer_visits_for(a,d-45,d-38)),
  'one incomplete location/day suppresses mature cohort result');
 UPDATE public.toast_day_status SET coverage_complete=true WHERE business_id=a AND restaurant_guid=rest_a AND business_date=d-41;
 UPDATE public.toast_raw_records SET payload=jsonb_set(payload,'{checks,0,customer,guid}',to_jsonb(cohort_other)),
  payload_sha256=repeat('f',64) WHERE business_id=a AND capture_key='pos0ef:cohort-return';
 PERFORM pg_temp.pos0e_assert(
  (select count(*)=3 and count(distinct identity_ref)=2 and sum(net_sales_cents)=3000
   and sum(returning_visit)=1 from public.customer_visits_for(a,d-45,d-38)),
  'corrected current record recomputes existing visits without duplicate spend');
 PERFORM pg_temp.pos0e_assert(
  (select count(*)=1 from public.customer_visits_for(a,d-45,d-38)
   where business_date=d-45 and net_sales_cents=800 and observed_return_7d=1),
  'corrected account assignment changes the actual returning cohort member');
 -- Distinct-date observed gaps 1,1,4: reappearance ratio 4;
 -- separate account gaps 1,1: as-of gap 5. No unique-human or churn claim.
 INSERT INTO public.toast_raw_records(business_id,restaurant_guid,entity,business_date,payload,payload_sha256,capture_key,run_id)
 SELECT a,rest_a,'order',d-45+g.offset_day,
  jsonb_build_object('guid',gen_random_uuid(),'checks',jsonb_build_array(
   jsonb_build_object('guid',gen_random_uuid(),'amount',2,'customer',jsonb_build_object('guid',g.guest)))),
   repeat('a',64),'pos0ef:cadence:'||g.guest||':'||g.offset_day,cohort_run
 FROM (select cadence_guest guest,unnest(array[0,1,2,6]) offset_day
  union all select lapse_guest,unnest(array[0,1,2])) g;
 PERFORM pg_temp.pos0e_assert(
  (select count(*)=1 and max(observed_prior_cadence_days)=1 and max(observed_reactivation_gap_ratio)=4
   from public.customer_visits_for(a,d-45,d-38) where observed_reactivation_gap_ratio is not null),
  'reactivation gap compares current gap to prior observed cadence without future evidence');
 PERFORM pg_temp.pos0e_assert(
  (select count(*)=2 and max(observed_lapse_gap_ratio)=5 and min(observed_lapse_gap_ratio)=0.5
   from public.customer_visits_for(a,d-45,d-38) where observed_lapse_gap_ratio is not null),
  'cadence-based recency ratio appears once per sufficiently observed account');
 PERFORM pg_temp.pos0e_assert(
  (select count(observed_lapse_flag)=2 and sum(observed_lapse_flag)=1
   and count(observed_reappearance_flag)=1 and sum(observed_reappearance_flag)=1
   from public.customer_visits_for(a,d-45,d-38)),
  'long gap flags classify only eligible account snapshots and returning visits');
 UPDATE public.toast_day_status SET coverage_complete=false WHERE business_id=a AND restaurant_guid=rest_a AND business_date=d-41;
 PERFORM pg_temp.pos0e_assert(
  (select count(observed_lapse_gap_ratio)=0 and count(observed_reactivation_gap_ratio)=0
   and count(observed_lapse_flag)=0 and count(observed_reappearance_flag)=0
   from public.customer_visits_for(a,d-45,d-38)),
  'missing source day suppresses lapse and reappearance signals');

 -- Independent item/modifier/basket fixture with two purchases of the
 -- same reference across separate dates, unresolved check, and split basket.
 INSERT INTO public.toast_raw_records(business_id,restaurant_guid,entity,business_date,payload,payload_sha256,capture_key,run_id)
 VALUES(a,rest_a,'order',d-43,
 '{"guid":"fb111111-1111-4111-8111-111111111111","checks":[
  {"guid":"fb211111-1111-4111-8111-111111111111","amount":12,
   "customer":{"guid":"fb311111-1111-4111-8111-111111111111"},"selections":[
   {"guid":"fb411111-1111-4111-8111-111111111111","item":{"guid":"fb511111-1111-4111-8111-111111111111"},"quantity":2,
    "modifiers":[{"guid":"fb611111-1111-4111-8111-111111111111","item":{"guid":"fb711111-1111-4111-8111-111111111111"},"optionGroup":{"guid":"fb811111-1111-4111-8111-111111111111"},"quantity":1}]}]},
  {"guid":"fb211111-1111-4111-8111-111111111112","amount":3,
   "customer":{"guid":"fb311111-1111-4111-8111-111111111111"},"selections":[
   {"guid":"fb411111-1111-4111-8111-111111111112","item":{"guid":"fb511111-1111-4111-8111-111111111112"},"quantity":1}]}]}',
 repeat('b',64),'pos0ef:product:first',cohort_run),
 (a,rest_a,'order',d-42,
 '{"guid":"fb111111-1111-4111-8111-111111111112","checks":[
 {"guid":"fb211111-1111-4111-8111-111111111113","amount":6,"customer":{"guid":"fb311111-1111-4111-8111-111111111111"},
 "selections":[{"guid":"fb411111-1111-4111-8111-111111111113","item":{"guid":"fb511111-1111-4111-8111-111111111111"},"quantity":1}]}]}',
 repeat('c',64),'pos0ef:product:return',cohort_run),
 (a,rest_a,'order',d-42,
 '{"guid":"fb111111-1111-4111-8111-111111111113","checks":[
 {"guid":"fb211111-1111-4111-8111-111111111114","amount":6,
 "selections":[{"guid":"fb411111-1111-4111-8111-111111111114","item":{"guid":"fb511111-1111-4111-8111-111111111111"},"quantity":1}]}]}',
 repeat('d',64),'pos0ef:product:unknown',cohort_run);
 PERFORM pg_temp.pos0e_assert(
  (select count(*)=1 and sum(pair_occurrence)=1 and count(quantity)=0
   from public.customer_products_for(a,d-43,d-42) where fact_kind='basket_pair'
    and product_ref='fb511111-1111-4111-8111-111111111111'
    and paired_product_ref='fb511111-1111-4111-8111-111111111112'),
 'split-check basket pair counts once per linked visit');
 PERFORM pg_temp.pos0e_assert(
  (select count(*)=1 and sum(quantity)=1 and bool_and(product_ref='fb511111-1111-4111-8111-111111111111')
   from public.customer_products_for(a,d-43,d-42) where fact_kind='modifier'
    and modifier_ref='fb711111-1111-4111-8111-111111111111'),
 'modifier quantity uses recorded selection and stable parent product');
 PERFORM pg_temp.pos0e_assert(
  (SELECT jsonb_object_agg(visit_class,units) FROM (
   SELECT visit_class,sum(quantity) units FROM public.customer_products_for(a,d-43,d-42)
   WHERE fact_kind='item' AND product_ref='fb511111-1111-4111-8111-111111111111'
   GROUP BY visit_class) q) @> '{"observed_first":2,"observed_returning":1,"unresolved":1}'::jsonb,
  'SQL returning-product mix separates first and unresolved units');
 PERFORM pg_temp.pos0e_assert(
  (SELECT count(source_ref)=1 FROM public.toast_records_for(a,d-45,d-38)
   WHERE record_type='check' AND counts_in_sales
    AND data#>>'{customer,visitPreference,favoriteDrink}'='fixture-latte')
  AND NOT EXISTS(SELECT 1 FROM public.toast_records_for(b,null,null)
   WHERE record_type='check' AND data#>'{customer,visitPreference,favoriteDrink}' IS NOT NULL)
  AND (public.customer_query_coverage(a,d-45,d-38)->>'eligibleChecks')::int>1,
  'rare historical fields and full coverage remain separately SQL-queryable and tenant-specific');
 -- Every public customer view column is retained.
 DECLARE view_name text; cols text[];
 BEGIN
  FOREACH view_name IN ARRAY ARRAY['cv_customer_visits','cv_customer_products'] LOOP
   SELECT array_agg(column_name::text ORDER BY ordinal_position) INTO cols
   FROM information_schema.columns WHERE table_schema='public' AND table_name=view_name;
   PERFORM pg_temp.pos0e_assert(coalesce(cardinality(cols),0)>20,'customer canonical columns exist: '||view_name);
  END LOOP;
 END;

 -- Real browser-equivalent authenticated role, not a postgres/service-only
 -- approximation. Protected mapping and credential tables stay inaccessible.
 DECLARE owner_a uuid:=gen_random_uuid(); own_n bigint; foreign_n bigint; own_cov jsonb; foreign_cov jsonb; own_raw_n bigint; foreign_raw_n bigint;
 BEGIN
  insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
   values(owner_a,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',owner_a||'@example.invalid','',now(),now());
  insert into public.memberships(business_id,user_id,role) values(a,owner_a,'owner');
  perform set_config('request.jwt.claim.sub',owner_a::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',owner_a,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  select count(*) into own_n from public.customer_visits_for(a,d,d);
  select count(*) into foreign_n from public.customer_visits_for(b,d,d);
  select count(*) into own_raw_n from public.toast_records_for(a,d,d) where record_type='check';
  select count(*) into foreign_raw_n from public.toast_records_for(b,d,d) where record_type='check';
  own_cov:=public.customer_query_coverage(a,d,d);
  foreign_cov:=public.customer_query_coverage(b,d,d);
  execute 'reset role';
  perform pg_temp.pos0e_assert(own_n=3 and own_raw_n>0 AND own_cov->>'eligibleChecks'='5',
   'authenticated owner can read scoped visit counts, raw records and coverage');
  perform pg_temp.pos0e_assert(foreign_n=0 and foreign_raw_n=0 and foreign_cov is null,
   'foreign owner scope cannot read visit, raw or coverage facts');
  perform pg_temp.pos0e_assert(not has_table_privilege('authenticated','public.toast_location_mappings','SELECT')
   and not has_table_privilege('authenticated','public.toast_api_credentials','SELECT')
   and not has_function_privilege('anon','public.customer_query_coverage(uuid,date,date)','EXECUTE'),
   'narrow coverage helper does not widen protected table or anonymous access');
 END;
END $pos0e$;
ROLLBACK;
