set lock_timeout = '5s';
set statement_timeout = '60s';

-- Commit one accepted order and its detail together. The conflicting header
-- row lock serializes concurrent promotions of the same provider order.
create function public.pos_commit_order(p_business_id uuid, p_order jsonb, p_lines jsonb)
returns void language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  incoming public.orders;
  order_id uuid;
begin
  if current_user not in ('postgres', 'service_role')
    and not public.scheduling_is_owner(p_business_id) then
    raise exception 'POS order promotion requires café owner' using errcode='42501';
  end if;
  if jsonb_typeof(p_order) is distinct from 'object' then
    raise exception 'Invalid POS order';
  end if;
  incoming := jsonb_populate_record(null::public.orders, p_order);

  if not exists (select from public.locations l
                  where l.id = incoming.location_id and l.business_id = p_business_id)
    or (incoming.employee_id is not null and not exists (
      select from public.employees e where e.id = incoming.employee_id and e.business_id = p_business_id
    )) then
    raise exception 'POS order refers to another or missing café location or employee';
  end if;

  insert into public.orders (
    business_id, location_id, pos_order_id, closed_at, business_date,
    gross_sales_cents, discounts_cents, refunds_cents, tax_cents, tip_cents,
    processing_fee_cents, processing_fee_status, processing_fee_provider, net_sales_cents,
    employee_id, dining_option, source_channel, guest_count
  ) values (
    p_business_id, incoming.location_id, incoming.pos_order_id, incoming.closed_at, incoming.business_date,
    incoming.gross_sales_cents, incoming.discounts_cents, incoming.refunds_cents, incoming.tax_cents, incoming.tip_cents,
    incoming.processing_fee_cents, incoming.processing_fee_status, incoming.processing_fee_provider, incoming.net_sales_cents,
    incoming.employee_id, incoming.dining_option, incoming.source_channel, incoming.guest_count
  ) on conflict (business_id, pos_order_id) do update set
    location_id = excluded.location_id,
    closed_at = excluded.closed_at,
    business_date = excluded.business_date,
    gross_sales_cents = excluded.gross_sales_cents,
    discounts_cents = excluded.discounts_cents,
    refunds_cents = excluded.refunds_cents,
    tax_cents = excluded.tax_cents,
    tip_cents = excluded.tip_cents,
    processing_fee_cents = excluded.processing_fee_cents,
    processing_fee_status = excluded.processing_fee_status,
    processing_fee_provider = excluded.processing_fee_provider,
    net_sales_cents = excluded.net_sales_cents,
    employee_id = excluded.employee_id,
    dining_option = excluded.dining_option,
    source_channel = excluded.source_channel,
    guest_count = excluded.guest_count
  returning id into order_id;

  perform public.pos_replace_order_lines(p_business_id, order_id, p_lines);
end;
$$;

revoke all on function public.pos_commit_order(uuid,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.pos_commit_order(uuid,jsonb,jsonb) to authenticated, service_role;

-- Evaluate the entire day's order set in one snapshot. In particular, a missing
-- order fee after the Data API row limit must still make this candidate ineligible.
create function public.pos_refresh_daily_fees(p_business_id uuid, p_business_date date, p_provider text)
returns void language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  amount bigint;
begin
  if current_user not in ('postgres', 'service_role')
    and not public.scheduling_is_owner(p_business_id) then
    raise exception 'POS fee refresh requires café owner' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'pos_refresh_daily_fees:' || p_business_id::text || ':' || to_char(p_business_date, 'YYYY-MM-DD') || ':' || p_provider, 0
  ));

  select case when bool_and(o.processing_fee_status = 'actual') then sum(o.processing_fee_cents) end
    into amount
  from public.orders o
  where o.business_id = p_business_id and o.business_date = p_business_date
    and o.processing_fee_provider = p_provider and not o.toast_excluded and o.superseded_by is null;

  if amount is null then
    perform public.set_processing_fee_candidate_eligibility(
      p_business_id, p_business_date, 'connected_pos_actual', p_provider, false
    );
  else
    perform public.upsert_processing_fee_daily_candidate(
      p_business_id, p_business_date, amount, 'actual', 'connected_pos_actual', p_provider,
      'pos-sync:' || p_provider || ':' || to_char(p_business_date, 'YYYY-MM-DD')
    );
  end if;
end;
$$;

revoke all on function public.pos_refresh_daily_fees(uuid,date,text) from public, anon, authenticated;
grant execute on function public.pos_refresh_daily_fees(uuid,date,text) to authenticated, service_role;
