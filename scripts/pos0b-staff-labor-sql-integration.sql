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
  jsonb_build_array(row||'{"clock_out":"2026-11-09T11:00:00Z",
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
DO $source_cutover$
DECLARE
 b uuid:='dddddddd-dddd-4ddd-8ddd-dddddddddd01';
 r uuid:='dddddddd-dddd-4ddd-8ddd-dddddddddd03';
 l uuid:='dddddddd-dddd-4ddd-8ddd-dddddddddd02';
 entry uuid:='dddddddd-dddd-4ddd-8ddd-dddddddddd04';
 worker uuid:='dddddddd-dddd-4ddd-8ddd-dddddddddd05';
 clock_ref text:='toast:'||r::text||':'||entry::text;
 body jsonb; prior_hash text; revision bigint;
 observed_at timestamptz:='2026-11-09T15:00:00Z';
 scope jsonb:='{"mode":"incremental","scope":{"query":"fixture"}}';
BEGIN
 SELECT payload_sha256 INTO STRICT prior_hash FROM public.external_records
 WHERE business_id=b AND provider='toast' AND restaurant_guid=r AND entity='time_entry' AND entity_guid=entry;
 body:=jsonb_build_object('guid',entry,'employeeReference',jsonb_build_object('guid',worker),
  'inDate','2026-11-09T10:00:00Z','outDate','2026-11-09T14:00:00Z','hourlyWage',null,
  'regularHours',4,'overtimeHours',0,'breaks','[]'::jsonb);
 revision:=public.external_commit_page(b,'toast',r::text,'labor/v1/timeEntries','modified',0,scope,true,
  jsonb_build_array(jsonb_build_object('key',entry,'payload',body,'updated_at',observed_at)));
 PERFORM public.toast_stage_labor_entries(b,r,l,jsonb_build_array(jsonb_build_object(
  'external_time_entry_id',entry,'external_employee_id',worker,'clock_in','2026-11-09T10:00:00Z',
  'clock_out','2026-11-09T14:00:00Z','hourly_wage_cents',null,'wage_status','missing',
  'provider_regular_hours',4,'provider_overtime_hours',0,'breaks','[]'::jsonb,'deleted',false,
  'provider_modified_at',observed_at)));
 PERFORM pg_temp.pos0b_assert((SELECT payload_sha256=prior_hash FROM public.external_records
  WHERE business_id=b AND provider='toast' AND restaurant_guid=r AND entity='time_entry' AND entity_guid=entry),
  'an exactly matched original eliminates the second stage snapshot');
 INSERT INTO public.timecards(business_id,pos_timecard_id,clock_in,clock_out,hourly_wage_cents,wage_source,
  source_type,source_provider,breaks,provider_regular_hours,provider_overtime_hours,pos_owner_edited)
 VALUES (b,clock_ref,'2026-11-09T10:00:00Z','2026-11-09T14:00:00Z',0,'pos','connected_pos','Toast','[]',4,0,false);
 PERFORM pg_temp.pos0b_assert((SELECT source_proven AND provider_hourly_wage_cents IS NULL AND hourly_wage_cents=0
  FROM public.cv_staff_clock_entries WHERE business_id=b AND pos_timecard_id=clock_ref),
  'the original null wage remains distinguishable from the approved payroll value');
 body:=jsonb_set(body,'{hourlyWage}','0');
 revision:=public.external_commit_page(b,'toast',r::text,'labor/v1/timeEntries','modified',revision,scope,true,
  jsonb_build_array(jsonb_build_object('key',entry,'payload',body,'updated_at',observed_at+interval '1 hour')));
 PERFORM pg_temp.pos0b_assert((SELECT source_proven AND provider_hourly_wage_cents=0
  FROM public.cv_staff_clock_entries WHERE business_id=b AND pos_timecard_id=clock_ref),
  'the same read exposes verified zero as numeric evidence');
 UPDATE public.timecards SET pos_owner_edited=true,wage_source='owner',hourly_wage_cents=1700
 WHERE business_id=b AND pos_timecard_id=clock_ref;
 PERFORM pg_temp.pos0b_assert((SELECT NOT source_proven AND hourly_wage_cents=1700
  FROM public.cv_staff_clock_entries WHERE business_id=b AND pos_timecard_id=clock_ref),
  'original evidence does not replace an independent owner edit');
END $source_cutover$;
ROLLBACK;
