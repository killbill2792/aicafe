-- Run on disposable local Supabase after migrations. Real PostgreSQL RPC assertions.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(v boolean, note text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
 IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'TOAST RAW SAMPLE TEST FAILED: %',note; END IF;
END $$;

SELECT pg_temp.assert_true(
 to_regprocedure('public.toast_claim_raw_sample(uuid,uuid,date)') IS NOT NULL,
 'correct UUID RPC signature exists');
SELECT pg_temp.assert_true(
 to_regprocedure('public.toast_claim_raw_sample(uuid,text,date)') IS NULL,
 'obsolete text RPC signature absent');
SELECT pg_temp.assert_true(
 NOT has_function_privilege('anon','public.toast_claim_raw_sample(uuid,uuid,date)','EXECUTE'),
 'anon cannot claim');
SELECT pg_temp.assert_true(
 NOT has_function_privilege('authenticated','public.toast_claim_raw_sample(uuid,uuid,date)','EXECUTE'),
 'authenticated cannot claim');
SELECT pg_temp.assert_true(
 has_function_privilege('service_role','public.toast_claim_raw_sample(uuid,uuid,date)','EXECUTE'),
 'service role can claim');
SELECT pg_temp.assert_true(
 NOT has_table_privilege('anon','public.toast_raw_samples','SELECT'),
 'anon cannot read samples');
SELECT pg_temp.assert_true(
 NOT has_table_privilege('authenticated','public.toast_raw_samples','INSERT'),
 'authenticated cannot write samples');

INSERT INTO public.businesses(id,name,is_demo) VALUES
 ('acacacac-acac-4cac-8cac-acacacacac01','Raw sample test A',false),
 ('bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbc02','Raw sample test B',false);
INSERT INTO public.locations(id,business_id,name) VALUES
 ('acacacac-acac-4cac-8cac-acacacacac11','acacacac-acac-4cac-8cac-acacacacac01','A'),
 ('bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbc12','bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbc02','B');
SELECT public.toast_save_configuration(
 'acacacac-acac-4cac-8cac-acacacacac01','https://ws-api.toasttab.com',
 'sample_test_a','fake_encrypted_credential',
 '[{"location_id":"acacacac-acac-4cac-8cac-acacacacac11","restaurant_guid":"acacacac-acac-4cac-8cac-acacacacac21"}]'::jsonb);
SELECT public.toast_save_configuration(
 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbc02','https://ws-api.toasttab.com',
 'sample_test_b','fake_encrypted_credential',
 '[{"location_id":"bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbc12","restaurant_guid":"bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbc22"}]'::jsonb);
UPDATE public.toast_location_mappings SET verified_at=now()
 WHERE business_id='acacacac-acac-4cac-8cac-acacacacac01';

SELECT pg_temp.assert_true(
 NOT public.toast_claim_raw_sample(
  'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbc02',
  'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbc22','2026-10-20'),
 'unverified mapping cannot claim');
SELECT pg_temp.assert_true(
 NOT public.toast_claim_raw_sample(
  'acacacac-acac-4cac-8cac-acacacacac01',
  'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbc22','2026-10-20'),
 'foreign tenant restaurant cannot claim');
SELECT pg_temp.assert_true(
 public.toast_claim_raw_sample(
  'acacacac-acac-4cac-8cac-acacacacac01',
  'acacacac-acac-4cac-8cac-acacacacac21','2026-10-20'),
 'verified mapping first claim succeeds (real DB function)');
SELECT pg_temp.assert_true(
 NOT public.toast_claim_raw_sample(
  'acacacac-acac-4cac-8cac-acacacacac01',
  'acacacac-acac-4cac-8cac-acacacacac21','2026-10-21'),
 'same business cooldown rejects second claim even for another date');

UPDATE public.toast_location_mappings SET verified_at=now()
 WHERE business_id='bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbc02';
SELECT pg_temp.assert_true(
 public.toast_claim_raw_sample(
  'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbc02',
  'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbc22','2026-10-20'),
 'other tenant may claim independently');
SELECT pg_temp.assert_true(
 (SELECT count(*)=2 FROM public.toast_raw_samples WHERE endpoint='__capture__'),
 'only two cooldown rows persisted');
SELECT pg_temp.assert_true(
 (SELECT count(*)=1 FROM public.toast_raw_samples
  WHERE business_id='acacacac-acac-4cac-8cac-acacacacac01'
   AND restaurant_guid='acacacac-acac-4cac-8cac-acacacacac21'
   AND business_date='2026-10-20' AND http_status=202
   AND item_count=0 AND sample='{}'::jsonb AND field_paths=array[]::text[]),
 'correct scoped marker row persisted');
ROLLBACK;
