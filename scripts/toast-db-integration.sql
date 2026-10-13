-- Run ONLY against disposable local Supabase after all project migrations, including Toast 40-51.
-- Every test datum is synthetic. Roll back all evidence at end of this test.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(v boolean, note text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'TEST FAILURE: %', note; END IF; END $$;
CREATE FUNCTION pg_temp.must_fail(statement text) RETURNS void
LANGUAGE plpgsql AS $$ DECLARE did_fail boolean:=false;
BEGIN
 BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN did_fail:=true; END;
 IF NOT did_fail THEN RAISE EXCEPTION 'TEST FAILURE expected rejection: %',statement; END IF;
END $$;
SELECT pg_temp.assert_true(NOT has_table_privilege('anon','public.toast_api_credentials','SELECT'),'anon read credentials');
SELECT pg_temp.assert_true(NOT has_table_privilege('authenticated','public.toast_api_credentials','SELECT'),'authenticated read credentials');
SELECT pg_temp.assert_true(NOT has_function_privilege('anon','public.toast_save_configuration(uuid,text,text,text,jsonb)','EXECUTE'),'anon configuration RPC');
SELECT pg_temp.assert_true(NOT has_function_privilege('authenticated','public.toast_store_order_fact(uuid,uuid,uuid,timestamptz,text,jsonb,uuid)','EXECUTE'),'authenticated order staging RPC');
SELECT pg_temp.assert_true(has_function_privilege('service_role','public.toast_save_configuration(uuid,text,text,text,jsonb)','EXECUTE'),'service role config RPC');
SELECT pg_temp.assert_true(has_function_privilege('service_role','public.toast_claim_poll(uuid,uuid,text)','EXECUTE'),'service role lease');
SELECT pg_temp.assert_true(NOT has_function_privilege('service_role',
 'public.toast_promote_reconciled_day_legacy(uuid,uuid,uuid,date,text)','EXECUTE'),
 'old unguarded promotion not executable by service_role');
SELECT pg_temp.assert_true(NOT has_function_privilege('service_role',
 'public.toast_promote_reconciled_day_pre_independent_verification(uuid,uuid,uuid,date,text)','EXECUTE'),
 'prior gated promotion not callable by service_role');
SELECT pg_temp.assert_true(NOT has_function_privilege('service_role',
 'public.toast_replace_location_mappings(uuid,jsonb)','EXECUTE'),
 'old delete-and-reinsert location RPC not callable');

INSERT INTO businesses(id,name,is_demo) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Test café A',false),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Test café B',false);
INSERT INTO locations(id,business_id,name) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Location A'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Location B');
SELECT toast_save_configuration(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','https://ws-api.toasttab.com','old_client','synthetic_ciphertext',
 '[{"location_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001","restaurant_guid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01"}]'::jsonb);
SELECT toast_save_configuration(
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','https://ws-api.toasttab.com','client_b','synthetic_ciphertext',
 '[{"location_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001","restaurant_guid":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbff01"}]'::jsonb);
SELECT pg_temp.must_fail($q$
 SELECT toast_save_configuration('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'https://ws-api.toasttab.com','bad_client','synthetic_ciphertext',
 '[{"location_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001","restaurant_guid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01"}]'::jsonb)
$q$);
SELECT pg_temp.assert_true(
 (SELECT client_id='old_client' FROM toast_api_credentials
 WHERE business_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
 'atomic failed credential update rolled back');
UPDATE toast_location_mappings SET verified_at=now()
 WHERE business_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
INSERT INTO toast_order_events (
 business_id,event_guid,restaurant_guid,event_time,order_guid)
VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0010',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01',now(),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0011');
-- A dependent event must not be orphaned by rotation and must block deletion.
SELECT toast_save_configuration(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','https://ws-api.toasttab.com','new_client','different_ciphertext',
 '[{"location_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001","restaurant_guid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01"}]'::jsonb);
SELECT pg_temp.assert_true(
 (SELECT client_id='new_client' FROM toast_api_credentials
 WHERE business_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),'credential rotation');
SELECT pg_temp.assert_true(
 (SELECT verified_at IS NULL FROM toast_location_mappings
 WHERE business_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),'rotation invalidates verification');
SELECT pg_temp.must_fail($q$
 SELECT toast_save_configuration('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'https://ws-api.toasttab.com','bad_removal','synthetic_ciphertext',
 '[{"location_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001","restaurant_guid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0004"}]'::jsonb)
$q$);
SELECT pg_temp.assert_true(
 (SELECT client_id='new_client' FROM toast_api_credentials
 WHERE business_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),'failed removal rollback');
UPDATE toast_location_mappings SET verified_at=now()
 WHERE business_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
SELECT pg_temp.assert_true(
 (SELECT count(*)=1 FROM toast_location_mappings
 WHERE business_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),'mapping preserved');

-- Event claim/finish nonce fencing: stale token cannot finish an event.
SELECT pg_temp.assert_true(
 (SELECT count(*)=1 FROM toast_claim_order_events(1)
 WHERE event_guid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0010'),'claim event');
SELECT pg_temp.assert_true(NOT toast_finish_order_event(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0010',
 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',true,NULL,NULL),'stale order nonce');
SELECT pg_temp.assert_true(toast_finish_order_event(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0010',
 (SELECT lease_nonce FROM toast_order_events
 WHERE business_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
 AND event_guid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0010'),
 true,NULL,NULL),'owned order nonce');

-- Concurrent/out-of-order provider updates: nonfinal state always fences old completed.
SELECT toast_store_order_fact('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0011',
 '2026-10-10T12:00:00Z','completed','{"posOrderId":"synthetic"}'::jsonb,NULL);
SELECT toast_store_order_fact('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0011',
 '2026-10-10T12:01:00Z','voided',NULL,NULL);
SELECT pg_temp.assert_true(NOT toast_store_order_fact(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0011',
 '2026-10-10T12:00:00Z','completed','{"posOrderId":"synthetic"}'::jsonb,NULL),
 'stale completed write rejected');
SELECT pg_temp.assert_true(
 (SELECT state='voided' AND normalized_order IS NULL FROM toast_modified_orders_staging
 WHERE business_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),'voided staging invalidation');
SELECT pg_temp.must_fail($q$
 SELECT toast_store_order_fact('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbff01','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0012',
 now(),'completed','{}'::jsonb,NULL)
$q$);

-- Older historical timecard cannot overwrite newer modified-date correction to wage/break/clockout.
SELECT toast_stage_labor_entries('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001',
 jsonb_build_array(jsonb_build_object(
 'external_time_entry_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0013',
 'external_employee_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0014',
 'clock_in','2026-09-01T10:00:00Z','clock_out','2026-09-01T18:00:00Z',
 'hourly_wage_cents',NULL,'wage_status','missing','breaks','[]'::jsonb,
 'deleted',false,'provider_modified_at','2026-10-11T00:00:00Z')));
SELECT toast_stage_labor_entries('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001',
 jsonb_build_array(jsonb_build_object(
 'external_time_entry_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0013',
 'external_employee_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0014',
 'clock_in','2026-09-01T10:00:00Z','clock_out',NULL,
 'hourly_wage_cents',100,'wage_status','verified','breaks','[]'::jsonb,
 'deleted',false,'provider_modified_at','2026-10-10T00:00:00Z')));
SELECT pg_temp.assert_true(
 (SELECT hourly_wage_cents IS NULL AND clock_out IS NOT NULL FROM toast_labor_entries
  WHERE business_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),'historical edit monotonicity');

-- Authoritative schedule windows can retire absent Toast shifts atomically.
SELECT toast_apply_schedule_window('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001',
 '2026-10-01T00:00:00Z','2026-10-10T00:00:00Z',
 '[{"external_shift_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0015",
 "external_employee_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0014",
 "external_job_id":null,"scheduled_start":"2026-10-05T10:00:00Z",
 "scheduled_end":"2026-10-05T18:00:00Z","deleted":false}]'::jsonb);
SELECT toast_apply_schedule_window('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001',
 '2026-10-01T00:00:00Z','2026-10-10T00:00:00Z','[]'::jsonb);

SELECT pg_temp.assert_true(
 (SELECT deleted FROM pos_scheduled_shifts
 WHERE business_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
 AND external_shift_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0015'),
 'complete schedule window retires missing provider shift');
SELECT pg_temp.must_fail($q$
 SELECT toast_apply_schedule_window('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001',
 '2026-10-01T00:00:00Z','2026-10-10T00:00:00Z','[]'::jsonb)
$q$);
DO $$
DECLARE nonce uuid;
BEGIN
 SELECT toast_claim_poll('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01','attendance') INTO nonce;
 PERFORM pg_temp.assert_true(nonce IS NOT NULL,'poll lease claim');
 PERFORM pg_temp.assert_true(toast_claim_poll('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01','attendance') IS NULL,'concurrent poll lease');
 PERFORM pg_temp.assert_true(NOT toast_finish_poll(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01',
  'attendance','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',now(),true,NULL,NULL),
  'stale poll nonce rejected');
 PERFORM pg_temp.assert_true(toast_finish_poll(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01',
  'attendance',nonce,'2026-10-10T18:00:00Z',true,NULL,NULL),
  'real poll lease completion');
END $$;
SELECT pg_temp.assert_true((SELECT last_time_entry_poll_at='2026-10-10T18:00:00Z'
 FROM toast_sync_health WHERE business_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
 'cursor advances through owned successful poll');
-- A matched owner report is still guarded by CSV overlap and by one transaction.
INSERT INTO toast_pilot_days(
 business_id,restaurant_guid,location_id,business_date,orders_snapshot,order_count,
 gross_sales_cents,net_sales_cents,discounts_cents,refunds_cents,tax_cents,tip_cents,
 product_quantities,snapshot_sha256,state,report_checked_at,fetched_at)
VALUES(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001','2025-01-10',
 jsonb_build_array(jsonb_build_object(
 'posOrderId','toast:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0019',
 'closedAt','2025-01-10T18:00:00Z','grossSalesCents',1100,'netSalesCents',1100,
 'discountsCents',0,'refundsCents',0,'taxCents',0,'tipCents',0,
 'processingFeeStatus','missing','processingFeeCents',0,'lines',
 jsonb_build_array(jsonb_build_object('posItemId',NULL,'name','Coffee','quantity',1,
 'netSalesCents',1100,'voided',false,'voidedBy',NULL,'modifiers','[]'::jsonb)))),
 1,1100,1100,0,0,0,0,'{}'::jsonb,'synthetic-checksum',
 'matched_owner_report',now(),now());
-- Owner-entered report totals alone must not be accepted as independently verified.
SELECT pg_temp.must_fail($q$
 SELECT toast_promote_reconciled_day('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001',
 '2025-01-10','synthetic-checksum')
$q$);
INSERT INTO toast_verified_report_evidence(
 business_id,restaurant_guid,business_date,staged_sha256,verification_source,evidence_reference)
 VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01','2025-01-10','synthetic-checksum',
 'independently_checked_toast_report','synthetic-db-test-only');
INSERT INTO orders(business_id,location_id,pos_order_id,closed_at,business_date,
 gross_sales_cents,net_sales_cents) VALUES(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001',
 'csv:old-upload','2025-01-10T18:00:00Z','2025-01-10',100,100);
SELECT pg_temp.must_fail($q$
 SELECT toast_promote_reconciled_day('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001',
 '2025-01-10','synthetic-checksum')
$q$);
SELECT pg_temp.assert_true(NOT EXISTS(
 SELECT 1 FROM orders WHERE pos_order_id LIKE 'toast:aaaaaaaa-aaaa-4aaa%'),
 'CSV overlap failure atomic/no partially promoted orders');
DELETE FROM orders WHERE pos_order_id='csv:old-upload'
 AND business_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
SELECT pg_temp.assert_true(toast_promote_reconciled_day(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001','2025-01-10','synthetic-checksum')=1,
 'matched guarded promotion committed once');
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM orders WHERE
 business_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
 AND pos_order_id LIKE 'toast:aaaaaaaa-aaaa-4aaa%'),'canonical stable order identity');


-- PR #63 final: 50 / 100 / 250 facts, one page per job and exact cursor fencing.
DO $check$
DECLARE b uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 r uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01';
 n integer; page_num integer; total_pages integer; copied integer;
 from_ts timestamptz; to_ts timestamptz; before_cursor timestamptz;
 batch jsonb; result jsonb; nonce uuid; failed boolean;
BEGIN
 FOREACH n IN ARRAY ARRAY[50,100,250] LOOP
  from_ts:='2026-10-10T02:00:00Z'::timestamptz+(n||' minutes')::interval;
  to_ts:=from_ts+interval '1 hour';
  SELECT last_order_poll_at INTO before_cursor FROM toast_sync_health
   WHERE business_id=b AND restaurant_guid=r;
  total_pages:=ceil(n/100.0)::integer;
  IF mod(n,100)=0 THEN total_pages:=total_pages+1; END IF;
  FOR page_num IN 1..total_pages LOOP
   SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'orderGuid',(md5('poll-fixture-'||n||'-'||i))::uuid,
    'restaurantGuid',r::text,'modifiedAt',(from_ts+interval '5 minutes')::text,
    'state','open','normalizedOrder',NULL)),'[]'::jsonb) INTO batch
    FROM generate_series((page_num-1)*100+1,LEAST(page_num*100,n)) AS i;
   SELECT toast_claim_poll(b,r,'orders') INTO nonce;
   PERFORM pg_temp.assert_true(nonce IS NOT NULL,'page claim required');
   IF n=250 AND page_num=2 THEN
     failed:=false;
     BEGIN
      PERFORM toast_stage_order_poll_page(b,r,nonce,from_ts,to_ts,page_num,
       jsonb_build_array(jsonb_build_object('orderGuid',gen_random_uuid(),
        'modifiedAt',(from_ts+interval '5 minutes')::text,
        'state','not_a_provider_state','normalizedOrder',NULL)),false,false);
     EXCEPTION WHEN OTHERS THEN failed:=true; END;
     PERFORM pg_temp.assert_true(failed,'malformed page must fail atomically');
     PERFORM pg_temp.assert_true((SELECT next_page=2 FROM toast_order_poll_progress
       WHERE business_id=b AND restaurant_guid=r),'page checkpoint survives failed SQL');
     PERFORM pg_temp.assert_true((SELECT last_order_poll_at IS NOT DISTINCT FROM before_cursor
       FROM toast_sync_health WHERE business_id=b AND restaurant_guid=r),
       'no partial cursor advancement after page failure');
     -- Interruption: release nonce and reacquire another. The page checkpoint persists.
     PERFORM pg_temp.assert_true(toast_finish_poll(b,r,'orders',nonce,NULL,true,NULL,NULL),
       'lease release after interrupted page');
     SELECT toast_claim_poll(b,r,'orders') INTO nonce;
     PERFORM pg_temp.assert_true(nonce IS NOT NULL,'resume acquires a new nonce');
   END IF;
   SELECT toast_stage_order_poll_page(
      b,r,nonce,from_ts,to_ts,page_num,batch,page_num<total_pages,false)
    INTO result;
   PERFORM pg_temp.assert_true((result->>'staged')::integer=jsonb_array_length(batch),
     'one complete bounded page staged');
   IF page_num<total_pages THEN
     PERFORM pg_temp.assert_true((SELECT last_order_poll_at IS NOT DISTINCT FROM before_cursor
      FROM toast_sync_health WHERE business_id=b AND restaurant_guid=r),
      'page without terminal marker cannot advance cursor');
     PERFORM pg_temp.assert_true((SELECT next_page=page_num+1
      FROM toast_order_poll_progress WHERE business_id=b AND restaurant_guid=r),
      'durable next-page checkpoint');
   ELSE
     PERFORM pg_temp.assert_true((SELECT last_order_poll_at=to_ts
      FROM toast_sync_health WHERE business_id=b AND restaurant_guid=r),
      'cursor advances only on final page');
   END IF;
  END LOOP;
  SELECT count(*) INTO copied FROM toast_modified_orders_staging
   WHERE business_id=b AND restaurant_guid=r AND state='open'
   AND order_guid IN (SELECT md5('poll-fixture-'||n||'-'||i)::uuid
    FROM generate_series(1,n) AS i);
  PERFORM pg_temp.assert_true(copied=n,'all 50/100/250 unique order ids persisted');
  PERFORM pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM toast_order_poll_progress
    WHERE business_id=b AND restaurant_guid=r),'completed window clears checkpoint');
 END LOOP;
END $check$;

-- Durable >30 day backfill: exact missing bounds, page interruption and complete restoration.
DO $check$
DECLARE b uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 r uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01';
 nonce uuid; from_ts timestamptz; to_ts timestamptz;
 rec toast_poll_recovery%ROWTYPE; saved timestamptz;
BEGIN
 UPDATE toast_sync_health SET last_order_poll_at='2026-07-01T00:00:00Z'
 WHERE business_id=b AND restaurant_guid=r;
 SELECT toast_claim_poll(b,r,'orders') INTO nonce;
 PERFORM pg_temp.assert_true(toast_begin_poll_recovery(
   b,r,'orders',nonce,'2026-10-10T00:00:00Z'),'backfill initialized');
 SELECT * INTO rec FROM toast_poll_recovery WHERE business_id=b AND restaurant_guid=r
  AND kind='orders';
 PERFORM pg_temp.assert_true(rec.state='requires_historical_backfill' AND
  rec.missing_since='2026-07-01T00:00:00Z' AND
  rec.missing_until='2026-10-10T00:00:00Z' AND
  rec.next_since=rec.missing_since,'exact persisted missing-period boundaries');
 PERFORM pg_temp.assert_true(toast_finish_poll(b,r,'orders',nonce,NULL,true,NULL,NULL),
   'recovery initialization leaves cursor unchanged');
 from_ts:=rec.next_since;to_ts:=from_ts+interval '3 hours';
 SELECT toast_claim_poll(b,r,'orders') INTO nonce;
 -- One exact 100-row page followed by an empty terminal page.
 PERFORM toast_stage_order_poll_page(b,r,nonce,from_ts,to_ts,1,
   (SELECT jsonb_agg(jsonb_build_object(
    'orderGuid',(md5('recovery-fixture-'||i))::uuid,
    'modifiedAt',(from_ts+interval '1 hour')::text,
    'state','open','normalizedOrder',NULL))
    FROM generate_series(1,100) i),true,true);
 PERFORM pg_temp.assert_true((SELECT next_since=from_ts FROM toast_poll_recovery
  WHERE business_id=b AND restaurant_guid=r AND kind='orders'),
  'backfill cursor held while next page pending');
 SELECT toast_claim_poll(b,r,'orders') INTO nonce;
 PERFORM pg_temp.must_fail(format(
  'SELECT toast_stage_order_poll_page(%L::uuid,%L::uuid,%L::uuid,%L::timestamptz,%L::timestamptz,3,%L::jsonb,false,true)',
  b,r,nonce,from_ts,to_ts,'[]'));
 PERFORM pg_temp.assert_true((SELECT next_page=2 FROM toast_order_poll_progress
  WHERE business_id=b AND restaurant_guid=r),'recovery page mismatch not silently skipped');
 PERFORM toast_stage_order_poll_page(b,r,nonce,from_ts,to_ts,2,'[]'::jsonb,false,true);
 PERFORM pg_temp.assert_true((SELECT next_since=to_ts AND state='backfilling'
  FROM toast_poll_recovery WHERE business_id=b AND restaurant_guid=r AND kind='orders'),
  'finished window advances backfill exactly once');
 LOOP
  SELECT * INTO rec FROM toast_poll_recovery WHERE business_id=b AND restaurant_guid=r
    AND kind='orders';
  EXIT WHEN rec.state='complete';
  from_ts:=rec.next_since;
  to_ts:=LEAST(from_ts+interval '20 days',rec.missing_until);
  SELECT toast_claim_poll(b,r,'orders') INTO nonce;
  PERFORM pg_temp.assert_true(nonce IS NOT NULL,'next historical window lease');
  PERFORM toast_stage_order_poll_page(b,r,nonce,from_ts,to_ts,1,'[]'::jsonb,false,true);
 END LOOP;
 PERFORM pg_temp.assert_true((SELECT state='complete' AND next_since=missing_until AND
  completed_at IS NOT NULL FROM toast_poll_recovery
  WHERE business_id=b AND restaurant_guid=r AND kind='orders'),
  'resumable backfill finished without skipping boundaries');
 PERFORM pg_temp.assert_true((SELECT last_order_poll_at='2026-10-10T00:00:00Z'
  FROM toast_sync_health WHERE business_id=b AND restaurant_guid=r),
  'normal order cursor restored at exact historical upper bound');
 PERFORM pg_temp.assert_true((SELECT count(*)=100 FROM toast_modified_orders_staging
  WHERE business_id=b AND restaurant_guid=r AND order_guid IN (
   SELECT md5('recovery-fixture-'||i)::uuid FROM generate_series(1,100) i)),
  'backfill staged all records with stable ids');
 PERFORM pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM toast_pilot_days
   WHERE business_id=b AND business_date BETWEEN '2026-07-01' AND '2026-10-10'),
   'empty modification windows do not invent verified-zero days');
END $check$;

-- Promotion freezes an immutable business-fact baseline. Neither a new
-- provider timestamp nor nonfinancial API metadata is a canonical correction.
DO $baseline$
DECLARE
 b uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 r uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01';
 v_guid uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0019';
 original jsonb; changing jsonb; prior_hash text;
BEGIN
 SELECT normalized_order,promoted_snapshot_sha256 INTO original,prior_hash
 FROM toast_promotion_order_baselines
 WHERE business_id=b AND restaurant_guid=r AND order_guid=v_guid;
 PERFORM pg_temp.assert_true(original IS NOT NULL AND prior_hash='synthetic-checksum',
  'promoted order baseline frozen in same transaction');
 PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM toast_promotion_order_baselines
  WHERE business_id=b AND restaurant_guid=r),'unique baseline for promoted order');
 PERFORM pg_temp.assert_true((SELECT verification_status='promoted_pending_live_reconciliation'
   AND fully_verified_for_owner_reporting=false AND pending_corrections=0
   FROM toast_financial_reporting_status
   WHERE business_id=b AND restaurant_guid=r AND business_date='2025-01-10'),
   'promoted day is not automatically fully verified by reporting boundary');

 PERFORM pg_temp.assert_true(toast_store_order_fact(b,r,v_guid,
  '2026-10-10T18:00:00Z','completed',original,NULL),
  'first poll after promotion accepted without false correction');
 PERFORM pg_temp.assert_true(toast_store_order_fact(b,r,v_guid,
  '2026-10-10T18:10:00Z','completed',original,NULL),
  'identical completed order with newer version accepted without false correction');
 PERFORM pg_temp.assert_true(toast_store_order_fact(b,r,v_guid,
  '2026-10-10T18:20:00Z','completed',
  original||'{"transportMetadata":"sync run changed"}'::jsonb,NULL),
  'nonfinancial transport metadata change does not alter financial baseline');
 PERFORM pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM toast_canonical_corrections
  WHERE business_id=b AND restaurant_guid=r AND order_guid=v_guid),
  'identical newer completed order never creates review row');
 PERFORM pg_temp.assert_true((SELECT state='promoted' FROM toast_pilot_days
  WHERE business_id=b AND restaurant_guid=r AND business_date='2025-01-10'),
  'identical refreshed order preserves promoted day');

 -- Financial difference (not timestamp) creates exactly one review record.
 changing:=jsonb_set(original,'{netSalesCents}','1200'::jsonb);
 PERFORM pg_temp.assert_true(toast_store_order_fact(b,r,v_guid,
  '2026-10-10T19:00:00Z','completed',changing,NULL),
  'changed completed net sale staged for review');
 PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM toast_canonical_corrections
  WHERE business_id=b AND restaurant_guid=r AND order_guid=v_guid
    AND latest_provider_state='completed'),
  'true completed-order accounting change opens single review');
 PERFORM pg_temp.assert_true((SELECT state='needs_review' FROM toast_pilot_days
  WHERE business_id=b AND restaurant_guid=r AND business_date='2025-01-10'),
  'true accounting change invalidates promoted-day status');
 PERFORM pg_temp.assert_true((SELECT verification_status='review_required'
   AND fully_verified_for_owner_reporting=false AND pending_corrections=1
   FROM toast_financial_reporting_status
   WHERE business_id=b AND restaurant_guid=r AND business_date='2025-01-10'),
   'report provenance does not silently show changed day verified');
 PERFORM pg_temp.assert_true(NOT has_table_privilege('anon',
  'public.toast_financial_reporting_status','SELECT'),
  'anonymous user cannot read private report provenance');
 PERFORM pg_temp.assert_true(NOT has_table_privilege('authenticated',
  'public.toast_promotion_order_baselines','SELECT'),
  'authenticated client cannot read baseline');
 PERFORM pg_temp.assert_true(NOT has_table_privilege('service_role',
  'public.toast_promotion_order_baselines','INSERT'),
  'application service role cannot forge baseline evidence');
 PERFORM pg_temp.assert_true(has_table_privilege('service_role',
  'public.toast_financial_reporting_status','SELECT'),
  'service role can surface tenant-scoped financial freshness');
 PERFORM pg_temp.assert_true(NOT has_function_privilege('service_role',
  'public.toast_promote_reconciled_day_pre_baseline(uuid,uuid,uuid,date,text)','EXECUTE'),
  'obsolete promotion wrapper is not accessible to service-role callers');

 -- A stale prior provider version may neither overwrite new state nor
 -- produce another change record.
 PERFORM pg_temp.assert_true(NOT toast_store_order_fact(b,r,v_guid,
  '2026-10-10T18:15:00Z','completed',original,NULL),
  'older provider version rejected despite matching the original baseline');
 PERFORM pg_temp.assert_true((SELECT latest_provider_modified_at='2026-10-10T19:00:00Z'
  FROM toast_canonical_corrections WHERE business_id=b AND restaurant_guid=r
   AND order_guid=v_guid),'stale version does not regress the correction marker');
 PERFORM pg_temp.assert_true((SELECT normalized_order=changing FROM
  toast_modified_orders_staging WHERE business_id=b AND restaurant_guid=r
  AND order_guid=v_guid),'stale payload did not replace newer completed accounting');
END $baseline$;

-- Already-promoted Toast sales: newer refund/void/reopen/delete -> ONE review record.
DO $check$
DECLARE b uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 r uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01';
 v_guid uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0019';
 kind text; counter integer:=0; changed boolean;
BEGIN
 FOREACH kind IN ARRAY ARRAY['refunded','voided','reopened','deleted'] LOOP
   counter:=counter+1;
   SELECT toast_store_order_fact(b,r,v_guid,
    '2026-10-11T00:00:00Z'::timestamptz+(counter||' hours')::interval,
    kind,NULL,NULL) INTO changed;
   PERFORM pg_temp.assert_true(changed,'newer provider state accepted');
   PERFORM pg_temp.assert_true((SELECT state=kind AND normalized_order IS NULL
    FROM toast_modified_orders_staging WHERE business_id=b AND restaurant_guid=r
     AND order_guid=v_guid),'newer nonfinal provider state preserved');
   PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM toast_canonical_corrections
    WHERE business_id=b AND restaurant_guid=r AND order_guid=v_guid),
    'one correction record, never duplicate');
 END LOOP;
 PERFORM pg_temp.assert_true((SELECT latest_provider_state='deleted' AND
   status='review_required' FROM toast_canonical_corrections
   WHERE business_id=b AND restaurant_guid=r AND order_guid=v_guid),
   'latest post-promotion correction requires review');
 PERFORM pg_temp.assert_true((SELECT state='needs_review' FROM toast_pilot_days
    WHERE business_id=b AND restaurant_guid=r AND business_date='2025-01-10'),
    'affected promoted business date no longer marked verified');
 PERFORM pg_temp.assert_true((SELECT net_sales_cents=1100 FROM orders
   WHERE business_id=b AND pos_order_id='toast:'||r::text||':'||v_guid::text),
   'historical canonical financial cents preserved pending review');
 PERFORM pg_temp.assert_true(NOT toast_store_order_fact(
   b,r,v_guid,'2026-10-10T00:00:00Z','completed',
   '{"posOrderId":"stale"}'::jsonb,NULL),'stale version rejected');
END $check$;
SELECT pg_temp.must_fail($q$
 SELECT toast_promote_reconciled_day('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001',
 '2025-01-10','synthetic-checksum')
$q$);
SELECT pg_temp.assert_true(NOT has_function_privilege('service_role',
 'public.toast_store_order_fact_pre_correction(uuid,uuid,uuid,timestamptz,text,jsonb,uuid)','EXECUTE'),
 'service role cannot bypass post-promotion review via old staging RPC');
SELECT pg_temp.assert_true(NOT has_function_privilege('service_role',
 'public.toast_promote_reconciled_day_pre_correction(uuid,uuid,uuid,date,text)','EXECUTE'),
 'service role cannot bypass latest canonical correction gate');
SELECT pg_temp.assert_true((SELECT net_sales_cents=1100 FROM orders
 WHERE business_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
 AND pos_order_id='toast:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0019'),
 'historical revenue preserved after repeat, modified, refund, void, reopened and delete');
SELECT pg_temp.assert_true(NOT has_table_privilege('anon','public.toast_poll_recovery','SELECT'),
 'no anonymous visibility into backfill journal');
SELECT pg_temp.assert_true(NOT has_table_privilege('authenticated','public.toast_canonical_corrections','UPDATE'),
 'authenticated users cannot clear canonical review');

-- Source refund/void business-date events: no amount inferred and no canonical rewrite.
SELECT pg_temp.assert_true(
 toast_stage_payment_day_events('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01','2025-01-10','refunded',
  '["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0029"]'::jsonb)=1,
 'one independently identified refund business-date review event');
SELECT pg_temp.assert_true(
 toast_stage_payment_day_events('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01','2025-01-10','refunded',
  '["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0029"]'::jsonb)=0,
 'duplicate refund event is idempotent');
SELECT pg_temp.assert_true((SELECT net_sales_cents=1100 FROM orders
 WHERE business_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
 AND pos_order_id LIKE 'toast:aaaaaaaa-aaaa-4aaa%'),
 'refund-date evidence must not rewrite original canonical sales');
SELECT pg_temp.must_fail($q$
 SELECT toast_promote_reconciled_day('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001',
 '2025-01-10','synthetic-checksum')
$q$);
SELECT pg_temp.must_fail($q$
 SELECT toast_stage_payment_day_events('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbff01','2025-01-10','refunded','[]'::jsonb)
$q$);
SELECT pg_temp.assert_true(NOT has_function_privilege('anon',
 'public.toast_unverified_sales_dates(uuid,date,date)','EXECUTE'),
 'anonymous clients cannot claim verified source date coverage');
SELECT pg_temp.assert_true(NOT has_function_privilege('authenticated',
 'public.toast_stage_payment_day_events(uuid,uuid,date,text,jsonb)','EXECUTE'),
 'only service role can stage payment-date events');

-- PR65: owner-approved staff link, non-overwriting clock facts, menu/recipe isolation.
DO $ops$
DECLARE b uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 r uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01';
 worker uuid; menu uuid; modifier uuid; ingredient uuid; n integer;
BEGIN
 INSERT INTO employees(business_id,display_name,default_hourly_wage_cents)
 VALUES(b,'Synthetic existing owner worker',1800) RETURNING id INTO worker;
 PERFORM pg_temp.assert_true(toast_stage_employee_roster(b,r,
 '[{"employee_guid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0014",
 "display_name":"Synthetic worker from Toast","deleted":false}]'::jsonb)=1,
 'Toast roster staged separate from canonical employees');
 PERFORM pg_temp.must_fail(format(
  'SELECT toast_link_employee(%L::uuid,%L::uuid,%L::uuid,%L::uuid)',
  b,r,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0014',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001'));
 PERFORM pg_temp.assert_true(toast_link_employee(b,r,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0014',worker),'manual approved employee mapping');
 PERFORM pg_temp.assert_true((SELECT display_name='Synthetic existing owner worker'
  FROM employees WHERE id=worker),'Toast roster must not rename owner record');
 -- Existing old staged entry has MISSING hourly wage; no silent zero/payroll.
 PERFORM pg_temp.must_fail(format(
  'SELECT toast_import_confirmed_attendance(%L::uuid,%L::uuid,%L::jsonb)',
  b,r,'["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0013"]'));
 PERFORM pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM timecards WHERE
  business_id=b AND pos_timecard_id LIKE 'toast:%'),'missing wage never imported');
 PERFORM toast_stage_labor_entries(b,r,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001',
 jsonb_build_array(jsonb_build_object(
 'external_time_entry_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0013',
 'external_employee_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0014',
 'clock_in','2026-09-01T10:00:00Z','clock_out','2026-09-01T18:00:00Z',
 'hourly_wage_cents',1550,'wage_status','verified','breaks','[]'::jsonb,
 'deleted',false,'provider_modified_at','2026-10-12T00:00:00Z')));
 -- Conflicting manual shift must not be overwritten or doubled.
 INSERT INTO timecards(business_id,employee_id,clock_in,clock_out,hourly_wage_cents,
  source_type,source_provider)
 VALUES(b,worker,'2026-09-01T11:00:00Z','2026-09-01T17:00:00Z',2000,'owner_manual','Owner');
 PERFORM pg_temp.must_fail(format(
  'SELECT toast_import_confirmed_attendance(%L::uuid,%L::uuid,%L::jsonb)',
  b,r,'["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0013"]'));
 DELETE FROM timecards WHERE business_id=b AND employee_id=worker
  AND source_type='owner_manual';
 SELECT toast_import_confirmed_attendance(b,r,
  '["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0013"]'::jsonb) INTO n;
 PERFORM pg_temp.assert_true(n=1,'owner-approved verified wage attendance imported');
 SELECT toast_import_confirmed_attendance(b,r,
  '["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0013"]'::jsonb) INTO n;
 PERFORM pg_temp.assert_true(n=0,'duplicate Toast timecard import is idempotent');
 PERFORM pg_temp.assert_true((SELECT hourly_wage_cents=1550 AND
  source_type='connected_pos' AND source_provider='Toast'
  FROM timecards WHERE employee_id=worker AND business_id=b),
  'hourly wage from Toast snapshot, without employee master wage overwrite');
 PERFORM toast_stage_labor_entries(b,r,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001',
 jsonb_build_array(jsonb_build_object(
 'external_time_entry_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0013',
 'external_employee_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0014',
 'clock_in','2026-09-01T10:00:00Z','clock_out','2026-09-01T19:00:00Z',
 'hourly_wage_cents',1550,'wage_status','verified','breaks','[]'::jsonb,
 'deleted',false,'provider_modified_at','2026-10-12T01:00:00Z')));
 PERFORM pg_temp.assert_true((SELECT reconciliation_status='review_canonical_owner_correction'
  FROM toast_attendance_review WHERE business_id=b AND restaurant_guid=r
  AND external_time_entry_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0013'),
  'later modified Toast clock-out surfaces review, not payroll rewrite');
 PERFORM pg_temp.assert_true((SELECT clock_out='2026-09-01T18:00:00Z'
  FROM timecards WHERE employee_id=worker AND business_id=b),
  'earlier canonical timecard remains unchanged after provider modification');
 INSERT INTO ingredients(business_id,name,base_unit)
 VALUES(b,'Synthetic espresso beans','g') RETURNING id INTO ingredient;
 INSERT INTO menu_items(business_id,name,base_name,price_cents)
 VALUES(b,'Owner recipe coffee','Owner recipe coffee',500) RETURNING id INTO menu;
 INSERT INTO recipe_lines(menu_item_id,ingredient_id,quantity)
 VALUES(menu,ingredient,18);
 INSERT INTO modifier_recipes(business_id,name,quantity_delta)
 VALUES(b,'Owner oat milk',5) RETURNING id INTO modifier;
 PERFORM pg_temp.assert_true(toast_stage_catalog(b,r,
 '[{"kind":"item","provider_guid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0030",
 "name":"Toast coffee","category":"Drinks","price_cents":550,
 "pricing_strategy":"BASE_PRICE","modifier_group_guids":[]},
 {"kind":"modifier","provider_guid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0031",
 "name":"Oat milk","category":null,"price_cents":null,
 "pricing_strategy":"OPEN_PRICE","modifier_group_guids":[]}]'::jsonb)=2,
 'both Toast menu item and modifier staged');
 PERFORM pg_temp.assert_true(toast_link_catalog(b,r,'item',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0030',menu),
  'reviewed Toast item linked without recipe rewrite');
 PERFORM pg_temp.assert_true(toast_link_catalog(b,r,'modifier',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0031',modifier),
  'reviewed Toast modifier linked without ingredient rewrite');
 PERFORM pg_temp.assert_true(toast_stage_catalog(b,r,
 '[{"kind":"item","provider_guid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0030",
 "name":"Toast coffee","category":"Drinks","price_cents":600,
 "pricing_strategy":"BASE_PRICE","modifier_group_guids":[]}]'::jsonb)=1,
 'later Toast price staged');
 PERFORM pg_temp.assert_true((SELECT count(*)=2 FROM toast_catalog_price_versions
  WHERE business_id=b AND restaurant_guid=r AND kind='item'
   AND provider_guid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0030'),
  'old/new Toast price versions both preserved');
 PERFORM pg_temp.assert_true((SELECT price_cents=500 AND name='Owner recipe coffee'
  FROM menu_items WHERE id=menu),'owner menu name/price unchanged');
 PERFORM pg_temp.assert_true((SELECT quantity=18 FROM recipe_lines
  WHERE menu_item_id=menu AND ingredient_id=ingredient),
  'ingredient recipe unchanged');
 PERFORM pg_temp.assert_true((SELECT quantity_delta=5 FROM modifier_recipes WHERE id=modifier),
  'modifier recipe quantities unchanged');
END $ops$;
SELECT pg_temp.assert_true(NOT has_table_privilege('authenticated',
 'public.toast_catalog_facts','UPDATE'),'provider catalog cannot be edited by ordinary members');
SELECT pg_temp.assert_true(NOT has_function_privilege('anon',
 'public.toast_import_confirmed_attendance(uuid,uuid,jsonb)','EXECUTE'),
 'anon cannot import paid timecards');

-- Denied access is exercised as real anonymous / authenticated SQL session roles.
SET LOCAL ROLE anon;
DO $$
BEGIN
 BEGIN
   PERFORM count(*) FROM toast_api_credentials;
   RAISE EXCEPTION 'anonymous read incorrectly allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
 BEGIN
   PERFORM count(*) FROM toast_location_mappings;
   RAISE EXCEPTION 'authenticated read incorrectly allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
ROLLBACK;
