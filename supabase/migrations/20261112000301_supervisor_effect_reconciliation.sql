-- Task 10 follow-up: recovery is a postcondition check, never a second effect.
-- Run AFTER 20261111000206_supervisor_effect_gateway.sql.
set lock_timeout = '3s';
set statement_timeout = '30s';

create function public.supervisor_reconcile_effect_attempt(
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
      and p.canonical_effect_payload->>'startDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
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
      order by h.changed_at desc limit 1;
    if price_record.id is not null then
      next_status := 'committed';
      next_start := a.business_date + 1;
      proof_ref := 'menu_price_history:' || price_record.id::text;
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

revoke all on function public.supervisor_reconcile_effect_attempt(
  uuid,uuid,uuid,uuid,integer) from public, anon, authenticated;
grant execute on function public.supervisor_reconcile_effect_attempt(
  uuid,uuid,uuid,uuid,integer) to service_role;
