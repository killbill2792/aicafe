-- Migration 130: the AI reaches every Toast field through cv_toast_records and
-- named fields in ai_query_view ("data.server.guid").
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
 q text:='select public.ai_query_view($1,''cv_toast_records'',$2,$3,$4,$5,$6,$6,null,100)';
BEGIN
 if to_regclass('public.toast_location_mappings') is not null then
  execute 'insert into public.businesses(id,name,is_demo) values($1,$2,false)' using b,'AI fields café';
  execute 'insert into public.locations(id,business_id,name) values($1,$2,$3)' using loc,b,'AI fields location';
  execute 'select public.toast_save_configuration($1,$2,$3,$4,$5)'
   using b,'https://ws-api.toasttab.com','ai_client','synthetic_ciphertext',
   jsonb_build_array(jsonb_build_object('location_id',loc,'restaurant_guid',r));
  execute 'update public.toast_location_mappings set verified_at=now() where business_id=$1' using b;
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
    jsonb_build_object('guid','sel-3','displayName','Cookie','price',3,'quantity',1,'voided',true)),
   'payments',jsonb_build_array(jsonb_build_object('guid','cccccccc-cccc-4ccc-8ccc-cccccccc0003',
    'type','CREDIT','amount',9.5,'tipAmount',1,'paymentStatus','CAPTURED'))))));
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

 -- Other Toast endpoints from the daily capture. Setup lists keep only the newest copy.
 insert into public.toast_raw_samples(business_id,restaurant_guid,endpoint,business_date,
  fetched_at,http_status,item_count,sample,field_paths) values
 (b,r::text,'labor/v1/timeEntries',d,now()-interval '1 hour',200,1,
  '[{"guid":"te-1","regularHours":6.5,"jobReference":{"guid":"job-1"}}]','{}'),
 (b,r::text,'config/v2/tables','2026-10-10',now()-interval '9 days',200,1,'[{"guid":"t-old","name":"Old"}]','{}'),
 (b,r::text,'config/v2/tables','2026-10-18',now()-interval '1 day',200,2,
  '[{"guid":"t-1","name":"Patio 4"},{"guid":"t-2","name":"Bar 1"}]','{}'),
 (b,r::text,'orders/v2/ordersBulk',d,now(),200,1,'[{"guid":"dup"}]','{}');

 perform pg_temp.assert_true((select count(*)=1 from public.cv_toast_records
  where business_id=b and record_type='order'),'each order appears once, from the latest import');
 perform pg_temp.assert_true((select count(*)=1 from public.cv_toast_records where business_id=b
  and record_type='payment' and (data->>'tipAmount')::numeric=2),'payments show the changed tip');
 perform pg_temp.assert_true((select count(*) from public.cv_toast_records where business_id=b and record_type='item')=3
  and (select count(*) from public.cv_toast_records where business_id=b and record_type='item' and counts_in_sales)=2,
  'every item is readable; the voided one does not count in sales');
 perform pg_temp.assert_true((select count(*) from public.cv_toast_records where business_id=b
  and record_type in ('modifier','item_discount','check_discount'))=3,'modifiers and discounts are their own rows');
 perform pg_temp.assert_true((select not (data ? 'checks') from public.cv_toast_records
  where business_id=b and record_type='order'),'an order row does not repeat its checks');
 perform pg_temp.assert_true(not exists(select 1 from public.cv_toast_records
  where business_id=b and record_type like 'orders/%'),'orders are read once, from the archive');
 perform pg_temp.assert_true((select count(*)=2 and bool_and(business_date is null) from public.cv_toast_records
  where business_id=b and record_type='config/v2/tables'),'setup lists show only the newest copy, undated');

 -- Named fields: sales of counted items, grouped by item name.
 execute q into res using b,null::text[],
  '[{"column":"record_type","op":"=","value":"item"},{"column":"counts_in_sales","op":"=","value":true}]'::jsonb,
  array['data.displayName'],'[{"fn":"sum","column":"data.price"}]'::jsonb,d;
 perform pg_temp.assert_true(res->'rows' @> '[{"data.displayName":"Latte","sum_data.price":5.5}]'
  and jsonb_array_length(res->'rows')=2,'sums a field inside data, grouped by another');
 execute q into res using b,null::text[],
  '[{"column":"record_type","op":"=","value":"order"}]'::jsonb,
  array['data.server.guid','data.table.name'],'[{"fn":"sum","column":"data.numberOfGuests"}]'::jsonb,d;
 perform pg_temp.assert_true(res->'rows'->0->>'data.server.guid'='server-1'
  and res->'rows'->0->>'data.table.name'='Patio 4','groups by nested fields');
 execute q into res using b,array['data.displayName'],
  '[{"column":"record_type","op":"=","value":"item"},{"column":"data.price","op":">","value":3.5}]'::jsonb,
  null::text[],null::jsonb,d;
 perform pg_temp.assert_true(jsonb_array_length(res->'rows')=2,'compares numbers inside data as numbers');
 execute q into res using b,array['data.name'],
  '[{"column":"record_type","op":"=","value":"config/v2/tables"}]'::jsonb,null::text[],null::jsonb,d;
 perform pg_temp.assert_true(jsonb_array_length(res->'rows')=2,'setup lists are read for any date');
 perform pg_temp.assert_true(public.ai_toast_fields(b,'item') @> '[{"field":"data.price","type":"number"}]'
  and not (public.ai_toast_fields(b,'order') @> '[{"field":"data.checks.0.amount"}]'),
  'lists the field names of a record type');
 begin
  execute q into res using b,array['data.price) from x; --'],null::jsonb,null::text[],null::jsonb,d;
  failed:=false;
 exception when others then failed:=true;
 end;
 perform pg_temp.assert_true(failed,'only plain field names are accepted');
END $ai_records$;

ROLLBACK;
