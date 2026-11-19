-- Task 8A: preserve completion proof independently of the mutable latest
-- menu checkpoint. No new source, price writer, scheduler, or historical backfill.
set lock_timeout='5s';
set statement_timeout='45s';

alter table public.menu_price_history
 add column toast_publication_completed_at timestamptz,
 add column toast_publication_pos_item_id text;
-- Both fields are absent on history written before this migration. An existing
-- Toast provider/receipt mutation is already protected by the 8a source guard.
alter table public.menu_price_history
 add constraint supervisor_8a_completed_publication_identity check (
  (toast_publication_completed_at is null and toast_publication_pos_item_id is null)
  or (toast_publication_completed_at is not null and
    toast_publication_pos_item_id is not null and
    source_type is not distinct from 'connected_pos' and
    source_provider is not distinct from 'toast' and
    toast_restaurant_guid is not null and toast_publication_version is not null
    and toast_observed_at is not null
    and toast_publication_completed_at>=toast_observed_at
    and toast_publication_pos_item_id ~*
      '^toast:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(:size:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})?$'
    and split_part(toast_publication_pos_item_id,':',2)=toast_restaurant_guid::text
    and old_price_cents is not null and old_price_cents>0
    and new_price_cents is not null and new_price_cents>0
    and old_price_cents<>new_price_cents)) not valid;
alter table public.menu_price_history validate constraint supervisor_8a_completed_publication_identity;
create index supervisor_8a_completed_toast_history
 on public.menu_price_history(business_id,toast_publication_completed_at,id)
 where toast_publication_completed_at is not null;

-- Separate opt-in means a café already using the approved-experiment cutover
-- cannot accidentally receive a historical flood when this code is deployed.
alter table public.supervisor_experiment_cutover_cafes
 add column toast_observation_enabled_at timestamptz;

-- Only the existing importer's final checkpoint transition can stamp proof.
-- A per-item receipt, pending version, failure, or a metadata-only refresh
-- cannot manufacture completion. The checkpoint and proof share a transaction.
create function public.supervisor_8a_stamp_completed_toast_history()
 returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if old.menu_checked_local_day is not null or new.menu_checked_local_day is null
    or old.menu_last_updated is distinct from new.menu_last_updated
    or new.menu_last_updated is null or new.menu_last_updated like 'pending:%'
    or old.menu_copied_at is null or new.menu_copied_at is null
    or new.menu_copied_at<old.menu_copied_at
    or new.menu_copied_at>clock_timestamp()+interval '1 minute'
    or new.business_id is distinct from old.business_id
    or new.restaurant_guid is distinct from old.restaurant_guid
 then return new;end if;
 if current_user in ('anon','authenticated') or
    coalesce(auth.role(),'') in ('anon','authenticated')
 then raise exception 'toast_history_source_service_role_only' using errcode='42501';end if;
 if not exists(select 1 from public.toast_location_mappings l
   where l.business_id=new.business_id and l.restaurant_guid=new.restaurant_guid
    and l.verified_at is not null)
 then return new;end if;
 update public.menu_price_history h
 set toast_publication_completed_at=new.menu_copied_at,
     toast_publication_pos_item_id=m.pos_item_id
 from public.menu_items m
 where h.business_id=new.business_id and m.business_id=h.business_id
   and m.id=h.menu_item_id and h.source_type='connected_pos'
   and h.source_provider='toast' and h.toast_restaurant_guid=new.restaurant_guid
   and h.toast_publication_version=new.menu_last_updated
   and h.toast_publication_completed_at is null
   and h.toast_observed_at is not null and h.toast_observed_at<=new.menu_copied_at
   and h.old_price_cents>0 and h.new_price_cents>0 and h.old_price_cents<>h.new_price_cents
   and m.catalog_source='toast' and m.is_active
   and m.toast_publication_state='active'
   and m.toast_publication_version=h.toast_publication_version
   and m.price_cents=h.new_price_cents
   and m.pos_item_id like 'toast:'||new.restaurant_guid::text||':%'
   and m.pos_item_id ~*
     '^toast:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(:size:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})?$'
   and m.pos_pricing_strategy=case when m.pos_item_id like '%:size:%'
      then 'SIZE_PRICE' else 'BASE_PRICE' end
   and (select count(*) from public.menu_price_history other
     where other.business_id=h.business_id and other.menu_item_id=h.menu_item_id
     and other.toast_restaurant_guid=h.toast_restaurant_guid
     and other.toast_publication_version=h.toast_publication_version
     and other.source_type='connected_pos' and other.source_provider='toast'
     and other.old_price_cents>0 and other.new_price_cents>0
     and other.old_price_cents<>other.new_price_cents)=1;
 return new;
end;$$;
revoke all on function public.supervisor_8a_stamp_completed_toast_history()
 from public,anon,authenticated;
grant execute on function public.supervisor_8a_stamp_completed_toast_history() to service_role;
create trigger supervisor_8a_stamp_completed_toast_history
 after update of menu_checked_local_day on public.toast_optional_sync_state
 for each row execute function public.supervisor_8a_stamp_completed_toast_history();

reset lock_timeout;
reset statement_timeout;
