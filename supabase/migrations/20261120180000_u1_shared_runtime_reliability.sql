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
  lease_until=v_now+interval '6 minutes',claimed_version=v.requested_version,last_started_at=v_now
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
create or replace function public.pos_relink_toast_lines(p_business_id uuid,p_restaurant_guid uuid)
returns integer language plpgsql security definer set search_path=public as $$
declare v_prefix text;v_count integer;
begin
 if coalesce(auth.role(),'')<>'service_role' or not exists(
  select 1 from public.toast_location_mappings where business_id=p_business_id
  and restaurant_guid=p_restaurant_guid and verified_at is not null)
 then raise exception 'POS relink unauthorized' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('pos-menu:'||p_business_id::text,0));
 v_prefix:='toast:'||p_restaurant_guid::text||':';
 -- Only sold GUIDs actually present on Toast order lines become archived placeholders.
 insert into public.menu_items(business_id,pos_item_id,name,base_name,price_cents,is_active,
  pos_archived_at,catalog_source)
 select p_business_id,l.pos_item_id,min(l.name),min(l.name),null,false,now(),'toast'
 from public.order_lines l join public.orders o on o.id=l.order_id
 where o.business_id=p_business_id and l.pos_item_id like v_prefix||'%'
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
 where o.business_id=p_business_id
  and l.pos_item_id like v_prefix||'%'
  and (l.menu_item_id is null or exists(select 1 from public.menu_items current_item
    where current_item.id=l.menu_item_id and current_item.pos_item_id=l.pos_item_id))
  and exists(select 1 from public.menu_items i where i.business_id=p_business_id
   and (i.pos_item_id=l.pos_item_id or i.pos_item_id like l.pos_item_id||':size:%'))
 )
 update public.order_lines l set menu_item_id=c.new_menu_item_id
 from candidates c where l.id=c.id and l.menu_item_id is distinct from c.new_menu_item_id;
 get diagnostics v_count=row_count;
 return v_count;
end $$;
revoke all on function public.pos_relink_toast_lines(uuid,uuid) from public,anon,authenticated;
grant execute on function public.pos_relink_toast_lines(uuid,uuid) to service_role;
