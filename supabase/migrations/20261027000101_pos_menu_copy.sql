-- PR 201: shared source metadata, source identities and trustworthy nullable labor.
-- Apply manually after migration 100. No production data is erased.
-- Additional monthly pay that the Standard Toast API cannot supply. Distinct
-- from imported hourly wages and employer-tax percentage fallback.
alter table public.businesses
 add column if not exists owner_monthly_payroll_extras_cents bigint
   check (owner_monthly_payroll_extras_cents >= 0),
 add column if not exists owner_monthly_payroll_extras_updated_at timestamptz;
alter table public.toast_sync_phase_errors
 drop constraint if exists toast_sync_phase_errors_phase_check;
alter table public.toast_sync_phase_errors
 add constraint toast_sync_phase_errors_phase_check
 check(phase in ('restaurant_info','cost_refresh','resume','daily',
 'modified_scan','repull','reconcile','backfill','optional','cleanup',
 'menu','roster','labor','sales_link'));
create unique index if not exists menu_items_business_id_id_uidx
 on public.menu_items(business_id,id);
alter table public.menu_items
 add column if not exists description text,
 add column if not exists pos_visibility text,
 add column if not exists pos_pricing_strategy text,
 add column if not exists pos_archived_at timestamptz,
 add column if not exists pos_name text,
 add column if not exists pos_metadata jsonb not null default '{}'::jsonb;
alter table public.modifier_recipes
 add column if not exists price_cents bigint,
 add column if not exists pos_group_id text,
 add column if not exists pos_group_name text,
 add column if not exists pos_pricing_strategy text,
 add column if not exists pos_metadata jsonb not null default '{}'::jsonb,
 add column if not exists is_active boolean not null default true,
 add column if not exists catalog_source text,
 add column if not exists catalog_last_synced_at timestamptz;
do $$
begin
 if exists(select 1 from public.modifier_recipes
 where pos_modifier_id is not null group by business_id,pos_modifier_id having count(*)>1) then
  raise exception 'Duplicate modifier_recipes business_id + pos_modifier_id; reconcile duplicate rows before migration 101';
 end if;
end $$;
create unique index if not exists modifier_recipes_business_pos_uidx
 on public.modifier_recipes(business_id,pos_modifier_id);
create table if not exists public.menu_item_modifier_groups(
 business_id uuid not null references public.businesses(id) on delete cascade,
 menu_item_id uuid not null references public.menu_items(id) on delete cascade,
 pos_group_id text not null,
 pos_group_name text,
 pos_metadata jsonb not null default '{}'::jsonb,
 min_selections integer,
 max_selections integer,
 required boolean not null default false,
 primary key(business_id,menu_item_id,pos_group_id),
 foreign key(business_id,menu_item_id) references public.menu_items(business_id,id) on delete cascade,
 check (min_selections is null or min_selections>=0),
 check (max_selections is null or max_selections>=0)
);
create table if not exists public.pos_item_aliases(
 business_id uuid not null references public.businesses(id) on delete cascade,
 menu_item_id uuid not null references public.menu_items(id) on delete cascade,
 provider text not null,
 pos_item_id text not null,
 primary key(business_id,provider,pos_item_id),
 foreign key(business_id,menu_item_id) references public.menu_items(business_id,id) on delete cascade
);
create index if not exists pos_item_aliases_item_idx
 on public.pos_item_aliases(business_id,menu_item_id);
alter table public.menu_item_modifier_groups enable row level security;
alter table public.pos_item_aliases enable row level security;
drop policy if exists "member read" on public.menu_item_modifier_groups;
create policy "member read" on public.menu_item_modifier_groups for select to authenticated
 using(public.is_member(business_id));
drop policy if exists "owner write" on public.menu_item_modifier_groups;
create policy "owner write" on public.menu_item_modifier_groups for all to authenticated
 using(public.scheduling_is_owner(business_id))
 with check(public.scheduling_is_owner(business_id)
  and exists(select 1 from public.menu_items i where i.id=menu_item_id and i.business_id=business_id));
drop policy if exists "member read" on public.pos_item_aliases;
create policy "member read" on public.pos_item_aliases for select to authenticated
 using(public.is_member(business_id));
drop policy if exists "owner write" on public.pos_item_aliases;
create policy "owner write" on public.pos_item_aliases for all to authenticated
 using(public.scheduling_is_owner(business_id))
 with check(public.scheduling_is_owner(business_id)
  and exists(select 1 from public.menu_items i where i.id=menu_item_id and i.business_id=business_id));
grant select,insert,update,delete on public.menu_item_modifier_groups,public.pos_item_aliases to authenticated;

-- Preserve both POS identity and the owner's display/name, role, wage, and active decisions.
alter table public.employees
 add column if not exists pos_display_name text,
 add column if not exists pos_last_role text,
 add column if not exists pos_last_wage_cents bigint,
 add column if not exists pos_last_active boolean,
 add column if not exists pos_last_synced_at timestamptz;
-- Hourly wage can truly be unknown: NULL is never equivalent to 0.
alter table public.timecards alter column hourly_wage_cents drop not null;
alter table public.timecards
 add column if not exists wage_source text not null default 'owner'
   check(wage_source in ('pos','estimate','owner','unknown')),
 add column if not exists pos_owner_edited boolean not null default false,
 add column if not exists pos_last_synced_at timestamptz;
alter table public.daily_rollups
 add column if not exists labor_wage_status text not null default 'actual'
 check(labor_wage_status in ('actual','estimate','missing'));
-- Rollup readers can distinguish unknown hours from actual zero expenditure.
alter table public.daily_rollups alter column staff_wages_cents drop not null;
alter table public.daily_rollups alter column staff_tax_cents drop not null;
-- This trigger only treats authenticated edits as owner edits: ingestion uses the service role.
create or replace function public.pos_protect_owner_timecard_edit()
 returns trigger language plpgsql set search_path=public as $$
begin
 if auth.role()='authenticated' and old.source_type='connected_pos' then
  if row(new.clock_in,new.clock_out,new.hourly_wage_cents,new.breaks)
   is distinct from row(old.clock_in,old.clock_out,old.hourly_wage_cents,old.breaks) then
    new.pos_owner_edited=true;
    new.wage_source='owner';
  end if;
 end if;
 return new;
end $$;
drop trigger if exists pos_owner_timecard_edit on public.timecards;
create trigger pos_owner_timecard_edit before update on public.timecards
 for each row execute function public.pos_protect_owner_timecard_edit();

create table if not exists public.pos_import_reviews(
 business_id uuid not null references public.businesses(id) on delete cascade,
 provider text not null,
 review_type text not null,
 source_key text not null,
 detail jsonb not null default '{}'::jsonb,
 status text not null default 'needs_owner' check(status in ('needs_owner','resolved')),
 created_at timestamptz not null default now(),
 primary key(business_id,provider,review_type,source_key)
);
alter table public.pos_import_reviews enable row level security;
drop policy if exists "owner read" on public.pos_import_reviews;
create policy "owner read" on public.pos_import_reviews for select to authenticated
 using(public.scheduling_is_owner(business_id));
drop policy if exists "owner update" on public.pos_import_reviews;
create policy "owner update" on public.pos_import_reviews for update to authenticated
 using(public.scheduling_is_owner(business_id))
 with check(public.scheduling_is_owner(business_id));
grant select,update on public.pos_import_reviews to authenticated;

-- Serialize per-cafe ingestion and safely link sized or historical Toast order lines.
-- This is called after catalog sync and day import; unknown GUIDs become one archived row.
create or replace function public.pos_relink_toast_lines(p_business_id uuid,p_restaurant_guid uuid)
returns integer language plpgsql security definer set search_path=public as $$
declare v_prefix text;v_count integer;
begin
 if auth.role()<>'service_role' or not exists(
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
 update public.order_lines l set menu_item_id=coalesce(
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
 (select max(mi.id) from public.menu_items mi
   where mi.business_id=p_business_id and mi.pos_item_id like l.pos_item_id||':size:%'
   having count(*)=1))
 from public.orders o
 where o.id=l.order_id and o.business_id=p_business_id
  and l.pos_item_id like v_prefix||'%'
  and (l.menu_item_id is null or exists(select 1 from public.menu_items current_item
    where current_item.id=l.menu_item_id and current_item.pos_item_id=l.pos_item_id))
  and exists(select 1 from public.menu_items i where i.business_id=p_business_id
   and (i.pos_item_id=l.pos_item_id or i.pos_item_id like l.pos_item_id||':size:%'));
 get diagnostics v_count=row_count;
 return v_count;
end $$;
revoke all on function public.pos_relink_toast_lines(uuid,uuid) from public,anon,authenticated;
grant execute on function public.pos_relink_toast_lines(uuid,uuid) to service_role;

-- Process every attendance fact independently: one conflict never aborts another shift.
create or replace function public.pos_import_toast_attendance(p_business_id uuid,p_restaurant_guid uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r record;v_id text;v_wage bigint;v_source text;
 v_existing public.timecards%rowtype; v_count integer:=0;v_skipped integer:=0;
 v_intervals jsonb:='[]'::jsonb;
begin
 if auth.role()<>'service_role' or not exists(
  select 1 from public.toast_location_mappings where business_id=p_business_id
    and restaurant_guid=p_restaurant_guid and verified_at is not null)
 then raise exception 'attendance unauthorized' using errcode='42501';end if;
 for r in select l.*,d.linked_employee_id,e.default_hourly_wage_cents
  from public.toast_labor_entries l
  left join public.toast_employee_directory d on d.business_id=l.business_id
   and d.restaurant_guid=l.restaurant_guid and d.employee_guid=l.external_employee_id
  left join public.employees e on e.id=d.linked_employee_id and e.business_id=l.business_id
  where l.business_id=p_business_id and l.restaurant_guid=p_restaurant_guid
  and not l.deleted and l.clock_out is not null and l.clock_out>l.clock_in
  order by l.external_time_entry_id
 loop
  v_id:='toast:'||p_restaurant_guid::text||':'||r.external_time_entry_id::text;
  if r.linked_employee_id is null then
   insert into public.pos_import_reviews(business_id,provider,review_type,source_key,detail)
   values(p_business_id,'toast','unlinked_timecard',v_id,jsonb_build_object('employeeGuid',r.external_employee_id))
   on conflict do nothing;
   v_skipped:=v_skipped+1;continue;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pos-staff:'||p_business_id::text||':'||r.linked_employee_id::text,0));
  v_wage:=coalesce(r.hourly_wage_cents,r.default_hourly_wage_cents);
  v_source:=case when r.hourly_wage_cents is not null then 'pos'
   when v_wage is not null then 'estimate' else 'unknown' end;
  select * into v_existing from public.timecards
   where business_id=p_business_id and pos_timecard_id=v_id for update;
  if found and v_existing.pos_owner_edited then
   insert into public.pos_import_reviews(business_id,provider,review_type,source_key,detail)
   values(p_business_id,'toast','shift_corrected',v_id,
    jsonb_build_object('clockIn',r.clock_in,'clockOut',r.clock_out))
   on conflict do nothing;
   v_skipped:=v_skipped+1;continue;
  end if;
  if exists (select 1 from public.timecards t
   where t.business_id=p_business_id and t.employee_id=r.linked_employee_id
     and t.pos_timecard_id is distinct from v_id
     and t.clock_in<r.clock_out and coalesce(t.clock_out,'infinity'::timestamptz)>r.clock_in)
  then
   insert into public.pos_import_reviews(business_id,provider,review_type,source_key,detail)
   values(p_business_id,'toast','overlapping_timecard',v_id,
    jsonb_build_object('employeeId',r.linked_employee_id,'clockIn',r.clock_in,'clockOut',r.clock_out))
   on conflict do nothing;
   v_skipped:=v_skipped+1;continue;
  end if;
  insert into public.timecards(business_id,employee_id,pos_timecard_id,clock_in,clock_out,
   hourly_wage_cents,wage_source,source_type,source_provider,breaks,pos_last_synced_at)
  values(p_business_id,r.linked_employee_id,v_id,r.clock_in,r.clock_out,
   v_wage,v_source,'connected_pos','Toast',r.breaks,now())
  on conflict(business_id,pos_timecard_id) do update set
   employee_id=excluded.employee_id,clock_in=excluded.clock_in,clock_out=excluded.clock_out,
   hourly_wage_cents=excluded.hourly_wage_cents,wage_source=excluded.wage_source,
   breaks=excluded.breaks,pos_last_synced_at=now()
  where public.timecards.pos_owner_edited=false
   and row(public.timecards.clock_in,public.timecards.clock_out,
    public.timecards.hourly_wage_cents,public.timecards.breaks)
    is distinct from row(excluded.clock_in,excluded.clock_out,
    excluded.hourly_wage_cents,excluded.breaks);
  if found then
   v_count:=v_count+1;
   -- Preserve both affected day ranges (including overnight and changed
   -- clock-out dates). A correction can remove wages from an old day.
   v_intervals:=v_intervals||jsonb_build_array(
    jsonb_build_object('start',r.clock_in,'end',r.clock_out));
   if v_existing.id is not null then
    v_intervals:=v_intervals||jsonb_build_array(
     jsonb_build_object('start',v_existing.clock_in,'end',v_existing.clock_out));
   end if;
  end if;
 end loop;
 return jsonb_build_object('changed',v_count,'skipped',v_skipped,'changedIntervals',v_intervals);
end $$;
revoke all on function public.pos_import_toast_attendance(uuid,uuid) from public,anon,authenticated;
grant execute on function public.pos_import_toast_attendance(uuid,uuid) to service_role;

-- Expose only scope booleans to the authenticated owner. Never expose keys,
-- credentials, hosts or permissions belonging to a different café.
create or replace function public.toast_business_scope_summary(p_business_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v jsonb;
begin
 if auth.role() <> 'authenticated' or not public.scheduling_is_owner(p_business_id)
 then raise exception 'Toast scopes unauthorized' using errcode='42501';end if;
 select to_jsonb(c.scopes_available) into v from public.toast_api_credentials c
  where c.business_id=p_business_id;
 return jsonb_build_object(
  'menus',case when jsonb_typeof(v->'menus')='boolean' then (v->>'menus')::boolean else null end,
  'labor',case when jsonb_typeof(v->'labor')='boolean' then (v->>'labor')::boolean else null end
 );
end $$;
revoke all on function public.toast_business_scope_summary(uuid) from public,anon;
grant execute on function public.toast_business_scope_summary(uuid) to authenticated;
