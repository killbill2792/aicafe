-- The permanent archive (toast_raw_records) must not keep customer personal details
-- (AGENTS.md section 4b and rule 8.5). toast_archive_page stored the unmodified Toast
-- order, check and payment payloads. This applies the same rules as the TypeScript
-- sampler redaction (lib/pos/toast/rawSample.server.ts) inside the database, so the
-- import path is unchanged. Business data (amounts, items, discounts, taxes, times,
-- GUIDs, card type and entry mode) is kept. Customer identifiers are dropped rather
-- than hashed because the database has no hash key. Hashes and capture keys are
-- computed from the redacted payload.

create or replace function public.toast_redact_raw(p jsonb,p_ctx text default '')
returns jsonb language plpgsql immutable set search_path=public as $redact$
declare
 k text; v jsonb; child text; out jsonb; s text;
 personal_parent constant text:='^(customer|customerinfo|customerdetails|guest|guestinfo|loyalty|loyaltyaccount|patron|card|cardinfo|carddetails|creditcard|paymentcard|cardholder|person|recipient|buyer|purchaser|payer|contact|deliveryinfo|billing|shipping)$';
 contact constant text:='(email|phone|mobile|fax|street|address|postal|zipcode|latitude|longitude|^lat$|^lon$|^lng$|ipaddress|birth|^firstname$|^lastname$|^fullname$|^chosenname$|^(customer|guest|cardholder|employee|server|cashier|recipient|buyer|purchaser|payer|patron)(first|last|full|chosen)?name$)';
 card_secret constant text:='(cardnumber|cardlast4|lastfour|last4|first5|firstfive|first6|firstsix|pan$|cvv|cvc|magstripe|trackdata|expiry|expiration|expiredate|cardholdername|cardname|networkid)';
 auth_secret constant text:='(password|secret|authorization|token|apikey|credential|sessiontoken|signature|passcode|pin$|routingnumber|accountnumber|deviceid)';
 freeform constant text:='(notes?|memo|comment|message|instructions?|^text$|^tabname$|receipttext|^description$)';
 customer_id constant text:='(^customer(id|guid|identifier|accountid|accountguid|number|externalid)$|^guest(id|guid|identifier)$|^loyalty(id|guid|identifier|accountid|accountguid|accountnumber|customerid|customerguid)$|^card(id|guid|fingerprint|tokenid|numberidentifier)$|^creditcard(id|guid|fingerprint)$|^giftcard(id|guid|fingerprint)$|^cardpaymentid$|^paymentcardid$|^cardtokenid$|^networktransactionidentifier$|^tendertransactionguid$|^maskedloyaltyidentifier$)';
 personal_field constant text:='^(name|displayname|nickname|firstname|lastname|fullname|chosenname)$';
 named_ctx constant text:='^(orders?|checks?|payments?|employee|staff|server|cashier)$';
begin
 if p is null then return null; end if;
 case jsonb_typeof(p)
 when 'object' then
  out:='{}'::jsonb;
  for k,v in select * from jsonb_each(p) loop
   continue when lower(k) ~ personal_parent or lower(k) ~ customer_id
    or lower(k) ~ contact or lower(k) ~ card_secret or lower(k) ~ auth_secret
    or lower(k) ~ freeform or (lower(k) ~ personal_field and lower(p_ctx) ~ named_ctx);
   child:=case when k in ('selections','discounts','appliedDiscounts','appliedServiceCharges','modifiers','items','menuItems') then ''
    when lower(k) ~ '^(giftcard|giftcardinfo|orders?|checks?|payments?|employee|staff|server|cashier)$' then k
    else p_ctx end;
   out:=out||jsonb_build_object(k,public.toast_redact_raw(v,child));
  end loop;
  return out;
 when 'array' then
  return coalesce((select jsonb_agg(public.toast_redact_raw(e,p_ctx) order by i)
   from jsonb_array_elements(p) with ordinality as a(e,i)),'[]'::jsonb);
 when 'string' then
  s:=p#>>'{}';
  if s ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' or s ~ '\m[0-9]{3}[-. ][0-9]{3}[-. ][0-9]{4}\M'
   or s ~ '\m[0-9]{13,19}\M' then return to_jsonb('[redacted]'::text); end if;
  return p;
 else return p;
 end case;
end $redact$;
revoke all on function public.toast_redact_raw(jsonb,text) from public,anon,authenticated;
grant execute on function public.toast_redact_raw(jsonb,text) to service_role;

create or replace function public.toast_archive_page(
 p_run_id uuid,p_business_date date,p_page integer,p_payload jsonb
) returns void language plpgsql security definer set search_path=public as $archive$
declare v_safe jsonb:=public.toast_redact_raw(p_payload,'orders');
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only'; end if;
 insert into public.toast_raw_records(
  business_id,restaurant_guid,entity,entity_guid,business_date,payload,
  payload_sha256,run_id,source_page,source_index,capture_key)
 select s.business_id,s.restaurant_guid,'order',
   case when item.raw->>'guid' ~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (item.raw->>'guid')::uuid else null end,
   p_business_date,item.raw,
   encode(sha256(convert_to(item.raw::text,'UTF8')),'hex'),
   p_run_id,p_page,item.idx::integer,
   'page:'||p_run_id::text||':'||p_business_date::text||':'||p_page::text||':'||item.idx::text||':'||encode(sha256(convert_to(item.raw::text,'UTF8')),'hex')
 from public.toast_sync_runs s
 cross join lateral jsonb_array_elements(v_safe) with ordinality as item(raw,idx)
 where s.id=p_run_id
 on conflict (business_id,capture_key) do nothing;
 -- Preserve nested checks as independent immutable raw entities.
 insert into public.toast_raw_records(business_id,restaurant_guid,entity,entity_guid,business_date,payload,payload_sha256,run_id,source_page,source_index,capture_key)
 select s.business_id,s.restaurant_guid,'check',
 case when c.raw->>'guid' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (c.raw->>'guid')::uuid else null end,
 p_business_date,c.raw,encode(sha256(convert_to(c.raw::text,'UTF8')),'hex'),p_run_id,p_page,o.idx::integer,
 'check:'||p_run_id::text||':'||p_business_date::text||':'||p_page::text||':'||o.idx::text||':'||c.idx::text||':'||
 encode(sha256(convert_to(c.raw::text,'UTF8')),'hex')
 from public.toast_sync_runs s
 cross join lateral jsonb_array_elements(v_safe) with ordinality as o(raw,idx)
 cross join lateral jsonb_array_elements(case when jsonb_typeof(o.raw->'checks')='array' then o.raw->'checks' else '[]'::jsonb end) with ordinality as c(raw,idx)
 where s.id=p_run_id
 on conflict(business_id,capture_key) do nothing;
 -- Preserve payments independently as raw entities; the owner reads only sanitized summaries.
 insert into public.toast_raw_records(business_id,restaurant_guid,entity,entity_guid,business_date,payload,payload_sha256,run_id,source_page,source_index,capture_key)
 select s.business_id,s.restaurant_guid,'payment',
 case when p.raw->>'guid' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (p.raw->>'guid')::uuid else null end,
 p_business_date,p.raw,encode(sha256(convert_to(p.raw::text,'UTF8')),'hex'),p_run_id,p_page,o.idx::integer,
 'payment:'||p_run_id::text||':'||p_business_date::text||':'||p_page::text||':'||o.idx::text||':'||c.idx::text||':'||p.idx::text||':'||
 encode(sha256(convert_to(p.raw::text,'UTF8')),'hex')
 from public.toast_sync_runs s
 cross join lateral jsonb_array_elements(v_safe) with ordinality as o(raw,idx)
 cross join lateral jsonb_array_elements(case when jsonb_typeof(o.raw->'checks')='array' then o.raw->'checks' else '[]'::jsonb end) with ordinality as c(raw,idx)
 cross join lateral jsonb_array_elements(case when jsonb_typeof(c.raw->'payments')='array' then c.raw->'payments' else '[]'::jsonb end) with ordinality as p(raw,idx)
 where s.id=p_run_id
 on conflict(business_id,capture_key) do nothing;
end $archive$;
revoke all on function public.toast_archive_page(uuid,date,integer,jsonb) from public,anon,authenticated;
grant execute on function public.toast_archive_page(uuid,date,integer,jsonb) to service_role;
