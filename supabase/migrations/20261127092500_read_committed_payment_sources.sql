set lock_timeout = '5s';
set statement_timeout = '60s';

-- Scope the expansion to the caller's committed order set before walking the
-- original JSON. Ordinality identifies a payment without a provider GUID.
create function public.toast_order_payment_members(p_order jsonb)
returns table(check_index bigint,payment_index bigint,payment jsonb)
language sql immutable strict parallel safe security invoker set search_path=pg_catalog as $$
 select c.idx,p.idx,p.body
 from jsonb_array_elements(case when jsonb_typeof(p_order->'checks')='array'
  then p_order->'checks' else '[]'::jsonb end) with ordinality c(body,idx)
 cross join lateral jsonb_array_elements(case when jsonb_typeof(c.body->'payments')='array'
  then c.body->'payments' else '[]'::jsonb end) with ordinality p(body,idx)
$$;
revoke all on function public.toast_order_payment_members(jsonb) from public,anon;
grant execute on function public.toast_order_payment_members(jsonb) to authenticated,service_role;

create or replace view public.cv_payments
 (business_id,source,source_ref,status,business_date,amount_cents,tip_cents,
  data,payment_type,card_type,card_entry_mode,original_processing_fee_cents,
  processing_fee_cents,fee_status)
with (security_invoker=true) as
 with observed as not materialized (
  select r.business_id,r.restaurant_guid,r.business_date,r.id,r.first_seen,r.entity_guid,
   coalesce(case when p.payment->>'guid' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then ((p.payment->>'guid')::uuid)::text end,
    'payment:'||r.run_id::text||':'||r.business_date::text||':'||r.source_page::text||':'||r.source_index::text||':'||
     p.check_index::text||':'||p.payment_index::text) as payment_ref,
   p.payment,p.check_index,p.payment_index
  from public.external_records r
  join public.toast_day_status d using(business_id,restaurant_guid,business_date)
  cross join lateral public.toast_order_payment_members(r.payload) p
  where r.provider='toast' and r.entity='order' and r.superseded_by is null
   and r.source_account=r.restaurant_guid::text and r.source_key=r.entity_guid::text
   and r.payload_origin in ('provider','historical_provider')
   and d.import_state='imported' and (r.run_id=d.last_import_run_id or r.seen_run_id=d.last_import_run_id)
 ), source_rows as not materialized (
  select distinct on (o.business_id,o.restaurant_guid,o.business_date,o.payment_ref)
   o.business_id,o.restaurant_guid,o.business_date,o.payment_ref,o.id as order_record_id,o.entity_guid as order_guid,
   left(o.payment->>'type',80) as payment_type,left(o.payment->>'cardType',80) as card_type,
   left(o.payment->>'cardEntryMode',80) as card_entry_mode,left(o.payment->>'paymentStatus',80) as payment_status,
   case when jsonb_typeof(o.payment->'amount')='number' then round((o.payment->>'amount')::numeric*100)::bigint end as amount_cents,
   case when jsonb_typeof(o.payment->'tipAmount')='number' then round((o.payment->>'tipAmount')::numeric*100)::bigint end as tip_cents,
   case when jsonb_typeof(o.payment->'originalProcessingFee')='number'
    then round((o.payment->>'originalProcessingFee')::numeric*100)::bigint end as order_fee,
   count(*) over (partition by o.business_id,o.restaurant_guid,o.business_date,o.payment_ref) as matches
  from observed o where o.payment_ref is not null
  order by o.business_id,o.restaurant_guid,o.business_date,o.payment_ref,o.first_seen desc,o.id,o.check_index,o.payment_index
 ), typed as not materialized (
  select p.*, (f.business_id is not null and
    (f.payment_type,f.payment_status,f.amount_cents,f.card_type,f.card_entry_mode) is not distinct from
    (p.payment_type,p.payment_status,p.amount_cents,p.card_type,p.card_entry_mode)) as same_inputs,
   f.original_processing_fee_cents as retained_fee,f.processing_fee_cents as derived_fee,
   f.fee_status as retained_status,f.fee_basis as retained_basis,point.fee as point_fee
  from source_rows p left join public.toast_payment_facts f using(business_id,restaurant_guid,business_date,payment_ref)
  left join lateral (
   select round((r.payload->>'originalProcessingFee')::numeric*100)::bigint as fee
   from public.external_record_links l
   join public.external_records r on (r.business_id,r.provider,r.id)=(l.business_id,l.provider,l.record_id)
   join public.external_resources e on (e.business_id,e.provider,e.source_account,e.resource)=
    (r.business_id,r.provider,r.source_account,r.entity)
   where (l.business_id,l.target_provider,l.target_id)=(p.business_id,'toast',p.order_record_id)
    and l.provider='toast' and l.relation='order_payment' and l.valid_until is null
    and r.source_account=p.restaurant_guid::text and r.entity='orders/v2/payments/{guid}' and r.source_key=p.payment_ref
    and l.evidence->>'payloadSha256'=r.payload_sha256
    and l.evidence->>'amountCents'=p.amount_cents::text
    and p.payment_type='CREDIT' and p.payment_status='CAPTURED'
    and jsonb_typeof(r.payload->'originalProcessingFee')='number'
    and public.external_current_observation(r,e)
   order by l.observed_at desc limit 1
  ) point on true
  where p.matches=1
 ), fees as not materialized (
  select t.*,
   case when t.point_fee is not null then t.point_fee
    when t.same_inputs and t.payment_status='CAPTURED' and t.retained_basis='toast'
     and t.order_fee is null then t.retained_fee else t.order_fee end as original_fee,
   upper(regexp_replace(coalesce(t.payment_type,''),'[^a-zA-Z]','','g')) in ('CASH','GIFTCARD','GIFTCERTIFICATE') as no_card_fee
  from typed t
 ), fee_choice as not materialized (
  select f.*,
   case when f.no_card_fee then 0 when f.original_fee is not null then f.original_fee
    when f.same_inputs and f.retained_status='estimated' then f.derived_fee
    when f.same_inputs and f.retained_basis='cash_or_gift' then f.derived_fee end as selected_fee,
   case when f.no_card_fee then 'cash_or_gift' when f.original_fee is not null then 'toast'
    when f.same_inputs and (f.retained_status='estimated' or f.retained_basis='cash_or_gift') then f.retained_basis
    else 'missing' end as basis
  from fees f
 )
 select p.business_id,'toast'::text,'payment:'||p.restaurant_guid::text||':'||p.payment_ref,
  case when p.amount_cents is null then 'open' else 'actual' end,p.business_date,p.amount_cents,p.tip_cents,
  jsonb_build_object('type',p.payment_type,'cardType',p.card_type,'cardEntryMode',p.card_entry_mode,
   'originalProcessingFeeCents',p.original_fee,'feeStatus',s.fee_status,'feeBasis',p.basis,
   'evidence','committed_order','orderGuid',p.order_guid,'paymentStatus',p.payment_status,
   'feeCacheMatches',p.same_inputs and p.original_fee is not distinct from p.retained_fee,
   'feeEvidence',case when p.point_fee is not null then 'point_observation'
    when p.order_fee is not null then 'committed_order'
    when p.original_fee is not null then 'historical_projection' end),
  p.payment_type,p.card_type,p.card_entry_mode,p.original_fee,p.selected_fee,s.fee_status
 from fee_choice p
 cross join lateral (select case when p.selected_fee is null then 'missing'
  when p.basis in ('toast','cash_or_gift') then 'actual' else 'estimated' end as fee_status) s
 union all
 select f.business_id,'toast'::text,'payment:'||f.restaurant_guid::text||':'||f.payment_ref,
  case when p.matches>1 then 'needs_match' else f.status end,f.business_date,f.amount_cents,f.tip_cents,
  jsonb_build_object('type',f.payment_type,'cardType',f.card_type,'cardEntryMode',f.card_entry_mode,
   'originalProcessingFeeCents',f.original_processing_fee_cents,'feeStatus',f.fee_status,'feeBasis',f.fee_basis,
   'evidence','historical_projection','paymentStatus',f.payment_status,'feeCacheMatches',true),
  f.payment_type,f.card_type,f.card_entry_mode,f.original_processing_fee_cents,f.processing_fee_cents,f.fee_status
 from public.toast_payment_facts f
 left join source_rows p using(business_id,restaurant_guid,business_date,payment_ref)
 where p.matches is distinct from 1
 union all
 select s.business_id,'toast'::text,'payment:'||s.restaurant_guid::text||':'||s.payment_ref,
  s.status,s.business_date,s.amount_cents,s.tip_cents,
  jsonb_build_object('type',s.payment_type,'legacy',true,'evidence','historical_summary'),
  s.payment_type,null::text,null::text,null::bigint,null::bigint,'missing'::text
 from public.toast_payment_summaries s
 where not exists(select from public.toast_payment_facts f where
  (f.business_id,f.restaurant_guid,f.business_date)=(s.business_id,s.restaurant_guid,s.business_date))
  and not exists(select from source_rows p where p.matches=1 and
   (p.business_id,p.restaurant_guid,p.business_date)=(s.business_id,s.restaurant_guid,s.business_date))
 union all
 select e.business_id,'toast'::text,
  'payment-event:'||e.restaurant_guid::text||':'||e.payment_guid::text||':'||e.kind||':'||e.event_business_date::text,
  'open'::text,e.event_business_date,null::bigint,null::bigint,
  jsonb_build_object('kind','payment_event','payment_guid',e.payment_guid,
   'event',e.kind,'observed_at',e.observed_at,'amount_known',false),
  null::text,null::text,null::text,null::bigint,null::bigint,'missing'::text
 from public.toast_payment_day_events e;

create or replace function public.toast_apply_archived_payment_fee(
  p_business_id uuid,p_restaurant_guid uuid,p_payment_guid uuid,p_revision bigint
) returns text language plpgsql security invoker set search_path=pg_catalog,public as $$
declare
  payment_resource constant text := 'orders/v2/payments/{guid}';
  restaurant_key constant text := p_restaurant_guid::text;
  payment_key constant text := p_payment_guid::text;
  body jsonb;
  source_record uuid;
  amount numeric;
  fee numeric;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Invalid payment fee evidence'; end if;
  -- The archive writer locks the same resource before its checkpoint and payload.
  -- Hold it until the canonical update commits, so a new observation cannot race it.
  perform 1 from public.external_resources e
    where (e.business_id,e.provider,e.source_account,e.resource)=(p_business_id,'toast',restaurant_key,payment_resource)
    for share;
  begin
    select o.record_id,o.payload into source_record,body from public.external_read_observation(p_business_id,'toast',restaurant_key,
      payment_resource,payment_key,p_revision,null,jsonb_build_object('paymentGuid',payment_key),'point') o;
  exception when serialization_failure or object_not_in_prerequisite_state then
    return 'refresh_evidence';
  end;
  if lower(body->>'guid') is distinct from payment_key or
    (body->>'restaurantGuid' is not null and lower(body->>'restaurantGuid')<>restaurant_key) or
    not coalesce(pg_input_is_valid(body->>'orderGuid','uuid'),false) or
    body->'voided'='true'::jsonb or upper(body->>'paymentStatus') is distinct from 'CAPTURED' or
    regexp_replace(upper(body->>'type'),'[^A-Z]','','g') is distinct from 'CREDIT' or
    jsonb_typeof(body->'amount') is distinct from 'number' or
    jsonb_typeof(body->'originalProcessingFee') is distinct from 'number' then
    return 'refresh_evidence';
  end if;
  amount := floor((body->>'amount')::numeric*100+0.5);
  fee := (body->>'originalProcessingFee')::numeric;
  if fee<0 or fee*100>9007199254740991 or abs(amount)>9007199254740991 then return 'refresh_evidence'; end if;
  if public.toast_apply_verified_payment_fee(p_business_id,p_restaurant_guid,(body->>'orderGuid')::uuid,
      p_payment_guid,amount::bigint,round(fee*100)::bigint) then
    -- Apply the relation only when exactly one retained current order
    -- contains this payment at the independently verified captured amount.
    with candidates as (
     select r.id,point.payload_sha256,p.check_index,p.payment_index,count(*) over () as matches
     from public.external_records point
     join public.external_records r on (r.business_id,r.provider)=(point.business_id,point.provider)
     join public.toast_day_status d on (d.business_id,d.restaurant_guid,d.business_date)=(r.business_id,r.restaurant_guid,r.business_date)
     cross join lateral public.toast_order_payment_members(r.payload) p
     where (point.business_id,point.provider,point.id)=(p_business_id,'toast',source_record)
      and (r.restaurant_guid,r.entity,r.entity_guid)=(p_restaurant_guid,'order',(body->>'orderGuid')::uuid)
      and r.source_account=restaurant_key and r.source_key=r.entity_guid::text and r.superseded_by is null
      and r.payload_origin in ('provider','historical_provider')
      and d.import_state='imported' and (r.run_id=d.last_import_run_id or r.seen_run_id=d.last_import_run_id)
      and p.payment->>'guid'=payment_key and p.payment->>'paymentStatus'='CAPTURED'
      and case when jsonb_typeof(p.payment->'amount')='number' then round((p.payment->>'amount')::numeric*100)=amount else false end
    )
    insert into public.external_record_links(business_id,provider,record_id,relation,target_provider,target_id,selector,evidence)
    select p_business_id,'toast',source_record,'order_payment','toast',c.id,'{"path":[]}',
     jsonb_build_object('payloadSha256',c.payload_sha256,'amountCents',amount,'paymentGuid',payment_key,
      'targetSelector',jsonb_build_object('path',jsonb_build_array('checks',c.check_index-1,'payments',c.payment_index-1)))
    from candidates c where c.matches=1
    on conflict (business_id,provider,record_id,relation,target_provider,target_id,md5(selector::text))
      where target_id is not null and valid_until is null
    do update set evidence=excluded.evidence,observed_at=clock_timestamp()
    where external_record_links.evidence is distinct from excluded.evidence;
    return 'applied';
  end if;
  return 'order_pending';
end $$;
