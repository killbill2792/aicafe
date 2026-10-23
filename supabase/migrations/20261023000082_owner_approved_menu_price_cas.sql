-- Owner-approved Alex price proposals: compare the approved baseline and save
-- through the SAME canonical Menu RPC while holding one PostgreSQL row lock.
-- Additive: existing Menu, import and POS clients keep their original RPC.
-- Only this approval path supplies an expected old price.
--
-- No production migration is performed by creating this file.
create function public.set_menu_item_price_with_history_if_current(
  p_business_id uuid,
  p_menu_item_id uuid,
  p_expected_old_price_cents bigint,
  p_new_price_cents bigint,
  p_source_type text,
  p_source_provider text default null
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_current_price_cents bigint;
  v_active boolean;
begin
  -- Only the authenticated café owner can execute owner-approved changes.
  -- SECURITY INVOKER also retains menu_items RLS; never use service-role writes.
  if auth.uid() is null or not exists (
    select 1 from public.memberships m
    where m.business_id = p_business_id
      and m.user_id = auth.uid()
      and m.role = 'owner'
  ) then
    return false;
  end if;

  if p_expected_old_price_cents is null or p_expected_old_price_cents < 0 then
    return false;
  end if;

  -- Locks the exact tenant-scoped row. On concurrent Menu/POS updates this
  -- waits, then checks the NEW committed row under READ COMMITTED isolation.
  select m.price_cents, m.is_active
    into v_current_price_cents, v_active
    from public.menu_items m
   where m.business_id = p_business_id
     and m.id = p_menu_item_id
   for update;

  if not found or v_active is distinct from true
    or v_current_price_cents is distinct from p_expected_old_price_cents then
    return false;
  end if;

  -- The existing Menu screen's canonical writer takes the same row lock
  -- reentrantly in THIS transaction, updates the price and records history.
  -- Neither the lock nor validation can be interleaved with another writer.
  return public.set_menu_item_price_with_history(
    p_business_id, p_menu_item_id, p_new_price_cents,
    p_source_type, p_source_provider
  );
end;
$$;

revoke all on function public.set_menu_item_price_with_history_if_current(
  uuid, uuid, bigint, bigint, text, text
) from public, anon;
grant execute on function public.set_menu_item_price_with_history_if_current(
  uuid, uuid, bigint, bigint, text, text
) to authenticated;
