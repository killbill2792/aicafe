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
  add column if not exists revision bigint not null default 1,
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
  and exists(select 1 from public.modifier_recipes r where r.id=modifier_recipe_id and r.business_id=pantry_modifier_links.business_id));
drop policy if exists "owners update" on public.pantry_modifier_links;
create policy "owners update" on public.pantry_modifier_links for update to authenticated
 using(exists(select 1 from public.memberships m where m.business_id=pantry_modifier_links.business_id
  and m.user_id=auth.uid() and m.role='owner'))
 with check(exists(select 1 from public.memberships m where m.business_id=pantry_modifier_links.business_id
  and m.user_id=auth.uid() and m.role='owner')
  and exists(select 1 from public.modifier_recipes r where r.id=modifier_recipe_id and r.business_id=pantry_modifier_links.business_id));
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


-- Save stock and its derived price atomically. Row-level owner authorization is
-- repeated inside the RPC because SECURITY DEFINER must never trust a caller ID.
-- New lines are idempotent; edits require the displayed updated_at CAS token.
create or replace function public.pantry_write_purchase_line(
 p_business_id uuid,p_line_id uuid,p_ingredient_id uuid,p_date date,
 p_quantity numeric,p_unit text,p_base_quantity numeric,p_cost_cents bigint,
 p_price_micros bigint,p_source text,p_source_ref text,p_expense_line_id uuid,
 p_expected_revision bigint
) returns bigint language plpgsql security definer set search_path=public as $$
declare v_row public.pantry_stock_purchases%rowtype;v_revision bigint;
begin
 if auth.uid() is null or not exists (
  select 1 from public.memberships m join public.businesses b on b.id=m.business_id
  where m.business_id=p_business_id and m.user_id=auth.uid()
    and m.role='owner' and b.is_demo=false
 ) then raise exception 'owner required' using errcode='42501';end if;
 if p_business_id is null or p_line_id is null or p_ingredient_id is null or p_date is null
  or p_quantity <= 0 or p_quantity > 1000000000
  or p_base_quantity <= 0 or p_base_quantity > 1000000000
  or p_unit is null or length(btrim(p_unit)) not between 1 and 40
  or p_cost_cents < 0 or p_cost_cents > 900000000000000
  or length(coalesce(p_source_ref,''))>200
  or p_source not in ('manual','bulk','receipt_page','receipt_chat','chat_text','csv','quickbooks','bank_feed')
  or (p_cost_cents>0 and (p_price_micros is null or p_price_micros<=0))
  or (coalesce(p_cost_cents,0)=0 and p_price_micros is not null)
  or not exists (select 1 from public.ingredients i
    where i.id=p_ingredient_id and i.business_id=p_business_id)
 then raise exception 'invalid purchase' using errcode='22023';end if;
 if p_expense_line_id is not null and (
  p_source not in ('receipt_page','receipt_chat') or
  not exists (select 1 from public.expense_lines l
    join public.expenses e on e.id=l.expense_id
    where l.id=p_expense_line_id and e.business_id=p_business_id)
 ) then raise exception 'invalid expense link' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_business_id::text||':'||p_line_id::text,47));
 select * into v_row from public.pantry_stock_purchases
  where business_id=p_business_id and line_id=p_line_id for update;
 if found then
  if v_row.voided_at is not null then
   raise exception 'purchase voided' using errcode='40001';end if;
  if p_expected_revision is null then
   -- Retries are permitted only when all stored facts are identical.
   if v_row.ingredient_id is distinct from p_ingredient_id
    or v_row.purchase_date is distinct from p_date
    or v_row.entered_quantity is distinct from p_quantity
    or v_row.entered_unit is distinct from p_unit
    or v_row.quantity_base is distinct from p_base_quantity
    or v_row.cost_cents is distinct from p_cost_cents
    or v_row.source is distinct from p_source
    or v_row.source_ref is distinct from p_source_ref
    or v_row.expense_line_id is distinct from p_expense_line_id
    then raise exception 'purchase changed' using errcode='40001';end if;
   return v_row.revision;
  end if;
  if v_row.revision is distinct from p_expected_revision
   then raise exception 'stale purchase' using errcode='40001';end if;
  update public.pantry_stock_purchases set
   ingredient_id=p_ingredient_id,purchase_date=p_date,entered_quantity=p_quantity,
   entered_unit=p_unit,quantity_base=p_base_quantity,cost_cents=p_cost_cents,
   updated_at=clock_timestamp(),revision=revision+1
   where id=v_row.id returning revision into v_revision;
 else
  if p_expected_revision is not null
   then raise exception 'purchase missing' using errcode='40001';end if;
  insert into public.pantry_stock_purchases(
   business_id,line_id,ingredient_id,purchase_date,entered_quantity,entered_unit,
   quantity_base,cost_cents,source,source_ref,expense_line_id
  ) values(
   p_business_id,p_line_id,p_ingredient_id,p_date,p_quantity,p_unit,
   p_base_quantity,p_cost_cents,p_source,p_source_ref,p_expense_line_id
  ) returning revision into v_revision;
 end if;
 if p_price_micros is not null then
  insert into public.ingredient_prices(
   ingredient_id,effective_from,cost_per_base_unit_micros,source,
   source_expense_line_id,source_stock_line_id
  ) values(
   p_ingredient_id,p_date,p_price_micros,
   case when p_source in ('receipt_page','receipt_chat') then 'receipt' else 'manual' end,
   p_expense_line_id,p_line_id
  ) on conflict (source_stock_line_id) do update set
   ingredient_id=excluded.ingredient_id,effective_from=excluded.effective_from,
   cost_per_base_unit_micros=excluded.cost_per_base_unit_micros,
   source=excluded.source,source_expense_line_id=excluded.source_expense_line_id
   where exists(select 1 from public.ingredients i where
     i.id=ingredient_prices.ingredient_id and i.business_id=p_business_id);
  if not found then
   -- SECURITY DEFINER must not let a guessed UUID rewrite another café's price.
   raise exception 'price line belongs to a different cafe' using errcode='42501';
  end if;
 else
  delete from public.ingredient_prices where source_stock_line_id=p_line_id
   and ingredient_id in (select id from public.ingredients where business_id=p_business_id);
 end if;
 return v_revision;
end $$;
revoke all on function public.pantry_write_purchase_line(uuid,uuid,uuid,date,numeric,text,numeric,bigint,bigint,text,text,uuid,bigint)
 from public,anon,authenticated;
grant execute on function public.pantry_write_purchase_line(uuid,uuid,uuid,date,numeric,text,numeric,bigint,bigint,text,text,uuid,bigint)
 to authenticated;

-- A void removes its attributed price atomically and is idempotent.
create or replace function public.pantry_void_purchase_line(p_business_id uuid,p_line_id uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare v_row public.pantry_stock_purchases%rowtype;
begin
 if auth.uid() is null or not exists (
  select 1 from public.memberships m join public.businesses b on b.id=m.business_id
  where m.business_id=p_business_id and m.user_id=auth.uid()
   and m.role='owner' and b.is_demo=false
 ) then raise exception 'owner required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_business_id::text||':'||p_line_id::text,47));
 select * into v_row from public.pantry_stock_purchases
  where business_id=p_business_id and line_id=p_line_id for update;
 if not found then return false;end if;
 if v_row.voided_at is not null then return true;end if;
 update public.pantry_stock_purchases set voided_at=clock_timestamp(),updated_at=clock_timestamp(),revision=revision+1
  where id=v_row.id;
 delete from public.ingredient_prices where source_stock_line_id=p_line_id
  and ingredient_id in (select id from public.ingredients where business_id=p_business_id);
 return true;
end $$;
revoke all on function public.pantry_void_purchase_line(uuid,uuid) from public,anon,authenticated;
grant execute on function public.pantry_void_purchase_line(uuid,uuid) to authenticated;


-- Bind one owner-uploaded chat receipt to exactly one expense across independently
-- approved lines; a stale line with a different total/date must fail closed.
alter table public.expenses add column if not exists chat_receipt_group_id uuid;
create unique index if not exists expenses_chat_receipt_group_uidx
 on public.expenses(business_id,chat_receipt_group_id) where chat_receipt_group_id is not null;

-- Receipt chat: create ONE expense for the owner-reviewed receipt total, then
-- the approved expense line and canonical stock+price in the SAME transaction.
-- Unapproved siblings create no stock or price; their later approvals resume
-- against the same expense and indexed line. A conflicting retry rolls back.
create or replace function public.pantry_write_receipt_chat_line(
 p_business_id uuid,p_line_id uuid,p_ingredient_id uuid,p_date date,
 p_quantity numeric,p_unit text,p_base_quantity numeric,p_cost_cents bigint,
 p_price_micros bigint,p_group_id uuid,p_line_index integer,
 p_vendor text,p_total_cents bigint,p_dedupe_key text,p_name text
) returns bigint language plpgsql security definer set search_path=public as $$
declare v_expense_id uuid;v_line public.expense_lines%rowtype;v_result bigint;
  v_expense public.expenses%rowtype;
begin
 if auth.uid() is null or not exists (
  select 1 from public.memberships m join public.businesses b on b.id=m.business_id
  where m.business_id=p_business_id and m.user_id=auth.uid()
   and m.role='owner' and b.is_demo=false
 ) then raise exception 'owner required' using errcode='42501';end if;
 if p_group_id is null or p_line_id is null or p_line_index is null or p_line_index not between 0 and 99
   or p_vendor is null or length(btrim(p_vendor)) not between 1 and 160
   or p_total_cents is null or p_total_cents <= 0 or p_total_cents > 900000000000000
   or p_cost_cents is null or p_cost_cents < 0
   or p_dedupe_key is null or length(p_dedupe_key) not between 1 and 200
   or p_name is null or length(btrim(p_name)) not between 1 and 160
 then raise exception 'receipt information required' using errcode='22023';end if;
 -- Same logical receipt is serialized BEFORE expense-line or stock locks.
 -- The expense dedupe key also detects a receipt recorded on the page.
 perform pg_advisory_xact_lock(hashtextextended(p_business_id::text||':receipt-group:'||p_group_id::text,52));
 perform pg_advisory_xact_lock(hashtextextended(p_business_id::text||':receipt:'||p_dedupe_key,53));
 insert into public.expenses(
  business_id,spent_on,amount_cents,vendor,category_code,source,status,dedupe_key,chat_receipt_group_id
 ) values (
  p_business_id,p_date,p_total_cents,p_vendor,'ingredients','receipt','actual',p_dedupe_key,p_group_id
 ) on conflict(business_id,dedupe_key) do nothing returning id into v_expense_id;
 if v_expense_id is null then
  select * into v_expense from public.expenses
   where business_id=p_business_id and dedupe_key=p_dedupe_key for update;
  if not found or v_expense.source <> 'receipt'
   or v_expense.amount_cents is distinct from p_total_cents
   or v_expense.spent_on is distinct from p_date
   or lower(btrim(coalesce(v_expense.vendor,'')))<>lower(btrim(p_vendor))
    then raise exception 'receipt changed' using errcode='40001';end if;
  if v_expense.chat_receipt_group_id is not null
    and v_expense.chat_receipt_group_id <> p_group_id then
    raise exception 'receipt already assigned elsewhere' using errcode='40001';end if;
  update public.expenses set chat_receipt_group_id=p_group_id
   where id=v_expense.id and chat_receipt_group_id is null;
  v_expense_id:=v_expense.id;
 end if;
 if exists(select 1 from public.expense_lines
  where expense_id=v_expense_id and receipt_line_index is null)
  then raise exception 'historical receipt needs review' using errcode='40001';end if;
 insert into public.expense_lines(
  expense_id,receipt_line_index,description,quantity,unit,amount_cents,ingredient_id
 ) values(v_expense_id,p_line_index,p_name,p_quantity,p_unit,p_cost_cents,p_ingredient_id)
 on conflict(expense_id,receipt_line_index) do nothing;
 select * into v_line from public.expense_lines
  where expense_id=v_expense_id and receipt_line_index=p_line_index for update;
 if not found or v_line.description is distinct from p_name
  or v_line.quantity is distinct from p_quantity
  or v_line.unit is distinct from p_unit
  or v_line.amount_cents is distinct from p_cost_cents
  or v_line.ingredient_id is distinct from p_ingredient_id
 then raise exception 'receipt line changed' using errcode='40001';end if;
 select public.pantry_write_purchase_line(
  p_business_id,p_line_id,p_ingredient_id,p_date,p_quantity,p_unit,
  p_base_quantity,p_cost_cents,p_price_micros,'receipt_chat',
  p_group_id::text,v_line.id,null
 ) into v_result;
 return v_result;
end $$;
revoke all on function public.pantry_write_receipt_chat_line(uuid,uuid,uuid,date,numeric,text,numeric,bigint,bigint,uuid,integer,text,bigint,text,text)
 from public,anon,authenticated;
grant execute on function public.pantry_write_receipt_chat_line(uuid,uuid,uuid,date,numeric,text,numeric,bigint,bigint,uuid,integer,text,bigint,text,text)
 to authenticated;


-- A brand-new café may have zero modifier_recipes. Let the owner explicitly
-- create a base-unit recipe and link one observed POS modifier atomically.
-- Never create a recipe from an AI suggestion without this owner's click.
create or replace function public.pantry_create_modifier_recipe_link(
 p_business_id uuid,p_provider text,p_location_ref text,p_pos_modifier_id text,
 p_name text,p_ingredient_id uuid,p_quantity_delta numeric,p_replaces_ingredient_id uuid
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_recipe_id uuid;
begin
 if auth.uid() is null or not exists(
  select 1 from public.memberships m join public.businesses b on b.id=m.business_id
  where m.business_id=p_business_id and m.user_id=auth.uid()
   and m.role='owner' and b.is_demo=false
 ) then raise exception 'owner required' using errcode='42501';end if;
 if p_provider not in ('toast','square','csv')
  or p_location_ref is null or length(btrim(p_location_ref)) not between 1 and 120
  or p_pos_modifier_id is null or length(btrim(p_pos_modifier_id)) not between 1 and 200
  or p_name is null or length(btrim(p_name)) not between 1 and 160
  or p_quantity_delta is null or p_quantity_delta<=0 or p_quantity_delta>999999
  or not exists(select 1 from public.ingredients i
    where i.business_id=p_business_id and i.id=p_ingredient_id)
  or (p_replaces_ingredient_id is not null and
    not exists(select 1 from public.ingredients i
      where i.business_id=p_business_id and i.id=p_replaces_ingredient_id))
 then raise exception 'invalid modifier recipe' using errcode='22023';end if;
 -- A duplicate link must fail before producing a dangling second recipe.
 perform pg_advisory_xact_lock(hashtextextended(
  p_business_id::text||':'||p_provider||':'||p_location_ref||':'||p_pos_modifier_id,71));
 if exists(select 1 from public.pantry_modifier_links l
  where l.business_id=p_business_id and l.provider=p_provider
    and l.location_ref=p_location_ref and l.pos_modifier_id=p_pos_modifier_id)
 then raise exception 'modifier already linked' using errcode='40001';end if;
 insert into public.modifier_recipes(
  business_id,pos_modifier_id,name,ingredient_id,quantity_delta,replaces_ingredient_id
 ) values (p_business_id,p_pos_modifier_id,p_name,p_ingredient_id,
  p_quantity_delta,p_replaces_ingredient_id) returning id into v_recipe_id;
 insert into public.pantry_modifier_links(
  business_id,provider,location_ref,pos_modifier_id,modifier_recipe_id
 ) values (p_business_id,p_provider,p_location_ref,p_pos_modifier_id,v_recipe_id);
 return v_recipe_id;
end $$;
revoke all on function public.pantry_create_modifier_recipe_link(uuid,text,text,text,text,uuid,numeric,uuid)
 from public,anon,authenticated;
grant execute on function public.pantry_create_modifier_recipe_link(uuid,text,text,text,text,uuid,numeric,uuid)
 to authenticated;
