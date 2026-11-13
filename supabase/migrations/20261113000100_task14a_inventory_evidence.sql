-- Task 14a: source-backed stock evidence in the ONE existing canonical view.
-- Safe only for separately authorized migration application; no data backfill,
-- deletion, new POS writer, client-visible service sync table, or current-stock guess.
set lock_timeout = '5s';
set statement_timeout = '45s';

-- Expose only four allowlisted, business-scoped source-receipt facts. The
-- operational_sources JSON itself remains service-role-only. SECURITY DEFINER
-- is necessary to read that private state, and MUST check the real signed-in
-- owner before each lookup; no model-provided or cross-café business identity.
create or replace function public.toast_stock_source_receipts(p_business_id uuid)
returns table(restaurant_guid uuid,checked_at text,successful_at text,
 source_status text,observed_count integer)
language plpgsql stable security definer set search_path=public,pg_temp as $receipts$
begin
 if p_business_id is null or (coalesce(current_setting('role',true),'authenticated') not in ('none','service_role')
  and (auth.uid() is null
   or not coalesce(public.scheduling_is_owner(p_business_id),false)))
 then raise exception 'stock_source_scope_denied' using errcode='42501'; end if;
 return query
 select s.restaurant_guid,
  nullif(s.operational_sources->'stock_inventory'->>'last_checked_at',''),
  nullif(s.operational_sources->'stock_inventory'->>'last_success_at',''),
  case when s.operational_sources->'stock_inventory'->>'status' in ('current','empty')
   then s.operational_sources->'stock_inventory'->>'status' else 'failed' end,
  case when jsonb_typeof(s.operational_sources->'stock_inventory'->'count')='number'
    and (s.operational_sources->'stock_inventory'->>'count') ~ '^[0-9]{1,8}$'
   then (s.operational_sources->'stock_inventory'->>'count')::integer end
 from public.toast_optional_sync_state s
 where s.business_id=p_business_id and s.operational_sources ? 'stock_inventory'
 order by s.restaurant_guid limit 100;
end $receipts$;
revoke all on function public.toast_stock_source_receipts(uuid) from public,anon;
grant execute on function public.toast_stock_source_receipts(uuid) to authenticated,service_role;

-- Keep the original column set and ordering for all existing readers. A stock
-- record omitted from a newer complete fetch stays in toast_raw_records as
-- historical evidence, but its CURRENT quantity/status must be null. A failure
-- may leave an old successful timestamp: source_status gates current claims.
-- Receipt-backed rows represent a present-state lookup on the café-local
-- query date. Legacy records without a stock-family receipt retain their
-- original observed business_date for existing canonical SQL range consumers;
-- the pure projection treats those values as unverified, never current.
create or replace view public.cv_inventory
 (business_id,source,source_ref,status,business_date,data,menu_item_ref,stock_status,quantity)
 with (security_invoker=true) as
 select i.business_id,'app'::text,'stock:'||i.id::text,'actual'::text,
  i.count_date,jsonb_build_object('ingredient_id',i.ingredient_id,
   'count_date',i.count_date,'quantity_base',i.quantity_base,
   'evidence_state','dated_owner_count'),null::text,null::text,
  i.quantity_base::numeric
 from public.pantry_stock_counts i
 union all
 select r.business_id,r.source,r.source_ref,r.status,
  case when receipt.restaurant_guid is not null
   then (now() at time zone b.timezone)::date
   else r.business_date end,
  jsonb_build_object('menu_item_ref',r.data->>'guid',
   'reported_stock_status',r.data->>'status',
   'quantity',case when e.evidence_state='observed_current' then r.data->'quantity' end,
   'source_as_of',r.data->>'lastSuccessAt',
   'observed_business_date',r.business_date,
   'checked_at',receipt.checked_at,
   'source_status',receipt.source_status,
   'observed_count',receipt.observed_count,
   'evidence_state',e.evidence_state),
  r.data->>'guid',
  -- Preserve the pre-existing SQL projection for legacy rows that have no
  -- recorded family check. They are NOT verified current stock: evidence_state
  -- stays source_unverified and all owner-facing tools must null the value.
  -- A known failed or newer successful receipt always hides historical stock.
  case when e.evidence_state='observed_current' or receipt.restaurant_guid is null
   then r.data->>'status' end,
  case when (e.evidence_state='observed_current' or receipt.restaurant_guid is null)
    and jsonb_typeof(r.data->'quantity')='number'
    and (r.data->>'quantity')::numeric>=0
   then (r.data->>'quantity')::numeric else null::numeric end
 from public.toast_records_for(null,null,null) r
 join public.businesses b on b.id=r.business_id
 left join lateral public.toast_stock_source_receipts(r.business_id) receipt
  on receipt.restaurant_guid::text=r.data->>'restaurant_guid'
 cross join lateral (select case
  when receipt.restaurant_guid is null or receipt.successful_at is null
   then 'source_unverified'
  when receipt.source_status not in ('current','empty') then 'source_failed'
  -- An empty family receipt is authoritative absence even if a fast retry
  -- reused the same millisecond timestamp as the retained object.
  when receipt.source_status='empty' then 'not_observed'
  -- Malformed/legacy count metadata cannot certify a full family observation.
  when coalesce(receipt.observed_count,0)<1 then 'source_unverified'
  when r.data->>'lastSuccessAt'=receipt.successful_at then 'observed_current'
  else 'not_observed' end::text as evidence_state) e
 where r.record_type='stock/v1/inventory';

revoke all on public.cv_inventory from public,anon;
grant select on public.cv_inventory to authenticated,service_role;
