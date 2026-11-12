-- POS0e security patch. Existing retained operational reader, NO new data source.
-- A camelCase-only credential denylist silently admitted snake_case reusable
-- secrets from old stored JSON via ai_toast_fields and ai_query_view. Normalize
-- only key names, preserving ordinary customer, staff and loyalty fields.
-- This migration is after the original POS0e 00156 reader and #444's 00302.
-- Does not re-process or reveal existing credential values.
set lock_timeout = '5s';
set statement_timeout = '30s';

create or replace function public.ai_query_path(p_col text) returns text[]
language sql immutable set search_path=public as $path$
 select case when p_col ~ '^data(\.([A-Za-z_][A-Za-z0-9_]{0,100}|[0-9]{1,3})){1,16}$'
  and not exists (
   select 1 from unnest(string_to_array(substr(p_col,6),'.')) s(part)
   where regexp_replace(part,'_','','g') ~* '^(pan|primaryAccountNumber|cardNumber|paymentCardNumber|cvv|cvc|cvv2|cvc2|cardVerificationValue|securityCode|magstripe|track|track1|track2|trackData|track1Data|track2Data|cardLast4|last4Digits|lastFour|first5|first6|expiration|expiry|expireDate|expirationDate|cardExpiry|cardExpiration|password|passcode|pin|apiKey|secret|clientSecret|privateKey|accessToken|refreshToken|sessionToken|authToken|authorization|authorizationToken|paymentToken|cardToken|oauthToken|bearerToken|apiSecret|token|tokenId|fingerprint|networkTransactionIdentifier|routingNumber|bankAccountNumber|accountNumber|signature|last4|firstFive|firstSix|expirationMonth|expirationYear|expiryMonth|expiryYear|expMonth|expYear|cardExpMonth|cardExpYear|cardExpirationMonth|cardExpirationYear|networkId)$'
      or regexp_replace(part,'_','','g') ~* '(Password|Secret|ApiKey|PrivateKey|AccessToken|RefreshToken|SessionToken|AuthToken|AuthorizationToken|OAuthToken|BearerToken|PaymentToken|CardToken|CardNumber|TrackData|SecurityCode|VerificationValue|Magstripe)$'
      or regexp_replace(part,'_','','g') ~* '^(card|cardInfo|cardDetails|cardData|creditCard|paymentCard|giftCard|giftCardInfo|paymentMethod)$'
  )
  and not (
   p_col ~* '^data\.(card|cardInfo|cardDetails|cardData|creditCard|paymentCard|giftCard|giftCardInfo|paymentMethod)\.(number|value|last4|first5|first6|lastFour|maskedNumber|expirationDate|expiryDate|expiryMonth|expiryYear|expMonth|expYear|holderName|cardholderName|networkId|networkTransactionIdentifier|accountId|accountNumber|tokenId)(\.|$)'
  )
 then string_to_array(substr(p_col,6),'.') end $path$;
revoke all on function public.ai_query_path(text) from public,anon;
grant execute on function public.ai_query_path(text) to authenticated,service_role;


-- Old records can be selected as whole data JSON or a permitted parent.
-- Redact only their READ projection; no payload rewrite or second ingestion path.
create or replace function public.ai_safe_retained_json(p_value jsonb,p_depth integer default 0)
returns jsonb language plpgsql immutable strict set search_path=public as $safe$
declare v_result jsonb;
begin
 if jsonb_typeof(p_value)='object' then
  if p_depth>=16 then return '{}'::jsonb; end if;
  select coalesce(jsonb_object_agg(e.key,public.ai_safe_retained_json(e.value,p_depth+1)),
   '{}'::jsonb) into v_result from jsonb_each(p_value) e
   where public.ai_query_path('data.'||replace(e.key,'-','_')) is not null;
  return v_result;
 elsif jsonb_typeof(p_value)='array' then
  if p_depth>=16 then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(public.ai_safe_retained_json(e.value,p_depth+1)
   order by e.n),'[]'::jsonb) into v_result
  from jsonb_array_elements(p_value) with ordinality e(value,n);
  return v_result;
 end if;
 return p_value;
end $safe$;
revoke all on function public.ai_safe_retained_json(jsonb,integer) from public,anon;
grant execute on function public.ai_safe_retained_json(jsonb,integer) to authenticated,service_role;

-- Same authorized current-record reader and source/tenant/verification guards;
-- only returned JSON is sanitized, so both discovery and query_data are safe.
create or replace function public.toast_records_for(p_business_id uuid,p_from date,p_to date)
returns table(business_id uuid,source text,source_ref text,status text,business_date date,
 record_type text,record_ref text,order_ref text,check_ref text,counts_in_sales boolean,data jsonb)
language sql stable security definer set search_path=public as $records$
with orders as not materialized (
 select r.business_id,r.business_date,r.id,r.payload o,
  case when d.business_id is null then 'provisional' else 'actual' end st,
  -- Same exclusions as the importer (lib/pos/toast/dayParser.ts): deleted, voided,
  -- excess-food and test-mode orders are kept here but never count in sales.
  (r.payload->'voided') is not distinct from 'true'::jsonb or (r.payload->'deleted') is not distinct from 'true'::jsonb
   or (r.payload->'excessFood') is not distinct from 'true'::jsonb or (r.payload->'createdInTestMode') is not distinct from 'true'::jsonb o_void
 from public.toast_raw_records r
 left join public.toast_day_status d on d.business_id=r.business_id
  and d.restaurant_guid=r.restaurant_guid and d.business_date=r.business_date
  and d.import_state='imported'
 where r.entity='order' and jsonb_typeof(r.payload)='object'
  and (
   -- An imported day: only its latest import's records.
   (d.business_id is not null and (r.run_id=d.last_import_run_id or r.seen_run_id=d.last_import_run_id))
   -- A day not imported yet: the orders the live job saved so far.
   or (d.business_id is null and r.run_id is null and r.seen_run_id is null and r.capture_key like 'live:%'))
  and (p_business_id is null or r.business_id=p_business_id)
  and (p_from is null or r.business_date>=p_from) and (p_to is null or r.business_date<=p_to)
  and case when p_business_id is not null then (select public.toast_records_allowed(p_business_id))
   else public.toast_records_allowed(r.business_id) end),
checks as not materialized (
 select o.*,c.v c,c.n cn,
  o.o_void or (c.v->'voided') is not distinct from 'true'::jsonb or (c.v->'deleted') is not distinct from 'true'::jsonb c_void
 from orders o cross join lateral jsonb_array_elements(case when jsonb_typeof(o.o->'checks')='array'
  then o.o->'checks' else '[]'::jsonb end) with ordinality c(v,n)
 where jsonb_typeof(c.v)='object'),
items as not materialized (
 -- Gift card and house-account items are deferred: the importer leaves them out of sales.
 select k.*,s.v s,s.n sn,k.c_void or (s.v->'voided') is not distinct from 'true'::jsonb or (s.v->'deferred') is not distinct from 'true'::jsonb
  or (s.v->>'selectionType') is not distinct from 'HOUSE_ACCOUNT_PAY_BALANCE' s_void
 from checks k cross join lateral jsonb_array_elements(case when jsonb_typeof(k.c->'selections')='array'
  then k.c->'selections' else '[]'::jsonb end) with ordinality s(v,n)
 where jsonb_typeof(s.v)='object'),
current_nonorders as not materialized (
 -- A single real, current object per provider key, never diagnostic samples.
 select r.business_id,r.restaurant_guid,r.id,r.entity,r.entity_guid,
  r.business_date,r.payload,
  coalesce(nullif(r.payload->>'endpoint',''),r.entity)::text record_type
 from public.toast_raw_records r
 where r.entity not in ('order','check','payment','item','modifier',
  'item_discount','check_discount','service_charge')
  and jsonb_typeof(r.payload)='object'
  -- Stage triggers also capture mirrored/test rows. A staged object needs a
  -- durable authenticated restaurant-info GET for the same café and Toast
  -- restaurant OR a currently verified mapping awaiting its info GET. Re-save or
  -- failed re-verification clears verified_at but NOT info_refreshed_at.
  -- The mirror lacks provider-identity evidence and remains excluded. Direct
  -- current-object archives and order projections are unchanged.
  and (r.capture_key not like 'stage:%' or exists (
   select 1 from public.toast_location_mappings m
   where m.business_id=r.business_id and m.restaurant_guid=r.restaurant_guid
    and (m.verified_at is not null or m.info_refreshed_at is not null)))
  and (p_business_id is null or r.business_id=p_business_id)
  and (p_from is null or r.business_date is null or r.business_date>=p_from)
  and (p_to is null or r.business_date is null or r.business_date<=p_to)
  and case when p_business_id is not null then (select public.toast_records_allowed(p_business_id))
   else public.toast_records_allowed(r.business_id) end)
select raw.business_id,raw.source,raw.source_ref,raw.status,raw.business_date,raw.record_type,raw.record_ref,raw.order_ref,raw.check_ref,raw.counts_in_sales,
 public.ai_safe_retained_json(raw.data) as data
from (
select business_id,'toast'::text,'toast-order:'||id::text,st,business_date,
 'order'::text,o->>'guid',o->>'guid',null::text,not o_void,o-'checks'
from orders
union all
select business_id,'toast','toast-check:'||id::text||':'||cn,st,business_date,
 'check',c->>'guid',o->>'guid',c->>'guid',not c_void,
 c-'selections'-'payments'-'appliedDiscounts'-'appliedServiceCharges'
from checks
union all
select business_id,'toast','toast-item:'||id::text||':'||cn||':'||sn,st,business_date,
 'item',s->>'guid',o->>'guid',c->>'guid',not s_void,s-'modifiers'-'appliedDiscounts'
from items
union all
select i.business_id,'toast','toast-modifier:'||i.id::text||':'||i.cn||':'||i.sn||':'||m.n,i.st,
 i.business_date,'modifier',m.v->>'guid',i.o->>'guid',i.c->>'guid',
 not i.s_void and (m.v->'voided') is distinct from 'true'::jsonb,
 m.v||jsonb_build_object('item_ref',i.s->>'guid')
from items i cross join lateral jsonb_array_elements(case when jsonb_typeof(i.s->'modifiers')='array'
 then i.s->'modifiers' else '[]'::jsonb end) with ordinality m(v,n)
where jsonb_typeof(m.v)='object'
union all
select i.business_id,'toast','toast-item-discount:'||i.id::text||':'||i.cn||':'||i.sn||':'||d.n,i.st,
 i.business_date,'item_discount',d.v->>'guid',i.o->>'guid',i.c->>'guid',not i.s_void
  and (d.v->>'processingState') is distinct from 'VOID',
 d.v||jsonb_build_object('item_ref',i.s->>'guid')
from items i cross join lateral jsonb_array_elements(case when jsonb_typeof(i.s->'appliedDiscounts')='array'
 then i.s->'appliedDiscounts' else '[]'::jsonb end) with ordinality d(v,n)
where jsonb_typeof(d.v)='object'
union all
select k.business_id,'toast','toast-payment:'||k.id::text||':'||k.cn||':'||p.n,k.st,k.business_date,
 'payment',p.v->>'guid',k.o->>'guid',k.c->>'guid',
 not k.c_void and (p.v->'voided') is distinct from 'true'::jsonb
  and coalesce(p.v->>'paymentStatus','') not in ('VOIDED','DENIED','CANCELLED','ERROR','ERROR_NETWORK'),p.v
from checks k cross join lateral jsonb_array_elements(case when jsonb_typeof(k.c->'payments')='array'
 then k.c->'payments' else '[]'::jsonb end) with ordinality p(v,n)
where jsonb_typeof(p.v)='object'
union all
select k.business_id,'toast','toast-check-discount:'||k.id::text||':'||k.cn||':'||d.n,k.st,k.business_date,
 'check_discount',d.v->>'guid',k.o->>'guid',k.c->>'guid',not k.c_void
  and (d.v->>'processingState') is distinct from 'VOID',d.v
from checks k cross join lateral jsonb_array_elements(case when jsonb_typeof(k.c->'appliedDiscounts')='array'
 then k.c->'appliedDiscounts' else '[]'::jsonb end) with ordinality d(v,n)
where jsonb_typeof(d.v)='object'
union all
select k.business_id,'toast','toast-service-charge:'||k.id::text||':'||k.cn||':'||d.n,k.st,k.business_date,
 'service_charge',d.v->>'guid',k.o->>'guid',k.c->>'guid',not k.c_void,d.v
from checks k cross join lateral jsonb_array_elements(case when jsonb_typeof(k.c->'appliedServiceCharges')='array'
 then k.c->'appliedServiceCharges' else '[]'::jsonb end) with ordinality d(v,n)
where jsonb_typeof(d.v)='object'
union all
select r.business_id,'toast'::text,'toast-current:'||r.id::text,
 -- Until source-specific freshness is verified, stored is not the same as final.
 'open'::text,r.business_date,r.record_type,
 coalesce(r.entity_guid::text,nullif(r.payload->>'guid',''),
  nullif(r.payload->>'employee_guid',''),nullif(r.payload->>'provider_guid','')),
 null::text,null::text,null::boolean,r.payload
from current_nonorders r
) raw(business_id,source,source_ref,status,business_date,record_type,record_ref,order_ref,check_ref,counts_in_sales,data)
$records$;
