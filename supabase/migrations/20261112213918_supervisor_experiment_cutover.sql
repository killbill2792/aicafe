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

create table public.supervisor_monitor_windows (
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null references public.businesses(id) on delete cascade,
 owner_user_id uuid not null references auth.users(id) on delete cascade,
 monitor_kind text not null check (monitor_kind in ('approved_price','toast_price_observation')),
 source_id uuid not null,
 window_index bigint not null check (window_index between 0 and 90),
 source_reference jsonb not null default '{}'::jsonb
   check (jsonb_typeof(source_reference)='object'),
 start_at timestamptz not null,
 end_at timestamptz not null,
 actual_final_close_at timestamptz,
 coverage_status text not null default 'unknown'
   check (coverage_status in ('unknown','partial','actual')),
 units numeric(18,2),
 revenue_cents bigint,
 unknown_time_lines bigint not null default 0 check (unknown_time_lines>=0),
 evaluation_status text not null default 'in_progress'
   check (evaluation_status in ('in_progress','insufficient_evidence','complete')),
 report_revision bigint not null default 1 check (report_revision>0),
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

-- Task 10 permits authenticated owner history writes and older menu RLS
-- permits member edits. Neither is authority to stamp a Toast publication.
-- Gate the ORIGINAL write (not only the later read): authenticated menu edits
-- cannot fabricate provider context, and member import receipts remain non-Toast.
-- SECURITY INVOKER makes current_user the actual PostgreSQL request role.
create function public.supervisor_8a_protect_toast_menu_source()
 returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if current_user not in ('anon','authenticated') and
    coalesce(auth.role(),'') not in ('anon','authenticated') then return new;end if;
 if tg_op='INSERT' then
  if new.catalog_source='toast' or
     new.pos_item_id ~* '^toast:' or
     new.toast_publication_state is distinct from 'unknown' or
     new.toast_publication_version is not null or
     new.toast_publication_observed_at is not null then
   raise exception 'toast_menu_source_service_role_only' using errcode='42501';
  end if;
 elsif new.toast_publication_state is distinct from old.toast_publication_state or
       new.toast_publication_version is distinct from old.toast_publication_version or
       new.toast_publication_observed_at is distinct from old.toast_publication_observed_at or
       ((old.catalog_source='toast' or new.catalog_source='toast' or
          old.pos_item_id ~* '^toast:' or new.pos_item_id ~* '^toast:')
        and (new.price_cents is distinct from old.price_cents or
             new.pos_item_id is distinct from old.pos_item_id or
             new.catalog_source is distinct from old.catalog_source or
             new.pos_pricing_strategy is distinct from old.pos_pricing_strategy)) then
  raise exception 'toast_menu_source_service_role_only' using errcode='42501';
 end if;
 return new;
end;$$;
revoke all on function public.supervisor_8a_protect_toast_menu_source()
 from public,anon,authenticated;
create trigger supervisor_8a_protect_toast_menu_source
 before insert or update on public.menu_items
 for each row execute function public.supervisor_8a_protect_toast_menu_source();

-- The Task 10 legacy authenticated import route may append non-Toast
-- connected_pos rows, but must never forge Toast-stamped history or later
-- tamper with an existing server-verified receipt.
create function public.supervisor_8a_protect_toast_price_history()
 returns trigger language plpgsql security invoker set search_path='' as $$
declare protected_source boolean;
begin
 if current_user not in ('anon','authenticated') and
    coalesce(auth.role(),'') not in ('anon','authenticated') then
  if tg_op='DELETE' then return old;end if;
  return new;
 end if;
 if tg_op='DELETE' then
  protected_source:=old.source_provider='toast' or
   old.toast_restaurant_guid is not null or
   old.toast_publication_version is not null or
   old.toast_observed_at is not null or
   old.toast_effective_at is not null;
 else
  protected_source:=new.source_provider='toast' or
   new.toast_restaurant_guid is not null or
   new.toast_publication_version is not null or
   new.toast_observed_at is not null or
   new.toast_effective_at is not null;
  if tg_op='UPDATE' then
   protected_source:=coalesce(protected_source,false) or
    old.source_provider='toast' or
    old.toast_restaurant_guid is not null or
    old.toast_publication_version is not null or
    old.toast_observed_at is not null or
    old.toast_effective_at is not null;
  end if;
 end if;
 if coalesce(protected_source,false) then
  raise exception 'toast_history_source_service_role_only' using errcode='42501';
 end if;
 if tg_op='DELETE' then return old;end if;
 return new;
end;$$;
revoke all on function public.supervisor_8a_protect_toast_price_history()
 from public,anon,authenticated;
create trigger supervisor_8a_protect_toast_price_history
 before insert or update or delete on public.menu_price_history
 for each row execute function public.supervisor_8a_protect_toast_price_history();

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

create table public.supervisor_experiment_notice_receipts (
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null references public.businesses(id) on delete cascade,
 owner_user_id uuid not null references auth.users(id) on delete cascade,
 source_id uuid not null,
 kind text not null check(kind in ('price_reminder','toast_price_initial',
  'toast_price_daily','toast_price_final')),
 local_date date not null,
 slot bigint not null default 0 check(slot between 0 and 2),
 state text not null default 'claimed' check(state in ('claimed','failed','posted')),
 claimed_at timestamptz not null default now(),
 posted_at timestamptz,
 retry_at timestamptz,
 attempts bigint not null default 1 check(attempts between 1 and 30),
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

-- Task 8a postcondition reconciliation: extend the ALREADY AUTHORIZED
-- Task 10 effect gateway without a second effect writer or a local price CAS.
-- All Task 10 capability branches, owner/mandate identity, claim age, effect
-- hash, row locks and uncertain-state semantics remain unchanged. The sole
-- new branch recovers an inert Toast Web manual instruction when the gateway
-- claimed it but crashed before persisting manual_pending.
-- Recovery of real owner_manual price writes STILL requires Task 10's
-- exact proposal-stamped canonical history; no current price alone is proof.
create or replace function public.supervisor_reconcile_effect_attempt(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid,
  p_proposal_id uuid, p_revision integer
) returns public.supervisor_proposals
language plpgsql security definer set search_path = public as $$
declare
  p public.supervisor_proposals;
  a public.supervisor_effect_attempts;
  stock public.pantry_stock_purchases;
  price_record public.menu_price_history;
  next_status text := null;
  next_start date := null;
  proof_ref text := null;
begin
  if auth.role() is distinct from 'service_role'
  then raise exception 'service_role_only' using errcode = '42501'; end if;
  if not exists (select 1 from public.memberships m
    where m.business_id = p_business_id and m.user_id = p_owner_user_id and m.role = 'owner')
  then raise exception 'proposal_owner_required' using errcode = '42501'; end if;
  select * into p from public.supervisor_proposals
    where business_id = p_business_id and owner_user_id = p_owner_user_id
      and thread_id = p_thread_id and id = p_proposal_id for update;
  if p.id is null or p.revision <> p_revision
  then raise exception 'proposal_revision_conflict' using errcode = 'P0001'; end if;
  select * into a from public.supervisor_effect_attempts
    where business_id = p_business_id and proposal_id = p_proposal_id
      and effect_hash = p.effect_hash for update;
  if a.id is null
  then raise exception 'effect_attempt_missing' using errcode = 'P0001'; end if;
  if a.state = 'verified' and p.status in ('committed','manual_pending')
  then return p; end if; -- idempotent read: no second commit
  if p.status <> 'executing' or a.state not in ('executing','uncertain')
  then raise exception 'effect_attempt_conflict' using errcode = 'P0001'; end if;
  -- Never take over a live claim. A stale claim with no evidence becomes uncertain.
  if a.state = 'executing' and a.created_at > now() - interval '5 minutes'
  then return p; end if;

  -- These three capabilities have no external write. The proposal transition
  -- itself is the only effect; do not call the capability commit function again.
  if p.capability_version = 1 and p.capability_id = 'leo.goal.v1' then
    next_status := 'committed';
    next_start := a.business_date + 1;
    proof_ref := 'inert-goal:' || p.id::text;
  elsif p.capability_version = 1 and p.capability_id = 'alex.drink_price_experiment.v1' then
    next_status := 'manual_pending';
    proof_ref := 'inert-price-experiment:' || p.id::text;
  elsif p.capability_version = 1 and p.capability_id = 'alex.event_readiness.v1'
      and p.canonical_effect_payload->>'startDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}
 then
    next_status := 'committed';
    next_start := (p.canonical_effect_payload->>'startDate')::date;
    proof_ref := 'inert-event-readiness:' || p.id::text;
  elsif p.capability_version = 1 and p.capability_id = 'maya.inventory_purchase.v1' then
    -- The canonical purchase writer uses proposal ID as a stable line ID.
    -- Verify the full immutable purchase identity, not just a matching amount.
    select * into stock from public.pantry_stock_purchases s
      where s.business_id = p.business_id and s.line_id = p.id
        and s.voided_at is null
        and s.ingredient_id::text = p.canonical_effect_payload->>'ingredientId'
        and s.purchase_date::text = p.canonical_effect_payload->>'date'
        and s.entered_quantity = (p.canonical_effect_payload->>'quantity')::numeric
        and s.entered_unit = p.canonical_effect_payload->>'unit'
        and s.cost_cents is not distinct from
          (p.canonical_effect_payload->>'costCents')::bigint
        and s.source = p.canonical_effect_payload->>'source';
    if stock.id is not null then
      next_status := 'committed';
      next_start := a.business_date + 1;
      proof_ref := 'pantry_stock_purchases:' || stock.id::text;
    end if;
  elsif p.capability_version = 1 and p.capability_id = 'alex.menu_price_change.v1' then
    -- This exact proposal-scoped history marker is written by the existing
    -- canonical price CAS writer, in its same transaction. A matching current
    -- price without this durable receipt is deliberately not sufficient.
    select * into price_record from public.menu_price_history h
      where h.business_id = p.business_id
        and h.menu_item_id::text = p.canonical_effect_payload->>'productId'
        and h.old_price_cents = (p.canonical_effect_payload->>'oldPriceCents')::bigint
        and h.new_price_cents = (p.canonical_effect_payload->>'newPriceCents')::bigint
        and h.source_type = 'owner_manual'
        and h.source_provider = 'Alex (owner approved; proposal ' || p.id::text || ')'
        and h.changed_at >= a.created_at
        and exists (select 1 from public.menu_items m
          where m.business_id = p.business_id and m.id = h.menu_item_id
            and m.price_cents = h.new_price_cents)
      order by h.changed_at desc limit 1;
    if price_record.id is not null then
      next_status := 'committed';
      next_start := a.business_date + 1;
      proof_ref := 'menu_price_history:' || price_record.id::text;
    elsif exists (
      select 1 from public.menu_items m
      where m.business_id = p.business_id
        and m.id::text = p.canonical_effect_payload->>'productId'
        and m.catalog_source = 'toast'
        and not exists (
          -- Never mistake a previously applied owner-local price CAS for an
          -- inert Toast handoff if the catalog switched source afterward.
          select 1 from public.menu_price_history h
          where h.business_id = p.business_id and h.menu_item_id = m.id
            and h.source_type = 'owner_manual'
            and h.source_provider =
              'Alex (owner approved; proposal ' || p.id::text || ')'
        )
    ) then
      -- Toast Web handoff is an INERT instruction, not a price write.
      -- The original owner/claim/hash/revision/lease checks above apply.
      -- It is safe to resume manual_pending after an uncertain finish, but
      -- NEVER fabricate a source publication or mark a price committed.
      next_status := 'manual_pending';
      proof_ref := 'inert-toast-price-handoff:' || p.id::text;
    end if;
  end if;

  if next_status is null then
    -- No authoritative receipt: keep the proposal blocked and never resend.
    update public.supervisor_effect_attempts set state = 'uncertain'
      where id = a.id and state = 'executing';
    return p;
  end if;
  update public.supervisor_effect_attempts
    set state = 'verified', receipt_ref = proof_ref, verified_at = now()
    where id = a.id and state in ('executing','uncertain');
  update public.supervisor_proposals set status = next_status,
    revision = revision + 1,
    committed_at = case when next_status = 'committed' then now() else null end,
    monitoring_start_date = next_start, updated_at = now()
    where id = p.id returning * into p;
  return p;
end $$;

reset lock_timeout;
reset statement_timeout;
