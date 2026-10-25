\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert(ok boolean,msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Toast H: %',msg;END IF;END $$;
CREATE FUNCTION pg_temp.reject(statement text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 BEGIN EXECUTE statement;EXCEPTION WHEN OTHERS THEN RETURN;END;
 RAISE EXCEPTION 'Expected rejection: %',statement;
END $$;
SELECT set_config('request.jwt.claim.role','service_role',true);
INSERT INTO auth.users(id,email) VALUES
('dddddddd-dddd-4ddd-8ddd-dddddddd0011','toast-h-owner@example.invalid'),
('dddddddd-dddd-4ddd-8ddd-dddddddd0012','toast-h-manager@example.invalid'),
('dddddddd-dddd-4ddd-8ddd-dddddddd0013','toast-h-other@example.invalid');
INSERT INTO public.businesses(id,name,is_demo) VALUES
('dddddddd-dddd-4ddd-8ddd-dddddddddddd','Toast H owner',false),
('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','Toast H other',false);
INSERT INTO public.memberships(business_id,user_id,role) VALUES
('dddddddd-dddd-4ddd-8ddd-dddddddddddd','dddddddd-dddd-4ddd-8ddd-dddddddd0011','owner'),
('dddddddd-dddd-4ddd-8ddd-dddddddddddd','dddddddd-dddd-4ddd-8ddd-dddddddd0012','manager'),
('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','dddddddd-dddd-4ddd-8ddd-dddddddd0013','owner');
INSERT INTO public.locations(id,business_id,name) VALUES
('dddddddd-dddd-4ddd-8ddd-dddddddd0001','dddddddd-dddd-4ddd-8ddd-dddddddddddd','H Main');
SELECT public.toast_save_configuration('dddddddd-dddd-4ddd-8ddd-dddddddddddd',
 'https://ws-api.toasttab.com','h-client','not-a-real-secret',
 '[{"location_id":"dddddddd-dddd-4ddd-8ddd-dddddddd0001","restaurant_guid":"dddddddd-dddd-4ddd-8ddd-dddddddd0002"}]');
UPDATE public.toast_location_mappings SET verified_at=now(),toast_time_zone='Pacific/Kiritimati',closeout_hour=4
 WHERE business_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
INSERT INTO public.toast_day_status(business_id,restaurant_guid,business_date,import_state,
 coverage_complete,recon_state,imported_at,net_sales_cents,order_count,unparsed_count)
 SELECT 'dddddddd-dddd-4ddd-8ddd-dddddddddddd','dddddddd-dddd-4ddd-8ddd-dddddddd0002',d,
 'imported',true,'checked_internal',now(),123456,210,0
 FROM unnest(array['2026-10-01'::date,'2026-10-02'::date,'2026-10-03'::date]) d;
INSERT INTO public.toast_sync_runs(business_id,restaurant_guid,kind,state,finished_at,orders_unparsed)
 VALUES('dddddddd-dddd-4ddd-8ddd-dddddddddddd','dddddddd-dddd-4ddd-8ddd-dddddddd0002','daily','completed',now(),1);
SELECT pg_temp.assert((SELECT not stale FROM public.toast_sync_health_v
 WHERE business_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'),'one unreadable order does not make a completed run stale');
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.toast_owner_summary_entries','INSERT'),'direct member writes denied');
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.toast_client_budgets','SELECT'),'operational budget private');
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.memberships','SELECT'),'summary RLS does not require membership table grants');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','dddddddd-dddd-4ddd-8ddd-dddddddd0011',true);
SELECT public.toast_save_owner_summary('dddddddd-dddd-4ddd-8ddd-dddddddddddd','dddddddd-dddd-4ddd-8ddd-dddddddd0002','2026-10-01',123456,210,null,null,null,'typed',5);
SELECT public.toast_save_owner_summary('dddddddd-dddd-4ddd-8ddd-dddddddddddd','dddddddd-dddd-4ddd-8ddd-dddddddd0002','2026-10-02',123460,210,null,null,null,'csv',5);
SELECT public.toast_save_owner_summary('dddddddd-dddd-4ddd-8ddd-dddddddddddd','dddddddd-dddd-4ddd-8ddd-dddddddd0002','2026-10-03',127456,210,null,null,null,'photo',5);
SELECT pg_temp.assert((SELECT count(*)=2 FROM public.toast_owner_summary_entries WHERE comparison='owner_summary_match'),'same tolerance gives two matches');
SELECT pg_temp.assert((SELECT delta_net_cents=4000 FROM public.toast_owner_summary_entries WHERE business_date='2026-10-03'),'40 dollar difference stored as integer cents');
SELECT pg_temp.assert((public.toast_check_evidence('dddddddd-dddd-4ddd-8ddd-dddddddddddd')->>'matched')::integer=2,'evidence counts match entries');
SELECT set_config('request.jwt.claim.sub','dddddddd-dddd-4ddd-8ddd-dddddddd0012',true);
SELECT pg_temp.assert((SELECT count(*)=3 FROM public.toast_owner_summary_entries),'member can read own café summaries');
SELECT pg_temp.reject($q$SELECT public.toast_save_owner_summary('dddddddd-dddd-4ddd-8ddd-dddddddddddd','dddddddd-dddd-4ddd-8ddd-dddddddd0002','2026-10-01',1,null,null,null,null,'typed',5)$q$);
SELECT set_config('request.jwt.claim.sub','dddddddd-dddd-4ddd-8ddd-dddddddd0013',true);
SELECT pg_temp.assert((SELECT count(*)=0 FROM public.toast_owner_summary_entries),'other café cannot read entries');
SELECT pg_temp.reject($q$SELECT public.toast_check_evidence('dddddddd-dddd-4ddd-8ddd-dddddddddddd')$q$);
RESET ROLE;
UPDATE public.businesses SET is_demo=true WHERE id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','dddddddd-dddd-4ddd-8ddd-dddddddd0011',true);
SELECT pg_temp.reject($q$SELECT public.toast_save_owner_summary('dddddddd-dddd-4ddd-8ddd-dddddddddddd','dddddddd-dddd-4ddd-8ddd-dddddddd0002','2026-10-01',1,null,null,null,null,'typed',5)$q$);
RESET ROLE;
UPDATE public.businesses SET is_demo=false WHERE id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
SELECT set_config('request.jwt.claim.role','service_role',true);
-- A repull updates the comparison, never the owner's values or timestamp.
UPDATE public.toast_day_status SET net_sales_cents=127456,imported_at=now()+interval '1 second'
 WHERE business_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd' AND business_date='2026-10-03';
SELECT pg_temp.assert((SELECT net_sales_cents=127456 AND source='photo' AND comparison='owner_summary_match'
 FROM public.toast_owner_summary_entries WHERE business_date='2026-10-03'),'repull preserves owner values and refreshes comparison');
SELECT pg_temp.assert((SELECT days_needing_look=0 FROM public.toast_owner_attention_counts_v
 WHERE business_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'),'repull clears mismatch from shared attention count');
UPDATE public.toast_day_status SET unparsed_count=1 WHERE business_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd' AND business_date='2026-10-01';
SELECT pg_temp.assert((SELECT days_needing_look=1 FROM public.toast_owner_attention_counts_v
 WHERE business_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'),'unreadable day is counted once');
UPDATE public.toast_location_mappings SET closeout_hour=5 WHERE business_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
SELECT pg_temp.assert((SELECT count(*)=3 FROM public.toast_day_status WHERE business_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'
 AND coverage_complete AND import_state='imported' AND rechecking_reason='closeout_changed'),'closeout preserves all three imports');
SELECT pg_temp.assert((SELECT days_needing_look=1 FROM public.toast_owner_attention_counts_v WHERE business_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'),'closeout does not add all days to attention');
-- Official mode requires independent, still-verified Analytics credentials.
SELECT pg_temp.assert(NOT public.toast_enable_official_check('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
 'missing Analytics credentials may not select official mode');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT pg_temp.reject($q$SELECT public.toast_enable_official_check('dddddddd-dddd-4ddd-8ddd-dddddddddddd')$q$);
RESET ROLE;
SELECT set_config('request.jwt.claim.role','service_role',true);
INSERT INTO public.toast_analytics_credentials(business_id,management_group_guid,api_origin,client_id,client_secret_enc,verified_at)
 VALUES('dddddddd-dddd-4ddd-8ddd-dddddddddddd','dddddddd-dddd-4ddd-8ddd-dddddddd0002','https://ws-api.toasttab.com','analytics-test','encrypted-test',now());
SELECT pg_temp.assert(public.toast_enable_official_check('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
 'valid separate Analytics credentials may enable official mode');
SELECT pg_temp.assert((SELECT toast_check_mode='official' FROM public.toast_api_credentials
 WHERE business_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'),'official mode persisted');
-- Shared client: both callers see one cooldown; a different client is unaffected.
SELECT public.toast_claim_client_budget(repeat('a',64),now()+interval '10 minutes');
SELECT pg_temp.assert(public.toast_claim_client_budget(repeat('a',64))>now(),'same client shares 429 cooldown');
SELECT pg_temp.assert(public.toast_claim_client_budget(repeat('b',64)) is null,'different client unaffected');
INSERT INTO public.toast_client_budgets(client_hash,calls) VALUES(repeat('c',64),array_fill(clock_timestamp(),array[20]));
SELECT pg_temp.assert(public.toast_claim_client_budget(repeat('c',64))>now(),'20-per-second bound');
INSERT INTO public.toast_client_budgets(client_hash,calls) VALUES(repeat('d',64),array_fill(now()-interval '2 minutes',array[10000]));
SELECT pg_temp.assert(public.toast_claim_client_budget(repeat('d',64))>now(),'10000-per-15-minutes bound');
ROLLBACK;
