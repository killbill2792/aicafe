set lock_timeout = '5s';
set statement_timeout = '60s';
-- Pantry presents the current source receipt and independent owner counts.
-- The provider quantity is usable only when it was included in the latest
-- complete snapshot for that account. A stale or empty receipt is not zero.
create function public.inventory_evidence_for(p_business_id uuid,p_from date,p_to date)
returns table(
  business_id uuid,source text,source_ref text,status text,business_date date,
  data jsonb,menu_item_ref text,stock_status text,quantity numeric
) language sql stable security invoker set search_path=pg_catalog,public as $$
  select i.business_id,'app','stock:'||i.id,'actual',i.count_date,
    jsonb_build_object('ingredient_id',i.ingredient_id,'ingredient_name',ingredient.name,
     'base_unit',ingredient.base_unit,'count_date',i.count_date,'quantity_base',i.quantity_base,
     'evidence_state','dated_owner_count'),
    null::text,null::text,i.quantity_base::numeric
  from public.pantry_stock_counts i
  left join public.ingredients ingredient on (ingredient.business_id,ingredient.id)=(i.business_id,i.ingredient_id)
  where i.business_id=p_business_id and i.count_date between p_from and p_to
  union all
  select r.business_id,r.provider,'toast-current:'||r.id,'open',shown.business_date,
    jsonb_build_object('menu_item_ref',r.source_key,'reported_stock_status',r.payload->>'status',
      'quantity',q.quantity,'source_as_of',r.source_context->>'lastSuccessAt',
      'observed_business_date',r.business_date,'checked_at',e.last_attempt_at,
      'source_status',e.status,'evidence_state',shown.evidence_state),
    r.source_key,case when shown.evidence_state='observed_current' then r.payload->>'status' end,q.quantity
  from public.external_records r
  join public.businesses b on b.id=r.business_id
  left join public.external_resources e on (e.business_id,e.provider,e.source_account,e.resource)=
    (r.business_id,r.provider,r.source_account,r.entity)
  cross join lateral (
    select case when e.last_complete_at is not null then (now() at time zone b.timezone)::date
                else r.business_date end as business_date,
      case when e.last_complete_commit is null then 'source_unverified'
           when e.status<>'current' then 'source_failed'
           when r.commit_id=e.last_complete_commit then 'observed_current'
           else 'not_observed' end as evidence_state
  ) shown
  cross join lateral (
    select case when shown.evidence_state='observed_current' and jsonb_typeof(r.payload->'quantity')='number'
          then case when (r.payload->>'quantity')::numeric>=0 then (r.payload->>'quantity')::numeric end
           end as quantity
  ) q
  where r.business_id=p_business_id and r.provider='toast' and r.entity='stock/v1/inventory'
    and r.source_account is not null and shown.business_date between p_from and p_to
$$;
revoke all on function public.inventory_evidence_for(uuid,date,date) from public,anon;
grant execute on function public.inventory_evidence_for(uuid,date,date) to authenticated,service_role;
