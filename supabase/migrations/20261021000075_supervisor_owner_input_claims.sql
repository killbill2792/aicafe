-- One-shot claims for owner-confirmed Supervisor-provided facts.
-- No owner/browser access: all writes go through the authenticated Server route,
-- compiled write registry, and existing domain action. A crash after claiming
-- may leave 'started': it must never automatically repeat the domain write.
create table if not exists public.supervisor_owner_input_claims (
  question_id uuid primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  state text not null default 'started' check (state in ('started','applied','uncertain')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists supervisor_owner_input_claims_owner_idx
  on public.supervisor_owner_input_claims(business_id,owner_user_id,created_at desc);
alter table public.supervisor_owner_input_claims enable row level security;
revoke all on public.supervisor_owner_input_claims from public,anon,authenticated;
grant select,insert,update on public.supervisor_owner_input_claims to service_role;
comment on table public.supervisor_owner_input_claims is
  'Private one-time claims; started/uncertain never grants automatic retry of a domain effect.';

-- Reviewed, tenant-authorized CAS extension for the EXISTING Menu ingredient
-- write action. The business-wide epoch row is locked BEFORE checking it and
-- inserting the price, making source validation + mutation one transaction.
-- Direct calls cannot impersonate another owner or choose a foreign ingredient.
create function public.menu_add_manual_ingredient_price_if_revision(
  p_business_id uuid, p_menu_item_id uuid, p_ingredient_id uuid,
  p_expected_revision text, p_expected_day date,
  p_package_cost_cents bigint, p_package_quantity numeric
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public as $owner_price$
declare
  v_revision bigint;
  v_timezone text;
  v_micro bigint;
begin
  if auth.uid() is null or p_expected_revision !~ '^[1-9][0-9]{0,18}$'
     or p_package_cost_cents <= 0 or p_package_cost_cents > 100000000
     or p_package_quantity <= 0 or p_package_quantity > 1000000 then
    return jsonb_build_object('ok',false,'reason','invalid_request');
  end if;
  select b.timezone into v_timezone
  from public.businesses b
  where b.id=p_business_id and b.is_demo=false and b.currency='USD'
    and exists(select 1 from public.memberships m
      where m.business_id=b.id and m.user_id=auth.uid() and m.role='owner');
  if v_timezone is null then
    return jsonb_build_object('ok',false,'reason','unauthorized');
  end if;
  -- Serialize CAS operations by business; P1 AFTER STATEMENT epoch bump reuses
  -- this row lock in the same transaction. Never lock whole tables or cafés.
  select revision into v_revision from public.p1_business_source_epochs
    where business_id=p_business_id for update;
  if v_revision is null or v_revision::text<>p_expected_revision or
    p_expected_day is distinct from (now() at time zone v_timezone)::date then
    return jsonb_build_object('ok',false,'reason','source_changed');
  end if;
  if not exists (
    select 1 from public.menu_items mi
    join public.recipe_lines rl on rl.menu_item_id=mi.id
    join public.ingredients i on i.id=rl.ingredient_id
    where mi.id=p_menu_item_id and mi.business_id=p_business_id
      and mi.is_active and i.id=p_ingredient_id and i.business_id=p_business_id
  ) or exists (
    select 1 from public.ingredient_prices ip
    where ip.ingredient_id=p_ingredient_id and ip.effective_from<=p_expected_day
  ) or exists (
    select 1 from public.menu_item_cost_fallbacks f
    where f.business_id=p_business_id and f.menu_item_id=p_menu_item_id
      and f.cost_cents>0
  ) then
    return jsonb_build_object('ok',false,'reason','source_changed');
  end if;
  -- Exactly the same canonical cents-to-microcents conversion used by the
  -- Menu action; SQL NUMERIC avoids float money and rounds once on storage.
  v_micro:=round((p_package_cost_cents::numeric/p_package_quantity)*1000000)::bigint;
  if v_micro<=0 or v_micro>9223372036854775807 then
    return jsonb_build_object('ok',false,'reason','invalid_request');
  end if;
  insert into public.ingredient_prices
    (ingredient_id,effective_from,cost_per_base_unit_micros,source)
    values (p_ingredient_id,p_expected_day,v_micro,'manual');
  return jsonb_build_object('ok',true,'effectiveDate',p_expected_day::text);
end;
$owner_price$;
revoke all on function public.menu_add_manual_ingredient_price_if_revision(
  uuid,uuid,uuid,text,date,bigint,numeric) from public,anon,authenticated;
grant execute on function public.menu_add_manual_ingredient_price_if_revision(
  uuid,uuid,uuid,text,date,bigint,numeric) to authenticated;
