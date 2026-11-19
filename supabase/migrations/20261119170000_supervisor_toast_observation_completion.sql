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

-- Retain old slot-zero observation records if any exist, but all new daily
-- claims use their elapsed-window index, independent of café timezone/date.
alter table public.supervisor_experiment_notice_receipts
 drop constraint supervisor_experiment_notice_receipts_slot_check,
 drop constraint supervisor_experiment_notice_receipts_check;
alter table public.supervisor_experiment_notice_receipts
 add constraint supervisor_8a_notice_slot_range check(
 (kind='price_reminder' and slot in (1,2)) or
 (kind in ('toast_price_initial','toast_price_final') and slot=0) or
 (kind='toast_price_daily' and slot between 0 and 7)) not valid;
alter table public.supervisor_experiment_notice_receipts validate constraint supervisor_8a_notice_slot_range;

-- Observation measurements are café facts; approved proposal results remain
-- private to the owner who authorized them. Delivery stays owner-specific.
drop policy supervisor_8a_windows_owner_read on public.supervisor_monitor_windows;
create policy supervisor_8a_windows_owner_read
 on public.supervisor_monitor_windows for select to authenticated
 using ((monitor_kind='toast_price_observation' or owner_user_id=(select auth.uid())) and exists(
  select 1 from public.memberships m
  where m.business_id=supervisor_monitor_windows.business_id
   and m.user_id=(select auth.uid()) and m.role='owner'));

create or replace function public.supervisor_8a_claim_notice(
 p_business_id uuid,p_owner_user_id uuid,p_source_id uuid,
 p_kind text,p_local_date date,p_slot smallint
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid;v_sent integer;v_existing public.supervisor_experiment_notice_receipts;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'service_role_only' using errcode='42501';end if;
 if not exists(select 1 from public.memberships m
   where m.business_id=p_business_id and m.user_id=p_owner_user_id
    and m.role='owner') then return null;end if;
 if p_kind not in ('price_reminder','toast_price_initial',
  'toast_price_daily','toast_price_final') or p_local_date is null or
  (p_kind='price_reminder' and p_slot not in (1,2)) or
  (p_kind in ('toast_price_initial','toast_price_final') and p_slot<>0) or
  (p_kind='toast_price_daily' and p_slot not between 1 and 7) then
  raise exception 'invalid_notice_key' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(
  concat_ws(':',p_business_id,p_owner_user_id,p_source_id,
   case when p_kind='price_reminder' then p_local_date::text else p_kind||':'||p_slot::text end),0));
 -- Recheck under the claim lock. A queued cron read may race an owner
 -- cancellation OR the matching Toast source publication. Never reclaim a
 -- failed lease when the exact approved change is already source-verified.
 if p_kind='price_reminder' and not exists (
  select 1 from public.supervisor_proposals p
  where p.business_id=p_business_id and p.owner_user_id=p_owner_user_id
   and p.id=p_source_id and p.status='manual_pending'
   and p.approved_at is not null
   and not exists (
    select 1 from public.menu_price_history h
    join public.toast_location_mappings l
     on l.business_id=h.business_id
     and l.restaurant_guid=h.toast_restaurant_guid
    where h.business_id=p.business_id
     and h.menu_item_id::text=p.canonical_effect_payload->>'productId'
     and h.old_price_cents::text=p.canonical_effect_payload->>'oldPriceCents'
     and h.new_price_cents::text=p.canonical_effect_payload->>'newPriceCents'
     and h.source_type='connected_pos' and h.source_provider='toast'
     and h.toast_publication_version is not null
     and h.toast_observed_at>=p.approved_at
     and l.verified_at is not null
     and (h.toast_publication_completed_at is not null or exists (
       select 1 from public.toast_optional_sync_state s
       where s.business_id=h.business_id and s.restaurant_guid=h.toast_restaurant_guid
       and s.menu_last_updated=h.toast_publication_version
       and s.menu_checked_local_day is not null and s.menu_copied_at>=h.toast_observed_at))
   )
 ) then return null;end if;
 if p_kind<>'price_reminder' and not exists (
  select 1 from public.menu_price_history h
  join public.toast_location_mappings l
   on l.business_id=h.business_id
   and l.restaurant_guid=h.toast_restaurant_guid
  where h.business_id=p_business_id and h.id=p_source_id
   and h.source_type='connected_pos' and h.source_provider='toast'
   and h.toast_restaurant_guid is not null and l.verified_at is not null
   and h.toast_publication_version is not null
   and h.toast_observed_at is not null
   and h.old_price_cents>0 and h.new_price_cents>0
   and h.old_price_cents<>h.new_price_cents
   and h.toast_publication_completed_at is not null
   and h.toast_publication_completed_at<=now()
   and exists (select 1 from public.supervisor_experiment_cutover_cafes g
     where g.business_id=h.business_id and g.mode='new'
     and g.parity_proven_at is not null and g.rollback_proven_at is not null
     and g.release_approved_at is not null
     and h.toast_observed_at>=g.toast_observation_enabled_at)
   and exists (select 1 from public.supervisor_monitor_windows w
     where w.business_id=h.business_id and w.monitor_kind='toast_price_observation'
     and w.source_id=h.id and w.window_index=case when p_kind='toast_price_daily' then p_slot-1 else 0 end
     and (p_kind<>'toast_price_daily' or w.evaluation_status<>'in_progress'))
 ) then return null;end if;
 select * into v_existing from public.supervisor_experiment_notice_receipts
  where business_id=p_business_id and owner_user_id=p_owner_user_id
   and source_id=p_source_id and kind=p_kind
   and (p_kind<>'price_reminder' or local_date=p_local_date) and slot=p_slot
  order by (state='posted') desc,created_at,id limit 1 for update;
 if found then
  if v_existing.state='posted' or
   (v_existing.state='claimed' and v_existing.claimed_at>now()-interval '5 minutes') or
   (v_existing.state='failed' and v_existing.retry_at>now()) or
   v_existing.attempts>=30 then return null;end if;
  update public.supervisor_experiment_notice_receipts
  set state='claimed',claimed_at=now(),retry_at=null,attempts=attempts+1,
   updated_at=now() where id=v_existing.id returning id into v_id;
  return v_id;
 end if;
 if p_kind='price_reminder' then
  select count(*) into v_sent from public.supervisor_experiment_notice_receipts
   where business_id=p_business_id and owner_user_id=p_owner_user_id
    and source_id=p_source_id and kind=p_kind and local_date=p_local_date;
  if v_sent>=2 then return null;end if;
 end if;
 insert into public.supervisor_experiment_notice_receipts
  (business_id,owner_user_id,source_id,kind,local_date,slot)
  values(p_business_id,p_owner_user_id,p_source_id,p_kind,p_local_date,p_slot)
  returning id into v_id;
 return v_id;
end;$$;
revoke all on function public.supervisor_8a_claim_notice(
 uuid,uuid,uuid,text,date,smallint) from public,anon,authenticated;
grant execute on function public.supervisor_8a_claim_notice(
 uuid,uuid,uuid,text,date,smallint) to service_role;


-- Lease the existing anchor, not a new task queue. Failed/cancelled workers
-- leave a durable fair retry position and cannot overwrite a newer generation.
alter table public.supervisor_monitor_windows
 add column observation_worker_token uuid,
 add column observation_worker_until timestamptz,
 add column observation_retry_at timestamptz;

-- Bounded fair enumeration. A pinned approved proposal already owns its
-- measurement. An eligible matching pending proposal gets first refusal;
-- a later source event never restarts a previously pinned experiment.
create function public.supervisor_8a_due_toast_observations(p_now timestamptz,p_limit integer)
 returns table(history_id uuid,business_id uuid,enabled_at timestamptz)
 language plpgsql security invoker set search_path='' as $$
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'service_role_only' using errcode='42501';end if;
 if p_now is null or p_limit is null or p_limit not between 1 and 100 then
  raise exception 'invalid_observation_batch' using errcode='22023';end if;
 return query
 select h.id,h.business_id,g.toast_observation_enabled_at
 from public.menu_price_history h
 join public.supervisor_experiment_cutover_cafes g on g.business_id=h.business_id
 join public.toast_location_mappings l on l.business_id=h.business_id and l.restaurant_guid=h.toast_restaurant_guid
 left join public.supervisor_monitor_windows w on w.business_id=h.business_id
  and w.monitor_kind='toast_price_observation' and w.source_id=h.id and w.window_index=0
 where g.mode='new' and g.parity_proven_at is not null
  and g.rollback_proven_at is not null and g.release_approved_at is not null
  and g.toast_observation_enabled_at is not null
  and h.toast_publication_completed_at is not null
  and h.toast_publication_completed_at<=p_now
  and h.toast_observed_at>=g.toast_observation_enabled_at
  and l.verified_at is not null
  and exists(select 1 from public.memberships m where m.business_id=h.business_id and m.role='owner')
  and (w.id is null or (w.source_reference->>'closedAt' is null
    and (w.observation_worker_until is null or w.observation_worker_until<=clock_timestamp())
    and (w.observation_retry_at is null or w.observation_retry_at<=clock_timestamp())))
  and not exists(select 1 from public.supervisor_monitor_windows a
    where a.business_id=h.business_id and a.monitor_kind='approved_price'
    and a.window_index=0 and a.source_reference->>'historyId'=h.id::text)
  and not exists(select 1 from public.supervisor_proposals p
    where p.business_id=h.business_id
    and p.capability_id in ('alex.drink_price_experiment.v1','alex.menu_price_change.v1')
    and p.status in ('manual_pending','manual_confirmed','committed')
    and p.approved_at<=h.toast_observed_at
    and p.canonical_effect_payload->>'productId'=h.menu_item_id::text
    and p.canonical_effect_payload->>'oldPriceCents'=h.old_price_cents::text
    and p.canonical_effect_payload->>'newPriceCents'=h.new_price_cents::text
    and not exists(select 1 from public.supervisor_monitor_windows a
      where a.business_id=h.business_id and a.monitor_kind='approved_price'
      and a.source_id=p.id and a.window_index=0))
 order by coalesce(w.updated_at,h.toast_publication_completed_at),h.id
 limit p_limit;
end;$$;
revoke all on function public.supervisor_8a_due_toast_observations(timestamptz,integer)
 from public,anon,authenticated;
grant execute on function public.supervisor_8a_due_toast_observations(timestamptz,integer) to service_role;

-- Serialize discovery of a single source event. The anchor is initialized
-- before any expensive reads so even a repeated source read failure rotates.
create function public.supervisor_8a_claim_observation_work(
 p_business_id uuid,p_history_id uuid,p_now timestamptz
) returns uuid language plpgsql security invoker set search_path='' as $$
declare h public.menu_price_history;w public.supervisor_monitor_windows;
 v_token uuid;v_owner uuid;v_name text;v_currency text;v_start timestamptz;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'service_role_only' using errcode='42501';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_business_id::text||':'||p_history_id::text,0));
 if not exists(select 1 from public.supervisor_8a_due_toast_observations(p_now,100) d
  where d.business_id=p_business_id and d.history_id=p_history_id) then return null;end if;
 select * into h from public.menu_price_history where id=p_history_id and business_id=p_business_id;
 select m.user_id into v_owner from public.memberships m where m.business_id=p_business_id
  and m.role='owner' order by m.user_id limit 1;
 select name into v_name from public.menu_items where id=h.menu_item_id and business_id=p_business_id;
 select currency into v_currency from public.businesses where id=p_business_id;
 if v_owner is null then return null;end if;
 v_start:=coalesce(h.toast_effective_at,h.toast_observed_at);
 if v_start is null or v_start>h.toast_observed_at then return null;end if;
 insert into public.supervisor_monitor_windows(business_id,owner_user_id,monitor_kind,source_id,window_index,
  source_reference,start_at,end_at)
 values(p_business_id,v_owner,'toast_price_observation',p_history_id,0,
  jsonb_build_object('businessId',p_business_id,'historyId',h.id,'menuItemId',h.menu_item_id,
  'restaurantGuid',h.toast_restaurant_guid,'posItemId',h.toast_publication_pos_item_id,
  'oldPriceCents',h.old_price_cents,'newPriceCents',h.new_price_cents,'publicationVersion',h.toast_publication_version,
  'observedAt',h.toast_observed_at,'startBasis',case when h.toast_effective_at is null then 'first_verified_observation' else 'source_effective' end,
  'itemName',coalesce(v_name,'Menu item'),'currency',v_currency),
  v_start,v_start+interval '24 hours') on conflict(business_id,monitor_kind,source_id,window_index) do nothing;
 select * into w from public.supervisor_monitor_windows where business_id=p_business_id
  and monitor_kind='toast_price_observation' and source_id=p_history_id and window_index=0 for update;
 if w.source_reference->>'closedAt' is not null or w.observation_worker_until>clock_timestamp()
  or w.observation_retry_at>clock_timestamp() then return null;end if;
 v_token:=gen_random_uuid();
 update public.supervisor_monitor_windows set observation_worker_token=v_token,
  observation_worker_until=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp()
  where id=w.id;
 return v_token;
end;$$;
revoke all on function public.supervisor_8a_claim_observation_work(uuid,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.supervisor_8a_claim_observation_work(uuid,uuid,timestamptz) to service_role;

create function public.supervisor_8a_write_observation_window(
 p_business_id uuid,p_history_id uuid,p_token uuid,p_index bigint,p_ref jsonb,
 p_coverage text,p_units numeric,p_revenue bigint,p_unknown bigint,p_evaluation text
) returns boolean language plpgsql security invoker set search_path='' as $$
declare w public.supervisor_monitor_windows; v_start timestamptz;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'service_role_only' using errcode='42501';end if;
 if p_index not between 0 and 6 then raise exception 'invalid_observation_window' using errcode='22023';end if;
 select * into w from public.supervisor_monitor_windows where business_id=p_business_id
  and monitor_kind='toast_price_observation' and source_id=p_history_id and window_index=0
  and observation_worker_token=p_token and observation_worker_until>clock_timestamp() for update;
 if not found then return false;end if;
 v_start:=w.start_at+p_index*interval '24 hours';
 insert into public.supervisor_monitor_windows(business_id,owner_user_id,monitor_kind,source_id,window_index,
  source_reference,start_at,end_at,coverage_status,units,revenue_cents,unknown_time_lines,evaluation_status)
 values(p_business_id,w.owner_user_id,'toast_price_observation',p_history_id,p_index,
  p_ref,v_start,v_start+interval '24 hours',p_coverage,p_units,p_revenue,p_unknown,p_evaluation)
 on conflict(business_id,monitor_kind,source_id,window_index) do update
  set source_reference=excluded.source_reference,coverage_status=excluded.coverage_status,
  units=excluded.units,revenue_cents=excluded.revenue_cents,unknown_time_lines=excluded.unknown_time_lines,
  evaluation_status=excluded.evaluation_status,updated_at=clock_timestamp()
  where p_evaluation<>'in_progress';
 return true;
end;$$;
revoke all on function public.supervisor_8a_write_observation_window(uuid,uuid,uuid,bigint,jsonb,text,numeric,bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.supervisor_8a_write_observation_window(uuid,uuid,uuid,bigint,jsonb,text,numeric,bigint,bigint,text) to service_role;

create function public.supervisor_8a_finish_observation_work(
 p_business_id uuid,p_history_id uuid,p_token uuid,p_ref jsonb,p_failed boolean
) returns boolean language plpgsql security invoker set search_path='' as $$
begin
 if auth.role() is distinct from 'service_role' then raise exception 'service_role_only' using errcode='42501';end if;
 update public.supervisor_monitor_windows set source_reference=coalesce(p_ref,source_reference),
  observation_worker_token=null,observation_worker_until=null,
  observation_retry_at=case when p_failed then clock_timestamp()+interval '10 minutes' else null end,
  updated_at=clock_timestamp()
 where business_id=p_business_id and monitor_kind='toast_price_observation'
  and source_id=p_history_id and window_index=0 and observation_worker_token=p_token
  and observation_worker_until>clock_timestamp();
 return found;
end;$$;
revoke all on function public.supervisor_8a_finish_observation_work(uuid,uuid,uuid,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.supervisor_8a_finish_observation_work(uuid,uuid,uuid,jsonb,boolean) to service_role;

-- Same deterministic owner-scoped thread convention as event lookahead.
-- The service worker can open a Supervisor thread without inventing an owner
-- message, only while membership and this observation's lease are current.
create function public.supervisor_8a_observation_thread(
 p_business_id uuid,p_owner_user_id uuid,p_history_id uuid,p_token uuid,p_request_id uuid
) returns uuid language plpgsql security invoker set search_path='' as $$
declare v_thread uuid;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'service_role_only' using errcode='42501';end if;
 perform 1 from public.supervisor_monitor_windows w where w.business_id=p_business_id
   and w.source_id=p_history_id and w.monitor_kind='toast_price_observation' and w.window_index=0
   and w.observation_worker_token=p_token and w.observation_worker_until>clock_timestamp() for update;
 if not found then return null;end if;
 perform 1 from public.memberships m where m.business_id=p_business_id
  and m.user_id=p_owner_user_id and m.role='owner' for share;
 if not found then return null;end if;
 select t.id into v_thread from public.ai_threads t where t.business_id=p_business_id
  and t.owner_user_id=p_owner_user_id order by t.updated_at desc,t.id limit 1;
 if v_thread is not null then return v_thread;end if;
 insert into public.ai_threads(business_id,owner_user_id,client_request_id,title)
  values(p_business_id,p_owner_user_id,p_request_id,'Toast price observations')
  on conflict(business_id,owner_user_id,client_request_id) do nothing;
 select t.id into v_thread from public.ai_threads t where t.business_id=p_business_id
  and t.owner_user_id=p_owner_user_id and t.client_request_id=p_request_id;
 return v_thread;
end;$$;
revoke all on function public.supervisor_8a_observation_thread(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.supervisor_8a_observation_thread(uuid,uuid,uuid,uuid,uuid) to service_role;

-- Capture the specific lease generation in the same transaction as the
-- existing claim. A delayed previous worker must never borrow a new lease.
create function public.supervisor_8a_claim_observation_notice(
 p_business_id uuid,p_owner_user_id uuid,p_source_id uuid,p_kind text,p_local_date date,p_slot smallint
) returns table(receipt_id uuid,attempt bigint) language plpgsql security invoker set search_path='' as $$
declare v_id uuid;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'service_role_only' using errcode='42501';end if;
 if p_kind not in ('toast_price_initial','toast_price_daily','toast_price_final') then
  raise exception 'invalid_observation_notice_kind' using errcode='22023';end if;
 v_id:=public.supervisor_8a_claim_notice(p_business_id,p_owner_user_id,p_source_id,p_kind,p_local_date,p_slot);
 if v_id is null then return;end if;
 return query select n.id,n.attempts from public.supervisor_experiment_notice_receipts n where n.id=v_id;
end;$$;
revoke all on function public.supervisor_8a_claim_observation_notice(uuid,uuid,uuid,text,date,smallint) from public,anon,authenticated;
grant execute on function public.supervisor_8a_claim_observation_notice(uuid,uuid,uuid,text,date,smallint) to service_role;

-- Atomic fenced in-app delivery for observation receipts. No provider call,
-- no price proposal, and no external transport is made by this function.
create function public.supervisor_8a_post_observation_notice(
 p_receipt_id uuid,p_attempt bigint,p_thread_id uuid,p_task_id text,p_message_id uuid,
 p_timezone text,p_payload jsonb,p_text text,p_confidence text,
 p_prior_message_id uuid default null,p_measurement_as_of timestamptz default null,
 p_worker_token uuid default null
) returns boolean language plpgsql security invoker set search_path='' as $$
declare n public.supervisor_experiment_notice_receipts; h public.menu_price_history;
 v_payload jsonb;v_previous jsonb;v_correction boolean;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'service_role_only' using errcode='42501';end if;
 select * into n from public.supervisor_experiment_notice_receipts
  where id=p_receipt_id and kind in ('toast_price_initial','toast_price_daily','toast_price_final')
   and attempts=p_attempt and ((state='claimed' and p_prior_message_id is null
     and claimed_at>clock_timestamp()-interval '5 minutes') or
     (state='posted' and message_id=p_prior_message_id and p_measurement_as_of is not null))
  for update;
 if not found then return false;end if;
 if p_worker_token is not null then
  perform 1 from public.supervisor_monitor_windows w where w.business_id=n.business_id
   and w.monitor_kind='toast_price_observation' and w.source_id=n.source_id and w.window_index=0
   and w.observation_worker_token=p_worker_token and w.observation_worker_until>clock_timestamp() for update;
  if not found then return false;end if;
 end if;
 v_correction:=n.state='posted';
 if v_correction and n.kind='toast_price_initial' then return true;end if;
 perform 1 from public.memberships m where m.business_id=n.business_id
  and m.user_id=n.owner_user_id and m.role='owner' for share;
 if not found then return false;end if;
 perform 1 from public.ai_threads t where t.id=p_thread_id
  and t.business_id=n.business_id and t.owner_user_id=n.owner_user_id for share;
 if not found then return false;end if;
 select h0.* into h from public.menu_price_history h0
  join public.supervisor_experiment_cutover_cafes g on g.business_id=h0.business_id
  join public.toast_location_mappings l on l.business_id=h0.business_id and l.restaurant_guid=h0.toast_restaurant_guid
  where h0.id=n.source_id and h0.business_id=n.business_id
   and h0.toast_publication_completed_at is not null and l.verified_at is not null
   and g.mode='new' and g.parity_proven_at is not null and g.rollback_proven_at is not null
   and g.release_approved_at is not null and h0.toast_observed_at>=g.toast_observation_enabled_at;
 if not found then return false;end if;
 if p_task_id is distinct from ('toast-price-observation:'||n.owner_user_id::text||':'||n.source_id::text||':'||n.kind||':'||n.slot::text)
  or p_message_id is null or p_payload is null or jsonb_typeof(p_payload) is distinct from 'object'
  or p_text is null or length(trim(p_text))=0 or length(p_text)>1200
  or p_timezone is null or p_confidence not in ('high','low')
 then raise exception 'invalid_observation_delivery' using errcode='22023';end if;
 v_payload:=p_payload||jsonb_build_object('observationOnly',true,'priceHistoryId',h.id,
    'threadId',p_thread_id,'ownerNoticeDate',n.local_date,'windowIndex',n.slot,
    'measurementAsOf',p_measurement_as_of);
 if v_correction then
  select t.payload into v_previous from public.operating_tasks t
   where t.business_id=n.business_id and t.id=p_task_id and t.owner_user_id=n.owner_user_id
   for update;
  if not found then return false;end if;
  if (v_previous->>'measurementAsOf')::timestamptz>p_measurement_as_of then return false;end if;
  if v_previous-'measurementAsOf'-'costEstimateAsOf'-'threadId' = v_payload-'measurementAsOf'-'costEstimateAsOf'-'threadId'
   then return true;end if;
  update public.operating_tasks set payload=v_payload,confidence=p_confidence,updated_at=clock_timestamp()
   where business_id=n.business_id and id=p_task_id and owner_user_id=n.owner_user_id;
 end if;
 insert into public.operating_tasks(
  business_id,id,agent_id,owner_user_id,kind,status,confidence,entity_type,entity_id,
  payload,evidence)
 values(n.business_id,p_task_id,'alex',n.owner_user_id,'priority_notice','watching',
  p_confidence,'menu_item',h.menu_item_id,
  v_payload,
  jsonb_build_array(jsonb_build_object('source','menu_price_history','facts',
    jsonb_build_object('sourceId',h.id,'publicationVersion',h.toast_publication_version))))
 on conflict(business_id,id) do nothing;
 insert into public.ai_messages(id,business_id,thread_id,owner_user_id,author_user_id,
  role,content_type,text_content,structured_content,grounding)
 values(p_message_id,n.business_id,p_thread_id,n.owner_user_id,null,'supervisor','blocks',null,
  jsonb_build_array(jsonb_build_object('type','text','text',p_text)),
  jsonb_build_object('status',case when p_confidence='high' then 'estimated' else 'insufficient_evidence' end,
   'intent','menu_pricing','evidence',jsonb_build_array(jsonb_build_object(
    'source','operating_tasks','identifier',p_task_id,'asOf',n.local_date))))
 on conflict(id) do nothing;
 if not exists(select 1 from public.operating_tasks t where t.business_id=n.business_id
   and t.id=p_task_id and t.owner_user_id=n.owner_user_id
   and t.payload->>'priceHistoryId'=n.source_id::text)
  or not exists(select 1 from public.ai_messages m where m.id=p_message_id
   and m.business_id=n.business_id and m.owner_user_id=n.owner_user_id
   and m.thread_id=p_thread_id and m.role='supervisor')
 then raise exception 'observation_notice_delivery_identity_conflict' using errcode='23514';end if;
 update public.supervisor_experiment_notice_receipts set state='posted',
  posted_at=clock_timestamp(),task_id=p_task_id,message_id=p_message_id,
  updated_at=clock_timestamp()
  where id=n.id and attempts=p_attempt and state=n.state;
 return found;
end;$$;
revoke all on function public.supervisor_8a_post_observation_notice(uuid,bigint,uuid,text,uuid,text,jsonb,text,text,uuid,timestamptz,uuid)
 from public,anon,authenticated;
grant execute on function public.supervisor_8a_post_observation_notice(uuid,bigint,uuid,text,uuid,text,jsonb,text,text,uuid,timestamptz,uuid)
 to service_role;

-- One immutable chat digest, independent task/receipt per observation.
-- A failed lease, revoked owner or invalid entry rolls back the whole group.
create function public.supervisor_8a_post_observation_digest(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_message_id uuid,
 p_text text,p_entries jsonb
) returns boolean language plpgsql security invoker set search_path='' as $$
declare entry jsonb;n public.supervisor_experiment_notice_receipts;v_ok boolean;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'service_role_only' using errcode='42501';end if;
 if jsonb_typeof(p_entries) is distinct from 'array' or jsonb_array_length(p_entries) not between 1 and 10
   or p_text is null or length(p_text)>1200 then
   raise exception 'invalid_observation_digest' using errcode='22023';end if;
 for entry in select value from jsonb_array_elements(p_entries) order by value->>'receiptId' loop
  select * into n from public.supervisor_experiment_notice_receipts where id=(entry->>'receiptId')::uuid
    and business_id=p_business_id and owner_user_id=p_owner_user_id
    and kind in ('toast_price_initial','toast_price_daily','toast_price_final') for update;
  if not found or entry->>'workerToken' is null then raise exception 'observation_digest_scope_lost' using errcode='40001';end if;
  v_ok:=public.supervisor_8a_post_observation_notice(n.id,(entry->>'attempt')::bigint,p_thread_id,
    entry->>'taskId',p_message_id,entry->>'timezone',entry->'payload',p_text,
    entry->>'confidence',null,(entry->>'measurementAsOf')::timestamptz,(entry->>'workerToken')::uuid);
  if v_ok is distinct from true then raise exception 'observation_digest_lease_lost' using errcode='40001';end if;
 end loop;
 return true;
end;$$;
revoke all on function public.supervisor_8a_post_observation_digest(uuid,uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.supervisor_8a_post_observation_digest(uuid,uuid,uuid,uuid,text,jsonb) to service_role;

create or replace function public.supervisor_8a_guard_toast_manual_confirmation()
 returns trigger language plpgsql set search_path=public as $$
declare v_item public.menu_items;v_product text;v_before text;v_target text;
begin
 if tg_op<>'UPDATE' or new.status is not distinct from old.status
   or new.status<>'manual_confirmed' or
   old.capability_id not in ('alex.drink_price_experiment.v1',
    'alex.menu_price_change.v1')
 then return new;end if;
 v_product:=old.canonical_effect_payload->>'productId';
 if v_product is null or v_product !~*
   '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$'
 then raise exception 'price_item_identity_missing' using errcode='22023';end if;
 select * into v_item from public.menu_items
 where business_id=old.business_id and id=v_product::uuid;
 if not found then
  raise exception 'price_item_missing' using errcode='23514';end if;
 if v_item.catalog_source is distinct from 'toast'
 then return new;end if; -- disconnected/manual cafés preserve their flow
 v_before:=old.canonical_effect_payload->>'oldPriceCents';
 v_target:=old.canonical_effect_payload->>'newPriceCents';
 if v_before is null or v_before!~'^[0-9]+$' or
    v_target is null or v_target!~'^[0-9]+$'
 then raise exception 'toast_price_baseline_missing' using errcode='22023';end if;
 -- A prior Task 8a worker may have verified and durably pinned the exact
 -- Toast source activation, then failed before the lifecycle transition.
 -- A later price revert, unpublication or contextual menu cannot invalidate
 -- THAT historical verification. The worker separately records interruption
 -- and cannot claim full-window evidence for changed source context.
 if old.approved_at is not null and exists (
  select 1 from public.supervisor_monitor_windows w
  join public.menu_price_history h
   on h.id::text=w.source_reference->>'historyId'
   and h.business_id=w.business_id and h.menu_item_id=v_item.id
  join public.toast_location_mappings l
   on l.business_id=h.business_id and l.restaurant_guid=h.toast_restaurant_guid
  where w.business_id=old.business_id and w.owner_user_id=old.owner_user_id
   and w.source_id=old.id and w.monitor_kind='approved_price'
   and w.window_index=0 and l.verified_at is not null
   and h.source_type='connected_pos' and h.source_provider='toast'
   and h.toast_restaurant_guid is not null and h.toast_observed_at is not null
   and h.toast_publication_version is not null
   and h.old_price_cents=v_before::bigint and h.new_price_cents=v_target::bigint
   and h.old_price_cents is distinct from h.new_price_cents
   and h.toast_observed_at>=old.approved_at
   and (h.toast_effective_at is null or h.toast_effective_at>=old.approved_at)
   and w.start_at=coalesce(h.toast_effective_at,h.toast_observed_at)
   and w.source_reference->>'businessId'=old.business_id::text
   and w.source_reference->>'menuItemId'=v_item.id::text
   and w.source_reference->>'historyId'=h.id::text
   and w.source_reference->>'restaurantGuid'=h.toast_restaurant_guid::text
   and w.source_reference->>'publicationVersion'=h.toast_publication_version
   and (w.source_reference->>'observedAt')::timestamptz=h.toast_observed_at
   and (w.source_reference->>'oldPriceCents')::bigint=v_before::bigint
   and (w.source_reference->>'newPriceCents')::bigint=v_target::bigint
   and w.source_reference->>'posItemId' like
     'toast:'||h.toast_restaurant_guid::text||':%'
   and (w.source_reference->>'posItemId' ~*
     ':[0-9a-f-]{36}:[0-9a-f-]{36}$' or
      w.source_reference->>'posItemId' ~*
     ':[0-9a-f-]{36}:size:[0-9a-f-]{36}$')
 ) then return new;end if;
 if v_item.toast_publication_state is distinct from 'active' or
  v_item.pos_pricing_strategy not in ('BASE_PRICE','SIZE_PRICE') or
  v_item.pos_pricing_strategy is null or
  v_item.price_cents is distinct from v_target::bigint or
  not exists(
    select 1 from public.menu_price_history h
    join public.toast_location_mappings l
     on l.business_id=h.business_id and l.restaurant_guid=h.toast_restaurant_guid
    join public.toast_optional_sync_state s
     on s.business_id=l.business_id and s.restaurant_guid=l.restaurant_guid
   where h.business_id=old.business_id and h.menu_item_id=v_item.id
    and h.source_type='connected_pos' and h.source_provider='toast'
    and h.old_price_cents=v_before::bigint and h.new_price_cents=v_target::bigint
    and h.old_price_cents is distinct from h.new_price_cents
    and h.toast_observed_at is not null and h.toast_restaurant_guid is not null
    and old.approved_at is not null
    and h.toast_observed_at >= old.approved_at
    and (h.toast_effective_at is null or h.toast_effective_at >= old.approved_at)
    and l.verified_at is not null
    and s.menu_checked_local_day is not null
    and s.menu_last_updated not like 'pending:%'
    and s.menu_copied_at>=h.toast_observed_at
    and s.menu_last_updated=h.toast_publication_version
    and v_item.toast_publication_version=h.toast_publication_version
    and v_item.toast_publication_observed_at=h.toast_observed_at
    and v_item.pos_item_id like 'toast:'||h.toast_restaurant_guid::text||':%'
    and (case when v_item.pos_pricing_strategy='SIZE_PRICE'
      then v_item.pos_item_id ~* ':[0-9a-f-]{36}:size:[0-9a-f-]{36}$'
      else v_item.pos_item_id ~* ':[0-9a-f-]{36}:[0-9a-f-]{36}$'
     end)
  ) then
   raise exception 'toast_price_not_source_verified' using errcode='23514';
 end if;
 return new;
end;$$;

reset lock_timeout;
reset statement_timeout;
