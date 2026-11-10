-- POS0d additive provider-publication evidence. No hard deletes or automatic effects.
-- Menu owner recipe/activity is separate from Toast publication state.
alter table public.menu_items
 add column if not exists toast_publication_state text not null default 'unknown'
   check (toast_publication_state in ('unknown','active','inactive')),
 add column if not exists toast_publication_version text,
 add column if not exists toast_publication_observed_at timestamptz;
alter table public.modifier_recipes
 add column if not exists toast_publication_state text not null default 'unknown'
   check (toast_publication_state in ('unknown','active','inactive')),
 add column if not exists toast_publication_version text,
 add column if not exists toast_publication_observed_at timestamptz;
alter table public.menu_item_modifier_groups
 add column if not exists toast_publication_state text not null default 'unknown'
   check (toast_publication_state in ('unknown','active','inactive')),
 add column if not exists toast_publication_version text,
 add column if not exists toast_publication_observed_at timestamptz;
-- Extend the ONE existing price history, not a second ledger or watcher.
alter table public.menu_price_history
 add column if not exists toast_restaurant_guid uuid,
 add column if not exists toast_publication_version text,
 add column if not exists toast_observed_at timestamptz,
 add column if not exists toast_effective_at timestamptz;
create unique index if not exists menu_price_verified_publication_unique
 on public.menu_price_history(business_id,menu_item_id,toast_restaurant_guid,toast_publication_version)
 where toast_restaurant_guid is not null and toast_publication_version is not null;

-- Service-role call only AFTER one complete, restaurant-verified, same-version
-- Menus V2 response promoted to existing staging and canonical stores.
-- A second independently stored optional-sync version marker prevents stale
-- replays from making a product or relationship inactive.
create or replace function public.toast_apply_verified_menu_presence(
 p_business_id uuid,p_restaurant_guid uuid,p_version text,
 p_observed_at timestamptz,p_item_ids text[],p_modifier_ids text[],
 p_group_links jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare prefix text; ni integer;nm integer;ng integer;
begin
 if auth.role()<>'service_role' or not exists(
  select 1 from public.toast_location_mappings
  where business_id=p_business_id and restaurant_guid=p_restaurant_guid
   and verified_at is not null
 ) then raise exception 'Toast menu unauthorized' using errcode='42501';end if;
 if p_version is null or length(trim(p_version))=0 or length(p_version)>150
   or p_observed_at is null or p_observed_at<now()-interval '2 hours'
   or p_observed_at>now()+interval '5 minutes'
   or p_item_ids is null or cardinality(p_item_ids)=0
   or cardinality(p_item_ids)>5000 or p_modifier_ids is null
   or cardinality(p_modifier_ids)>10000
   or jsonb_typeof(p_group_links) is distinct from 'array'
   or jsonb_array_length(p_group_links)>20000
 then raise exception 'Incomplete menu receipt' using errcode='22023';end if;
 if not exists(select 1 from public.toast_optional_sync_state s
  where s.business_id=p_business_id and s.restaurant_guid=p_restaurant_guid
    and s.menu_last_updated=p_version and s.menu_copied_at is not null
    and s.menu_copied_at>=p_observed_at-interval '20 minutes')
 then raise exception 'Stale menu version' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(
   'toast-menu:'||p_business_id::text||':'||p_restaurant_guid::text,0));
 prefix:='toast:'||p_restaurant_guid::text||':';
 if exists(select 1 from unnest(p_item_ids) x(id)
   where x.id is null or left(x.id,length(prefix))<>prefix)
  or exists(select 1 from unnest(p_modifier_ids) x(id)
   where x.id is null or left(x.id,length(prefix))<>prefix)
  or exists(select 1 from jsonb_array_elements(p_group_links) x(value)
   where jsonb_typeof(x.value) is distinct from 'object'
     or left(coalesce(x.value->>'item_pos_id',''),length(prefix))<>prefix
     or left(coalesce(x.value->>'pos_group_id',''),length(prefix))<>prefix)
 then raise exception 'Wrong Toast restaurant identity' using errcode='22023';end if;
 -- Fail the entire transaction if canonical promotion missed ANY claimed row.
 if exists(select 1 from unnest(p_item_ids) x(id) where not exists(
   select 1 from public.menu_items m where m.business_id=p_business_id
    and m.catalog_source='toast' and m.pos_item_id=x.id))
  or exists(select 1 from unnest(p_modifier_ids) x(id) where not exists(
   select 1 from public.modifier_recipes m where m.business_id=p_business_id
    and m.catalog_source='toast' and m.pos_modifier_id=x.id))
  or exists(select 1 from jsonb_array_elements(p_group_links) x(value) where not exists(
   select 1 from public.menu_item_modifier_groups g
    join public.menu_items m on m.id=g.menu_item_id and m.business_id=g.business_id
    where g.business_id=p_business_id and m.catalog_source='toast'
     and m.pos_item_id=x.value->>'item_pos_id'
     and g.pos_group_id=x.value->>'pos_group_id'))
 then raise exception 'Unpromoted published references' using errcode='22023';end if;
 -- Empty collections cannot silently retire a previously known collection.
 if cardinality(p_modifier_ids)=0 and exists(
   select 1 from public.modifier_recipes m where m.business_id=p_business_id
     and m.catalog_source='toast' and m.pos_modifier_id like prefix||'%'
     and m.toast_publication_state='active')
  or jsonb_array_length(p_group_links)=0 and exists(
   select 1 from public.menu_item_modifier_groups g
   join public.menu_items m on m.id=g.menu_item_id and m.business_id=g.business_id
   where g.business_id=p_business_id and m.pos_item_id like prefix||'%'
    and g.toast_publication_state='active')
 then raise exception 'Empty associations are not unpublish proof' using errcode='22023';end if;
 update public.menu_items m set toast_publication_state='active',
   toast_publication_version=p_version,toast_publication_observed_at=p_observed_at
 where m.business_id=p_business_id and m.catalog_source='toast'
  and m.pos_item_id=any(p_item_ids)
  and (m.toast_publication_state is distinct from 'active'
    or m.toast_publication_version is distinct from p_version);
 update public.menu_items m set toast_publication_state='inactive',
  toast_publication_version=p_version,toast_publication_observed_at=p_observed_at
 where m.business_id=p_business_id and m.catalog_source='toast'
  and m.pos_item_id like prefix||'%' and m.toast_publication_state='active'
  and not(m.pos_item_id=any(p_item_ids));
 get diagnostics ni=row_count;
 update public.modifier_recipes m set toast_publication_state='active',
  toast_publication_version=p_version,toast_publication_observed_at=p_observed_at
 where m.business_id=p_business_id and m.catalog_source='toast'
  and m.pos_modifier_id=any(p_modifier_ids)
  and (m.toast_publication_state is distinct from 'active'
   or m.toast_publication_version is distinct from p_version);
 update public.modifier_recipes m set toast_publication_state='inactive',
  toast_publication_version=p_version,toast_publication_observed_at=p_observed_at
 where m.business_id=p_business_id and m.catalog_source='toast'
  and m.pos_modifier_id like prefix||'%' and m.toast_publication_state='active'
  and not(m.pos_modifier_id=any(p_modifier_ids));
 get diagnostics nm=row_count;
 with wanted as(
  select x.value->>'item_pos_id' item_id,x.value->>'pos_group_id' group_id
  from jsonb_array_elements(p_group_links) x(value))
 update public.menu_item_modifier_groups g set toast_publication_state='active',
   toast_publication_version=p_version,toast_publication_observed_at=p_observed_at
 from public.menu_items m,wanted w
 where g.business_id=p_business_id and m.business_id=p_business_id
  and g.menu_item_id=m.id and m.pos_item_id=w.item_id and g.pos_group_id=w.group_id
  and m.catalog_source='toast'
  and (g.toast_publication_state is distinct from 'active'
   or g.toast_publication_version is distinct from p_version);
 update public.menu_item_modifier_groups g set toast_publication_state='inactive',
  toast_publication_version=p_version,toast_publication_observed_at=p_observed_at
 from public.menu_items m
 where g.business_id=p_business_id and m.business_id=p_business_id
  and m.id=g.menu_item_id and m.catalog_source='toast'
  and m.pos_item_id like prefix||'%' and g.toast_publication_state='active'
  and not exists(select 1 from jsonb_array_elements(p_group_links) x(value)
   where x.value->>'item_pos_id'=m.pos_item_id
     and x.value->>'pos_group_id'=g.pos_group_id);
 get diagnostics ng=row_count;
 -- Never change is_active, ingredient/recipe, order, owner-name or price data.
 return jsonb_build_object('inactiveItems',ni,'inactiveModifiers',nm,'inactiveGroups',ng);
end;$$;
revoke all on function public.toast_apply_verified_menu_presence(
 uuid,uuid,text,timestamptz,text[],text[],jsonb) from public,anon,authenticated;
grant execute on function public.toast_apply_verified_menu_presence(
 uuid,uuid,text,timestamptz,text[],text[],jsonb) to service_role;

-- Only annotate a price transition already made by the existing POS writer.
-- A manual price or owner Done is never source verification. Source effective
-- time is unknown unless separately evidenced; do not backdate observation.
create or replace function public.toast_verify_existing_price_history(
 p_business_id uuid,p_restaurant_guid uuid,p_item_pos_id text,
 p_version text,p_observed_at timestamptz,p_price_cents bigint
) returns boolean language plpgsql security definer set search_path=public as $$
declare v_id uuid;h_id uuid;
begin
 if auth.role()<>'service_role' then
  raise exception 'Toast price unauthorized' using errcode='42501';end if;
 if p_price_cents is null or p_price_cents<=0 or p_observed_at is null
    or p_version is null then return false;end if;
 select id into v_id from public.menu_items
 where business_id=p_business_id and catalog_source='toast'
  and pos_item_id=p_item_pos_id
  and pos_item_id like 'toast:'||p_restaurant_guid::text||':%'
  and price_cents=p_price_cents and toast_publication_state='active'
  and toast_publication_version=p_version
  and toast_publication_observed_at=p_observed_at;
 if v_id is null then return false;end if;
 select h.id into h_id from public.menu_price_history h
 where h.business_id=p_business_id and h.menu_item_id=v_id
  and h.source_type='connected_pos' and h.source_provider='toast'
  and h.new_price_cents=p_price_cents
  and h.changed_at between p_observed_at-interval '20 minutes'
                   and p_observed_at+interval '5 minutes'
  and (h.toast_restaurant_guid is null or h.toast_restaurant_guid=p_restaurant_guid)
 order by h.changed_at desc,h.id desc limit 1 for update;
 if h_id is null then return false;end if;
 update public.menu_price_history set toast_restaurant_guid=p_restaurant_guid,
  toast_publication_version=p_version,toast_observed_at=p_observed_at,
  toast_effective_at=null
 where id=h_id and (toast_publication_version is null or toast_publication_version=p_version);
 return found;
end;$$;
revoke all on function public.toast_verify_existing_price_history(
 uuid,uuid,text,text,timestamptz,bigint) from public,anon,authenticated;
grant execute on function public.toast_verify_existing_price_history(
 uuid,uuid,text,text,timestamptz,bigint) to service_role;
