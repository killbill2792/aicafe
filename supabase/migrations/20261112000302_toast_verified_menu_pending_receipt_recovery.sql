-- POS0d pending publication receipt recovery (additive; migration 159 unchanged).
-- The original service-only function, version/cafe checks, canonical presence,
-- non-destructive relationships and price-history SQL are preserved exactly.
-- Only a pending exact source version may outlive the normal two-hour gate.
-- One existing state row retains retry observations; no new ledger or producer.
SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- Only the existing restaurant-scoped optional-sync row holds provisional
-- evidence. These are original authenticated Menus V2 observation instants, not
-- effective-at timestamps or a second price-history ledger.
alter table public.toast_optional_sync_state add column if not exists menu_pending_observations jsonb not null default '[]'::jsonb;
-- Atomically preserve each validated same-version observation BEFORE any
-- canonical price writer. Retry restarts keep earlier attempts, so a third
-- attempt can still verify a price written on an interrupted second attempt.
create or replace function public.toast_record_pending_menu_observation( p_business_id uuid,p_restaurant_guid uuid,p_version text, p_first_observed_at timestamptz,p_observed_at timestamptz
) returns jsonb language plpgsql security definer set search_path=public as $$
declare saved jsonb;
begin if auth.role() IS DISTINCT FROM 'service_role' or not exists( select 1 from public.toast_location_mappings where business_id=p_business_id and restaurant_guid=p_restaurant_guid and verified_at is not null
 ) then raise exception 'Toast menu unauthorized' using errcode='42501';end if;
 if p_version is null or length(trim(p_version))=0 or length(p_version)>150 or p_first_observed_at is null or p_observed_at is null
   or p_first_observed_at>p_observed_at or p_observed_at<now()-interval '2 hours' or p_observed_at>now()+interval '5 minutes' then raise exception 'Invalid pending menu observation' using errcode='22023';end if;
 update public.toast_optional_sync_state s set menu_pending_observations=case when s.menu_pending_observations ? p_observed_at::text then s.menu_pending_observations else s.menu_pending_observations||to_jsonb(p_observed_at::text)
 end where s.business_id=p_business_id and s.restaurant_guid=p_restaurant_guid and s.menu_last_updated='pending:'||p_version
  and s.menu_checked_local_day is null and s.menu_copied_at=p_first_observed_at and jsonb_typeof(s.menu_pending_observations)='array' returning s.menu_pending_observations into saved;
 if saved is null then raise exception 'Pending Toast receipt is not current' using errcode='22023';
 end if;
 return saved;
end;$$;
revoke all on function public.toast_record_pending_menu_observation( uuid,uuid,text,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.toast_record_pending_menu_observation( uuid,uuid,text,timestamptz,timestamptz) to service_role;
-- An already authenticated, durably recorded V1 observation can prove
-- EXISTING Toast price history even if V2 is now current. Never invent rows,
-- backdate changed_at, or use the absence of V1 as menu-retirement proof.
create or replace function public.toast_reconcile_superseded_menu_history( p_business_id uuid,p_restaurant_guid uuid,p_version text,p_first_observed_at timestamptz
) returns boolean language plpgsql security definer set search_path=public as $$
declare evidence jsonb;last_at timestamptz;
begin if auth.role() IS DISTINCT FROM 'service_role' or not exists( select 1 from public.toast_location_mappings where business_id=p_business_id and restaurant_guid=p_restaurant_guid and verified_at is not null
 ) then raise exception 'Toast price unauthorized' using errcode='42501';end if;
 select s.menu_pending_observations,(select max(v.value::timestamptz)
  from jsonb_array_elements_text(s.menu_pending_observations) v(value))
 into evidence,last_at from public.toast_optional_sync_state s where s.business_id=p_business_id and s.restaurant_guid=p_restaurant_guid and s.menu_checked_local_day is null and s.menu_copied_at=p_first_observed_at
  and s.menu_last_updated in (p_version,'pending:'||p_version);
 if evidence is null or jsonb_typeof(evidence)<>'array' or last_at is null or p_version is null or length(p_version)>150 then raise exception 'No durable superseded receipt' using errcode='22023';end if;
 with proofs as( select h.id,obs.value::timestamptz observed_at, row_number() over(partition by h.id order by abs(extract(epoch from h.changed_at-obs.value::timestamptz))) rank from public.menu_price_history h join public.menu_items m
    on m.id=h.menu_item_id and m.business_id=h.business_id cross join lateral jsonb_array_elements_text(evidence) obs(value)
  where h.business_id=p_business_id and h.source_type='connected_pos' and h.source_provider='toast' and h.toast_publication_version is null and m.catalog_source='toast' and m.pos_item_id like 'toast:'||p_restaurant_guid::text||':%'
   and m.price_cents=h.new_price_cents and h.changed_at between obs.value::timestamptz-interval '20 minutes' and obs.value::timestamptz+interval '5 minutes' )
 update public.menu_price_history h set toast_restaurant_guid=p_restaurant_guid, toast_publication_version=p_version,toast_observed_at=proofs.observed_at, toast_effective_at=null from proofs where h.id=proofs.id and proofs.rank=1;
 -- Any potentially related Toast history without verifiable source price
 -- remains unresolved; do NOT discard the previous version's receipts.
 if exists(select 1 from public.menu_price_history h join public.menu_items m on m.id=h.menu_item_id and m.business_id=h.business_id where h.business_id=p_business_id and h.source_type='connected_pos'
   and h.source_provider='toast' and h.toast_publication_version is null and m.catalog_source='toast' and m.pos_item_id like 'toast:'||p_restaurant_guid::text||':%' and h.changed_at between p_first_observed_at-interval '20 minutes'
                        and last_at+interval '5 minutes' ) then raise exception 'Unverified superseded Toast price' using errcode='22023';end if;
 return true;
end;$$;
revoke all on function public.toast_reconcile_superseded_menu_history( uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.toast_reconcile_superseded_menu_history( uuid,uuid,text,timestamptz) to service_role;

create or replace function public.toast_apply_verified_menu_presence( p_business_id uuid,p_restaurant_guid uuid,p_version text, p_observed_at timestamptz,p_item_ids text[],p_modifier_ids text[], p_group_links jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare prefix text; ni integer;nm integer;ng integer;
begin if auth.role() IS DISTINCT FROM 'service_role' or not exists( select 1 from public.toast_location_mappings where business_id=p_business_id and restaurant_guid=p_restaurant_guid and verified_at is not null
 ) then raise exception 'Toast menu unauthorized' using errcode='42501';end if;
 if p_version is null or length(trim(p_version))=0 or length(p_version)>150 or p_observed_at is null or p_observed_at>now()+interval '5 minutes'
   -- This narrowly permits an old receipt ONLY for a pending, already copied
   -- publication whose original observed instant was durably persisted before
   -- canonical price import. A completed stamp cannot reopen stale evidence.
   or (p_observed_at<now()-interval '2 hours' and not exists( select 1 from public.toast_optional_sync_state pending where pending.business_id=p_business_id and pending.restaurant_guid=p_restaurant_guid and pending.menu_last_updated=p_version
       and pending.menu_checked_local_day is null and pending.menu_copied_at=p_observed_at ))
   or p_item_ids is null or cardinality(p_item_ids)=0 or cardinality(p_item_ids)>5000 or p_modifier_ids is null or cardinality(p_modifier_ids)>10000 or jsonb_typeof(p_group_links) is distinct from 'array' or jsonb_array_length(p_group_links)>20000
 then raise exception 'Incomplete menu receipt' using errcode='22023';end if;
 if not exists(select 1 from public.toast_optional_sync_state s where s.business_id=p_business_id and s.restaurant_guid=p_restaurant_guid
    and s.menu_last_updated=p_version and s.menu_copied_at is not null and s.menu_copied_at>=p_observed_at-interval '20 minutes')
 then raise exception 'Stale menu version' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended( 'toast-menu:'||p_business_id::text||':'||p_restaurant_guid::text,0));
 prefix:='toast:'||p_restaurant_guid::text||':';
 if exists(select 1 from unnest(p_item_ids) x(id)
   where x.id is null or left(x.id,length(prefix))<>prefix)
  or exists(select 1 from unnest(p_modifier_ids) x(id)
   where x.id is null or left(x.id,length(prefix))<>prefix)
  or exists(select 1 from jsonb_array_elements(p_group_links) x(value)
   where jsonb_typeof(x.value) is distinct from 'object' or left(coalesce(x.value->>'item_pos_id',''),length(prefix))<>prefix or left(coalesce(x.value->>'pos_group_id',''),length(prefix))<>prefix)
 then raise exception 'Wrong Toast restaurant identity' using errcode='22023';end if;
 -- Fail the entire transaction if canonical promotion missed ANY claimed row.
 if exists(select 1 from unnest(p_item_ids) x(id) where not exists( select 1 from public.menu_items m where m.business_id=p_business_id and m.catalog_source='toast' and m.pos_item_id=x.id))
  or exists(select 1 from unnest(p_modifier_ids) x(id) where not exists( select 1 from public.modifier_recipes m where m.business_id=p_business_id and m.catalog_source='toast' and m.pos_modifier_id=x.id))
  or exists(select 1 from jsonb_array_elements(p_group_links) x(value) where not exists( select 1 from public.menu_item_modifier_groups g
    join public.menu_items m on m.id=g.menu_item_id and m.business_id=g.business_id where g.business_id=p_business_id and m.catalog_source='toast' and m.pos_item_id=x.value->>'item_pos_id' and g.pos_group_id=x.value->>'pos_group_id'))
 then raise exception 'Unpromoted published references' using errcode='22023';end if;
 -- Empty collections cannot silently retire a previously known collection.
 if cardinality(p_modifier_ids)=0 and exists( select 1 from public.modifier_recipes m where m.business_id=p_business_id and m.catalog_source='toast' and m.pos_modifier_id like prefix||'%' and m.toast_publication_state='active')
  or jsonb_array_length(p_group_links)=0 and exists( select 1 from public.menu_item_modifier_groups g join public.menu_items m on m.id=g.menu_item_id and m.business_id=g.business_id
   where g.business_id=p_business_id and m.pos_item_id like prefix||'%' and g.toast_publication_state='active')
 then raise exception 'Empty associations are not unpublish proof' using errcode='22023';end if;
 update public.menu_items m set toast_publication_state='active', toast_publication_version=p_version,toast_publication_observed_at=p_observed_at where m.business_id=p_business_id and m.catalog_source='toast' and m.pos_item_id=any(p_item_ids)
  and (m.toast_publication_state is distinct from 'active' or m.toast_publication_version is distinct from p_version);
 update public.menu_items m set toast_publication_state='inactive', toast_publication_version=p_version,toast_publication_observed_at=p_observed_at where m.business_id=p_business_id and m.catalog_source='toast'
  and m.pos_item_id like prefix||'%' and m.toast_publication_state='active' and not(m.pos_item_id=any(p_item_ids));
 get diagnostics ni=row_count;
 update public.modifier_recipes m set toast_publication_state='active', toast_publication_version=p_version,toast_publication_observed_at=p_observed_at where m.business_id=p_business_id and m.catalog_source='toast'
  and m.pos_modifier_id=any(p_modifier_ids)
  and (m.toast_publication_state is distinct from 'active' or m.toast_publication_version is distinct from p_version);
 update public.modifier_recipes m set toast_publication_state='inactive', toast_publication_version=p_version,toast_publication_observed_at=p_observed_at where m.business_id=p_business_id and m.catalog_source='toast'
  and m.pos_modifier_id like prefix||'%' and m.toast_publication_state='active' and not(m.pos_modifier_id=any(p_modifier_ids));
 get diagnostics nm=row_count;
 with wanted as( select x.value->>'item_pos_id' item_id,x.value->>'pos_group_id' group_id from jsonb_array_elements(p_group_links) x(value))
 update public.menu_item_modifier_groups g set toast_publication_state='active', toast_publication_version=p_version,toast_publication_observed_at=p_observed_at from public.menu_items m,wanted w
 where g.business_id=p_business_id and m.business_id=p_business_id and g.menu_item_id=m.id and m.pos_item_id=w.item_id and g.pos_group_id=w.group_id and m.catalog_source='toast'
  and (g.toast_publication_state is distinct from 'active' or g.toast_publication_version is distinct from p_version);
 update public.menu_item_modifier_groups g set toast_publication_state='inactive', toast_publication_version=p_version,toast_publication_observed_at=p_observed_at from public.menu_items m
 where g.business_id=p_business_id and m.business_id=p_business_id and m.id=g.menu_item_id and m.catalog_source='toast' and m.pos_item_id like prefix||'%' and g.toast_publication_state='active'
  and not exists(select 1 from jsonb_array_elements(p_group_links) x(value)
   where x.value->>'item_pos_id'=m.pos_item_id and x.value->>'pos_group_id'=g.pos_group_id);
 get diagnostics ng=row_count;
 -- Never change is_active, ingredient/recipe, order, owner-name or price data.
 return jsonb_build_object('inactiveItems',ni,'inactiveModifiers',nm,'inactiveGroups',ng);
end;$$;
revoke all on function public.toast_apply_verified_menu_presence( uuid,uuid,text,timestamptz,text[],text[],jsonb) from public,anon,authenticated;
grant execute on function public.toast_apply_verified_menu_presence( uuid,uuid,text,timestamptz,text[],text[],jsonb) to service_role;
-- Source proof selects the exact registered receipt matching the existing
-- connected_pos/Toast price-history write, even after several interrupted
-- retries. Original changed_at is never rewritten; no owner/manual annotation.
create or replace function public.toast_verify_existing_price_history( p_business_id uuid,p_restaurant_guid uuid,p_item_pos_id text, p_version text,p_observed_at timestamptz,p_price_cents bigint
) returns boolean language plpgsql security definer set search_path=public as $$
declare v_id uuid;h_id uuid;matched_at timestamptz;
begin if auth.role() IS DISTINCT FROM 'service_role' then raise exception 'Toast price unauthorized' using errcode='42501';end if;
 if p_price_cents is null or p_price_cents<=0 or p_observed_at is null or p_version is null then return false;end if;
 select id into v_id from public.menu_items where business_id=p_business_id and catalog_source='toast' and pos_item_id=p_item_pos_id
  and pos_item_id like 'toast:'||p_restaurant_guid::text||':%' and price_cents=p_price_cents and toast_publication_state='active' and toast_publication_version=p_version and toast_publication_observed_at=p_observed_at;
 if v_id is null then return false;end if;
 -- The original publication is always eligible under migration 159 rules.
 -- A retry observation is eligible ONLY if previously saved atomically by the
 -- service-role recorder while the SAME original receipt remained pending.
 -- Selection of the receipt is based on the existing real changed_at time.
 select h.id,proof.observed_at into h_id,matched_at from public.menu_price_history h cross join lateral ( select p_observed_at as observed_at union select obs.value::timestamptz from public.toast_optional_sync_state s
   cross join lateral jsonb_array_elements_text(s.menu_pending_observations) obs(value)
   where s.business_id=p_business_id and s.restaurant_guid=p_restaurant_guid and s.menu_last_updated=p_version and s.menu_checked_local_day is null and s.menu_copied_at=p_observed_at ) proof where h.business_id=p_business_id and h.menu_item_id=v_id
  and h.source_type='connected_pos' and h.source_provider='toast' and h.new_price_cents=p_price_cents and h.changed_at between proof.observed_at-interval '20 minutes' and proof.observed_at+interval '5 minutes'
  and (h.toast_restaurant_guid is null or h.toast_restaurant_guid=p_restaurant_guid)
  and (h.toast_publication_version is null or h.toast_publication_version=p_version)
 order by h.changed_at desc, abs(extract(epoch from h.changed_at-proof.observed_at)) asc,h.id desc limit 1 for update of h;
 if h_id is null then return false;end if;
 update public.menu_price_history set toast_restaurant_guid=p_restaurant_guid, toast_publication_version=p_version,toast_observed_at=matched_at,
  toast_effective_at=null where id=h_id and (toast_publication_version is null or toast_publication_version=p_version);
 return found;
end;$$;
revoke all on function public.toast_verify_existing_price_history( uuid,uuid,text,text,timestamptz,bigint) from public,anon,authenticated;
grant execute on function public.toast_verify_existing_price_history( uuid,uuid,text,text,timestamptz,bigint) to service_role;

RESET lock_timeout;
RESET statement_timeout;
