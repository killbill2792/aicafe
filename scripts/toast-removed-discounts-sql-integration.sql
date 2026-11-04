-- Migration 150: a discount removed at the register (processingState VOID) is not
-- counted in typed order details, and the AI sees it with counts_in_sales = false.
-- Run ONLY against a disposable local Supabase after all migrations. Synthetic data, rolled back.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(v boolean, note text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'TEST FAILURE: %', note; END IF; END $$;

DO $removed$
DECLARE
 b uuid:='eeeeeeee-2222-4eee-8eee-eeeeeeeeee00'; r uuid:='eeeeeeee-2222-4eee-8eee-eeeeeeeeee01';
 loc uuid:='eeeeeeee-2222-4eee-8eee-eeeeeeeeee02'; d date:='2026-11-02';
 ord uuid:='eeeeeeee-2222-4eee-8eee-eeeeeeee0001'; run_i uuid; o jsonb; facts jsonb;
BEGIN
 insert into public.businesses(id,name,is_demo) values(b,'Removed discount test café',false);
 insert into public.locations(id,business_id,name) values(loc,b,'Removed discount test location');
 perform public.toast_save_configuration(b,'https://ws-api.toasttab.com','removed_client','synthetic_ciphertext',
  jsonb_build_array(jsonb_build_object('location_id',loc,'restaurant_guid',r)));
 update public.toast_location_mappings set verified_at=now() where business_id=b;

 -- The real Nov 2 shape: applied, removed (VOID), applied again on one drink; once on another;
 -- plus a check-level discount that was removed.
 o:=jsonb_build_object('guid',ord,'modifiedDate','2026-11-02T21:40:00.000+0000',
  'checks',jsonb_build_array(jsonb_build_object('guid','eeeeeeee-2222-4eee-8eee-eeeeeeee0011','paymentStatus','CLOSED',
   'appliedDiscounts',jsonb_build_array(jsonb_build_object('guid','eeeeeeee-2222-4eee-8eee-eeeeeeee0031',
    'name','Manager Comp - Check','discountAmount',5,'processingState','VOID')),
   'selections',jsonb_build_array(
    jsonb_build_object('guid','eeeeeeee-2222-4eee-8eee-eeeeeeee0012','displayName','Banana Bread Matcha','price',7.87,
     'appliedDiscounts',jsonb_build_array(
      jsonb_build_object('guid','eeeeeeee-2222-4eee-8eee-eeeeeeee0021','name','Dental Students & Faculty','discountAmount',0.88,'processingState','VOID'),
      jsonb_build_object('guid','eeeeeeee-2222-4eee-8eee-eeeeeeee0022','name','Dental Students & Faculty','discountAmount',0.88,'processingState',null))),
    jsonb_build_object('guid','eeeeeeee-2222-4eee-8eee-eeeeeeee0013','displayName','Cinnamon Roll Matcha','price',7.87,
     'appliedDiscounts',jsonb_build_array(
      jsonb_build_object('guid','eeeeeeee-2222-4eee-8eee-eeeeeeee0023','name','Dental Students & Faculty','discountAmount',0.88)))))));

 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,state)
  values(b,r,'daily','running') returning id into run_i;
 insert into public.toast_day_pages(run_id,business_date,page,payload) values(run_i,d,1,jsonb_build_array(o));
 insert into public.toast_day_status(business_id,restaurant_guid,business_date,import_state,
  last_import_run_id,imported_at,unparsed_count)
  values(b,r,d,'imported',run_i,now(),0)
  on conflict(business_id,restaurant_guid,business_date) do update
  set import_state='imported',last_import_run_id=run_i,imported_at=now(),unparsed_count=0;
 perform public.toast_archive_day_pages(run_i,d);

 -- Typed details (what the discounts view reads): 2 student discounts, no removed ones.
 select item_discounts into facts from public.toast_current_typed_order_facts_v where business_id=b and order_guid=ord;
 perform pg_temp.assert_true(jsonb_array_length(facts)=2,'two applied item discounts, got '||coalesce(facts::text,'none'));
 perform pg_temp.assert_true((select sum((x->>'amountCents')::int)=176 from jsonb_array_elements(facts) x),
  'student discounts total $1.76, not $2.64');
 perform pg_temp.assert_true((select jsonb_array_length(check_discounts)=0 from public.toast_current_typed_order_facts_v
  where business_id=b and order_guid=ord),'a removed check discount is not counted');

 -- The AI still sees every discount Toast sent, but the removed ones do not count.
 perform pg_temp.assert_true((select count(*)=3 and count(*) filter (where counts_in_sales)=2
  from public.toast_records_for(b,d,d) where record_type='item_discount'),
  'three item discount rows kept, two count (as Toast reports 5 for the day, not 6)');
 perform pg_temp.assert_true((select count(*)=1 and bool_and(not counts_in_sales)
  from public.toast_records_for(b,d,d) where record_type='check_discount'),'the removed check discount is kept but not counted');

 -- Rebuilding typed details (as the migration does for existing orders) gives the same result.
 delete from public.toast_order_typed_facts where business_id=b;
 perform public.toast_capture_typed_order(id) from public.toast_raw_records where business_id=b and entity='order';
 perform pg_temp.assert_true((select jsonb_array_length(item_discounts)=2 and run_id=run_i
  from public.toast_order_typed_facts where business_id=b),'a rebuild keeps the import run and the same discounts');
END $removed$;

ROLLBACK;
