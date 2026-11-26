-- The AI reaches Toast fields through scoped canonical SQL, including nested JSON.
-- Run ONLY against a disposable local Supabase after all migrations. Synthetic data, rolled back.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(v boolean, note text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'TEST FAILURE: %', note; END IF; END $$;

DO $ai_records$
DECLARE
 b uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccc00'; r uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccc01';
 loc uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccc02'; d date:='2026-10-19';
 run_a uuid; run_b uuid; page jsonb; changed jsonb; res jsonb; failed boolean;
BEGIN
 if to_regclass('public.toast_location_mappings') is not null then
  execute 'insert into public.businesses(id,name,is_demo) values($1,$2,false)' using b,'AI fields café';
  execute 'insert into public.locations(id,business_id,name) values($1,$2,$3)' using loc,b,'AI fields location';
  execute 'select public.toast_save_configuration($1,$2,$3,$4,$5)'
   using b,'https://ws-api.toasttab.com','ai_client','synthetic_ciphertext',
   jsonb_build_array(jsonb_build_object('location_id',loc,'restaurant_guid',r));
  execute 'update public.toast_location_mappings set verified_at=now(),info_refreshed_at=now() where business_id=$1' using b;
 else
  insert into public.businesses(id) values(b);
 end if;
 page:=jsonb_build_array(jsonb_build_object('guid','cccccccc-cccc-4ccc-8ccc-cccccccc0001',
  'server',jsonb_build_object('guid','server-1'),'table',jsonb_build_object('name','Patio 4'),
  'source','In Store','numberOfGuests',2,
  'checks',jsonb_build_array(jsonb_build_object('guid','cccccccc-cccc-4ccc-8ccc-cccccccc0002',
   'amount',9.5,
   'appliedDiscounts',jsonb_build_array(jsonb_build_object('name','Staff','discountAmount',0.5)),
   'selections',jsonb_build_array(
    jsonb_build_object('guid','sel-1','displayName','Latte','price',5.5,'quantity',1,
     'modifiers',jsonb_build_array(jsonb_build_object('displayName','Oat milk','price',0.75)),
     'appliedDiscounts',jsonb_build_array(jsonb_build_object('name','Happy hour','discountAmount',1))),
    jsonb_build_object('guid','sel-2','displayName','Muffin','price',4,'quantity',1),
    jsonb_build_object('guid','sel-3','displayName','Cookie','price',3,'quantity',1,'voided',true),
    jsonb_build_object('guid','sel-4','displayName','Gift card','price',25,'quantity',1,'deferred',true)),
   'payments',jsonb_build_array(jsonb_build_object('guid','cccccccc-cccc-4ccc-8ccc-cccccccc0003',
    'type','CREDIT','amount',9.5,'tipAmount',1,'paymentStatus','CAPTURED'),
    jsonb_build_object('guid','cccccccc-cccc-4ccc-8ccc-cccccccc0004','type','CREDIT','amount',9.5,'paymentStatus','DENIED'))),
   jsonb_build_object('guid','cccccccc-cccc-4ccc-8ccc-cccccccc0005','voided',true,'amount',4,
    'payments',jsonb_build_array(jsonb_build_object('guid','cccccccc-cccc-4ccc-8ccc-cccccccc0006',
     'type','CASH','amount',4,'paymentStatus','CLOSED'))))),
  -- A training order made in Toast's test mode: kept, never counted.
  jsonb_build_object('guid','cccccccc-cccc-4ccc-8ccc-cccccccc0007','createdInTestMode',true,
   'checks',jsonb_build_array(jsonb_build_object('guid','cccccccc-cccc-4ccc-8ccc-cccccccc0008','amount',5,
    'selections',jsonb_build_array(jsonb_build_object('guid','sel-5','displayName','Latte','price',5,'quantity',1)),
    'payments',jsonb_build_array(jsonb_build_object('guid','cccccccc-cccc-4ccc-8ccc-cccccccc0009',
     'type','CASH','amount',5,'paymentStatus','CLOSED'))))));
 changed:=jsonb_set(page,'{0,checks,0,payments,0,tipAmount}','2'::jsonb);

 -- Import A, then import B where Toast changed the tip: only B's version is read.
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,state)
  values(b,r,'repull_modified','running') returning id into run_a;
 insert into public.toast_day_pages(run_id,business_date,page,payload) values(run_a,d,1,page);
 insert into public.toast_day_status(business_id,restaurant_guid,business_date,import_state,
  last_import_run_id,imported_at,unparsed_count) values(b,r,d,'imported',run_a,now(),0)
  on conflict(business_id,restaurant_guid,business_date) do update
  set import_state='imported',last_import_run_id=run_a,imported_at=now(),unparsed_count=0;
 perform public.toast_archive_day_pages(run_a,d);
 delete from public.toast_day_pages where run_id=run_a;
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,state)
  values(b,r,'repull_modified','running') returning id into run_b;
 insert into public.toast_day_pages(run_id,business_date,page,payload) values(run_b,d,1,changed);
 update public.toast_day_status set last_import_run_id=run_b,imported_at=now()+interval '1 second'
  where business_id=b and restaurant_guid=r and business_date=d;
 perform public.toast_archive_day_pages(run_b,d);
 delete from public.toast_day_pages where run_id=run_b;

 -- Operational non-order objects are retained once by the existing current writer.
 -- A diagnostic sample for the same endpoint is deliberately contradictory.
 insert into public.toast_raw_records(business_id,restaurant_guid,entity,business_date,
  payload,payload_sha256,capture_key)
 values
 (b,r,'labor/v1/timeEntries',d,
  '{"guid":"te-1","regularHours":6.5,"jobReference":{"guid":"job-1"}}',
  repeat('a',64),'pos0e:time-entry:te-1'),
 (b,r,'config/v2/tables',null,'{"guid":"t-1","name":"Patio 4"}',
  repeat('b',64),'pos0e:table:t-1'),
 (b,r,'config/v2/tables',null,'{"guid":"t-2","name":"Bar 1"}',
  repeat('c',64),'pos0e:table:t-2');

 insert into public.toast_raw_samples(business_id,restaurant_guid,endpoint,business_date,
  fetched_at,http_status,item_count,sample,field_paths) values
 (b,r::text,'config/v2/tables','2026-10-18',now(),200,1,
  '[{"guid":"DIAGNOSTIC-ONLY","name":"WRONG"}]','{}'),
 (b,r::text,'orders/v2/ordersBulk',d,now(),200,1,'[{"guid":"dup"}]','{}');

 perform pg_temp.assert_true((select count(*)=2 from public.cv_toast_records
  where business_id=b and record_type='order'),'each order appears once, from the latest import');
 perform pg_temp.assert_true((select count(*)=1 from public.cv_toast_records
  where business_id=b and record_type='order' and not counts_in_sales),'a test-mode order is kept but not counted');
 perform pg_temp.assert_true((select count(*) from public.cv_toast_records where business_id=b and record_type='payment')=4
  and (select count(*) from public.cv_toast_records where business_id=b and record_type='payment' and counts_in_sales)=1,
  'declined payments, payments on voided checks and test-mode payments are kept but not counted');
 perform pg_temp.assert_true((select count(*)=1 from public.cv_toast_records where business_id=b
  and record_type='payment' and (data->>'tipAmount')::numeric=2),'payments show the changed tip');
 perform pg_temp.assert_true((select count(*) from public.cv_toast_records where business_id=b and record_type='item')=5
  and (select count(*) from public.cv_toast_records where business_id=b and record_type='item' and counts_in_sales)=2,
  'every item is readable; voided, gift card and test-mode items do not count in sales');
 perform pg_temp.assert_true(not exists(select 1 from public.cv_toast_records where business_id=b
  and record_type in ('order','check','item','payment') and counts_in_sales is null),'the sales flag is never unknown for order records');
 perform pg_temp.assert_true((select count(*) from public.cv_toast_records where business_id=b
  and record_type in ('modifier','item_discount','check_discount'))=3,'modifiers and discounts are their own rows');
 perform pg_temp.assert_true((select bool_and(not (data ? 'checks')) from public.cv_toast_records
  where business_id=b and record_type='order'),'an order row does not repeat its checks');
 perform pg_temp.assert_true(not exists(select 1 from public.cv_toast_records
  where business_id=b and record_type like 'orders/%'),'orders are read once, from the archive');
 perform pg_temp.assert_true((select count(*)=2 and bool_and(business_date is null) from public.cv_toast_records
  where business_id=b and record_type='config/v2/tables'),'setup objects from current retained records are undated and unique');

 perform pg_temp.assert_true(not exists(select 1 from public.cv_toast_records
  where business_id=b and record_ref='DIAGNOSTIC-ONLY'),
  'historical diagnostic capture cannot enter the operational reader');
 -- Native SQL can group and filter nested provider fields directly.
 select jsonb_agg(to_jsonb(q)) into res from (
  select data->>'displayName' as name,sum((data->>'price')::numeric) as price
  from public.toast_records_for(b,d,d) where record_type='item' AND counts_in_sales group by 1
 ) q;
 perform pg_temp.assert_true(res @> '[{"name":"Latte","price":5.5}]'
   and jsonb_array_length(res)=2,'sums nested prices by item name');
 perform pg_temp.assert_true(
  (select count(*)>0 from public.toast_records_for(b,d,d)
   where record_type='order' AND counts_in_sales
   AND data#>>'{server,guid}'='server-1' AND data#>>'{table,name}'='Patio 4'),
  'nested server and table fields are available');
 perform pg_temp.assert_true(
  (select count(*)=2 from public.toast_records_for(b,d,d)
   where record_type='item' AND counts_in_sales AND (data->>'price')::numeric>3.5),
  'SQL compares numeric JSON fields as numbers');
 perform pg_temp.assert_true(
  (select count(*)=2 FROM public.toast_records_for(b,d,d)
   where record_type='config/v2/tables' AND business_date IS NULL),
  'setup lists are undated and readable');
 -- A signed-in user who does not own this café reads nothing, and the archive table stays closed.
 perform set_config('request.jwt.claim.sub','cccccccc-cccc-4ccc-8ccc-ccccccccccff',true);
 perform set_config('request.jwt.claims','{"sub":"cccccccc-cccc-4ccc-8ccc-ccccccccccff","role":"authenticated"}',true);
 execute 'set local role authenticated';
 perform pg_temp.assert_true((select count(*)=0 from public.toast_records_for(b,null,null)),
  'another user cannot read this café''s Toast records');
 perform pg_temp.assert_true(not has_table_privilege('public.toast_raw_records','SELECT'),
  'the archive table itself stays closed to signed-in users');
 execute 'reset role';
 -- The café's owner, signed in, reads them.
 insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
  values('cccccccc-cccc-4ccc-8ccc-ccccccccccee','00000000-0000-0000-0000-000000000000','authenticated',
   'authenticated','ai-fields-owner@example.test','',now(),now());
 insert into public.memberships(business_id,user_id,role) values(b,'cccccccc-cccc-4ccc-8ccc-ccccccccccee','owner');
 perform set_config('request.jwt.claim.sub','cccccccc-cccc-4ccc-8ccc-ccccccccccee',true);
 perform set_config('request.jwt.claims','{"sub":"cccccccc-cccc-4ccc-8ccc-ccccccccccee","role":"authenticated"}',true);
 execute 'set local role authenticated';
 perform pg_temp.assert_true((select count(*)>0 from public.toast_records_for(b,null,null)),
  'the owner reads their café''s Toast records');
 execute 'reset role';
END $ai_records$;

ROLLBACK;

-- Run the independent POS0e migrated-schema, cross-café and poisoned-capture
-- negative proof as part of the existing trusted database CI invocation.
\ir pos0e-current-reader-sql-integration.sql
