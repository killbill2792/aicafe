\set ON_ERROR_STOP on
-- LDI E: REAL PostgreSQL/RLS/RPC verification on disposable local Supabase.
-- Transaction rolls back all synthetic businesses, users and event facts.
BEGIN;
SELECT gen_random_uuid() AS business_a,gen_random_uuid() AS business_b,
  gen_random_uuid() AS owner_a,gen_random_uuid() AS owner_b,
  gen_random_uuid() AS cafe_event_a,gen_random_uuid() AS cafe_event_b \gset
INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
VALUES
 (:'owner_a','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'ldi-e-owner-a@example.invalid','',now(),now()),
 (:'owner_b','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'ldi-e-owner-b@example.invalid','',now(),now());
INSERT INTO public.businesses(id,name,timezone,is_demo)
VALUES
 (:'business_a','LDI E disposable café A','America/Los_Angeles',false),
 (:'business_b','LDI E disposable café B','America/Los_Angeles',false);
INSERT INTO public.memberships(business_id,user_id,role)
VALUES (:'business_a',:'owner_a','owner'),(:'business_b',:'owner_b','owner');

SET LOCAL ROLE service_role;
-- Source URL + same dated name anchor initial identity without a venue.
SELECT public.ldi_upsert_city_event(
 'us|ca|example',repeat('a',64),repeat('a',64),NULL,
 'Civic Fair','other','2026-11-04','2026-11-04',
 'https://city.example.org/events/civic-fair','2026-11-03T10:00:00Z',
 NULL,NULL,NULL,NULL) AS city_id \gset
SELECT set_config('test.ldi.city',:'city_id',true);
SELECT public.ldi_upsert_city_event(
 'us|ca|example',repeat('a',64),repeat('a',64),NULL,
 'Civic Fair','other','2026-11-04','2026-11-04',
 'https://city.example.org/events/civic-fair','2026-11-03T11:00:00Z',
 NULL,NULL,NULL,NULL) AS replay_id \gset
DO $check$
BEGIN
 IF current_setting('test.ldi.city')::uuid<>current_setting('test.ldi.replay')::uuid THEN
  RAISE EXCEPTION 'A idempotent event RPC changed the public event UUID';
 END IF;
END $check$;
-- Same source becomes more detailed. Corroborated venue+address permits A's
-- strong cross-source alias; a new event URL cannot be conflated by title alone.
SELECT public.ldi_upsert_city_event(
 'us|ca|example',repeat('b',64),repeat('a',64),repeat('b',64),
 'Civic Fair','other','2026-11-04','2026-11-04',
 'https://city.example.org/events/civic-fair','2026-11-03T12:00:00Z',
 'Civic Hall','20 Main St','civic hall','20 main st') AS enriched_id \gset
SELECT public.ldi_upsert_city_event(
 'us|ca|example',repeat('b',64),repeat('c',64),repeat('b',64),
 'Civic Fair','other','2026-11-04','2026-11-04',
 'https://hall.example.org/calendar/fair','2026-11-03T13:00:00Z',
 'Civic Hall','20 Main St','civic hall','20 main st') AS second_source_id \gset
SELECT set_config('test.ldi.enriched',:'enriched_id',true);
SELECT set_config('test.ldi.second',:'second_source_id',true);
DO $check$
BEGIN
 IF current_setting('test.ldi.city')::uuid<>current_setting('test.ldi.enriched')::uuid
 OR current_setting('test.ldi.city')::uuid<>current_setting('test.ldi.second')::uuid
 OR (SELECT count(*) FROM public.city_event_sources
  WHERE city_event_id=current_setting('test.ldi.city')::uuid)<>2
 OR (SELECT count(*) FROM public.city_event_aliases
  WHERE city_event_id=current_setting('test.ldi.city')::uuid)<>3
 THEN RAISE EXCEPTION 'A strong corroboration did not reconcile two URLs'; END IF;
END $check$;
-- Distinct URL without corroborated venue remains a separate public fact.
SELECT public.ldi_upsert_city_event(
 'us|ca|example',repeat('d',64),repeat('d',64),NULL,
 'Civic Fair','other','2026-11-04','2026-11-04',
 'https://other.example.org/civic-fair','2026-11-03T13:00:00Z',
 NULL,NULL,NULL,NULL) AS unconfirmed_id \gset
DO $check$
BEGIN
 IF current_setting('test.ldi.city')::uuid=:'unconfirmed_id'::uuid
 OR (SELECT count(*) FROM public.city_events WHERE city_key='us|ca|example')<>2
 THEN RAISE EXCEPTION 'A merged two unrelated source-only event URLs'; END IF;
END $check$;

-- LDI E's root queue and migration 138's repaired RPC must coexist.
INSERT INTO public.city_source_coverage(
 city_key,source_key,window_from,window_to,scan_from,scan_to,
 window_reason,status,search_attempted,is_scan_root,last_checked_at)
VALUES ('us|ca|example','category:city-calendar','2026-11-03','2026-11-09',
 '2026-11-03','2026-11-16','initial','partial',false,true,'2026-11-03T09:00:00Z');
SELECT public.ldi_record_city_coverage(
 'us|ca|example','category:city-calendar','2026-11-03','2026-11-09',
 'found','2026-11-03T10:00:00Z');
SELECT public.ldi_record_city_coverage(
 'us|ca|example','category:city-calendar','2026-11-03','2026-11-09',
 'failed','2026-11-03T11:00:00Z');
-- Unqueued B sub-window has valid NONNULL scan bounds, non-root identity.
SELECT public.ldi_record_city_coverage(
 'us|ca|example','category:city-calendar','2026-11-03','2026-11-06',
 'none_found','2026-11-03T12:00:00Z');
DO $check$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.city_source_coverage
   WHERE city_key='us|ca|example' AND source_key='category:city-calendar'
     AND window_from='2026-11-03' AND window_to='2026-11-09'
     AND is_scan_root AND search_attempted AND status='failed'
     AND scan_from='2026-11-03' AND scan_to='2026-11-16'
     AND last_completed_at='2026-11-03T10:00:00Z')
 OR NOT EXISTS(SELECT 1 FROM public.city_source_coverage
   WHERE city_key='us|ca|example' AND source_key='category:city-calendar'
     AND window_from='2026-11-03' AND window_to='2026-11-06'
     AND scan_from='2026-11-03' AND scan_to='2026-11-06'
     AND NOT is_scan_root AND status='none_found')
 THEN RAISE EXCEPTION 'LDI E coverage root/child, failure or retry semantics wrong'; END IF;
END $check$;

-- Preserve original cafe_event UUIDs and owner decisions via guarded link RPC.
INSERT INTO public.cafe_events(id,business_id,name,kind,start_date,end_date,source_url,status)
VALUES
 (:'cafe_event_a',:'business_a','Civic Fair','other',
  '2026-11-04','2026-11-06','https://city.example.org/events/civic-fair','cancelled'),
 (:'cafe_event_b',:'business_b','Civic Fair','other',
  '2026-11-04','2026-11-04','https://city.example.org/events/civic-fair','found');
SELECT public.ldi_link_cafe_event(:'business_a'::uuid,:'cafe_event_a'::uuid,:'city_id'::uuid);
SELECT public.ldi_link_cafe_event(:'business_b'::uuid,:'cafe_event_b'::uuid,:'city_id'::uuid);
SELECT public.ldi_link_cafe_event(:'business_a'::uuid,:'cafe_event_a'::uuid,:'city_id'::uuid);

SELECT public.ldi_upsert_cafe_neighborhood(
 :'business_a'::uuid,'us|ca|example',repeat('f',64),
 'Civic Hall','convention','20 Main St','https://hall.example.org/about',
 'https://hall.example.org/calendar','2026-11-03T10:00:00Z',
 'potential','Café A owner-specific theory') AS place_a \gset
SELECT public.ldi_upsert_cafe_neighborhood(
 :'business_b'::uuid,'us|ca|example',repeat('f',64),
 'Civic Hall','convention','20 Main St','https://hall.example.org/about',
 'https://hall.example.org/calendar','2026-11-03T10:00:00Z',
 'unknown','Café B has no confirmed impact') AS place_b \gset
SELECT set_config('test.ldi.place_a',:'place_a',true);
SELECT set_config('test.ldi.place_b',:'place_b',true);
INSERT INTO public.cafe_neighborhood_source_coverage(
 business_id,scope,address_hash,status,retry_eligible,checked_at)
VALUES
 (:'business_a','campus_and_conventions',repeat('1',64),'found',false,'2026-11-03T10:00:00Z'),
 (:'business_b','campus_and_conventions',repeat('2',64),'failed',true,'2026-11-03T10:00:00Z');

DO $check$
BEGIN
 IF current_setting('test.ldi.place_a')<>current_setting('test.ldi.place_b')
 OR (SELECT count(*) FROM public.cafe_city_event_links
      WHERE city_event_id=current_setting('test.ldi.city')::uuid)<>2
 OR (SELECT count(*) FROM public.cafe_events WHERE status='cancelled'
      AND id=:'cafe_event_a'::uuid)<>1
 THEN RAISE EXCEPTION 'shared event/place identity or legacy owner status corrupt'; END IF;
END $check$;

-- Authenticate owner A: shared sourced city facts visible, never café B
-- associations, hypotheses, scope coverage or owner decisions.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'owner_a',true);
DO $check$
BEGIN
 IF (SELECT count(*) FROM public.city_events WHERE city_key='us|ca|example')<>2
 OR (SELECT count(*) FROM public.city_places WHERE city_key='us|ca|example')<>1
 OR (SELECT count(*) FROM public.cafe_city_event_links)<>1
 OR (SELECT count(*) FROM public.cafe_neighborhood_evidence)<>1
 OR (SELECT count(*) FROM public.cafe_neighborhood_source_coverage)<>1
 OR (SELECT count(*) FROM public.cafe_neighborhood_evidence
     WHERE rationale='Café B has no confirmed impact')<>0
 OR (SELECT count(*) FROM public.cafe_events WHERE status='cancelled')<>1
 OR has_function_privilege('authenticated',
   'public.ldi_upsert_city_event(text,text,text,text,text,text,date,date,text,timestamptz,text,text,text,text)',
   'EXECUTE')
 THEN RAISE EXCEPTION 'owner A RLS/private source separation or RPC grants failed'; END IF;
END $check$;
SELECT set_config('request.jwt.claim.sub',:'owner_b',true);
DO $check$
BEGIN
 IF (SELECT count(*) FROM public.cafe_city_event_links)<>1
 OR (SELECT count(*) FROM public.cafe_neighborhood_evidence)<>1
 OR (SELECT count(*) FROM public.cafe_neighborhood_source_coverage)<>1
 OR (SELECT count(*) FROM public.cafe_events WHERE status='cancelled')<>0
 OR (SELECT count(*) FROM public.cafe_neighborhood_evidence
     WHERE rationale='Café B has no confirmed impact')<>1
 THEN RAISE EXCEPTION 'owner B read owner A private decisions'; END IF;
END $check$;
ROLLBACK;
