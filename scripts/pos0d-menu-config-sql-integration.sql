-- POS0d: migrated disposable PostgreSQL ONLY. Source-shaped current publication
-- test; no provider requests, no production effects. Rolls back every fixture.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.pos0d_assert(ok boolean,label text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'POS0d FAIL: %',label;END IF;
END $$;
DO $pos0d$
DECLARE
 b uuid:='f0d00000-0000-4000-8000-000000000001';
 other_b uuid:='f0d00000-0000-4000-8000-000000000002';
 r uuid:='f0d00000-0000-4000-8000-000000000011';
 other_r uuid:='f0d00000-0000-4000-8000-000000000022';
 loc uuid:='f0d00000-0000-4000-8000-000000000111';
 other_loc uuid:='f0d00000-0000-4000-8000-000000000222';
 a uuid:='f0d00000-0000-4000-8000-000000000301';
 gone uuid:='f0d00000-0000-4000-8000-000000000302';
 other_item uuid:='f0d00000-0000-4000-8000-000000000303';
 ing uuid:='f0d00000-0000-4000-8000-000000000401';
 item_a text;item_b text;mod_a text;mod_b text;group_a text;group_b text;
 pairs jsonb;only_a jsonb;observed timestamptz:=now();
 late_observed timestamptz;
 failed boolean;actual jsonb;price_verified boolean;
BEGIN
 item_a:='toast:'||r||':aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 item_b:='toast:'||r||':bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 mod_a:='toast:'||r||':cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 mod_b:='toast:'||r||':dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 group_a:='toast:'||r||':eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 group_b:='toast:'||r||':ffffffff-ffff-4fff-8fff-ffffffffffff';
 pairs:=jsonb_build_array(
  jsonb_build_object('item_pos_id',item_a,'pos_group_id',group_a),
  jsonb_build_object('item_pos_id',item_b,'pos_group_id',group_b));
 only_a:=jsonb_build_array(jsonb_build_object('item_pos_id',item_a,'pos_group_id',group_a));
 INSERT INTO public.businesses(id,name,is_demo) VALUES
 (b,'POS0d ephemeral café',false),(other_b,'POS0d other café',false);
 INSERT INTO public.locations(id,business_id,name) VALUES
 (loc,b,'One'),(other_loc,other_b,'Other');
 INSERT INTO public.toast_api_credentials
 (business_id,api_origin,client_id,client_secret_enc) VALUES
 (b,'https://synthetic.example','fake-client-a','test-only-encrypted'),
 (other_b,'https://synthetic.example','fake-client-b','test-only-encrypted');
 INSERT INTO public.toast_location_mappings
 (business_id,location_id,restaurant_guid,verified_at)
 VALUES(b,loc,r,now()),(other_b,other_loc,other_r,now());
 INSERT INTO public.toast_optional_sync_state
 (business_id,restaurant_guid,menu_last_updated,menu_copied_at)
 VALUES(b,r,'2026-11-09T09:00:00Z',now());

 INSERT INTO public.menu_items(id,business_id,pos_item_id,name,base_name,
  price_cents,catalog_source,is_active)
 VALUES(a,b,item_a,'Latte','Latte',500,'toast',true),
       (gone,b,item_b,'Historic special','Historic special',600,'toast',true),
       (other_item,other_b,'toast:'||other_r||':cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        'Other restaurant','Other restaurant',900,'toast',true);
 INSERT INTO public.modifier_recipes(business_id,pos_modifier_id,name,catalog_source)
 VALUES(b,mod_a,'Oat','toast'),(b,mod_b,'Soy','toast');
 INSERT INTO public.menu_item_modifier_groups
 (business_id,menu_item_id,pos_group_id) VALUES
 (b,a,group_a),(b,gone,group_b);
 INSERT INTO public.ingredients(id,business_id,name,base_unit)
 VALUES(ing,b,'Historic ingredient','g');
 INSERT INTO public.recipe_lines(menu_item_id,ingredient_id,quantity)
 VALUES(gone,ing,15);
 PERFORM pg_temp.pos0d_assert((SELECT count(*)=2 FROM public.menu_items
  WHERE business_id=b AND toast_publication_state='unknown'),
  'migration does not reinterpret legacy Toast rows as published');

 -- Synthetic service-only authority: same stored metadata and all promoted rows.
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 actual:=public.toast_apply_verified_menu_presence(b,r,'2026-11-09T09:00:00Z',observed,
   ARRAY[item_a,item_b],ARRAY[mod_a,mod_b],pairs);
 PERFORM pg_temp.pos0d_assert(actual->>'inactiveItems'='0',
   'first verified publication retires nothing');
 PERFORM pg_temp.pos0d_assert((SELECT count(*)=2 FROM public.menu_items
   WHERE business_id=b AND toast_publication_state='active'),
   'first source publication active');
 PERFORM pg_temp.pos0d_assert((SELECT count(*)=2 FROM public.modifier_recipes
   WHERE business_id=b AND toast_publication_state='active'),
   'modifier publication source-scoped');
 PERFORM pg_temp.pos0d_assert((SELECT count(*)=2 FROM public.menu_item_modifier_groups
   WHERE business_id=b AND toast_publication_state='active'),
   'group links source-scoped');
 PERFORM pg_temp.pos0d_assert((SELECT toast_publication_state='unknown'
   FROM public.menu_items WHERE id=other_item),'other café left unknown');

 -- A new independently recorded publication; only second source GUID disappears.
 UPDATE public.toast_optional_sync_state
 SET menu_last_updated='2026-11-09T10:00:00Z',menu_copied_at=now()
 WHERE business_id=b AND restaurant_guid=r;
 actual:=public.toast_apply_verified_menu_presence(b,r,'2026-11-09T10:00:00Z',observed,
   ARRAY[item_a],ARRAY[mod_a],only_a);
 PERFORM pg_temp.pos0d_assert(actual->>'inactiveItems'='1'
   AND actual->>'inactiveModifiers'='1' AND actual->>'inactiveGroups'='1',
   'only verified missing source identities turn inactive');
 PERFORM pg_temp.pos0d_assert((SELECT toast_publication_state='inactive' AND is_active
   FROM public.menu_items WHERE id=gone),
   'inactive provider status never overwrites owner activity flag');
 PERFORM pg_temp.pos0d_assert((SELECT quantity=15 FROM public.recipe_lines
   WHERE menu_item_id=gone AND ingredient_id=ing),
   'historical owner recipe survives unpublish');
 PERFORM pg_temp.pos0d_assert((SELECT count(*)=2 FROM public.menu_items WHERE business_id=b),
   'no item hard deletion or duplicate');
 -- Replay is idempotent.
 actual:=public.toast_apply_verified_menu_presence(b,r,'2026-11-09T10:00:00Z',observed,
   ARRAY[item_a],ARRAY[mod_a],only_a);
 PERFORM pg_temp.pos0d_assert(actual->>'inactiveItems'='0','idempotent verified replay');

 -- Neither an old version nor another restaurant may claim a new absence.
 failed:=false;
 BEGIN
  PERFORM public.toast_apply_verified_menu_presence(b,r,'2026-11-09T09:00:00Z',observed,
    ARRAY[item_b],ARRAY[mod_b],pairs);
 EXCEPTION WHEN sqlstate '22023' THEN failed:=true;END;
 PERFORM pg_temp.pos0d_assert(failed,'stale version rejected');
 failed:=false;
 BEGIN
  PERFORM public.toast_apply_verified_menu_presence(b,r,'2026-11-09T10:00:00Z',observed,
    ARRAY['toast:'||other_r||':a'],ARRAY[mod_a],only_a);
 EXCEPTION WHEN sqlstate '22023' THEN failed:=true;END;
 PERFORM pg_temp.pos0d_assert(failed,'cross-restaurant identity rejected');
 failed:=false;
 BEGIN
  PERFORM public.toast_apply_verified_menu_presence(b,r,'2026-11-09T10:00:00Z',observed,
    ARRAY[]::text[],ARRAY[mod_a],only_a);
 EXCEPTION WHEN sqlstate '22023' THEN failed:=true;END;
 PERFORM pg_temp.pos0d_assert(failed,'empty snapshot never unpublishes last-good');
 failed:=false;
 PERFORM set_config('request.jwt.claim.role','authenticated',true);
 BEGIN
  PERFORM public.toast_apply_verified_menu_presence(b,r,'2026-11-09T10:00:00Z',observed,
   ARRAY[item_a],ARRAY[mod_a],only_a);
 EXCEPTION WHEN sqlstate '42501' THEN failed:=true;END;
 PERFORM pg_temp.pos0d_assert(failed,'owner/user cannot forge verified source');
 PERFORM set_config('request.jwt.claim.role','service_role',true);

 -- Same stable provider GUID republished, without recipe/price/order loss.
 UPDATE public.toast_optional_sync_state
 SET menu_last_updated='2026-11-09T11:00:00Z',menu_copied_at=now()
 WHERE business_id=b AND restaurant_guid=r;
 PERFORM public.toast_apply_verified_menu_presence(b,r,'2026-11-09T11:00:00Z',observed,
   ARRAY[item_a,item_b],ARRAY[mod_a,mod_b],pairs);
 PERFORM pg_temp.pos0d_assert((SELECT toast_publication_state='active'
   FROM public.menu_items WHERE id=gone),'same GUID republish is active');
 PERFORM pg_temp.pos0d_assert((SELECT quantity=15 FROM public.recipe_lines
   WHERE menu_item_id=gone AND ingredient_id=ing),
   'republish retains same ID and owner recipe');

 -- Source proof ANNOTATES the single real price history; it cannot invent
 -- an experiment or turn a local/manual proposal into a Toast publication.
 UPDATE public.menu_items SET price_cents=550 WHERE id=a;
 INSERT INTO public.menu_price_history(business_id,menu_item_id,
  old_price_cents,new_price_cents,source_type,source_provider,changed_at)
 VALUES(b,a,500,550,'connected_pos','toast',now()),
       (b,gone,600,650,'owner_manual',null,now());
 price_verified:=public.toast_verify_existing_price_history(b,r,item_a,
  '2026-11-09T11:00:00Z',observed,550);
 PERFORM pg_temp.pos0d_assert(price_verified,'matching source price-history annotated');
 PERFORM pg_temp.pos0d_assert((SELECT toast_restaurant_guid=r
  AND toast_publication_version='2026-11-09T11:00:00Z'
  AND toast_observed_at=observed AND toast_effective_at IS NULL
  FROM public.menu_price_history WHERE menu_item_id=a),
  'source observed instant is not guessed effective instant');
 PERFORM pg_temp.pos0d_assert(NOT public.toast_verify_existing_price_history(
  b,r,item_b,'2026-11-09T11:00:00Z',observed,650),
  'manual owner price never becomes source-verified');
 PERFORM pg_temp.pos0d_assert((SELECT count(*)=2 FROM public.menu_price_history
  WHERE business_id=b),'no duplicate history or second ledger');

 -- Simulate a worker crash AFTER the existing canonical price/history writer
 -- but BEFORE presence promotion. Its first receipt has been durably stamped
 -- as pending; when retry finally happens >2 hours later, it must use that
 -- same original instant, not fabricate a new effective change time.
 observed:=now()-interval '3 hours';
 UPDATE public.toast_optional_sync_state
 SET menu_last_updated='2026-11-09T12:00:00Z',
     menu_copied_at=observed,menu_checked_local_day=NULL,
     menu_pending_observations=to_jsonb(ARRAY[observed::text])
 WHERE business_id=b AND restaurant_guid=r;
 UPDATE public.menu_items SET price_cents=575 WHERE id=a;
 INSERT INTO public.menu_price_history(business_id,menu_item_id,
  old_price_cents,new_price_cents,source_type,source_provider,changed_at)
 VALUES(b,a,550,575,'connected_pos','toast',observed+interval '1 minute');
 actual:=public.toast_apply_verified_menu_presence(b,r,'2026-11-09T12:00:00Z',observed,
   ARRAY[item_a,item_b],ARRAY[mod_a,mod_b],pairs);
 PERFORM pg_temp.pos0d_assert(actual->>'inactiveItems'='0',
   'delayed pending receipt promotes without retiring surviving items');
 PERFORM pg_temp.pos0d_assert(public.toast_verify_existing_price_history(
   b,r,item_a,'2026-11-09T12:00:00Z',observed,575),
   'older pending receipt verifies the original committed price transition');
 PERFORM pg_temp.pos0d_assert((SELECT count(*)=1 FROM public.menu_price_history
   WHERE business_id=b AND menu_item_id=a AND new_price_cents=575
     AND toast_restaurant_guid=r
     AND toast_publication_version='2026-11-09T12:00:00Z'
     AND toast_observed_at=observed AND toast_effective_at IS NULL),
   'delayed replay retains exact original observation and single history');
 PERFORM public.toast_apply_verified_menu_presence(b,r,
   '2026-11-09T12:00:00Z',observed,
   ARRAY[item_a,item_b],ARRAY[mod_a,mod_b],pairs);
 PERFORM pg_temp.pos0d_assert(public.toast_verify_existing_price_history(
   b,r,item_a,'2026-11-09T12:00:00Z',observed,575),
   'delayed same-version replay remains idempotent');
 PERFORM pg_temp.pos0d_assert((SELECT count(*)=3 FROM public.menu_price_history
   WHERE business_id=b),'delayed replay never duplicates price history');

 -- The first attempt did not write item_b. A second attempt later wrote
 -- the price and died before verifying it. The third attempt (45 minutes
 -- later) must use the SECOND, already persisted observation, not invent a
 -- changed_at at the third attempt's time or re-fetch an old effective date.
 late_observed:=now()-interval '45 minutes';
 UPDATE public.menu_items SET price_cents=675 WHERE id=gone;
 INSERT INTO public.menu_price_history(business_id,menu_item_id,
  old_price_cents,new_price_cents,source_type,source_provider,changed_at)
 VALUES(b,gone,600,675,'connected_pos','toast',late_observed+interval '1 minute');
 PERFORM pg_temp.pos0d_assert(NOT public.toast_verify_existing_price_history(
   b,r,item_b,'2026-11-09T12:00:00Z',observed,675),
   'without the second receipt no third retry may claim source proof');
 -- Emulate a second attempt that atomically persisted the then-current
 -- validated receipt before its canonical writer. Now, on the third attempt,
 -- this 45-minute-old receipt is still durable and source-scoped.
 UPDATE public.toast_optional_sync_state SET
   menu_pending_observations=menu_pending_observations||to_jsonb(late_observed::text)
 WHERE business_id=b AND restaurant_guid=r;
 PERFORM pg_temp.pos0d_assert(public.toast_verify_existing_price_history(
   b,r,item_b,'2026-11-09T12:00:00Z',observed,675),
   'third retry attributes late price to durable second-attempt receipt');
 PERFORM pg_temp.pos0d_assert((SELECT count(*)=1 FROM public.menu_price_history
   WHERE business_id=b AND menu_item_id=gone AND new_price_cents=675
     AND source_type='connected_pos' AND source_provider='toast'
     AND toast_publication_version='2026-11-09T12:00:00Z'
     AND toast_observed_at=late_observed
     AND changed_at=late_observed+interval '1 minute'
     AND toast_effective_at IS NULL),
   'third retry preserves actual price write and second observation');
 -- The actual recorder is idempotent, checks the exact existing pending
 -- café/version/original timestamp, and cannot be forged by an owner.
 -- Registration happens BEFORE canonical promotion in the actual worker.
 UPDATE public.toast_optional_sync_state SET
  menu_last_updated='pending:2026-11-09T12:00:00Z'
 WHERE business_id=b AND restaurant_guid=r;
 actual:=public.toast_record_pending_menu_observation(
   b,r,'2026-11-09T12:00:00Z',observed,now());
 PERFORM pg_temp.pos0d_assert(jsonb_array_length(actual)=3,
   'fresh retry receipt appended atomically to existing proof');
 actual:=public.toast_record_pending_menu_observation(
   b,r,'2026-11-09T12:00:00Z',observed,now());
 PERFORM pg_temp.pos0d_assert(jsonb_array_length(actual)=3,
   'same observation replay never duplicates evidence');
 failed:=false;
 BEGIN
  PERFORM public.toast_record_pending_menu_observation(
   b,r,'2026-11-09T12:00:00Z',now()-interval '4 hours',now());
 EXCEPTION WHEN sqlstate '22023' THEN failed:=true;END;
 PERFORM pg_temp.pos0d_assert(failed,
   'recorder rejects mismatched original receipt identity');
 failed:=false;
 PERFORM set_config('request.jwt.claim.role','authenticated',true);
 BEGIN
  PERFORM public.toast_record_pending_menu_observation(
   b,r,'2026-11-09T12:00:00Z',observed,now());
 EXCEPTION WHEN sqlstate '42501' THEN failed:=true;END;
 PERFORM pg_temp.pos0d_assert(failed,
   'authenticated owner cannot forge a pending observation');
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 UPDATE public.toast_optional_sync_state SET
  menu_last_updated='2026-11-09T12:00:00Z'
 WHERE business_id=b AND restaurant_guid=r;
 PERFORM pg_temp.pos0d_assert((SELECT toast_publication_version IS NULL
   FROM public.menu_price_history WHERE menu_item_id=gone AND source_type='owner_manual'),
   'late source proof cannot relabel the owner manual history');
 PERFORM pg_temp.pos0d_assert((SELECT count(*)=4 FROM public.menu_price_history
   WHERE business_id=b),'retry source proof never creates a second history ledger');

 -- The exception must NOT permit stale receipts without the exact original
 -- pending observed-at checkpoint, or after completion.
 UPDATE public.toast_optional_sync_state SET menu_copied_at=now()
 WHERE business_id=b AND restaurant_guid=r;
 failed:=false;
 BEGIN
  PERFORM public.toast_apply_verified_menu_presence(b,r,'2026-11-09T12:00:00Z',observed,
    ARRAY[item_a,item_b],ARRAY[mod_a,mod_b],pairs);
 EXCEPTION WHEN sqlstate '22023' THEN failed:=true;END;
 PERFORM pg_temp.pos0d_assert(failed,
   'delayed receipt rejected when stored observation does not match');
 UPDATE public.toast_optional_sync_state
 SET menu_copied_at=observed,menu_checked_local_day=current_date
 WHERE business_id=b AND restaurant_guid=r;
 failed:=false;
 BEGIN
  PERFORM public.toast_apply_verified_menu_presence(b,r,'2026-11-09T12:00:00Z',observed,
    ARRAY[item_a,item_b],ARRAY[mod_a,mod_b],pairs);
 EXCEPTION WHEN sqlstate '22023' THEN failed:=true;END;
 PERFORM pg_temp.pos0d_assert(failed,
   'completed publication cannot reopen old receipt exception');
 failed:=false;
 BEGIN
  PERFORM public.toast_record_pending_menu_observation(
   b,r,'2026-11-09T12:00:00Z',observed,now());
 EXCEPTION WHEN sqlstate '22023' THEN failed:=true;END;
 PERFORM pg_temp.pos0d_assert(failed,
   'completed publication cannot append another fresh source receipt');
 UPDATE public.toast_optional_sync_state SET menu_checked_local_day=NULL
 WHERE business_id=b AND restaurant_guid=r;
 failed:=false;
 PERFORM set_config('request.jwt.claim.role','authenticated',true);
 BEGIN
  PERFORM public.toast_apply_verified_menu_presence(b,r,'2026-11-09T12:00:00Z',observed,
    ARRAY[item_a,item_b],ARRAY[mod_a,mod_b],pairs);
 EXCEPTION WHEN sqlstate '42501' THEN failed:=true;END;
 PERFORM pg_temp.pos0d_assert(failed,
   'delayed recovery remains service-role only');
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 PERFORM pg_temp.pos0d_assert((SELECT toast_publication_state='unknown'
   FROM public.menu_items WHERE id=other_item),
   'late recovery never changes another café');
END $pos0d$;
ROLLBACK;
