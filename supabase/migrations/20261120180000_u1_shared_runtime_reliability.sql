-- U1: preserve original sources/keys; only change coordination and no-op writes.
-- Existing cron and post-import caller are the ONLY producers.
create table public.supervisor_derived_refresh_state (
 business_id uuid primary key references public.businesses(id) on delete cascade,
 requested_version bigint not null default 0 check(requested_version>=0),
 completed_version bigint not null default 0 check(completed_version>=0 and completed_version<=requested_version),
 claimed_version bigint,
 lease_token uuid,
 lease_until timestamptz,
 last_started_at timestamptz,
 last_success_at timestamptz,
 last_error text,
 check ((lease_token is null and lease_until is null and claimed_version is null)
   or (lease_token is not null and lease_until is not null and claimed_version is not null))
);
alter table public.supervisor_derived_refresh_state enable row level security;
revoke all on table public.supervisor_derived_refresh_state from public,anon,authenticated;
grant select on table public.supervisor_derived_refresh_state to service_role;

-- A short transaction serializes admission, NOT the business refresh.
-- Only one full derived refresh fleet-wide; any overlapping import/cron
-- increments the durable generation, so completion cannot lose a later request.
create or replace function public.supervisor_claim_derived_refresh(p_business_id uuid,p_admit boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v public.supervisor_derived_refresh_state; v_now timestamptz;v_token uuid;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_business_id is null or p_admit is null
  then raise exception 'derived refresh unauthorized' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('supervisor-derived-refresh-admission-v1',0));
 if not exists(select 1 from public.businesses b where b.id=p_business_id and not b.is_demo)
  then raise exception 'derived refresh scope unavailable' using errcode='42501';end if;
 v_now:=clock_timestamp();
 insert into public.supervisor_derived_refresh_state(business_id,requested_version)
  values(p_business_id,1)
  on conflict(business_id) do update set requested_version=supervisor_derived_refresh_state.requested_version+1
  returning * into v;
 if not p_admit or exists(select 1 from public.supervisor_derived_refresh_state s
  where s.lease_token is not null and s.lease_until>v_now) then return null;end if;
 v_token:=gen_random_uuid();
 update public.supervisor_derived_refresh_state set lease_token=v_token,
  lease_until=v_now+interval '6 minutes',claimed_version=v.requested_version,last_started_at=v_now,
  last_error=case when v.lease_token is not null and v.lease_until<=v_now then 'lease_expired' else v.last_error end
  where business_id=p_business_id;
 return jsonb_build_object('token',v_token);
end $$;
revoke all on function public.supervisor_claim_derived_refresh(uuid,boolean) from public,anon,authenticated;
grant execute on function public.supervisor_claim_derived_refresh(uuid,boolean) to service_role;

create or replace function public.supervisor_finish_derived_refresh(p_business_id uuid,p_token uuid,p_success boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v public.supervisor_derived_refresh_state;v_now timestamptz:=clock_timestamp();
begin
 if coalesce(auth.role(),'')<>'service_role' or p_success is null
  then raise exception 'derived refresh unauthorized' using errcode='42501';end if;
 update public.supervisor_derived_refresh_state set
  completed_version=case when p_success then claimed_version else completed_version end,
  last_success_at=case when p_success then v_now else last_success_at end,
  last_error=case when p_success then null else 'derived_refresh_failed' end,
  lease_token=null,lease_until=null,claimed_version=null
 where business_id=p_business_id and lease_token=p_token and lease_until>v_now returning * into v;
 if not found then return jsonb_build_object('accepted',false,'pending',true);end if;
 return jsonb_build_object('accepted',true,'pending',v.requested_version>v.completed_version);
end $$;
revoke all on function public.supervisor_finish_derived_refresh(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.supervisor_finish_derived_refresh(uuid,uuid,boolean) to service_role;

-- Least recently started first. No unfinished café disappears when a
-- previous invocation reaches its deadline; no external cursor or new cron.
create or replace function public.supervisor_list_derived_refresh_businesses()
returns table(id uuid,timezone text,is_demo boolean)
language plpgsql stable security definer set search_path=public as $$
begin
 if coalesce(auth.role(),'')<>'service_role'
  then raise exception 'derived refresh unauthorized' using errcode='42501';end if;
 return query select b.id,b.timezone,b.is_demo from public.businesses b
 left join public.supervisor_derived_refresh_state s on s.business_id=b.id
 where not b.is_demo
 order by s.last_started_at asc nulls first,b.id limit 100;
end $$;
revoke all on function public.supervisor_list_derived_refresh_businesses() from public,anon,authenticated;
grant execute on function public.supervisor_list_derived_refresh_businesses() to service_role;

-- An explicit, server-verified owner binding for unattended callers. Existing
-- one-argument browser entry remains owner-only and cannot be used by service role.
create or replace function public.toast_business_scope_summary(p_business_id uuid,p_owner_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v jsonb;
begin
 if not (coalesce(auth.role(),'')='service_role' or
  (coalesce(auth.role(),'')='authenticated' and auth.uid()=p_owner_user_id))
  or not exists(select 1 from public.memberships m where
   m.business_id=p_business_id and m.user_id=p_owner_user_id and m.role='owner')
  then raise exception 'Toast scopes unauthorized' using errcode='42501';end if;
 select to_jsonb(c.scopes_available) into v from public.toast_api_credentials c
 where c.business_id=p_business_id;
 return jsonb_build_object(
  'menus',case when jsonb_typeof(v->'menus')='boolean' then (v->>'menus')::boolean else null end,
  'labor',case when jsonb_typeof(v->'labor')='boolean' then (v->>'labor')::boolean else null end
 );
end $$;
revoke all on function public.toast_business_scope_summary(uuid,uuid) from public,anon,authenticated;
grant execute on function public.toast_business_scope_summary(uuid,uuid) to service_role;
create or replace function public.toast_business_scope_summary(p_business_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 if coalesce(auth.role(),'')<>'authenticated' or not public.scheduling_is_owner(p_business_id)
  then raise exception 'Toast scopes unauthorized' using errcode='42501';end if;
 return public.toast_business_scope_summary(p_business_id,auth.uid());
end $$;

-- Same matching rules and historical placeholders. MATERIALIZED evaluates
-- the existing candidate link once; do not rewrite a line whose identity is unchanged.
alter table public.toast_sync_phase_errors add column last_recovered_at timestamptz;
create or replace function public.pos_relink_toast_lines(p_business_id uuid,p_restaurant_guid uuid,p_business_date date)
returns integer language plpgsql security definer set search_path=public as $
declare v_prefix text;v_count integer;v_date date:=p_business_date;v_failed_at timestamptz;
begin
 if coalesce(auth.role(),'')<>'service_role' or not exists(
  select 1 from public.toast_location_mappings where business_id=p_business_id
  and restaurant_guid=p_restaurant_guid and verified_at is not null)
 then raise exception 'POS relink unauthorized' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('pos-menu:'||p_business_id::text,0));
 -- A prior failed post-commit relink must not be forgotten by a subsequent
 -- narrow day import. Retain the failure receipt; recover the broader scope.
 select e.last_failed_at into v_failed_at from public.toast_sync_phase_errors e
  where e.business_id=p_business_id and e.restaurant_guid=p_restaurant_guid and e.phase='sales_link'
   and (e.last_recovered_at is null or e.last_recovered_at<e.last_failed_at);
 if v_failed_at is not null then v_date:=null;end if;
 v_prefix:='toast:'||p_restaurant_guid::text||':';
 -- Only sold GUIDs actually present on Toast order lines become archived placeholders.
 insert into public.menu_items(business_id,pos_item_id,name,base_name,price_cents,is_active,
  pos_archived_at,catalog_source)
 select p_business_id,l.pos_item_id,min(l.name),min(l.name),null,false,now(),'toast'
 from public.order_lines l join public.orders o on o.id=l.order_id
 where o.business_id=p_business_id and (v_date is null or o.business_date=v_date) and l.pos_item_id like v_prefix||'%'
 and not exists (select 1 from public.menu_items i
  where i.business_id=p_business_id and (i.pos_item_id=l.pos_item_id
    or i.pos_item_id like l.pos_item_id||':size:%'))
 group by l.pos_item_id
 on conflict(business_id,pos_item_id) do nothing;
 -- The size option in order_lines.modifiers is the Toast option GUID, not a fabricated item GUID.
 with candidates as materialized (
 select l.id,coalesce(
 (select mi.id from public.menu_items mi
   where mi.business_id=p_business_id and
   mi.pos_item_id=l.pos_item_id||':size:'||
     trim(both '"' from coalesce((
       select m->>'posModifierId' from jsonb_array_elements(l.modifiers)m
       where exists(select 1 from public.menu_items sz
        where sz.business_id=p_business_id and
         sz.pos_item_id=l.pos_item_id||':size:'||(m->>'posModifierId'))
       limit 1),''))
   limit 1),
 (select mi.id from public.menu_items mi
   where mi.business_id=p_business_id and mi.pos_item_id=l.pos_item_id limit 1),
 (select min(mi.id::text)::uuid from public.menu_items mi
   where mi.business_id=p_business_id and mi.pos_item_id like l.pos_item_id||':size:%'
   having count(*)=1)) as new_menu_item_id
 from public.order_lines l join public.orders o on o.id=l.order_id
 where o.business_id=p_business_id and (v_date is null or o.business_date=v_date)
  and l.pos_item_id like v_prefix||'%'
  and (l.menu_item_id is null or exists(select 1 from public.menu_items current_item
    where current_item.id=l.menu_item_id and current_item.pos_item_id=l.pos_item_id))
  and exists(select 1 from public.menu_items i where i.business_id=p_business_id
   and (i.pos_item_id=l.pos_item_id or i.pos_item_id like l.pos_item_id||':size:%'))
 )
 update public.order_lines l set menu_item_id=c.new_menu_item_id
 from candidates c where l.id=c.id and l.menu_item_id is distinct from c.new_menu_item_id;
 get diagnostics v_count=row_count;
 if v_date is null and v_failed_at is not null then
  update public.toast_sync_phase_errors set last_recovered_at=clock_timestamp()
  where business_id=p_business_id and restaurant_guid=p_restaurant_guid and phase='sales_link'
   and last_failed_at=v_failed_at;
 end if;
 return v_count;
end $;
revoke all on function public.pos_relink_toast_lines(uuid,uuid,date) from public,anon,authenticated;
grant execute on function public.pos_relink_toast_lines(uuid,uuid,date) to service_role;
-- Catalog changes still re-evaluate the restaurant's eligible history.
create or replace function public.pos_relink_toast_lines(p_business_id uuid,p_restaurant_guid uuid)
returns integer language plpgsql security definer set search_path=public as $
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'POS relink unauthorized' using errcode='42501';end if;
 return public.pos_relink_toast_lines(p_business_id,p_restaurant_guid,null::date);
end $;
revoke all on function public.pos_relink_toast_lines(uuid,uuid) from public,anon,authenticated;
grant execute on function public.pos_relink_toast_lines(uuid,uuid) to service_role;

-- Preserve the existing fair, revision-fenced investigation claim. Refresh
-- the trusted clock at admission, even if the cron began several minutes ago.
create or replace function public.supervisor_claim_investigation(p_now timestamptz)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v public.supervisor_investigations;v_token uuid;v_open boolean;
  v_exists boolean;v_status_open boolean;v_scan integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required' using errcode='42501'; end if;
  if p_now is null then raise exception 'Invalid instant' using errcode='22023'; end if;
  -- A delayed caller or database wait cannot claim with an already expired lease.
  p_now:=greatest(p_now,clock_timestamp());
  -- Serialize only the brief selection transaction, never the investigation.
  -- Concurrent ticks do not all choose a noisy café from the same snapshot.
  if not pg_try_advisory_xact_lock(hashtextextended('supervisor-investigation-dispatch-v1',0))
    then return null; end if;
  -- A stale or revoked row must not hide healthy work elsewhere in the queue.
  -- Bounded cleanup in the SAME transaction; no unbounded worker loop.
  for v_scan in 1..16 loop
  with last_served as (
    select business_id,max(last_claimed_at) as served
      from public.supervisor_investigations group by business_id
  )
  select i.* into v from public.supervisor_investigations i
    join last_served s on s.business_id=i.business_id
    where i.phase in ('collect','investigate','awaiting_owner')
      and i.next_retry_at<=p_now and (i.lease_until is null or i.lease_until<=p_now)
    -- First choose the least recently served café, then preserve that café's
    -- urgency and aging. New incidents do not reset the café's dispatch history.
    order by s.served asc nulls first,
      (i.priority+least(250,greatest(0,
      extract(epoch from (p_now-i.created_at))/3600))::integer) desc,
      i.next_retry_at asc,i.created_at asc,i.business_id asc,i.source_id asc,i.owner_user_id asc
    for update of i skip locked limit 1;
  if not found then return null; end if;
  if not public.supervisor_routine_owner_authorized(
    v.business_id,v.owner_user_id,v.thread_id) then
    update public.supervisor_investigations set phase='blocked',last_error='authorization_revoked',
      lease_token=null,lease_until=null,updated_at=p_now
    where business_id=v.business_id and owner_user_id=v.owner_user_id
      and source_type=v.source_type and source_id=v.source_id;
    continue;
  end if;
  -- Missing evidence is NOT verified resolution. Neither is a still-open
  -- owner task reassigned to someone else. Treat these as blocked exceptions.
  if v.source_type='alert' then
    select exists(select 1 from public.alerts a
      where a.business_id=v.business_id and a.id::text=v.source_id) into v_exists;
    select exists(select 1 from public.alerts a
      where a.business_id=v.business_id and a.id::text=v.source_id
        and a.status in ('new','seen')) into v_open;
    v_status_open:=v_open;
  else
    select exists(select 1 from public.operating_tasks t
      where t.business_id=v.business_id and t.id=v.source_id) into v_exists;
    select exists(select 1 from public.operating_tasks t
      where t.business_id=v.business_id and t.id=v.source_id
        and t.status in ('needs_owner','needs_response','watching')) into v_status_open;
    select exists(select 1 from public.operating_tasks t
      where t.business_id=v.business_id and t.id=v.source_id
        and t.status in ('needs_owner','needs_response','watching')
        and (t.owner_user_id is null or t.owner_user_id=v.owner_user_id)) into v_open;
  end if;
  if not v_open then
    update public.supervisor_investigations set
      phase=case when v_exists and not v_status_open then 'resolved' else 'blocked' end,
      last_error=case when not v_exists then 'source_missing'
        when v_status_open then 'source_reassigned' else 'source_closed' end,
      lease_token=null,lease_until=null,updated_at=p_now
    where business_id=v.business_id and owner_user_id=v.owner_user_id
      and source_type=v.source_type and source_id=v.source_id;
    -- Deleted/reassigned/closed source data must not leave private,
    -- now-obsolete investigation reports in the owner's active inbox.
    update public.operating_tasks set status='handled',
      resolved_at=coalesce(resolved_at,p_now)
      where business_id=v.business_id and owner_user_id=v.owner_user_id
        and kind='priority_notice' and status in ('needs_owner','needs_response','watching')
        and payload->>'intent'='priority_investigation'
        and payload->>'sourceType'=v.source_type
        and payload->>'sourceId'=v.source_id;
    continue;
  end if;
  v_token:=gen_random_uuid();
  update public.supervisor_investigations set lease_token=v_token,
    lease_until=greatest(p_now,clock_timestamp())+interval '3 minutes',last_claimed_at=clock_timestamp(),updated_at=p_now
    where business_id=v.business_id and owner_user_id=v.owner_user_id
      and source_type=v.source_type and source_id=v.source_id;
  return jsonb_build_object('business_id',v.business_id,'owner_user_id',v.owner_user_id,
    'thread_id',v.thread_id,'source_type',v.source_type,'source_id',v.source_id,
    'revision_hash',v.revision_hash,'stable_key',v.stable_key,
    'episode_id',v.episode_id,
    'phase',v.phase,'evidence',v.evidence,'narrative',v.narrative,
    'last_error',v.last_error,'step_version',v.step_version,
    'lease_token',v_token);
  end loop;
  return null;
end $$;
revoke all on function public.supervisor_claim_investigation(timestamptz) from public,anon,authenticated;
grant execute on function public.supervisor_claim_investigation(timestamptz) to service_role;

-- Existing per-owner FIFO and authorization; do not lock every opted-in
-- binding on an idle poll. Index exactly the pending FIFO selector and expiry.
create index whatsapp_inbound_pending_binding_idx on public.whatsapp_inbound(binding_id,provider_at,received_at) where state='queued' and attempts<5;
create index whatsapp_inbound_expiry_idx on public.whatsapp_inbound(leased_until) where state='leased';
create or replace function public.whatsapp_claim_inbound() returns jsonb
language plpgsql security definer set search_path=public as $$
declare b public.whatsapp_owner_bindings; i public.whatsapp_inbound;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_only'; end if;
 update public.whatsapp_inbound set state=case when attempts>=5 then 'failed' else 'queued' end,
   error_code='lease_expired',lease_token=null,leased_until=null
   where state='leased' and leased_until<now();
 for b in select x.* from public.whatsapp_owner_bindings x where x.opted_in
   and exists(select 1 from public.whatsapp_inbound pending
    where pending.binding_id=x.id and pending.state='queued' and pending.attempts<5)
   order by x.id for update skip locked loop
   if not public.whatsapp_binding_active(b.id) or
     not pg_try_advisory_xact_lock(hashtextextended('wa_inbound:'||b.owner_user_id::text,0))
      then continue; end if;
   if exists (select 1 from public.whatsapp_inbound j where j.owner_user_id=b.owner_user_id and j.state='leased')
     then continue; end if;
   select * into i from public.whatsapp_inbound
     where binding_id=b.id and state='queued' and attempts<5
     order by provider_at,received_at limit 1 for update skip locked;
   if not found then continue; end if;
   update public.whatsapp_inbound set state='leased',attempts=attempts+1,
     lease_token=gen_random_uuid(),leased_until=now()+interval '3 minutes'
     where wamid=i.wamid returning * into i;
   return to_jsonb(i);
 end loop;
 return null;
end $$;
revoke all on function public.whatsapp_claim_inbound() from public,anon,authenticated;
grant execute on function public.whatsapp_claim_inbound() to service_role;

-- Legacy three-argument RPC remains available for diagnostic candidate dates.
-- The business guard only needs the intersection with actual canonical orders.
-- All canonical order dates are already members of that legacy union. Return
-- the exact date set in one small response, not 365 REST existence requests.
create or replace function public.toast_unverified_sales_dates(
 p_business_id uuid,p_from date,p_to date,p_canonical_only boolean)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare dates jsonb;
begin
 if p_canonical_only is distinct from true or p_business_id is null
  or (coalesce(auth.role(),'')<>'service_role' and (auth.uid() is null or not is_member(p_business_id)))
  or p_from is null or p_to is null or p_to<p_from or p_to>p_from+370
 then raise exception 'not authorized for Toast reporting coverage' using errcode='42501';end if;
 select coalesce(jsonb_agg(d.business_date order by d.business_date),'[]'::jsonb) into dates
 from (select p_from+g.n as business_date from generate_series(0,p_to-p_from) g(n)) d
 where exists(select 1 from public.orders o
  where o.business_id=p_business_id and o.business_date=d.business_date
   and o.pos_order_id like 'toast:%');
 return jsonb_build_object('canonicalDates',dates);
end $$;
revoke all on function public.toast_unverified_sales_dates(uuid,date,date,boolean) from public,anon;
grant execute on function public.toast_unverified_sales_dates(uuid,date,date,boolean) to authenticated,service_role;
