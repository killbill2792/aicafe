-- Owner-recorded closing stock counts and purchases; quantity stored in canonical g/ml/each.
-- Nothing is inferred from pricing packs or POS revenue.
create table public.pantry_stock_counts (
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null references public.businesses(id) on delete cascade,
 ingredient_id uuid not null,
 count_date date not null,
 quantity_base numeric(18,4) not null check (quantity_base>=0 and quantity_base<=1000000000),
 entered_quantity numeric(18,4) not null check (entered_quantity>=0),
 entered_unit text not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(business_id,ingredient_id,count_date),
 foreign key(ingredient_id,business_id) references public.ingredients(id,business_id) on delete cascade
);
create index pantry_stock_counts_date_idx on public.pantry_stock_counts(business_id,count_date,ingredient_id);
create table public.pantry_stock_purchases (
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null references public.businesses(id) on delete cascade,
 ingredient_id uuid not null,
 purchase_date date not null,
 quantity_base numeric(18,4) not null check (quantity_base>0 and quantity_base<=1000000000),
 entered_quantity numeric(18,4) not null check (entered_quantity>0),
 entered_unit text not null,
 created_at timestamptz not null default now(),
 foreign key(ingredient_id,business_id) references public.ingredients(id,business_id) on delete cascade
);
create index pantry_stock_purchases_date_idx on public.pantry_stock_purchases(business_id,purchase_date,ingredient_id);
alter table public.pantry_stock_counts enable row level security;
alter table public.pantry_stock_purchases enable row level security;
create policy "members read" on public.pantry_stock_counts for select to authenticated
 using (public.is_member(business_id));
create policy "owners write" on public.pantry_stock_counts for insert to authenticated
 with check (exists(select 1 from public.memberships m where m.business_id=pantry_stock_counts.business_id and m.user_id=auth.uid() and m.role='owner'));
create policy "owners update" on public.pantry_stock_counts for update to authenticated
 using (exists(select 1 from public.memberships m where m.business_id=pantry_stock_counts.business_id and m.user_id=auth.uid() and m.role='owner'))
 with check (exists(select 1 from public.memberships m where m.business_id=pantry_stock_counts.business_id and m.user_id=auth.uid() and m.role='owner'));
create policy "members read" on public.pantry_stock_purchases for select to authenticated
 using (public.is_member(business_id));
create policy "owners write" on public.pantry_stock_purchases for insert to authenticated
 with check (exists(select 1 from public.memberships m where m.business_id=pantry_stock_purchases.business_id and m.user_id=auth.uid() and m.role='owner'));
grant select,insert,update on public.pantry_stock_counts to authenticated;
grant select,insert on public.pantry_stock_purchases to authenticated;

-- Existing Toast staging data is service-only: provide an intentionally narrow,
-- owner-scoped read of promotion coverage and clocked-in staff, never wages/tokens.
create function public.pantry_usage_toast_evidence(
 p_business_id uuid,p_from date,p_to date
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_covered boolean; v_staff jsonb;
begin
 if auth.uid() is null or not exists (
  select 1 from public.memberships m where m.business_id=p_business_id
   and m.user_id=auth.uid() and m.role='owner'
 ) then raise exception 'not authorized' using errcode='42501'; end if;
 if p_from is null or p_to is null or p_to<p_from
  or p_to-p_from>30 then raise exception 'invalid usage range'; end if;
 select exists (select 1 from public.toast_location_mappings m
   where m.business_id=p_business_id and m.verified_at is not null)
   and not exists (
    select 1 from generate_series(p_from,p_to,interval '1 day') d
     cross join public.toast_location_mappings m
     where m.business_id=p_business_id and m.verified_at is not null
      and not exists (
       select 1 from public.toast_pilot_days p where p.business_id=p_business_id
        and p.restaurant_guid=m.restaurant_guid
        and p.business_date=d::date and p.state='promoted'
        and p.promoted_at is not null
      )
   ) into v_covered;
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',l.external_time_entry_id::text,
  'clockIn',l.clock_in,'clockOut',l.clock_out,\n  'locationId',l.location_id::text,
  'staff',coalesce(e.display_name,'Unlinked Toast employee'),
  'staffId',l.external_employee_id::text
 ) order by l.clock_in,l.external_time_entry_id),'[]'::jsonb) into v_staff
 from public.toast_labor_entries l
 left join public.toast_employee_directory e
  on e.business_id=l.business_id and e.restaurant_guid=l.restaurant_guid
  and e.employee_guid=l.external_employee_id and e.deleted=false
 where l.business_id=p_business_id and not l.deleted
  and l.clock_in < (p_to+1)::timestamptz
  and coalesce(l.clock_out,now()) >= p_from::timestamptz;
 return jsonb_build_object('covered',v_covered,'staff',v_staff,
  'modifierMappings',coalesce((select jsonb_agg(jsonb_build_object(
   'posModifierId',c.provider_guid::text,'recipeId',c.linked_modifier_recipe_id::text))
   from public.toast_catalog_facts c where c.business_id=p_business_id
   and c.kind='modifier' and c.linked_modifier_recipe_id is not null),'[]'::jsonb));
end $$;
revoke all on function public.pantry_usage_toast_evidence(uuid,date,date)
 from public,anon,authenticated;
grant execute on function public.pantry_usage_toast_evidence(uuid,date,date) to authenticated;
