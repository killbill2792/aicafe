-- POS0b disposable-database regression: this file must be invoked explicitly by
-- an owner-authorized CI step; merely committing it is NOT execution proof.
-- All values synthetic; never connect this script to a real Supabase project.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.pos0b_assert(ok boolean, reason text) RETURNS void
 LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'POS0b test: %',reason; END IF;
 END $$;
SELECT pg_temp.pos0b_assert(
 to_regprocedure('public.toast_stage_labor_entries(uuid,uuid,uuid,jsonb)') IS NOT NULL,
 'existing authorized attendance writer must remain registered');
SELECT pg_temp.pos0b_assert(
 to_regprocedure('public.pos_import_toast_attendance(uuid,uuid)') IS NOT NULL,
 'existing canonical attendance importer must remain registered');
SELECT pg_temp.pos0b_assert(
 (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname='toast_labor_entries'),
 'labor staging must keep RLS');
SELECT pg_temp.pos0b_assert(
 NOT has_function_privilege('authenticated',
  'public.toast_stage_labor_entries(uuid,uuid,uuid,jsonb)','EXECUTE'),
 'regular users cannot mutate the labor stage');

INSERT INTO public.businesses(id,name,is_demo) VALUES
 ('dddddddd-dddd-4ddd-8ddd-dddddddddd01','POS0b synthetic café',false);
INSERT INTO public.locations(id,business_id,name) VALUES
 ('dddddddd-dddd-4ddd-8ddd-dddddddddd02',
  'dddddddd-dddd-4ddd-8ddd-dddddddddd01','Synthetic location');
SELECT public.toast_save_configuration(
 'dddddddd-dddd-4ddd-8ddd-dddddddddd01','https://ws-api.toasttab.com',
 'synthetic_client_id','synthetic_encrypted_secret',
 '[{"location_id":"dddddddd-dddd-4ddd-8ddd-dddddddddd02",
 "restaurant_guid":"dddddddd-dddd-4ddd-8ddd-dddddddddd03"}]'::jsonb);
UPDATE public.toast_location_mappings SET verified_at=now()
 WHERE business_id='dddddddd-dddd-4ddd-8ddd-dddddddddd01'
 AND restaurant_guid='dddddddd-dddd-4ddd-8ddd-dddddddddd03';

CREATE TEMP TABLE pos0b_test_payload(row jsonb) ON COMMIT DROP;
INSERT INTO pos0b_test_payload VALUES (jsonb_build_object(
 'external_time_entry_id','dddddddd-dddd-4ddd-8ddd-dddddddddd04',
 'external_employee_id','dddddddd-dddd-4ddd-8ddd-dddddddddd05',
 'clock_in','2026-11-09T10:00:00Z','clock_out','2026-11-09T12:00:00Z',
 'hourly_wage_cents',null,'wage_status','missing','breaks','[]'::jsonb,
 'provider_regular_hours',2,'provider_overtime_hours',0,
 'deleted',false,'provider_modified_at','2026-11-09T13:00:00Z'
));

SELECT pg_temp.pos0b_assert(
 (SELECT public.toast_stage_labor_entries(
  'dddddddd-dddd-4ddd-8ddd-dddddddddd01',
  'dddddddd-dddd-4ddd-8ddd-dddddddddd03',
  'dddddddd-dddd-4ddd-8ddd-dddddddddd02',jsonb_build_array(row))
 FROM pos0b_test_payload)=1,'first permitted time entry must insert');
SELECT pg_temp.pos0b_assert(
 (SELECT public.toast_stage_labor_entries(
  'dddddddd-dddd-4ddd-8ddd-dddddddddd01',
  'dddddddd-dddd-4ddd-8ddd-dddddddddd03',
  'dddddddd-dddd-4ddd-8ddd-dddddddddd02',jsonb_build_array(row))
 FROM pos0b_test_payload)=0,'identical replay must not rewrite staged entry');
SELECT pg_temp.pos0b_assert(
 (SELECT count(*)=1 FROM public.toast_raw_records
  WHERE business_id='dddddddd-dddd-4ddd-8ddd-dddddddddd01'
  AND restaurant_guid='dddddddd-dddd-4ddd-8ddd-dddddddddd03'
  AND entity='time_entry'
  AND entity_guid='dddddddd-dddd-4ddd-8ddd-dddddddddd04'),
 'identical replay must not generate another archive snapshot');

SELECT pg_temp.pos0b_assert(
 (SELECT public.toast_stage_labor_entries(
  'dddddddd-dddd-4ddd-8ddd-dddddddddd01',
  'dddddddd-dddd-4ddd-8ddd-dddddddddd03',
  'dddddddd-dddd-4ddd-8ddd-dddddddddd02',
  jsonb_build_array(row||'{"clock_out":"2026-11-09T09:00:00Z",
   "provider_modified_at":"2026-11-08T13:00:00Z"}'::jsonb))
 FROM pos0b_test_payload)=0,'older modified-date revision cannot overwrite newest');

SELECT pg_temp.pos0b_assert(
 (SELECT public.toast_stage_labor_entries(
  'dddddddd-dddd-4ddd-8ddd-dddddddddd01',
  'dddddddd-dddd-4ddd-8ddd-dddddddddd03',
  'dddddddd-dddd-4ddd-8ddd-dddddddddd02',
  jsonb_build_array(row||'{"clock_out":"2026-11-09T13:00:00Z",
   "breaks":[{"start":"2026-11-09T11:00:00Z","end":"2026-11-09T11:15:00Z","paid":false}],
   "provider_modified_at":"2026-11-09T14:00:00Z"}'::jsonb))
 FROM pos0b_test_payload)=1,'genuine newer clock/break revision must update');
SELECT pg_temp.pos0b_assert(
 (SELECT hourly_wage_cents IS NULL AND wage_status='missing' AND
  clock_out='2026-11-09T13:00:00Z'::timestamptz AND
  jsonb_array_length(breaks)=1
 FROM public.toast_labor_entries
 WHERE business_id='dddddddd-dddd-4ddd-8ddd-dddddddddd01'
 AND restaurant_guid='dddddddd-dddd-4ddd-8ddd-dddddddddd03'
 AND external_time_entry_id='dddddddd-dddd-4ddd-8ddd-dddddddddd04'),
 'preserve missing wage as NULL while retaining revised clock and break');
SELECT pg_temp.pos0b_assert(
 (SELECT public.toast_stage_labor_entries(
  'dddddddd-dddd-4ddd-8ddd-dddddddddd01',
  'dddddddd-dddd-4ddd-8ddd-dddddddddd03',
  'dddddddd-dddd-4ddd-8ddd-dddddddddd02',
  jsonb_build_array(row||'{"clock_out":"2026-11-09T13:00:00Z",
   "breaks":[{"start":"2026-11-09T11:00:00Z","end":"2026-11-09T11:15:00Z","paid":false}],
   "provider_modified_at":"2026-11-09T14:00:00Z"}'::jsonb))
 FROM pos0b_test_payload)=0,'replay of same revision is not another change');
DO $pos0b_negative$
BEGIN
 BEGIN
  PERFORM public.toast_stage_labor_entries(
   'dddddddd-dddd-4ddd-8ddd-dddddddddd01',
   'dddddddd-dddd-4ddd-8ddd-dddddddddd99',
   'dddddddd-dddd-4ddd-8ddd-dddddddddd02',
   (SELECT jsonb_build_array(row) FROM pos0b_test_payload));
  RAISE EXCEPTION 'wrong restaurant mapping was accepted';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='wrong restaurant mapping was accepted' THEN RAISE; END IF;
 END;
END $pos0b_negative$;
ROLLBACK;
