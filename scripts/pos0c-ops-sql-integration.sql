-- POS0c: disposable migrated Supabase SQL proof; never point to production.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(ok boolean,msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'POS0c FAILURE: %',msg;END IF;END $$;

DO $pos0c$
DECLARE
 b uuid:='f0c00000-0000-4000-8000-000000000001';
 b2 uuid:='f0c00000-0000-4000-8000-000000000002';
 r uuid:='f0c00000-0000-4000-8000-000000000011';
 r2 uuid:='f0c00000-0000-4000-8000-000000000022';
 l uuid:='f0c00000-0000-4000-8000-000000000111';
 l2 uuid:='f0c00000-0000-4000-8000-000000000222';
 e uuid:='f0c00000-0000-4000-8000-000000000301';
 stock uuid:='f0c00000-0000-4000-8000-000000000302';
 ord uuid:='f0c00000-0000-4000-8000-000000000401';
 item uuid:='f0c00000-0000-4000-8000-000000000402';
 synthetic uuid:='f0c00000-0000-4000-8000-000000000403';
 cash jsonb;inv jsonb;kitchen jsonb;availability jsonb;schedule jsonb;
 n integer;bad boolean:=false;
BEGIN
 PERFORM pg_temp.assert_true(
  not exists(select 1 from public.toast_json_diff(
   public.toast_stage_comparable('{"id":21,"amount":5}'::jsonb),
   public.toast_stage_comparable('{"id":22,"amount":5}'::jsonb))),
  'POS0c cannot regress migration 144: internal refund row id changes are not Toast deltas');
 INSERT INTO public.businesses(id,name,is_demo) VALUES
 (b,'POS0c disposable café',false),(b2,'POS0c second tenant',false);
 INSERT INTO public.locations(id,business_id,name)
 VALUES(l,b,'One'),(l2,b2,'Other');
 -- Every verified mapping requires its café-scoped Toast credential parent.
 -- These inert disposable values never make a provider request.
 INSERT INTO public.toast_api_credentials
  (business_id,api_origin,client_id,client_secret_enc) VALUES
  (b,'https://synthetic.example','pos0c-fixture-a','not-a-secret'),
  (b2,'https://synthetic.example','pos0c-fixture-b','not-a-secret');
 INSERT INTO public.toast_location_mappings(business_id,location_id,restaurant_guid,
  verified_at,toast_time_zone,closeout_hour,toast_start_date)
 VALUES(b,l,r,now(),'UTC',4,'2026-11-01'),
  (b2,l2,r2,now(),'UTC',4,'2026-11-01');
 cash:=jsonb_build_object('business_id',b,'restaurant_guid',r,'endpoint','cashmgmt/v1/entries',
  'provider_key',e,'source_key_kind','provider_guid','guid',e,'amount',12.50,'date','2026-11-08T15:00:00Z',
  'business_date','2026-11-08','type','CASH_IN','fetched_at','2026-11-08T16:00:00Z',
  'lastSuccessAt','2026-11-08T16:00:00Z');
 PERFORM pg_temp.assert_true(public.toast_stage_operational_batch(b,r,'cashmgmt/v1/entries',
  '2026-11-08',jsonb_build_array(cash))=1,'first operation saved');
 PERFORM pg_temp.assert_true(public.toast_stage_operational_batch(b,r,'cashmgmt/v1/entries',
  '2026-11-08',jsonb_build_array(cash||'{"fetched_at":"2026-11-08T16:15:00Z",
   "lastSuccessAt":"2026-11-08T16:15:00Z"}'::jsonb))=1,'re-fetch saved');
 SELECT count(*) INTO n FROM public.toast_raw_records
 WHERE business_id=b and restaurant_guid=r and entity='cashmgmt/v1/entries';
 PERFORM pg_temp.assert_true(n=1,'same cash GUID must never double count');
 PERFORM pg_temp.assert_true(not exists(SELECT 1 FROM public.toast_raw_changes
  WHERE business_id=b),'new fetch time is not a business delta');
 PERFORM public.toast_stage_operational_batch(b,r,'cashmgmt/v1/entries',
  '2026-11-08',jsonb_build_array(cash||'{"amount":15.25}'::jsonb));
 PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM public.toast_raw_records
  WHERE business_id=b and entity='cashmgmt/v1/entries'),'cash updates in place');
 PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM public.toast_raw_changes
  WHERE business_id=b and entity_guid=e),'exactly one native cash amount delta');
 PERFORM pg_temp.assert_true((SELECT changes->0->>'path'='.amount'
  AND changes->0->'before'='12.50'::jsonb AND changes->0->'after'='15.25'::jsonb
  FROM public.toast_raw_changes WHERE business_id=b and entity_guid=e),
  'exact cents field diff with source amount (dollars)');
 PERFORM pg_temp.assert_true((SELECT amount_cents=1525 FROM public.cv_cash
  WHERE business_id=b and entry_type='CASH_IN' LIMIT 1),
  'same cash amount through the existing POS0e canonical screen/tool view');

 inv:=jsonb_build_object('business_id',b,'restaurant_guid',r,'endpoint','stock/v1/inventory',
  'provider_key',stock,'source_key_kind','provider_guid','guid',stock,'status','QUANTITY','quantity',3.5,
  'business_date','2026-11-08','source_business_date_kind','observed_cafe_day',
  'lastSuccessAt','2026-11-08T16:00:00Z');
 PERFORM public.toast_stage_operational_batch(b,r,'stock/v1/inventory',
  '2026-11-08',
  jsonb_build_array(inv));
 PERFORM public.toast_stage_operational_batch(b,r,'stock/v1/inventory',null,
  jsonb_build_array(inv||'{"quantity":2.5}'::jsonb));
 PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM public.toast_raw_records
  WHERE business_id=b AND entity='stock/v1/inventory'),'one stock item current');
 PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM public.toast_raw_changes
  WHERE business_id=b AND entity_guid=stock),'stock delta saved, no duplicate');
 PERFORM public.toast_stage_operational_batch(b,r,'stock/v1/inventory',
  '2026-11-09',jsonb_build_array(inv||'{"quantity":2.5,
   "business_date":"2026-11-09","lastSuccessAt":"2026-11-09T16:00:00Z"}'::jsonb));
 PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM public.toast_raw_changes
  WHERE business_id=b AND entity_guid=stock),
  're-observing unchanged stock next café day must not log phantom source delta');
 PERFORM pg_temp.assert_true((SELECT business_date='2026-11-09'
  FROM public.toast_raw_records WHERE business_id=b AND entity_guid=stock LIMIT 1),
  'latest observed café stock day is queryable');
 PERFORM pg_temp.assert_true((SELECT quantity=2.5 FROM public.cv_inventory
  WHERE business_id=b AND source='toast' AND menu_item_ref=stock::text LIMIT 1),
  'inventory query reads current quantity, not missing=zero');
 kitchen:=jsonb_build_object('business_id',b,'restaurant_guid',r,
  'endpoint','kitchen/v1/export/itemFulfillments',
  'provider_key','2026-11-08|'||ord||'|'||item||'|0|none',
  'operational_object_uuid',synthetic,'source_key_kind','provider_composite',
  'orderGuid',ord,'selectionGuid',item,'restaurantGuid',r,
  'itemFulfillmentLevel',0,'ticketFiredAt','2026-11-08T17:00:00Z',
  'business_date','2026-11-08');
 PERFORM public.toast_stage_operational_batch(b,r,'kitchen/v1/export/itemFulfillments',
  '2026-11-08',jsonb_build_array(kitchen));
 PERFORM public.toast_stage_operational_batch(b,r,'kitchen/v1/export/itemFulfillments',
  '2026-11-08',jsonb_build_array(kitchen||'{"itemFulfilledAt":"2026-11-08T17:05:00Z"}'::jsonb));
 PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM public.toast_raw_changes
  WHERE business_id=b AND entity_guid=synthetic),'KDS composite change journal');
 PERFORM pg_temp.assert_true((SELECT ready_at='2026-11-08T17:05:00Z' FROM public.cv_kitchen
  WHERE business_id=b AND ticket_ref is null LIMIT 1),'KDS completion through canonical view');
 availability:=jsonb_build_object('business_id',b,'restaurant_guid',r,
  'endpoint','restaurant-availability/v1/availability',
  'provider_key','restaurant-singleton','operational_object_uuid',synthetic,
  'source_key_kind','restaurant_singleton','status','ONLINE','restaurantGuid',r);
 PERFORM public.toast_stage_operational_batch(b,r,'restaurant-availability/v1/availability',
  null,jsonb_build_array(availability));
 PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM public.toast_raw_records
  WHERE business_id=b AND entity='restaurant-availability/v1/availability'),
  'single current availability; never a new snapshot per check');
 PERFORM public.toast_stage_operational_batch(b,r,'stock/v1/inventory',
  '2026-11-08','[]');
 PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM public.toast_raw_records
  WHERE business_id=b AND entity='stock/v1/inventory'),'empty result does not infer stock zero');
 PERFORM pg_temp.assert_true((SELECT jsonb_array_length(public.ai_toast_fields(
  b,'stock/v1/inventory'))>0),'current-only field discovery sees stock');
 PERFORM pg_temp.assert_true((public.ai_query_view(b,'cv_inventory',
  ARRAY['source','menu_item_ref','quantity']::text[],'[]'::jsonb,
  '{}'::text[],'[]'::jsonb,'2026-11-09','2026-11-09',
  NULL,30)->>'sourceCount')::integer >= 1,
  'existing query_data SQL path sees current dated inventory');

 BEGIN
  PERFORM public.toast_stage_operational_batch(b,r,'stock/v1/inventory',null,
   jsonb_build_array(inv||jsonb_build_object('restaurant_guid',r2)));
 EXCEPTION WHEN sqlstate '22023' THEN bad:=true;END;
 PERFORM pg_temp.assert_true(bad,'cross-restaurant row rejected before any durable write');
 PERFORM pg_temp.assert_true(not exists(SELECT 1 FROM public.toast_raw_records
  WHERE business_id=b2),'no cross-café operational leakage');
 PERFORM pg_temp.assert_true(not has_function_privilege('anon',
  'public.toast_stage_operational_batch(uuid,uuid,text,date,jsonb)','EXECUTE'),
  'untrusted clients cannot call the operational writer');

 -- P1: missing optional operational fields never replace a complete last-good
 -- object, and must not advance its source-as-of. An explicit null is different.
 kitchen:=kitchen||'{"itemFulfilledAt":"2026-11-08T17:05:00Z",
  "itemStartedAt":"2026-11-08T17:01:00Z",
  "lastSuccessAt":"2026-11-08T17:06:00Z"}'::jsonb;
 PERFORM public.toast_stage_operational_batch(b,r,
  'kitchen/v1/export/itemFulfillments','2026-11-08',jsonb_build_array(kitchen));
 bad:=false;
 BEGIN
  PERFORM public.toast_stage_operational_batch(b,r,
   'kitchen/v1/export/itemFulfillments','2026-11-08',
   jsonb_build_array((kitchen-'itemStartedAt')||
    '{"lastSuccessAt":"2026-11-08T17:10:00Z"}'::jsonb));
 EXCEPTION WHEN sqlstate '22023' THEN bad:=true; END;
 PERFORM pg_temp.assert_true(bad,'omitted KDS timestamp rejected as incomplete');
 PERFORM pg_temp.assert_true((SELECT payload->>'itemStartedAt'='2026-11-08T17:01:00Z'
  AND payload->>'lastSuccessAt'='2026-11-08T17:06:00Z'
  FROM public.toast_raw_records WHERE business_id=b
   AND entity='kitchen/v1/export/itemFulfillments' LIMIT 1),
  'partial KDS response preserves original timing and source freshness');
 PERFORM public.toast_stage_operational_batch(b,r,
  'kitchen/v1/export/itemFulfillments','2026-11-08',
  jsonb_build_array(kitchen||'{"itemStartedAt":null}'::jsonb));
 PERFORM pg_temp.assert_true((SELECT payload ? 'itemStartedAt'
  AND payload->'itemStartedAt'='null'::jsonb
  FROM public.toast_raw_records WHERE business_id=b
   AND entity='kitchen/v1/export/itemFulfillments' LIMIT 1),
  'explicit source null may clear an old KDS field; absence cannot');

 schedule:=jsonb_build_object('business_id',b,'restaurant_guid',r,
  'endpoint','ordermgmt-config/v1/published/orderingSchedule',
  'provider_key','restaurant-singleton','operational_object_uuid',synthetic,
  'source_key_kind','restaurant_singleton','acceptScheduledOrders',true,
  'servicePeriods',jsonb_build_array(jsonb_build_object('name','morning')),
  'sourceWindow',jsonb_build_object('start','09:00','end','17:00'),
  'lastSuccessAt','2026-11-08T16:00:00Z');
 PERFORM public.toast_stage_operational_batch(b,r,
  'ordermgmt-config/v1/published/orderingSchedule',null,jsonb_build_array(schedule));
 bad:=false;
 BEGIN
  PERFORM public.toast_stage_operational_batch(b,r,
   'ordermgmt-config/v1/published/orderingSchedule',null,
   jsonb_build_array((schedule-'servicePeriods')||
    '{"lastSuccessAt":"2026-11-08T16:20:00Z"}'::jsonb));
 EXCEPTION WHEN sqlstate '22023' THEN bad:=true; END;
 PERFORM pg_temp.assert_true(bad,'omitted ordering service periods rejected');
 bad:=false;
 BEGIN
  PERFORM public.toast_stage_operational_batch(b,r,
   'ordermgmt-config/v1/published/orderingSchedule',null,
   jsonb_build_array(schedule||'{"sourceWindow":{"start":"09:00"},
     "lastSuccessAt":"2026-11-08T16:30:00Z"}'::jsonb));
 EXCEPTION WHEN sqlstate '22023' THEN bad:=true; END;
 PERFORM pg_temp.assert_true(bad,'omitted nested schedule field rejected');
 PERFORM pg_temp.assert_true((SELECT payload->'servicePeriods' IS NOT NULL
  AND payload->'sourceWindow'->>'end'='17:00'
  AND payload->>'lastSuccessAt'='2026-11-08T16:00:00Z'
  FROM public.toast_raw_records WHERE business_id=b
   AND entity='ordermgmt-config/v1/published/orderingSchedule' LIMIT 1),
  'rejected schedule responses leave prior source fields and as-of intact');
 PERFORM pg_temp.assert_true(not exists(
  SELECT 1 FROM public.toast_raw_changes
  WHERE business_id=b AND entity='ordermgmt-config/v1/published/orderingSchedule'),
  'incomplete schedule rejection never creates false source deltas');
END $pos0c$;
ROLLBACK;
