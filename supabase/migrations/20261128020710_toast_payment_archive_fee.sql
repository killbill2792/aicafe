set lock_timeout = '5s';
set statement_timeout = '60s';

-- The independently observed payment supplies the fee. The existing writer
-- still checks the matching committed order and owns the typed projection.
create function public.toast_apply_archived_payment_fee(
  p_business_id uuid,p_restaurant_guid uuid,p_payment_guid uuid,p_revision bigint
) returns text language plpgsql security invoker set search_path=pg_catalog,public as $$
declare
  payment_resource constant text := 'orders/v2/payments/{guid}';
  restaurant_key constant text := p_restaurant_guid::text;
  payment_key constant text := p_payment_guid::text;
  body jsonb;
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
    select o.payload into body from public.external_read_observation(p_business_id,'toast',restaurant_key,
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
    return 'applied';
  end if;
  return 'order_pending';
end $$;
revoke all on function public.toast_apply_archived_payment_fee(uuid,uuid,uuid,bigint) from public,anon,authenticated;
grant execute on function public.toast_apply_archived_payment_fee(uuid,uuid,uuid,bigint) to service_role;
