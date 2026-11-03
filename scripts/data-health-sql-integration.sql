-- Migration 142: the daily data health check finds size, growth, repeated POS
-- records and café-day total mismatches, keeps one row per day, and is closed to app users.
-- Run ONLY against a disposable local Supabase after all migrations. Synthetic data, rolled back.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(v boolean, note text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'TEST FAILURE: %', note; END IF; END $$;

SELECT pg_temp.assert_true(NOT has_function_privilege('authenticated',
 'public.run_data_health_check(bigint,integer)','EXECUTE'),'app users cannot run the check');
SELECT pg_temp.assert_true(NOT has_table_privilege('authenticated','public.data_health_checks','SELECT'),
 'app users cannot read health results');
SELECT pg_temp.assert_true(NOT has_table_privilege('anon','public.data_health_checks','SELECT'),
 'anonymous users cannot read health results');

DO $health$
DECLARE
 b uuid:='bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbc0000'; r uuid:='bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbc0001';
 v uuid:='bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbc0002'; d date:=(now() at time zone 'utc')::date-1;
 run uuid; res public.data_health_checks; f jsonb; size bigint:=pg_database_size(current_database());
BEGIN
 insert into public.businesses(id,name,is_demo) values(b,'Health check test café',false);
 -- Yesterday's check was tiny, so today looks like sudden growth when the database is over 50 MB.
 insert into public.data_health_checks(checked_on,database_bytes,plan_bytes)
  values((now() at time zone 'utc')::date-1,1,8589934592);
 -- One void stored twice on the same day.
 insert into public.toast_raw_records(business_id,restaurant_guid,entity,entity_guid,business_date,
  payload,payload_sha256,capture_key)
 values(b,r,'void',v,d,'{"a":1}',repeat('a',64),'health:v1'),(b,r,'void',v,d,'{"a":2}',repeat('b',64),'health:v2');
 -- An imported day of 10.00 with no stored orders.
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,state)
  values(b,r,'daily','running') returning id into run;
 insert into public.toast_day_status(business_id,restaurant_guid,business_date,import_state,
  last_import_run_id,imported_at,unparsed_count,net_sales_cents)
  values(b,r,d,'imported',run,now(),0,1000);

 res:=public.run_data_health_check(1,30);
 f:=res.findings;
 perform pg_temp.assert_true(res.database_bytes>0 and jsonb_array_length(res.largest_tables) between 1 and 8,
  'size and largest tables are recorded');
 perform pg_temp.assert_true(f @> '[{"kind":"database_near_limit"}]','a tiny plan is reported as near the limit');
 perform pg_temp.assert_true((f @> '[{"kind":"sudden_growth"}]')=(size-1>52428800),
  'growth is reported only above 50 MB / 20 %');
 perform pg_temp.assert_true(f @> jsonb_build_array(jsonb_build_object('kind','repeated_pos_records',
  'business_id',b,'entity','void','objects',1,'extra_rows',1)),'the repeated void is reported, got '||f::text);
 perform pg_temp.assert_true(f @> jsonb_build_array(jsonb_build_object('kind','total_mismatch',
  'business_id',b,'business_date',d,'import_net_cents',1000,'stored_net_cents',0)),
  'the day whose orders do not add up is reported');

 -- Fix the problems; re-running the same day replaces the row.
 delete from public.toast_raw_records where capture_key='health:v2' and business_id=b;
 update public.toast_day_status set net_sales_cents=0 where business_id=b;
 res:=public.run_data_health_check(8589934592000,30);
 perform pg_temp.assert_true((select count(*)=1 from public.data_health_checks
  where checked_on=(now() at time zone 'utc')::date),'one row per day');
 perform pg_temp.assert_true(not (res.findings @> '[{"kind":"database_near_limit"}]')
  and not (res.findings @> jsonb_build_array(jsonb_build_object('business_id',b))),
  'fixed problems are no longer reported, got '||res.findings::text);
END $health$;

ROLLBACK;
