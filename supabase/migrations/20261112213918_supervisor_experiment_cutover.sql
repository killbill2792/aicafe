-- Task 8a: owner-scoped verified price experiment windows and durable notices.
-- Additive only; no existing cron, POS writer, generic Task 10 RPC or production effect.
set lock_timeout='5s';
set statement_timeout='45s';

create table public.supervisor_experiment_cutover_cafes (
 business_id uuid primary key references public.businesses(id) on delete cascade,
 mode text not null default 'legacy' check(mode in ('legacy','shadow','new')),
 parity_proven_at timestamptz,
 rollback_proven_at timestamptz,
 release_approved_at timestamptz,
 enabled_at timestamptz,
 updated_at timestamptz not null default now(),
 constraint supervisor_8a_new_requires_all_gates check (
  mode<>'new' or (parity_proven_at is not null and
   rollback_proven_at is not null and release_approved_at is not null))
);
-- Reason: supervisor_experiment_cutover_cafes is created here; RLS is required before granting owner-scoped read access.
-- squawk-ignore ban-alter-row-level-security
alter table public.supervisor_experiment_cutover_cafes enable row level security;
revoke all on public.supervisor_experiment_cutover_cafes from public,anon,authenticated;
grant select on public.supervisor_experiment_cutover_cafes to authenticated;
grant all on public.supervisor_experiment_cutover_cafes to service_role;
create policy supervisor_8a_cutover_owner_read
 on public.supervisor_experiment_cutover_cafes for select to authenticated
 using (exists (select 1 from public.memberships m
   where m.business_id=supervisor_experiment_cutover_cafes.business_id
    and m.user_id=(select auth.uid()) and m.role='owner'));

-- Reason: window indexes are explicitly bounded to 0..90 and revision counters are small.
-- squawk-ignore prefer-bigint-over-int
create table public.supervisor_monitor_windows (
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null references public.businesses(id) on delete cascade,
 owner_user_id uuid not null references auth.users(id) on delete cascade,
 monitor_kind text not null check (monitor_kind in ('approved_price','toast_price_observation')),
 source_id uuid not null,
 window_index integer not null check (window_index between 0 and 90),
 source_reference jsonb not null default '{}'::jsonb
   check (jsonb_typeof(source_reference)='object'),
 start_at timestamptz not null,
 end_at timestamptz not null,
 actual_final_close_at timestamptz,
 coverage_status text not null default 'unknown'
   check (coverage_status in ('unknown','partial','actual')),
 units numeric(18,2),
 revenue_cents bigint,
 unknown_time_lines integer not null default 0 check (unknown_time_lines>=0),
 evaluation_status text not null default 'in_progress'
   check (evaluation_status in ('in_progress','insufficient_evidence','complete')),
 report_revision integer not null default 1 check (report_revision>0),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (business_id,monitor_kind,source_id,window_index),
 constraint supervisor_8a_elapsed_window check (
  end_at=start_at+interval '24 hours' and
  (actual_final_close_at is null or actual_final_close_at>=end_at)),
 constraint supervisor_8a_coverage_consistent check(
  coverage_status<>'actual' or
  (unknown_time_lines=0 and units is not null and revenue_cents is not null))
);
create index supervisor_8a_windows_by_owner on public.supervisor_monitor_windows
 (business_id,owner_user_id,monitor_kind,updated_at desc);
-- Reason: supervisor_monitor_windows is created here; RLS is required before granting owner-scoped read access.
-- squawk-ignore ban-alter-row-level-security
alter table public.supervisor_monitor_windows enable row level security;
revoke all on public.supervisor_monitor_windows from public,anon,authenticated;
grant select on public.supervisor_monitor_windows to authenticated;
grant all on public.supervisor_monitor_windows to service_role;
create policy supervisor_8a_windows_owner_read
 on public.supervisor_monitor_windows for select to authenticated
 using (owner_user_id=(select auth.uid()) and exists(
  select 1 from public.memberships m
  where m.business_id=supervisor_monitor_windows.business_id
   and m.user_id=(select auth.uid()) and m.role='owner'));

-- Capture every actual canonical Toast price-context mutation at database time.
-- The latest menu publication stamp is NOT when a strategy first changed.
-- A later unrelated menu publication must never erase an in-window change.
create table public.supervisor_toast_price_context_changes (
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null references public.businesses(id) on delete cascade,
 menu_item_id uuid not null references public.menu_items(id) on delete cascade,
 old_pos_item_id text,
 new_pos_item_id text,
 old_pricing_strategy text,
 new_pricing_strategy text,
 old_catalog_source text,
 new_catalog_source text,
 old_is_active boolean,
 new_is_active boolean,
 old_price_cents bigint,
 new_price_cents bigint,
 old_publication_state text,
 new_publication_state text,
 observed_at timestamptz not null default clock_timestamp()
);
create index supervisor_8a_context_history
 on public.supervisor_toast_price_context_changes
 (business_id,menu_item_id,observed_at,id);
-- Reason: supervisor_toast_price_context_changes is created here; RLS is required before granting owner-scoped read access.
-- squawk-ignore ban-alter-row-level-security
alter table public.supervisor_toast_price_context_changes enable row level security;
revoke all on public.supervisor_toast_price_context_changes
 from public,anon,authenticated;
grant select on public.supervisor_toast_price_context_changes to service_role;
-- The client cannot forge observation dates: only an actual menu_items
-- UPDATE can insert a row. This trigger is callable only by PostgreSQL.
create function public.supervisor_8a_record_toast_price_context()
 returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op<>'UPDATE' or
    (old.catalog_source is distinct from 'toast'
     and new.catalog_source is distinct from 'toast') then return new;end if;
 if old.pos_item_id is distinct from new.pos_item_id or
    old.pos_pricing_strategy is distinct from new.pos_pricing_strategy or
    old.catalog_source is distinct from new.catalog_source or
    old.is_active is distinct from new.is_active or
    old.price_cents is distinct from new.price_cents or
    old.toast_publication_state is distinct from new.toast_publication_state then
  insert into public.supervisor_toast_price_context_changes (
   business_id,menu_item_id,old_pos_item_id,new_pos_item_id,
   old_pricing_strategy,new_pricing_strategy,
   old_catalog_source,new_catalog_source,old_is_active,new_is_active,
   old_price_cents,new_price_cents,old_publication_state,new_publication_state,
   observed_at)
  values (new.business_id,new.id,old.pos_item_id,new.pos_item_id,
   old.pos_pricing_strategy,new.pos_pricing_strategy,
   old.catalog_source,new.catalog_source,old.is_active,new.is_active,
   old.price_cents,new.price_cents,
   old.toast_publication_state,new.toast_publication_state,
   clock_timestamp());
 end if;
 return new;
end;$$;
revoke all on function public.supervisor_8a_record_toast_price_context()
 from public,anon,authenticated;
grant execute on function public.supervisor_8a_record_toast_price_context()
 to service_role;
create trigger supervisor_8a_toast_price_context_change
 after update on public.menu_items
 for each row
 when (
  old.pos_item_id is distinct from new.pos_item_id or
  old.pos_pricing_strategy is distinct from new.pos_pricing_strategy or
  old.catalog_source is distinct from new.catalog_source or
  old.is_active is distinct from new.is_active or
  old.price_cents is distinct from new.price_cents or
  old.toast_publication_state is distinct from new.toast_publication_state
 )
 execute function public.supervisor_8a_record_toast_price_context();

-- Reason: reminder slots are 0..2 and retries are capped at 30; these counters cannot overflow.
-- squawk-ignore prefer-bigint-over-int, prefer-bigint-over-smallint
create table public.supervisor_experiment_notice_receipts (
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null references public.businesses(id) on delete cascade,
 owner_user_id uuid not null references auth.users(id) on delete cascade,
 source_id uuid not null,
 kind text not null check(kind in ('price_reminder','toast_price_initial',
  'toast_price_daily','toast_price_final')),
 local_date date not null,
 slot smallint not null default 0 check(slot between 0 and 2),
 state text not null default 'claimed' check(state in ('claimed','failed','posted')),
 claimed_at timestamptz not null default now(),
 posted_at timestamptz,
 retry_at timestamptz,
 attempts integer not null default 1 check(attempts between 1 and 30),
 task_id text,
 message_id uuid,
 last_error_category text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(business_id,owner_user_id,source_id,kind,local_date,slot),
 check((kind='price_reminder' and slot in (1,2)) or
       (kind<>'price_reminder' and slot=0)),
 check(state<>'posted' or posted_at is not null)
);
create index supervisor_8a_notice_retry on public.supervisor_experiment_notice_receipts
 (state,retry_at) where state<>'posted';
-- Reason: supervisor_experiment_notice_receipts is created here; RLS is required before granting owner-scoped read access.
-- squawk-ignore ban-alter-row-level-security
alter table public.supervisor_experiment_notice_receipts enable row level security;
revoke all on public.supervisor_experiment_notice_receipts from public,anon,authenticated;
grant select on public.supervisor_experiment_notice_receipts to authenticated;
grant all on public.supervisor_experiment_notice_receipts to service_role;
create policy supervisor_8a_notice_owner_read
 on public.supervisor_experiment_notice_receipts for select to authenticated
 using (owner_user_id=(select auth.uid()) and exists(
  select 1 from public.memberships m
  where m.business_id=supervisor_experiment_notice_receipts.business_id
   and m.user_id=(select auth.uid()) and m.role='owner'));

-- A lease is not a delivery receipt. Only the existing operating_tasks +
-- ai_messages writes may advance state to posted, with stable identifiers.
-- Advisory lock and uniqueness serialize concurrent cron workers and cap
-- reminders at two owner/source/local-date slots.
create function public.supervisor_8a_claim_notice(
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
  (p_kind<>'price_reminder' and p_slot<>0) then
  raise exception 'invalid_notice_key' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(
  concat_ws(':',p_business_id,p_owner_user_id,p_source_id,p_local_date),0));
 -- Do not send a reminder for a cancelled, rejected, superseded or
 -- already-confirmed proposal. A cron read may race an owner action.
 if p_kind='price_reminder' and not exists (
  select 1 from public.supervisor_proposals p
  where p.business_id=p_business_id and p.owner_user_id=p_owner_user_id
   and p.id=p_source_id and p.status='manual_pending'
   and p.approved_at is not null
 ) then return null;end if;
 if p_kind<>'price_reminder' and not exists (
  select 1 from public.menu_price_history h
  where h.business_id=p_business_id and h.id=p_source_id
   and h.source_type='connected_pos' and h.source_provider='toast'
   and h.toast_restaurant_guid is not null
   and h.toast_publication_version is not null
   and h.toast_observed_at is not null
   and h.old_price_cents>0 and h.new_price_cents>0
   and h.old_price_cents<>h.new_price_cents
 ) then return null;end if;
 select * into v_existing from public.supervisor_experiment_notice_receipts
  where business_id=p_business_id and owner_user_id=p_owner_user_id
   and source_id=p_source_id and kind=p_kind
   and local_date=p_local_date and slot=p_slot for update;
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

-- The generic Task 10 transition function is deliberately NOT edited.
-- Reject a Toast-connected owner's "Done" as publication verification until
-- the exact restaurant, source item/size, approved before/after and current
-- publication are independently authenticated by the existing POS0d receipt.
create function public.supervisor_8a_guard_toast_manual_confirmation()
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
    and s.menu_copied_at>=h.toast_observed_at-interval '20 minutes'
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
create trigger supervisor_8a_toast_price_confirmation_guard
 before update on public.supervisor_proposals
 for each row execute function public.supervisor_8a_guard_toast_manual_confirmation();

reset lock_timeout;
reset statement_timeout;
