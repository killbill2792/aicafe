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
SELECT set_config('test.ldi.replay',:'replay_id',true);
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
SELECT set_config('test.ldi.unconfirmed',:'unconfirmed_id',true);
DO $check$
BEGIN
 IF current_setting('test.ldi.city')::uuid=current_setting('test.ldi.unconfirmed')::uuid
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
SELECT set_config('test.ldi.cafe_event_a',:'cafe_event_a',true);
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
      AND id=current_setting('test.ldi.cafe_event_a')::uuid)<>1
 THEN RAISE EXCEPTION 'shared event/place identity or legacy owner status corrupt'; END IF;
END $check$;

-- The existing row-clock claim is one conditional UPDATE, with no new
-- lease table. Prove a stale second claim and stale completion cannot win,
-- and the other café remains untouched.
DO $check$
DECLARE winner integer; loser integer; stale integer;
BEGIN
 UPDATE public.cafe_events SET last_verification_attempt_at='2026-11-03T15:00:00Z'
 WHERE id=current_setting('test.ldi.cafe_event_a')::uuid
 AND last_verification_attempt_at IS NULL;
 GET DIAGNOSTICS winner=ROW_COUNT;
 UPDATE public.cafe_events SET last_verification_attempt_at='2026-11-03T15:00:01Z'
 WHERE id=current_setting('test.ldi.cafe_event_a')::uuid
 AND last_verification_attempt_at IS NULL;
 GET DIAGNOSTICS loser=ROW_COUNT;
 UPDATE public.cafe_events SET last_verified_at='2026-11-03T15:00:01Z'
 WHERE id=current_setting('test.ldi.cafe_event_a')::uuid
 AND last_verification_attempt_at='2026-11-03T15:00:01Z';
 GET DIAGNOSTICS stale=ROW_COUNT;
 IF winner<>1 OR loser<>0 OR stale<>0 OR EXISTS(
 SELECT 1 FROM public.cafe_events WHERE id<>current_setting('test.ldi.cafe_event_a')::uuid
 AND source_url='https://city.example.org/events/civic-fair' AND last_verification_attempt_at IS NOT NULL)
 THEN RAISE EXCEPTION 'LDI stale worker claim or cross-cafe verification write'; END IF;
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
RESET ROLE;
SET LOCAL ROLE service_role;
-- Atomic correction: old aliases resolve, new aliases resolve, private UUIDs
-- and original date history survive, and a conflicting edition rolls back.
SELECT public.ldi_correct_occurrence(:'business_a',:'cafe_event_a',:'city_id',
 '2026-11-03T15:00:00Z',jsonb_build_object('previousStatus','cancelled','status','found',
 'verdict','reinstated','verifiedAt','2026-11-03T15:00:00Z','sourceUrl','https://city.example.org/events/civic-fair',
 'statement','Organizer confirms replacement dates','newDate','2026-11-10','newEndDate','2026-11-11'),
 array[repeat('8',64),repeat('9',64)]) AS corrected \gset
SELECT set_config('test.ldi.corrected',:'corrected',true);
SELECT public.ldi_upsert_city_event('us|ca|example',repeat('a',64),repeat('a',64),null,
 'Civic Fair','other','2026-11-04','2026-11-30','https://city.example.org/events/civic-fair',
 '2026-11-03T16:00:00Z',null,null,null,null) AS historical_alias \gset
SELECT set_config('test.ldi.historical_alias',:'historical_alias',true);
SELECT public.ldi_upsert_city_event('us|ca|example',repeat('9',64),repeat('7',64),repeat('9',64),
 'Civic Fair','other','2026-11-10','2026-11-30','https://third.example.org/listing',
 '2026-11-03T17:00:00Z','Civic Hall','20 Main St','civic hall','20 main st') AS moved_source \gset
SELECT set_config('test.ldi.moved_source',:'moved_source',true);
SELECT public.ldi_upsert_city_event('us|ca|example',repeat('7',64),repeat('7',64),null,
 'Civic Fair','other','2026-11-10','2026-11-30','https://third.example.org/listing',
 '2026-11-03T18:00:00Z',null,null,null,null) AS moved_source_replay \gset
SELECT set_config('test.ldi.moved_source_replay',:'moved_source_replay',true);
UPDATE public.city_events SET end_date='2026-11-30'
 WHERE id=current_setting('test.ldi.city')::uuid;
DO $check$
BEGIN
 IF current_setting('test.ldi.corrected')<>'t'
 OR current_setting('test.ldi.historical_alias')<>current_setting('test.ldi.city')
 OR current_setting('test.ldi.moved_source')<>current_setting('test.ldi.city')
 OR current_setting('test.ldi.moved_source_replay')<>current_setting('test.ldi.city')
 OR NOT EXISTS(select 1 from public.city_event_sources where city_event_id=current_setting('test.ldi.city')::uuid
 and source_url='https://third.example.org/listing')
 OR NOT EXISTS(select 1 from public.city_events where id=current_setting('test.ldi.city')::uuid
 and start_date='2026-11-10' and end_date='2026-11-11' and lifecycle->>'status'='found')
 OR (select count(*) from public.cafe_events ce join public.cafe_city_event_links l
 on l.business_id=ce.business_id and l.cafe_event_id=ce.id where l.city_event_id=current_setting('test.ldi.city')::uuid
 and ce.start_date='2026-11-10' and ce.end_date='2026-11-11' and ce.status='found'
 and ce.verification_details->'change'->>'previousStartDate'='2026-11-04')<>2
 OR NOT EXISTS(select 1 from public.city_event_aliases where alias_key=repeat('8',64)
 and city_event_id=current_setting('test.ldi.city')::uuid)
 OR has_function_privilege('authenticated','public.ldi_correct_occurrence(uuid,uuid,uuid,timestamptz,jsonb,text[])','EXECUTE')
 THEN RAISE EXCEPTION 'LDI atomic occurrence correction, history or grants failed'; END IF;
END $check$;
-- New per-date monitor claims share a durable existing ledger, not a second
-- worker queue. Competing proposal ids and stale releases cannot bypass it.
SELECT gen_random_uuid() AS thread_a,gen_random_uuid() AS plan_one,
 gen_random_uuid() AS plan_two,gen_random_uuid() AS token_one,gen_random_uuid() AS token_two \gset
INSERT INTO public.ai_threads(id,business_id,owner_user_id,client_request_id)
 VALUES(:'thread_a',:'business_a',:'owner_a',gen_random_uuid());
INSERT INTO public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,
 capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale)
 VALUES(:'plan_one',:'business_a',:'owner_a',:'thread_a',gen_random_uuid(),'alex.event_readiness.v1',1,'{}',repeat('a',64),'{}','{}','en'),
 (:'plan_two',:'business_a',:'owner_a',:'thread_a',gen_random_uuid(),'alex.event_readiness.v1',1,'{}',repeat('b',64),'{}','{}','en');
SELECT public.ldi_claim_monitor(:'business_a',:'owner_a',:'plan_one','2026-11-10',:'token_one',false) AS won \gset
SELECT public.ldi_claim_monitor(:'business_a',:'owner_a',:'plan_two','2026-11-10',:'token_two',false) AS lost \gset
SELECT public.ldi_release_monitor(:'business_a',:'plan_one','2026-11-10',:'token_two',false);
SELECT public.ldi_claim_monitor(:'business_a',:'owner_a',:'plan_two','2026-11-10',:'token_two',false) AS still_lost \gset
INSERT INTO public.supervisor_monitor_samples(business_id,proposal_id,business_date,observation,evidence_source)
 VALUES(:'business_a',:'plan_one','2026-11-10','{"coverage":"actual","actualCents":10000}','daily_rollups');
SELECT public.ldi_release_monitor(:'business_a',:'plan_one','2026-11-10',:'token_one',false);
SELECT public.ldi_claim_monitor(:'business_a',:'owner_a',:'plan_two','2026-11-10',:'token_two',false) AS claimed_other \gset
SELECT set_config('test.ldi.won',:'won',true),set_config('test.ldi.lost',:'lost',true),
 set_config('test.ldi.still_lost',:'still_lost',true),set_config('test.ldi.claimed_other',:'claimed_other',true),
 set_config('test.ldi.plan_two',:'plan_two',true),set_config('test.ldi.business_a',:'business_a',true);
DO $check$
BEGIN
 IF current_setting('test.ldi.won')<>'t' OR current_setting('test.ldi.lost')<>'f'
 OR current_setting('test.ldi.still_lost')<>'f' OR current_setting('test.ldi.claimed_other')<>'f'
 OR has_function_privilege('authenticated','public.ldi_claim_monitor(uuid,uuid,uuid,date,uuid,boolean)','EXECUTE')
 THEN RAISE EXCEPTION 'LDI monitor claim or grants failed'; END IF;
 BEGIN
 INSERT INTO public.supervisor_monitor_samples(business_id,proposal_id,business_date,observation,evidence_source)
 VALUES(current_setting('test.ldi.business_a')::uuid,current_setting('test.ldi.plan_two')::uuid,
 '2026-11-10','{"coverage":"actual","actualCents":10000}','daily_rollups');
 RAISE EXCEPTION 'overlapping event sample was incorrectly allowed';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $check$;
-- An inactive status-only receipt does not reserve the café's sales day.
INSERT INTO public.supervisor_monitor_samples(business_id,proposal_id,business_date,observation,evidence_source)
 VALUES(:'business_a',:'plan_one','2026-11-11','{"coverage":"event_inactive","eventActivity":"inactive"}','cafe_events');
SELECT public.ldi_claim_monitor(:'business_a',:'owner_a',:'plan_two','2026-11-11',:'token_two',false) AS active_after_inactive \gset
SELECT set_config('test.ldi.active_after_inactive',:'active_after_inactive',true);
INSERT INTO public.supervisor_monitor_samples(business_id,proposal_id,business_date,observation,evidence_source)
 VALUES(:'business_a',:'plan_two','2026-11-11','{"coverage":"actual","actualCents":20000}','daily_rollups');
DO $check$
BEGIN
 IF current_setting('test.ldi.active_after_inactive')<>'t' OR
 (SELECT count(*) FROM public.supervisor_monitor_samples WHERE business_id=current_setting('test.ldi.business_a')::uuid
 AND business_date='2026-11-11' AND observation->>'coverage'='actual')<>1
 THEN RAISE EXCEPTION 'inactive event blocked active cafe-day sales'; END IF;
END $check$;
-- Two claims for one exact preparation or change revision: only the first
-- may run, stale release cannot unlock it, and completed work stays closed.
SELECT public.ldi_claim_event_work(:'business_a',:'owner_a',
 'event-work:assessment:'||:'token_one','2026-11-10',:'token_one') AS work_won \gset
SELECT public.ldi_claim_event_work(:'business_a',:'owner_a',
 'event-work:assessment:'||:'token_one','2026-11-10',:'token_two') AS work_lost \gset
SELECT public.ldi_release_event_work(:'business_a','event-work:assessment:'||:'token_one',:'token_two',false);
SELECT public.ldi_claim_event_work(:'business_a',:'owner_a',
 'event-work:assessment:'||:'token_one','2026-11-10',:'token_two') AS work_still_lost \gset
SELECT public.ldi_release_event_work(:'business_a','event-work:assessment:'||:'token_one',:'token_one',true);
SELECT public.ldi_claim_event_work(:'business_a',:'owner_a',
 'event-work:assessment:'||:'token_one','2026-11-10',:'token_two') AS work_done \gset
SELECT set_config('test.ldi.work_won',:'work_won',true),set_config('test.ldi.work_lost',:'work_lost',true),
 set_config('test.ldi.work_still_lost',:'work_still_lost',true),set_config('test.ldi.work_done',:'work_done',true);
DO $check$
BEGIN
 IF current_setting('test.ldi.work_won')<>'t' OR current_setting('test.ldi.work_lost')<>'f'
 OR current_setting('test.ldi.work_still_lost')<>'f' OR current_setting('test.ldi.work_done')<>'f'
 OR has_function_privilege('authenticated','public.ldi_claim_event_work(uuid,uuid,text,date,uuid)','EXECUTE')
 THEN RAISE EXCEPTION 'LDI duplicate worker paid claim or grant failed'; END IF;
END $check$;
ROLLBACK;
