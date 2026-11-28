-- Scope genuine pre-archive stock records without offering them as current
-- stock. The current read requires a verified observation receipt.
-- Reason: Attribution, view cutover and removal of the redundant receipt reader are atomic.
-- squawk-ignore transaction-nesting
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

with historical as (
 select distinct on (r.business_id,r.restaurant_guid,r.payload->>'guid')
   r.business_id,r.id,r.restaurant_guid::text as account,r.payload->>'guid' as source_key
 from public.external_records r
 join public.toast_location_mappings m on (m.business_id,m.restaurant_guid)=(r.business_id,r.restaurant_guid)
 where r.provider='toast' and r.entity='stock/v1/inventory' and r.source_account is null
   and nullif(r.payload->>'guid','') is not null
   and (m.verified_at is not null or m.info_refreshed_at is not null)
   and r.capture_key='stage:toast_operational_current:key:'||r.restaurant_guid::text||'|'||r.entity||'|'||(r.payload->>'guid')
   and r.payload=public.ai_safe_retained_json(r.payload)
   and not exists (select from public.external_records current_record where
     (current_record.business_id,current_record.provider,current_record.source_account,current_record.entity,current_record.source_key)=
       (r.business_id,r.provider,r.restaurant_guid::text,r.entity,r.payload->>'guid'))
 order by r.business_id,r.restaurant_guid,r.payload->>'guid',r.last_seen desc,r.id
)
update public.external_records r set source_account=h.account,source_key=h.source_key,
 payload_origin='historical_provider'
from historical h
where (r.business_id,r.provider,r.id)=(h.business_id,'toast',h.id);

create or replace view public.cv_inventory
 (business_id,source,source_ref,status,business_date,data,menu_item_ref,stock_status,quantity)
 with (security_invoker=true) as
 select i.business_id,'app','stock:'||i.id,'actual',i.count_date,
    jsonb_build_object('ingredient_id',i.ingredient_id,'ingredient_name',ingredient.name,
     'base_unit',ingredient.base_unit,'count_date',i.count_date,'quantity_base',i.quantity_base,
     'evidence_state','dated_owner_count'),
    null::text,null::text,i.quantity_base::numeric
  from public.pantry_stock_counts i
  left join public.ingredients ingredient on (ingredient.business_id,ingredient.id)=(i.business_id,i.ingredient_id)

  union all
  select r.business_id,r.provider,'toast-current:'||r.id,'open',shown.business_date,
    jsonb_build_object('menu_item_ref',r.source_key,'reported_stock_status',r.payload->>'status',
      'quantity',q.quantity,'source_as_of',coalesce(r.source_context->>'lastSuccessAt',r.payload->>'lastSuccessAt'),
      'observed_business_date',r.business_date,'checked_at',e.last_attempt_at,
      'source_status',e.status,'evidence_state',shown.evidence_state),
    r.source_key,case when shown.evidence_state='observed_current' then r.payload->>'status' end,q.quantity
  from public.external_records r
  join public.businesses b on b.id=r.business_id
  left join public.external_resources e on (e.business_id,e.provider,e.source_account,e.resource)=
    (r.business_id,r.provider,r.source_account,r.entity)
  cross join lateral (
    select case when e.last_complete_at is not null or r.source_context->>'observation_mode'='point' then (now() at time zone b.timezone)::date
                else r.business_date end as business_date,
      case when public.external_current_observation(r,e) then 'observed_current'
           when r.payload_origin='historical_provider' or e.last_complete_commit is null then 'source_unverified'
           when e.status<>'current' then 'source_failed'
           else 'not_observed' end as evidence_state
  ) shown
  cross join lateral (
    select case when shown.evidence_state='observed_current' and jsonb_typeof(r.payload->'quantity')='number'
          then case when (r.payload->>'quantity')::numeric>=0 then (r.payload->>'quantity')::numeric end
           end as quantity
  ) q
  where r.provider='toast' and r.entity='stock/v1/inventory' and r.source_account is not null;

create or replace function public.inventory_evidence_for(p_business_id uuid,p_from date,p_to date)
returns table(
  business_id uuid,source text,source_ref text,status text,business_date date,
  data jsonb,menu_item_ref text,stock_status text,quantity numeric
) language sql stable security invoker set search_path=pg_catalog,public as $$

 select v.* from public.cv_inventory v
 where v.business_id=p_business_id and v.business_date between p_from and p_to
$$;

create or replace function public.toast_constrained_stock_guids(p_business_id uuid,p_restaurant_guid uuid)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(distinct r.entity_guid),'[]'::jsonb)
 from public.external_records r
 where r.business_id=p_business_id and r.provider='toast' and r.source_account=p_restaurant_guid::text
   and r.entity='stock/v1/inventory' and r.entity_guid is not null
   and r.payload->>'status' in ('OUT_OF_STOCK','QUANTITY')
$$;

-- Reason: Pantry and SQL use the archive resource and observation membership after the view replacement.
-- squawk-ignore ban-drop-function
 drop function public.toast_stock_source_receipts(uuid);
-- Reason: End the shared inventory cutover transaction.
-- squawk-ignore transaction-nesting
commit;
