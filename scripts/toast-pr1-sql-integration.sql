\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert(v boolean,n text) RETURNS void LANGUAGE plpgsql AS $$
begin if v is distinct from true then raise exception 'Toast PR1: %',n;end if;end $$;
SELECT pg_temp.assert(NOT has_function_privilege('anon',
 'public.toast_import_day(uuid,uuid,uuid,date,jsonb,jsonb,uuid)','EXECUTE'),'anon cannot import');
SELECT pg_temp.assert(NOT has_function_privilege('authenticated',
 'public.toast_import_day(uuid,uuid,uuid,date,jsonb,jsonb,uuid)','EXECUTE'),'client cannot import');
SELECT pg_temp.assert(has_function_privilege('service_role',
 'public.toast_import_day(uuid,uuid,uuid,date,jsonb,jsonb,uuid)','EXECUTE'),'service can import');
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','toast_void_facts','INSERT'),'browser cannot write voids');
SELECT pg_temp.assert(NOT has_function_privilege('service_role',
 'public.toast_promote_reconciled_day(uuid,uuid,uuid,date,text)','EXECUTE'),'manual promotion retired');

SELECT set_config('request.jwt.claim.role','service_role',true);
INSERT INTO public.businesses(id,name,is_demo) VALUES(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Disposable Toast PR1',false);
INSERT INTO public.locations(id,business_id,name) VALUES(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Location A');
SELECT public.toast_save_configuration(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','https://ws-api.toasttab.com','test','not-a-secret',
 '[{"location_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001",
 "restaurant_guid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01"}]'::jsonb);
UPDATE public.toast_location_mappings SET verified_at=now(),toast_time_zone='America/Los_Angeles',closeout_hour=4,
 toast_start_date='2026-10-16'
 WHERE business_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
INSERT INTO public.toast_sync_runs(id,business_id,restaurant_guid,kind)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa00e1','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01','daily'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa00e2','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01','daily'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa00e3','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01','daily');
SELECT public.toast_stage_day_page(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa00e1','2026-10-16',1,'[]'::jsonb);
SELECT pg_temp.assert((SELECT next_page_missing=1 FROM
 (SELECT CASE WHEN count(*)=1 THEN 1 ELSE 0 END AS next_page_missing FROM toast_day_pages) x),
 'durable page checkpoint');
SELECT public.toast_import_day(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01','2026-10-16',
 '[{"posOrderId":"toast:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa1234",
 "closedAt":"2026-10-17T02:00:00Z","grossSalesCents":1200,"discountsCents":200,"refundsCents":0,
 "taxCents":40,"tipCents":100,"netSalesCents":1000,"lines":[{"posItemId":null,"name":"Coffee",
 "quantity":1,"netSalesCents":1000,"modifiers":[],"voided":false}]}]'::jsonb,
 '{"net_sales_cents":1000,"order_count":1,"gross_sales_cents":1200,
 "discounts_cents":200,"refunds_cents":0,"tax_cents":40,"tip_cents":100,
 "open_check_count":1,"service_charges_cents":0,"gratuity_cents":0,
 "unparsed_count":0,"warnings":{},"voids":[{"selection_guid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa3333",
 "order_guid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa1234",
 "check_guid":null,"order_business_date":"2026-10-16","void_business_date":"2026-10-17",
 "voided_at":null,"amount_cents":450,"amount_basis":"price","void_reason_guid":null,"level":"selection"}],
 "refund_facts":[],"unparsed":[],"snapshot_sha256":"test"}'::jsonb,
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa00e1');
SELECT pg_temp.assert((SELECT net_sales_cents=1000 AND sales_data_status='actual' AND voids_status='unknown'
 FROM public.daily_rollups WHERE business_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
 AND business_date='2026-10-16'),'atomic day rollup, no unearned void completeness');
SELECT pg_temp.assert((SELECT count(*)=1 FROM public.toast_void_facts WHERE
 void_business_date='2026-10-17'),'later-day void attribution');
SELECT pg_temp.assert((SELECT count(*)=1 FROM public.order_lines
 WHERE net_sales_cents=1000),'line imported');
SELECT public.toast_import_day(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01','2026-10-16',
 '[{"posOrderId":"toast:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa1234",
 "closedAt":"2026-10-17T02:00:00Z","grossSalesCents":1200,"discountsCents":200,"refundsCents":0,
 "taxCents":40,"tipCents":100,"netSalesCents":1000,"lines":[{"posItemId":null,"name":"Coffee",
 "quantity":1,"netSalesCents":1000,"modifiers":[],"voided":false}]}]'::jsonb,
 '{"net_sales_cents":1000,"order_count":1,"gross_sales_cents":1200,
 "discounts_cents":200,"refunds_cents":0,"tax_cents":40,"tip_cents":100,
 "open_check_count":1,"service_charges_cents":0,"gratuity_cents":0,"unparsed_count":0,
 "warnings":{},"voids":[],"refund_facts":[],"unparsed":[],"snapshot_sha256":"test"}'::jsonb,
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa00e2');
SELECT pg_temp.assert((SELECT count(*)=1 FROM public.orders WHERE business_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
 AND pos_order_id like 'toast:%'),'idempotent order upsert');
SELECT pg_temp.assert((SELECT count(*)=0 FROM public.toast_order_revisions),'unchanged day creates no revisions');
SELECT public.toast_import_day(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01','2026-10-16','[]'::jsonb,
 '{"net_sales_cents":0,"order_count":0,"gross_sales_cents":0,"discounts_cents":0,
 "refunds_cents":0,"tax_cents":0,"tip_cents":0,"open_check_count":0,
 "service_charges_cents":0,"gratuity_cents":0,"unparsed_count":1,
 "warnings":{"unparsed_orders":1},"voids":[],"refund_facts":[],
 "unparsed":[{"business_date":"2026-10-16","order_guid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa1234",
 "error_path":"checks.0.amount","raw_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],
 "snapshot_sha256":"new"}'::jsonb,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa00e3');
SELECT pg_temp.assert((SELECT net_sales_cents=1000 AND sales_data_status='missing'
 FROM public.daily_rollups WHERE business_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
 AND business_date='2026-10-16'),'unparsed page retains old orders and fails closed');
SELECT pg_temp.assert((SELECT recon_state='mismatch' FROM public.toast_day_status
 WHERE business_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
 AND business_date='2026-10-16'),'unparsed orders flagged mismatch');
ROLLBACK;
