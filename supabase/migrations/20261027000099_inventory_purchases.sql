-- PR G: source-neutral sales evidence, owner-recorded purchases and confirmed modifier links.
-- Safe to replay; never rewrites historical ingredient quantities or sales modifiers.
alter table public.pantry_stock_purchases
  add column if not exists line_id uuid not null default gen_random_uuid(),
  add column if not exists source text not null default 'manual'
    check (source in ('manual','bulk','receipt_page','receipt_chat','chat_text','csv','quickbooks','bank_feed')),
  add column if not exists source_ref text,
  add column if not exists cost_cents bigint check (cost_cents is null or cost_cents >= 0),
  add column if not exists expense_line_id uuid references public.expense_lines(id) on delete set null,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists voided_at timestamptz;
update public.pantry_stock_purchases set source='manual' where source is null;
create unique index if not exists pantry_purchases_business_line_uidx
  on public.pantry_stock_purchases(business_id,line_id);
create unique index if not exists pantry_purchases_expense_line_uidx
  on public.pantry_stock_purchases(expense_line_id) where expense_line_id is not null;
create index if not exists pantry_purchases_active_month_idx
  on public.pantry_stock_purchases(business_id,purchase_date) where voided_at is null;
alter table public.pantry_stock_purchases enable row level security;
drop policy if exists "owners update" on public.pantry_stock_purchases;
create policy "owners update" on public.pantry_stock_purchases for update to authenticated
 using (exists (select 1 from public.memberships m where m.business_id=pantry_stock_purchases.business_id
   and m.user_id=auth.uid() and m.role='owner'))
 with check (exists (select 1 from public.memberships m where m.business_id=pantry_stock_purchases.business_id
   and m.user_id=auth.uid() and m.role='owner'));
grant select,insert,update on public.pantry_stock_purchases to authenticated;

-- Index per scanned receipt row makes expense + stock retry-resumable.
alter table public.expense_lines add column if not exists receipt_line_index integer;
create unique index if not exists expense_lines_receipt_index_uidx
 on public.expense_lines(expense_id,receipt_line_index);

-- One price per stock line: retries never create multiple price-history entries.
alter table public.ingredient_prices add column if not exists source_stock_line_id uuid;
create unique index if not exists ingredient_prices_stock_line_uidx
  on public.ingredient_prices(source_stock_line_id);

create table if not exists public.pantry_modifier_links (
 business_id uuid not null references public.businesses(id) on delete cascade,
 provider text not null check(provider in ('toast','square','csv')),
 location_ref text not null check(length(location_ref) between 1 and 120),
 pos_modifier_id text not null check(length(pos_modifier_id) between 1 and 200),
 modifier_recipe_id uuid not null references public.modifier_recipes(id) on delete restrict,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key(business_id,provider,location_ref,pos_modifier_id)
);
alter table public.pantry_modifier_links enable row level security;
drop policy if exists "members read" on public.pantry_modifier_links;
create policy "members read" on public.pantry_modifier_links for select to authenticated
 using(public.is_member(business_id));
drop policy if exists "owners write" on public.pantry_modifier_links;
create policy "owners write" on public.pantry_modifier_links for insert to authenticated
 with check(exists(select 1 from public.memberships m where m.business_id=pantry_modifier_links.business_id
  and m.user_id=auth.uid() and m.role='owner')
  and exists(select 1 from public.modifier_recipes r where r.id=modifier_recipe_id and r.business_id=business_id));
drop policy if exists "owners update" on public.pantry_modifier_links;
create policy "owners update" on public.pantry_modifier_links for update to authenticated
 using(exists(select 1 from public.memberships m where m.business_id=pantry_modifier_links.business_id
  and m.user_id=auth.uid() and m.role='owner'))
 with check(exists(select 1 from public.memberships m where m.business_id=pantry_modifier_links.business_id
  and m.user_id=auth.uid() and m.role='owner')
  and exists(select 1 from public.modifier_recipes r where r.id=modifier_recipe_id and r.business_id=business_id));
grant select,insert,update on public.pantry_modifier_links to authenticated;

-- Canonical rollups represent sync/import evidence even for a day with zero sales.
-- No Toast-only orders are required. Keep Toast staff for optional shift grouping.
create or replace function public.pantry_usage_sales_evidence(
 p_business_id uuid,p_from date,p_to date
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_covered boolean;v_staff jsonb;
begin
 if auth.uid() is null or not exists (
  select 1 from public.memberships m where m.business_id=p_business_id
   and m.user_id=auth.uid() and m.role='owner'
 ) then raise exception 'not authorized' using errcode='42501';end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>30
  then raise exception 'invalid usage range';end if;
 select not exists (
  select 1 from generate_series(p_from,p_to,interval '1 day') d
  where not exists (
   select 1 from public.daily_rollups r where r.business_id=p_business_id
    and r.business_date=d::date and r.sales_data_status='actual'
  )
 ) into v_covered;
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',l.external_time_entry_id::text,'clockIn',l.clock_in,'clockOut',l.clock_out,
  'locationId',l.location_id::text,'staff',coalesce(e.display_name,'Unlinked employee'),
  'staffId',l.external_employee_id::text
 ) order by l.clock_in,l.external_time_entry_id),'[]'::jsonb) into v_staff
 from public.toast_labor_entries l
 join public.businesses b on b.id=l.business_id
 left join public.toast_employee_directory e
  on e.business_id=l.business_id and e.restaurant_guid=l.restaurant_guid
  and e.employee_guid=l.external_employee_id and e.deleted=false
 where l.business_id=p_business_id and not l.deleted
  and l.clock_in < ((p_to+1)::timestamp at time zone b.timezone)
  and coalesce(l.clock_out,now()) >= (p_from::timestamp at time zone b.timezone);
 return jsonb_build_object('covered',v_covered,'staff',v_staff,
  'modifierMappings',coalesce((
   select jsonb_agg(jsonb_build_object('provider','toast','locationRef',c.restaurant_guid::text,
    'posModifierId',c.provider_guid::text,'recipeId',c.linked_modifier_recipe_id::text))
   from public.toast_catalog_facts c where c.business_id=p_business_id
    and c.kind='modifier' and c.linked_modifier_recipe_id is not null
  ),'[]'::jsonb) || coalesce((
   select jsonb_agg(jsonb_build_object('provider',l.provider,'locationRef',l.location_ref,
    'posModifierId',l.pos_modifier_id,'recipeId',l.modifier_recipe_id::text))
   from public.pantry_modifier_links l where l.business_id=p_business_id
  ),'[]'::jsonb));
end $$;
revoke all on function public.pantry_usage_sales_evidence(uuid,date,date) from public,anon,authenticated;
grant execute on function public.pantry_usage_sales_evidence(uuid,date,date) to authenticated;

-- Edit an inert purchase proposal with its own revision token, never after approval.
create or replace function public.supervisor_edit_inventory_purchase(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,
 p_proposal_id uuid,p_revision integer,p_effect jsonb,p_effect_hash text
) returns public.supervisor_proposals language plpgsql security definer set search_path=public as $$
declare v_proposal public.supervisor_proposals%rowtype;
begin
 if current_user <> 'service_role' then
  raise exception 'service role required' using errcode='42501';
 end if;
 if p_effect is null or jsonb_typeof(p_effect)<>'object'
  or p_effect_hash !~ '^[a-f0-9]{64}$' then
  raise exception 'invalid purchase effect';
 end if;
 select * into v_proposal from public.supervisor_proposals where id=p_proposal_id
  and business_id=p_business_id and owner_user_id=p_owner_user_id and thread_id=p_thread_id
  for update;
 if not found or v_proposal.capability_id<>'maya.inventory_purchase.v1'
  or v_proposal.status<>'draft' or v_proposal.revision<>p_revision then
  raise exception 'purchase proposal changed' using errcode='40001';
 end if;
 update public.supervisor_proposals set
  canonical_effect_payload=p_effect,effect_hash=p_effect_hash,revision=revision+1,
  updated_at=now()
 where id=p_proposal_id
 returning * into v_proposal;
 return v_proposal;
end $$;
revoke all on function public.supervisor_edit_inventory_purchase(uuid,uuid,uuid,uuid,integer,jsonb,text)
 from public,anon,authenticated;
grant execute on function public.supervisor_edit_inventory_purchase(uuid,uuid,uuid,uuid,integer,jsonb,text)
 to service_role;
