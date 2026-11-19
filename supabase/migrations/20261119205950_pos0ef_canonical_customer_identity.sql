-- POS0E/POS0F customer evidence in the existing authorized current Toast reader.
-- No new table, raw writer, scheduler, role or provider permissions.
-- Cardholder names are display evidence only. Never link by payment data/name.
-- https://doc.toasttab.com/openapi/orders/tag/Data-definitions/schema/Customer/
-- https://doc.toasttab.com/openapi/orders/tag/Data-definitions/schema/AppliedLoyaltyInfo/
-- https://doc.toasttab.com/openapi/orders/tag/Data-definitions/schema/Check/
set lock_timeout = '5s';
set statement_timeout = '30s';

-- Old retained strings can predate ingestion redaction. Expose only plausible
-- name labels from explicit fields; no arbitrary object or payment data.
create or replace function public.ai_customer_name(p_value jsonb)
returns text language plpgsql immutable strict set search_path=public as $name$
declare v text;
begin
 if jsonb_typeof(p_value)<>'string' then return null; end if;
 v:=regexp_replace(btrim(p_value#>>'{}'),'[[:space:]]+',' ','g');
 if length(v) not between 1 and 120 or v !~ '[[:alpha:]]'
  or v ~ '[[:cntrl:]]' or (p_value#>>'{}') ~ '[[:cntrl:]]'
  or v !~ '^[[:alpha:] .''’–-]+$'
  or v ~* '(^bearer[[:space:]]|password|secret|token|^sk-)'
  or lower(v) in ('unknown','guest','customer','cash','credit','card','test','redacted','none','null','n/a')
 then return null; end if;
 return v;
end $name$;
revoke all on function public.ai_customer_name(jsonb) from public,anon,authenticated,service_role;

-- One private refund calculation for check attribution and recorded refunds.
create or replace function public.ai_customer_check_refund_cents(p_check jsonb)
returns bigint language plpgsql immutable strict set search_path=public as $refund$
declare v bigint:=0; delta bigint; item jsonb; refs text[]:=array[]::text[]; ref text;
begin
 if p_check->'payments' is not null and jsonb_typeof(p_check->'payments') not in ('array','null') then return null; end if;
 for item in select value from jsonb_array_elements(case when jsonb_typeof(p_check->'payments')='array'
  then p_check->'payments' else '[]'::jsonb end) loop
  if jsonb_typeof(item)<>'object' then return null; end if;
  if (item->'voided') is not distinct from 'true'::jsonb or
   coalesce(item->>'paymentStatus','') in ('VOIDED','DENIED','CANCELLED','ERROR','ERROR_NETWORK') then continue; end if;
  ref:=nullif(btrim(item->>'guid'),'');
  if ref is not null then
   if ref=any(refs) then return null; end if;
   refs:=array_append(refs,ref);
  end if;
  if item->'refund' is not null and item->'refund'<>'null'::jsonb then
   delta:=public.toast_json_dollars_to_cents(item->'refund'->'refundAmount');
   if delta is null or ref is null then return null; end if;
   v:=v+delta;
  end if;
 end loop;
 if abs(v::numeric)>9007199254740991 then return null; end if;
 return v;
exception when numeric_value_out_of_range then return null;
end $refund$;
revoke all on function public.ai_customer_check_refund_cents(jsonb) from public,anon,authenticated,service_role;

-- Any nonvoid recorded use is positive evidence. An absent/malformed array
-- is not certified nonuse. A zero requires explicit complete arrays.
create or replace function public.ai_customer_discount_participation(p_check jsonb)
returns integer language plpgsql immutable strict set search_path=public as $discount$
declare selection jsonb; discount jsonb; complete boolean:=true; used boolean:=false;
begin
 if jsonb_typeof(p_check->'appliedDiscounts') is distinct from 'array' then complete:=false;end if;
 if jsonb_typeof(p_check->'selections') is distinct from 'array' then complete:=false;end if;
 for discount in select value from jsonb_array_elements(case when jsonb_typeof(p_check->'appliedDiscounts')='array'
  then p_check->'appliedDiscounts' else '[]'::jsonb end) loop
  if jsonb_typeof(discount)<>'object' then complete:=false;
  elsif discount->>'processingState' is distinct from 'VOID' then used:=true;end if;
 end loop;
 for selection in select value from jsonb_array_elements(case when jsonb_typeof(p_check->'selections')='array'
  then p_check->'selections' else '[]'::jsonb end) loop
  if jsonb_typeof(selection)<>'object' then complete:=false;continue;end if;
  if selection->'voided'='true'::jsonb or selection->'deferred'='true'::jsonb or selection->>'selectionType'='HOUSE_ACCOUNT_PAY_BALANCE' then continue;end if;
  if jsonb_typeof(selection->'appliedDiscounts') is distinct from 'array' then complete:=false;end if;
  for discount in select value from jsonb_array_elements(case when jsonb_typeof(selection->'appliedDiscounts')='array'
   then selection->'appliedDiscounts' else '[]'::jsonb end) loop
   if jsonb_typeof(discount)<>'object' then complete:=false;
   elsif discount->>'processingState' is distinct from 'VOID' then used:=true;end if;
  end loop;
 end loop;
 return case when used then 1 when complete then 0 end;
end $discount$;
revoke all on function public.ai_customer_discount_participation(jsonb) from public,anon,authenticated,service_role;

-- Use the existing canonical cents conversion and importer semantics:
-- check.amount less fundraising, nonvoid deferred/house-account selections and
-- eligible payment refunds. Missing/invalid evidence remains NULL. This is an
-- order-business-date attribution, not a settlement-day or payment balance.
create or replace function public.ai_customer_check_net_cents(p_check jsonb)
returns bigint language plpgsql immutable strict set search_path=public as $money$
declare v bigint; delta bigint; item jsonb;
begin
 v:=public.toast_json_dollars_to_cents(p_check->'amount');
 if v is null then return null; end if;
 if exists(select 1 from unnest(array['selections','appliedServiceCharges','payments']) k
  where p_check->k is not null and jsonb_typeof(p_check->k) not in ('array','null'))
 then return null; end if;
 for item in select value from jsonb_array_elements(case when jsonb_typeof(p_check->'appliedServiceCharges')='array'
  then p_check->'appliedServiceCharges' else '[]'::jsonb end) loop
  if jsonb_typeof(item)<>'object' then return null; end if;
  if item->>'serviceChargeCategory'='FUNDRAISING_CAMPAIGN' then
   delta:=public.toast_json_dollars_to_cents(item->'chargeAmount');
   if delta is null then return null; end if;
   v:=v-delta;
  end if;
 end loop;
 for item in select value from jsonb_array_elements(case when jsonb_typeof(p_check->'selections')='array'
  then p_check->'selections' else '[]'::jsonb end) loop
  if jsonb_typeof(item)<>'object' then return null; end if;
  if (item->'voided') is distinct from 'true'::jsonb and
   ((item->'deferred') is not distinct from 'true'::jsonb or item->>'selectionType'='HOUSE_ACCOUNT_PAY_BALANCE') then
   delta:=public.toast_json_dollars_to_cents(item->'price');
   if delta is null then return null; end if;
   v:=v-delta;
  end if;
 end loop;
 delta:=public.ai_customer_check_refund_cents(p_check);
 if delta is null then return null;end if;
 v:=v-delta;
 if abs(v::numeric)>9007199254740991 then return null; end if;
 return v;
exception when numeric_value_out_of_range then return null;
end $money$;
revoke all on function public.ai_customer_check_net_cents(jsonb) from public,anon,authenticated,service_role;

-- Only provider guest-object references and explicitly documented, vendor-
-- scoped loyalty account identifiers. These are observed references/accounts,
-- NOT proof of a unique human or cross-account link. Never link by name,
-- cardPaymentId, masked account identifier, phone, email or payment GUID.
create or replace function public.ai_customer_check_evidence(
 p_business_id uuid,p_restaurant_guid uuid,p_order_ref text,p_check jsonb,p_eligible boolean)
returns jsonb language plpgsql immutable set search_path=public as $customer$
declare guest text; loyalty text; vendor text; guest_ref text; loyalty_ref text;
 ident text; visit text; identity_state text:='unresolved'; payer text; payer_count bigint;
 tab text; first_name text; last_name text; guest_name text; display text; display_source text;
 net bigint;
begin
 guest:=lower(nullif(btrim(p_check#>>'{customer,guid}'),''));
 if guest !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  or guest='00000000-0000-0000-0000-000000000000' then guest:=null; end if;
 loyalty:=nullif(btrim(p_check#>>'{appliedLoyaltyInfo,loyaltyIdentifier}'),'');
 vendor:=upper(nullif(btrim(p_check#>>'{appliedLoyaltyInfo,vendor}'),''));
 if jsonb_typeof(p_check#>'{appliedLoyaltyInfo,loyaltyIdentifier}') is distinct from 'string'
  or loyalty is null or length(loyalty)>256 or loyalty ~ '[[:cntrl:]]'
  or loyalty ~ '[0-9][0-9 -]{11,}[0-9]'
  or loyalty ~* '(bearer[[:space:]]|password|secret|token|^sk-)'
  or vendor is null or vendor not in ('TOAST','PUNCHH','PUNCHH2','PAYTRONIX','APPFRONT','INTEGRATION')
 then loyalty:=null; end if;
 if p_eligible and p_business_id is not null and p_restaurant_guid is not null
  and nullif(btrim(p_order_ref),'') is not null and nullif(btrim(p_check->>'guid'),'') is not null then
  if guest is not null then
   guest_ref:='guest:'||encode(sha256(convert_to(jsonb_build_array(p_business_id,p_restaurant_guid,guest)::text,'UTF8')),'hex');
  end if;
  if loyalty is not null then
   loyalty_ref:='loyalty:'||encode(sha256(convert_to(jsonb_build_array(p_business_id,p_restaurant_guid,vendor,loyalty)::text,'UTF8')),'hex');
  end if;
  -- No transitive linking between identity namespaces. A guest-only record
  -- and an account-only record are not silently merged.
  ident:=coalesce(guest_ref,loyalty_ref);
  identity_state:=case when guest_ref is not null then 'guest_reference'
   when loyalty_ref is not null then 'loyalty_account_reference' else 'unresolved' end;
  if ident is not null then
   visit:='visit:'||encode(sha256(convert_to(jsonb_build_array(p_business_id,p_restaurant_guid,p_order_ref,ident)::text,'UTF8')),'hex');
  end if;
 end if;
 tab:=public.ai_customer_name(p_check->'tabName');
 first_name:=public.ai_customer_name(p_check#>'{customer,firstName}');
 last_name:=public.ai_customer_name(p_check#>'{customer,lastName}');
 if first_name is not null and last_name is not null then guest_name:=first_name||' '||last_name; end if;

 -- Extract only explicit name leaves BEFORE the existing all-card-container
 -- reader guard strips the parent. A conflicting payer stays ambiguous.
 select count(distinct lower(n)),min(n) into payer_count,payer from (
  select public.ai_customer_name(v.name) n from
   jsonb_array_elements(case when jsonb_typeof(p_check->'payments')='array'
    then p_check->'payments' else '[]'::jsonb end) p
   cross join lateral (values
    (p->'cardholderName'),
    (to_jsonb(public.ai_customer_name(p#>'{cardholder,firstName}')||' '||public.ai_customer_name(p#>'{cardholder,lastName}'))),
    (p#>'{cardInfo,holderName}'),(p#>'{cardInfo,cardholderName}'),
    (p#>'{cardDetails,cardholderName}'),
    (to_jsonb(public.ai_customer_name(p#>'{cardDetails,firstName}')||' '||public.ai_customer_name(p#>'{cardDetails,lastName}'))),
    (p#>'{paymentCard,cardholderName}')
   ) v(name)
  where jsonb_typeof(p)='object' and p->>'type'='CREDIT'
   and (p->'voided') is distinct from 'true'::jsonb
   and coalesce(p->>'paymentStatus','') not in ('VOIDED','DENIED','CANCELLED','ERROR','ERROR_NETWORK')
 ) candidates where n like '% %';
 if payer_count<>1 then payer:=null; end if;
 display:=coalesce(payer,tab,guest_name,first_name,last_name);
 display_source:=case when payer is not null then 'cardholder'
  when tab is not null then 'tab_label'
  when guest_name is not null then 'toast_guest'
  when first_name is not null or last_name is not null then 'toast_guest_partial'
  else 'unknown' end;
 net:=case when p_eligible then public.ai_customer_check_net_cents(p_check) end;
 return jsonb_build_object('identityRef',ident,'visitRef',visit,'identityState',identity_state,
  'guestRef',guest_ref,'loyaltyAccountRef',loyalty_ref,'restaurantRef',p_restaurant_guid,
  'displayName',display,'displayNameSource',display_source,'payerName',payer,
  'payerNameConflict',payer_count>1,'guestName',guest_name,'tabLabel',tab,
  'recordedRefundCents',case when p_eligible and jsonb_typeof(p_check->'payments')='array' then public.ai_customer_check_refund_cents(p_check) end,
  'discountParticipation',case when p_eligible then public.ai_customer_discount_participation(p_check) end,
  'loyaltyParticipation',case when p_eligible and loyalty is not null then 1
   when p_eligible and p_check->'appliedLoyaltyInfo'='null'::jsonb then 0 end,
  'netSalesCents',net,'financialStatus',case when not p_eligible then 'excluded'
   when net is null then 'missing' else 'recorded_check_attribution' end);
end $customer$;
revoke all on function public.ai_customer_check_evidence(uuid,uuid,text,jsonb,boolean) from public,anon,authenticated,service_role;

-- Child rows carry only identity/visit keys, NOT names or check-level money.
-- Avoid multiplying spend when grouping products, modifiers or tenders.
create or replace function public.ai_customer_child_evidence(p_evidence jsonb)
returns jsonb language sql immutable strict set search_path=public as $child$
 select p_evidence-array['displayName','displayNameSource','payerName',
  'payerNameConflict','guestName','tabLabel','netSalesCents','financialStatus','orderDurationSeconds','recordedRefundCents','discountParticipation','loyaltyParticipation']::text[]
$child$;
revoke all on function public.ai_customer_child_evidence(jsonb) from public,anon,authenticated,service_role;


-- Historic raw names can contain credential-shaped values. Preserve valid
-- name leaves, not an unclassified raw cardholder object.
create or replace function public.ai_customer_safe_payment(p_payment jsonb)
returns jsonb language plpgsql immutable strict set search_path=public as $payment$
declare v jsonb; n text; first_name text; last_name text;
begin
 v:=p_payment-'cardholderName'-'cardholder'-'aiCafeCustomer';
 n:=public.ai_customer_name(p_payment->'cardholderName');
 if n is not null then v:=v||jsonb_build_object('cardholderName',n); end if;
 first_name:=public.ai_customer_name(p_payment#>'{cardholder,firstName}');
 last_name:=public.ai_customer_name(p_payment#>'{cardholder,lastName}');
 if first_name is not null or last_name is not null then
  v:=v||jsonb_build_object('cardholder',jsonb_strip_nulls(jsonb_build_object('firstName',first_name,'lastName',last_name)));
 end if;
 return v;
end $payment$;
revoke all on function public.ai_customer_safe_payment(jsonb) from public,anon,authenticated,service_role;

-- Safe, source-derived order dimensions shared across check and selection rows.
-- Source channel values remain discoverable separately; only known categories
-- enter unattended grouped labels. Order durations are not fulfilment times.
create or replace function public.ai_customer_order_context(p_order jsonb,p_timezone text,p_day date)
returns jsonb language plpgsql stable set search_path=public as $context$
declare opened timestamptz; closed timestamptz; hour_local integer; duration_secs bigint; channel text; dining text;
begin
 begin
  if p_order->>'openedDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})$' then
   opened:=(p_order->>'openedDate')::timestamptz;
   hour_local:=extract(hour from opened at time zone p_timezone)::integer;
  end if;
  if p_order->>'closedDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})$' then
   closed:=(p_order->>'closedDate')::timestamptz;
  end if;
  if opened is not null and closed>=opened then duration_secs:=floor(extract(epoch from closed-opened))::bigint;end if;
 exception when data_exception or invalid_parameter_value then
  hour_local:=null;duration_secs:=null;
 end;
 channel:=case lower(btrim(p_order->>'source')) when 'online' then 'online'
  when 'in store' then 'in_store' when 'in-store' then 'in_store'
  when 'invoice' then 'invoice' when 'kiosk' then 'kiosk'
  when 'toast pickup' then 'toast_pickup' when 'toast delivery' then 'toast_delivery'
  else case when nullif(btrim(p_order->>'source'),'') is null then null else 'other_recorded' end end;
 dining:=lower(p_order#>>'{diningOption,guid}');
 if dining !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then dining:=null;end if;
 return jsonb_build_object('orderChannel',channel,'diningOptionRef',dining,'localHour',hour_local,
  'businessWeekday',extract(isodow from p_day)::integer,'orderDurationSeconds',duration_secs);
end $context$;
revoke all on function public.ai_customer_order_context(jsonb,text,date) from public,anon,authenticated,service_role;

create or replace function public.toast_records_for(p_business_id uuid,p_from date,p_to date)
returns table(business_id uuid,source text,source_ref text,status text,business_date date,
 record_type text,record_ref text,order_ref text,check_ref text,counts_in_sales boolean,data jsonb)
language sql stable security definer set search_path=public as $records$
with orders as not materialized (
 select r.business_id,r.restaurant_guid,r.business_date,r.id,r.payload o,b.timezone cafe_timezone,
  case when d.business_id is null then 'provisional' else 'actual' end st,
  -- Same exclusions as the importer (lib/pos/toast/dayParser.ts): deleted, voided,
  -- excess-food and test-mode orders are kept here but never count in sales.
  (r.payload->'voided') is not distinct from 'true'::jsonb or (r.payload->'deleted') is not distinct from 'true'::jsonb
   or (r.payload->'excessFood') is not distinct from 'true'::jsonb or (r.payload->'createdInTestMode') is not distinct from 'true'::jsonb o_void
 from public.toast_raw_records r
 join public.businesses b on b.id=r.business_id
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
  o.o_void or (c.v->'voided') is not distinct from 'true'::jsonb or (c.v->'deleted') is not distinct from 'true'::jsonb c_void,
  public.ai_customer_check_evidence(o.business_id,o.restaurant_guid,o.o->>'guid',c.v,
   not (o.o_void or (c.v->'voided') is not distinct from 'true'::jsonb or (c.v->'deleted') is not distinct from 'true'::jsonb))||public.ai_customer_order_context(o.o,o.cafe_timezone,o.business_date) customer_evidence
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
 'order'::text,o->>'guid',o->>'guid',null::text,not o_void,o-'checks'-'aiCafeCustomer'
from orders
union all
select business_id,'toast','toast-check:'||id::text||':'||cn,st,business_date,
 'check',c->>'guid',o->>'guid',c->>'guid',not c_void,
 (c-'selections'-'payments'-'appliedDiscounts'-'appliedServiceCharges'-'aiCafeCustomer')||jsonb_build_object('aiCafeCustomer',customer_evidence)
from checks
union all
select business_id,'toast','toast-item:'||id::text||':'||cn||':'||sn,st,business_date,
 'item',s->>'guid',o->>'guid',c->>'guid',not s_void,(s-'modifiers'-'appliedDiscounts'-'aiCafeCustomer')||jsonb_build_object('aiCafeCustomer',public.ai_customer_child_evidence(customer_evidence))
from items
union all
select i.business_id,'toast','toast-modifier:'||i.id::text||':'||i.cn||':'||i.sn||':'||m.n,i.st,
 i.business_date,'modifier',m.v->>'guid',i.o->>'guid',i.c->>'guid',
 not i.s_void and (m.v->'voided') is distinct from 'true'::jsonb,
 (m.v-'aiCafeCustomer')||jsonb_build_object('item_ref',i.s->>'guid','aiCafeCustomer',public.ai_customer_child_evidence(i.customer_evidence))
from items i cross join lateral jsonb_array_elements(case when jsonb_typeof(i.s->'modifiers')='array'
 then i.s->'modifiers' else '[]'::jsonb end) with ordinality m(v,n)
where jsonb_typeof(m.v)='object'
union all
select i.business_id,'toast','toast-item-discount:'||i.id::text||':'||i.cn||':'||i.sn||':'||d.n,i.st,
 i.business_date,'item_discount',d.v->>'guid',i.o->>'guid',i.c->>'guid',not i.s_void
  and (d.v->>'processingState') is distinct from 'VOID',
 (d.v-'aiCafeCustomer')||jsonb_build_object('item_ref',i.s->>'guid','aiCafeCustomer',public.ai_customer_child_evidence(i.customer_evidence))
from items i cross join lateral jsonb_array_elements(case when jsonb_typeof(i.s->'appliedDiscounts')='array'
 then i.s->'appliedDiscounts' else '[]'::jsonb end) with ordinality d(v,n)
where jsonb_typeof(d.v)='object'
union all
select k.business_id,'toast','toast-payment:'||k.id::text||':'||k.cn||':'||p.n,k.st,k.business_date,
 'payment',p.v->>'guid',k.o->>'guid',k.c->>'guid',
 not k.c_void and (p.v->'voided') is distinct from 'true'::jsonb
  and coalesce(p.v->>'paymentStatus','') not in ('VOIDED','DENIED','CANCELLED','ERROR','ERROR_NETWORK'),public.ai_customer_safe_payment(p.v)||jsonb_build_object('aiCafeCustomer',public.ai_customer_child_evidence(k.customer_evidence))
from checks k cross join lateral jsonb_array_elements(case when jsonb_typeof(k.c->'payments')='array'
 then k.c->'payments' else '[]'::jsonb end) with ordinality p(v,n)
where jsonb_typeof(p.v)='object'
union all
select k.business_id,'toast','toast-check-discount:'||k.id::text||':'||k.cn||':'||d.n,k.st,k.business_date,
 'check_discount',d.v->>'guid',k.o->>'guid',k.c->>'guid',not k.c_void
  and (d.v->>'processingState') is distinct from 'VOID',(d.v-'aiCafeCustomer')||jsonb_build_object('aiCafeCustomer',public.ai_customer_child_evidence(k.customer_evidence))
from checks k cross join lateral jsonb_array_elements(case when jsonb_typeof(k.c->'appliedDiscounts')='array'
 then k.c->'appliedDiscounts' else '[]'::jsonb end) with ordinality d(v,n)
where jsonb_typeof(d.v)='object'
union all
select k.business_id,'toast','toast-service-charge:'||k.id::text||':'||k.cn||':'||d.n,k.st,k.business_date,
 'service_charge',d.v->>'guid',k.o->>'guid',k.c->>'guid',not k.c_void,(d.v-'aiCafeCustomer')||jsonb_build_object('aiCafeCustomer',public.ai_customer_child_evidence(k.customer_evidence))
from checks k cross join lateral jsonb_array_elements(case when jsonb_typeof(k.c->'appliedServiceCharges')='array'
 then k.c->'appliedServiceCharges' else '[]'::jsonb end) with ordinality d(v,n)
where jsonb_typeof(d.v)='object'
union all
select r.business_id,'toast'::text,'toast-current:'||r.id::text,
 -- Until source-specific freshness is verified, stored is not the same as final.
 'open'::text,r.business_date,r.record_type,
 coalesce(r.entity_guid::text,nullif(r.payload->>'guid',''),
  nullif(r.payload->>'employee_guid',''),nullif(r.payload->>'provider_guid','')),
 null::text,null::text,null::boolean,r.payload-'aiCafeCustomer'
from current_nonorders r
) raw(business_id,source,source_ref,status,business_date,record_type,record_ref,order_ref,check_ref,counts_in_sales,data)
$records$;

-- Reusable visit-grain projection of the existing current-source reader.
-- One linked provider identity/order, not a person or a payment. Unknown
-- checks remain in cv_toast_records for coverage and reconciliation.
-- Read history through the query end BEFORE applying output date bounds.
-- Factor the existing #537 historical recipe-cost proof into one internal
-- product/day evidence relation. The former daily proof remains the same
-- public contract; no second recipe calculation or cost ledger.
create function public.ai_historical_ingredient_cost_items(p_business_id uuid,p_from date,p_to date)
returns table(business_date date,menu_item_id uuid,unit_cost_microcents numeric,ingredients_cents bigint)
language sql stable security definer set search_path=public as $history$
 with days as (
  select d.business_date,d.net_sales_cents,d.orders_count,d.drinks_count,d.ingredients_cents,
    d.voids_status,d.voids_source,
    (d.business_date::timestamp at time zone b.timezone) as start_at,
    ((d.business_date+1)::timestamp at time zone b.timezone) as end_at
  from public.daily_rollups d join public.businesses b on b.id=d.business_id
  join public.catalog_cost_history_start h on h.business_id=d.business_id
  where d.business_id=p_business_id and d.business_date between p_from and p_to
    and d.sales_data_status='actual' and h.observed_at<=(d.business_date::timestamp at time zone b.timezone)
    and d.business_date<(statement_timestamp() at time zone b.timezone)::date
 ), active_orders as (
  select o.id,o.business_date,o.net_sales_cents,o.pos_order_id from public.orders o
  join days d on d.business_date=o.business_date
  where o.business_id=p_business_id and not o.toast_excluded and o.superseded_by is null
 ), order_totals as (
  select o.business_date,count(*) n,sum(o.net_sales_cents) net,bool_or(o.pos_order_id like 'toast:%') toast
  from active_orders o group by o.business_date
 ), sold as (
  select o.business_date,l.menu_item_id,sum(l.quantity) qty,
   sum(l.net_sales_cents) net,
   bool_or(l.quantity<=0 or l.menu_item_id is null or
    (l.modifiers is not null and l.modifiers not in ('[]'::jsonb,'{}'::jsonb))) unsupported
  from active_orders o join public.order_lines l on l.order_id=o.id
  where not l.voided group by o.business_date,l.menu_item_id
 ), recipe_state as (
  select s.business_date,s.menu_item_id,s.qty,s.net,s.unsupported,d.start_at,d.end_at,
   coalesce((select jsonb_agg(jsonb_build_object('ingredient',v.row_id,'quantity',v.quantity)) from (
    select distinct on(h.row_id) h.row_id,h.present,h.quantity
    from public.catalog_cost_history h where h.business_id=p_business_id
     and h.kind='recipe_line' and h.entity_id=s.menu_item_id and h.observed_at<=d.start_at
    order by h.row_id,h.observed_at desc,h.id desc
   ) v where v.present),'[]'::jsonb) recipe
  from sold s join days d on d.business_date=s.business_date
 ), supported as (
  select r.*,
   not r.unsupported and r.menu_item_id is not null and jsonb_array_length(r.recipe)>0
   and exists(select 1 from public.menu_items m where m.id=r.menu_item_id and m.business_id=p_business_id)
   and not exists(select 1 from public.catalog_cost_history h where h.business_id=p_business_id
     and h.entity_id=r.menu_item_id and (h.kind='combo_component' or
       (h.kind='recipe_line' and h.observed_at>r.start_at and h.observed_at<r.end_at)))
   as supported_recipe
  from recipe_state r
 ), costs as (
  select r.business_date,r.menu_item_id,r.qty,r.net,r.supported_recipe,
    count(*) filter(where line.ingredient is not null) line_count,
    count(*) filter(where line.quantity>0 and i.id is not null and cost.price_micros>0
     and not exists(select 1 from public.catalog_cost_history h where h.business_id=p_business_id and h.kind='ingredient_price'
      and h.entity_id=line.ingredient and h.observed_at>r.start_at and h.observed_at<r.end_at)) priced_count,
    sum(line.quantity*cost.price_micros) micros
  from supported r
  left join lateral jsonb_to_recordset(r.recipe) as line(ingredient uuid,quantity numeric) on true
  left join public.ingredients i on i.id=line.ingredient and i.business_id=p_business_id
  left join lateral (
   select v.price_micros from (
    select distinct on(h.row_id) h.row_id,h.present,h.effective_from,h.price_micros,h.price_recorded_at
    from public.catalog_cost_history h where h.business_id=p_business_id and h.kind='ingredient_price'
     and h.entity_id=line.ingredient and h.observed_at<=r.start_at
    order by h.row_id,h.observed_at desc,h.id desc
   ) v where v.present and v.effective_from<=r.business_date
   order by v.effective_from desc,v.price_recorded_at desc,v.row_id desc limit 1
  ) cost on true
  group by r.business_date,r.menu_item_id,r.qty,r.net,r.supported_recipe
 ), item_totals as (
  select c.business_date,sum(c.qty) qty,sum(c.net) net,
    round(sum(c.qty*c.micros)/1000000)::bigint ingredients,
    bool_and(c.supported_recipe and c.line_count>0 and c.line_count=c.priced_count) complete
  from costs c group by c.business_date
 )
 select d.business_date,c.menu_item_id,c.micros as unit_cost_microcents,d.ingredients_cents::bigint from days d
 join order_totals o on o.business_date=d.business_date
 join item_totals i on i.business_date=d.business_date
 join costs c on c.business_date=d.business_date
 where i.complete and o.n=d.orders_count and o.net=d.net_sales_cents
   and i.qty=d.drinks_count and i.net=d.net_sales_cents and i.ingredients=d.ingredients_cents
   and (not o.toast or (d.voids_status='complete' and d.voids_source='toast'
    and not exists(select 1 from public.toast_owner_attention_days_v a
      where a.business_id=p_business_id and a.business_date=d.business_date)))

 order by d.business_date,c.menu_item_id
$history$;
revoke all on function public.ai_historical_ingredient_cost_items(uuid,date,date) from public,anon,authenticated,service_role;

create or replace function public.read_historical_ingredient_cost_proof(p_business_id uuid,p_from date,p_to date)
returns table(business_date date,ingredients_cents bigint)
language plpgsql stable security definer set search_path=public as $history$
begin
 if (coalesce(auth.role(),'')<>'service_role' and (auth.uid() is null or not public.is_member(p_business_id)))
 or p_business_id is null or p_from is null or p_to is null or p_to<p_from or p_to-p_from>370
 then raise exception 'catalog_history_scope_invalid' using errcode='42501';end if;
 return query
 select distinct i.business_date,i.ingredients_cents
 from public.ai_historical_ingredient_cost_items(p_business_id,p_from,p_to) i order by i.business_date;
end $history$;
revoke all on function public.read_historical_ingredient_cost_proof(uuid,date,date) from public,anon;
grant execute on function public.read_historical_ingredient_cost_proof(uuid,date,date) to authenticated,service_role;

-- Scope narrower than the existing member daily totals: only an authorized
-- customer reader or the service worker gets item evidence. Explicit bounds;
-- no arbitrary raw or historical-table access and no provider data writes.
create function public.customer_historical_recipe_cost_items(p_business_id uuid,p_from date,p_to date)
returns table(business_date date,menu_item_id uuid,unit_cost_microcents numeric)
language sql stable security definer set search_path=public as $history$
 select i.business_date,i.menu_item_id,i.unit_cost_microcents
 from (select p_business_id id where p_business_id is not null and p_from is not null and p_to is not null
  and p_to>=p_from and p_to-p_from<=370 and public.toast_records_allowed(p_business_id)) scope
 cross join lateral public.ai_historical_ingredient_cost_items(scope.id,p_from,p_to) i
$history$;
revoke all on function public.customer_historical_recipe_cost_items(uuid,date,date) from public,anon;
grant execute on function public.customer_historical_recipe_cost_items(uuid,date,date) to authenticated,service_role;

create or replace function public.customer_visits_for(p_business_id uuid,p_from date,p_to date)
returns table(business_id uuid,source text,source_ref text,status text,business_date date,
 identity_ref text,identity_state text,restaurant_ref text,order_ref text,
 eligible_check_count bigint,net_sales_cents bigint,known_money_check_count bigint,
 first_observed_date date,last_observed_date date,previous_observed_date date,next_observed_date date,
 observed_visit_number bigint,days_since_previous integer,days_since_last_observed integer,
 first_observed_visit integer,returning_visit integer,
 observed_return_7d integer,observed_return_30d integer,observed_return_60d integer,observed_return_90d integer,
 history_start_date date,as_of_date date,
 period_account_visits bigint,period_account_net_sales_cents bigint,
 period_account_revenue_share numeric,period_account_revenue_share_squared numeric,
 history_account_net_sales_cents bigint,
 observed_prior_cadence_days numeric,observed_reactivation_gap_ratio numeric,observed_lapse_gap_ratio numeric,
 order_duration_seconds bigint,observed_lapse_flag integer,observed_reappearance_flag integer,
 historical_recipe_cost_cents bigint,historical_recipe_contribution_cents bigint)
language sql stable security invoker set search_path=public as $visits$
 with checks as materialized (
  select r.business_id,r.business_date,r.status,r.order_ref,r.check_ref,
   r.data#>>'{aiCafeCustomer,identityRef}' identity_ref,
   r.data#>>'{aiCafeCustomer,identityState}' identity_state,
   r.data#>>'{aiCafeCustomer,restaurantRef}' restaurant_ref,
   r.data#>>'{aiCafeCustomer,visitRef}' visit_ref,
   (r.data#>>'{aiCafeCustomer,netSalesCents}')::bigint net_cents,
   (r.data#>>'{aiCafeCustomer,orderDurationSeconds}')::bigint duration_seconds,
   least(coalesce(p_to,(now() at time zone b.timezone)::date),
    (now() at time zone b.timezone)::date) as_of
  from public.toast_records_for(p_business_id,null,p_to) r
  join public.businesses b on b.id=r.business_id
  where r.record_type='check' and r.counts_in_sales and r.business_date is not null
   and r.business_date<=least(coalesce(p_to,(now() at time zone b.timezone)::date),
    (now() at time zone b.timezone)::date)
 ), historical_costs as materialized (
  select * from public.customer_historical_recipe_cost_items(p_business_id,p_from,p_to)
 ), source_items as materialized (
  select r.business_id,r.business_date,r.order_ref,r.check_ref,r.record_ref,r.status,
   r.data#>>'{aiCafeCustomer,restaurantRef}' restaurant_ref,
   r.data#>>'{item,guid}' product_ref,
   case when jsonb_typeof(r.data->'quantity')='number' then (r.data->>'quantity')::numeric end quantity
  from public.toast_records_for(p_business_id,p_from,p_to) r
  where r.record_type='item' and r.counts_in_sales
   and exists(select 1 from historical_costs hc where hc.business_date=r.business_date)
 ), matched_lines as (
  select s.*,o.id normalized_order_id,o.net_sales_cents normalized_order_net,
   case when s.status='actual' and s.quantity>0 and s.quantity=l.quantity
    and l.pos_item_id='toast:'||s.restaurant_ref||':'||s.product_ref
    and l.menu_item_id=hc.menu_item_id and hc.unit_cost_microcents>0
    and coalesce(l.modifiers,'[]'::jsonb) in ('[]'::jsonb,'{}'::jsonb)
    then s.quantity*hc.unit_cost_microcents end cost_micros
  from source_items s
  left join public.orders o on o.business_id=s.business_id and o.business_date=s.business_date
   and o.pos_order_id='toast:'||s.restaurant_ref||':'||s.order_ref and not o.toast_excluded and o.superseded_by is null
  left join public.order_lines l on l.order_id=o.id and l.pos_line_id=s.record_ref and not l.voided
  left join historical_costs hc on hc.business_date=s.business_date and hc.menu_item_id=l.menu_item_id
 ), verified_orders as (
  -- One exact provider-order/selection mapping for every nonvoid normalized
  -- line; raw check net must reconcile independently to the normalized order.
  select m.business_id,m.restaurant_ref,m.order_ref,m.business_date,m.normalized_order_id
  from matched_lines m
  join lateral (
   select count(*) n,count(distinct c.check_ref) unique_n,count(c.net_cents) money_n,sum(c.net_cents) net,
    bool_and(c.status='actual') actual
   from checks c where c.business_id=m.business_id and c.restaurant_ref=m.restaurant_ref
    and c.order_ref=m.order_ref and c.business_date=m.business_date
  ) c on c.n=c.unique_n and c.n=c.money_n and c.n>0 and c.actual and c.net=m.normalized_order_net
  where m.normalized_order_id is not null
   and exists(select 1 from checks c where c.business_id=m.business_id and c.restaurant_ref=m.restaurant_ref
    and c.order_ref=m.order_ref and c.business_date=m.business_date and c.check_ref=m.check_ref)
  group by m.business_id,m.restaurant_ref,m.order_ref,m.business_date,m.normalized_order_id
  having count(*)=count(distinct m.record_ref) and count(*)=count(m.cost_micros)
   and count(*)=(select count(*) from public.order_lines l where l.order_id=m.normalized_order_id and not l.voided)
   and not exists(select 1 from source_items s where s.business_id=m.business_id and s.restaurant_ref=m.restaurant_ref
    and s.order_ref=m.order_ref and s.business_date=m.business_date
    and not exists(select 1 from checks c where c.business_id=s.business_id and c.restaurant_ref=s.restaurant_ref
     and c.order_ref=s.order_ref and c.business_date=s.business_date and c.check_ref=s.check_ref))
 ), check_costs as (
  select m.business_id,m.restaurant_ref,m.order_ref,m.business_date,m.check_ref,sum(m.cost_micros) cost_micros
  from matched_lines m join verified_orders v using(business_id,restaurant_ref,order_ref,business_date,normalized_order_id)
  group by m.business_id,m.restaurant_ref,m.order_ref,m.business_date,m.check_ref
 ), coverage as (
  select business_id,restaurant_ref,min(business_date) history_start
  from checks group by business_id,restaurant_ref
 ), grouped as (
  select c.business_id,c.identity_ref,c.restaurant_ref,c.order_ref,c.visit_ref,
   min(c.identity_state) identity_state,min(c.business_date) business_date,
   case when bool_and(c.status='actual') then 'actual' else 'provisional' end status,
   count(*) check_count,count(c.net_cents) known_money,
   case when count(*)=count(c.net_cents) and count(*)=count(distinct c.check_ref)
    and abs(sum(c.net_cents))<=9007199254740991 then sum(c.net_cents)::bigint end net_cents,
   min(c.as_of) as_of,
   case when count(c.duration_seconds)=count(*) and min(c.duration_seconds)=max(c.duration_seconds) then min(c.duration_seconds) end duration_seconds,
   case when count(cc.cost_micros)=count(*) and count(*)=count(distinct c.check_ref)
    and sum(cc.cost_micros)>=0 and round(sum(cc.cost_micros)/1000000)<=9007199254740991
    then round(sum(cc.cost_micros)/1000000)::bigint end recipe_cost
  from checks c left join check_costs cc on cc.business_id=c.business_id and cc.restaurant_ref=c.restaurant_ref
   and cc.order_ref=c.order_ref and cc.business_date=c.business_date and cc.check_ref=c.check_ref
  where c.identity_ref is not null and c.visit_ref is not null
  group by c.business_id,c.identity_ref,c.restaurant_ref,c.order_ref,c.visit_ref
  having count(distinct c.business_date)=1
 ), timeline as (
  select g.*,
   min(g.business_date) over person first_day,max(g.business_date) over person last_day,
   lag(g.business_date) over visits prev_day,lead(g.business_date) over visits next_day,
   row_number() over visits visit_number,
   sum(g.net_cents) over person history_net,
   count(g.net_cents) over person history_money_count,
   count(*) over person history_visits
  from grouped g
  window person as (partition by g.business_id,g.restaurant_ref,g.identity_ref),
   visits as (partition by g.business_id,g.restaurant_ref,g.identity_ref order by g.business_date,g.visit_ref)
 ), period_accounts as (
  -- Only visits in the requested period, but ordinal/recency history is not
  -- clipped at the period start. One aggregate per scoped account.
  select business_id,restaurant_ref,identity_ref,count(*) visits,
   case when count(*)=count(net_cents) and abs(sum(net_cents))<=9007199254740991
    then sum(net_cents)::bigint end net
  from timeline where (p_from is null or business_date>=p_from)
  group by business_id,restaurant_ref,identity_ref
 ), period_totals as (
  select business_id,case when count(*)=count(net) and min(net)>=0 and sum(net)>0
   then sum(net) end total
  from period_accounts group by business_id
 ), cadence as (
  -- Use positive date gaps only. Same-day order sequence is not a
  -- cadence measurement. Need two prior observed gaps, not one.
  select t.*,
   avg(t.business_date-t.prev_day) filter(where t.business_date>t.prev_day) over prior_gaps prior_cadence,
   count(*) filter(where t.business_date>t.prev_day) over prior_gaps prior_gap_count,
   avg(t.business_date-t.prev_day) filter(where t.business_date>t.prev_day) over through_gaps last_cadence,
   count(*) filter(where t.business_date>t.prev_day) over through_gaps last_gap_count
  from timeline t
  window prior_gaps as (partition by t.business_id,t.restaurant_ref,t.identity_ref order by t.business_date,t.visit_ref
   rows between unbounded preceding and 1 preceding),
   through_gaps as (partition by t.business_id,t.restaurant_ref,t.identity_ref order by t.business_date,t.visit_ref
   rows between unbounded preceding and current row)
 )
 select t.business_id,'toast'::text,t.visit_ref,t.status,t.business_date,
  t.identity_ref,t.identity_state,t.restaurant_ref,t.order_ref,t.check_count,t.net_cents,t.known_money,
  t.first_day,t.last_day,t.prev_day,t.next_day,t.visit_number,
  t.business_date-t.prev_day,t.as_of-t.last_day,
  (t.visit_number=1)::integer,(t.visit_number>1)::integer,
  -- NULL unless the FIRST observed cohort's whole source horizon elapsed
  -- and was imported complete. Zero is "none observed", not proof of churn.
  case when t.visit_number=1 and t.status='actual' and c.days7=8 and t.business_date+7<=t.as_of
   then coalesce((t.next_day<=t.business_date+7)::integer,0) end,
  case when t.visit_number=1 and t.status='actual' and c.days30=31 and t.business_date+30<=t.as_of
   then coalesce((t.next_day<=t.business_date+30)::integer,0) end,
  case when t.visit_number=1 and t.status='actual' and c.days60=61 and t.business_date+60<=t.as_of
   then coalesce((t.next_day<=t.business_date+60)::integer,0) end,
  case when t.visit_number=1 and t.status='actual' and c.days90=91 and t.business_date+90<=t.as_of
   then coalesce((t.next_day<=t.business_date+90)::integer,0) end,
  h.history_start,t.as_of,
  -- Account facts occur once at the last visit through the cutoff.
  -- The period denominator is all *linked* accounts, not all sales.
  case when t.next_day is null then a.visits end,
  case when t.next_day is null then a.net end,
  case when t.next_day is null then a.net::numeric/nullif(p.total,0) end,
  case when t.next_day is null then power(a.net::numeric/nullif(p.total,0),2) end,
  case when t.next_day is null and t.history_money_count=t.history_visits
   and abs(t.history_net)<=9007199254740991 then t.history_net::bigint end,
  case when t.prior_gap_count>=2 and cadence_days.through_visit=t.business_date-t.first_day+1
   then t.prior_cadence end,
  case when t.prior_gap_count>=2 and t.business_date>t.prev_day
   and cadence_days.through_visit=t.business_date-t.first_day+1
   then (t.business_date-t.prev_day)::numeric/nullif(t.prior_cadence,0) end,
  case when t.next_day is null and t.last_gap_count>=2
   and cadence_days.through_as_of=t.as_of-t.first_day+1
   then (t.as_of-t.last_day)::numeric/nullif(t.last_cadence,0) end,
  t.duration_seconds,
  -- Two typical positive gaps overdue is a review heuristic, not proof a
  -- person left. Non-last rows and incomplete histories remain NULL.
  case when t.next_day is null and t.last_gap_count>=2
   and cadence_days.through_as_of=t.as_of-t.first_day+1
   then ((t.as_of-t.last_day)::numeric>=2*t.last_cadence)::integer end,
  case when t.prior_gap_count>=2 and t.business_date>t.prev_day
   and cadence_days.through_visit=t.business_date-t.first_day+1
   then ((t.business_date-t.prev_day)::numeric>=2*t.prior_cadence)::integer end,
  t.recipe_cost,
  case when t.net_cents is not null and t.recipe_cost is not null
    and abs(t.net_cents::numeric-t.recipe_cost)<=9007199254740991
   then t.net_cents-t.recipe_cost end
 from cadence t
 join coverage h on h.business_id=t.business_id and h.restaurant_ref=t.restaurant_ref
 left join period_accounts a on a.business_id=t.business_id and a.restaurant_ref=t.restaurant_ref and a.identity_ref=t.identity_ref
 left join period_totals p on p.business_id=t.business_id
 left join lateral (
  select count(*) filter(where ds.business_date<=t.business_date) through_visit,count(*) through_as_of
  from public.toast_day_status ds
  where (t.prior_gap_count>=2 or (t.next_day is null and t.last_gap_count>=2))
   and ds.business_id=t.business_id and ds.restaurant_guid::text=t.restaurant_ref
   and ds.business_date between t.first_day and case when t.next_day is null then t.as_of else t.business_date end
   and ds.import_state='imported' and ds.coverage_complete and ds.unparsed_count=0
   and ds.recon_state not in ('mismatch','owner_flagged')
 ) cadence_days on true
 left join lateral (
  select count(*) filter(where ds.business_date<=t.business_date+7) days7,
   count(*) filter(where ds.business_date<=t.business_date+30) days30,
   count(*) filter(where ds.business_date<=t.business_date+60) days60,
   count(*) days90
  from public.toast_day_status ds
  where t.visit_number=1 and ds.business_id=t.business_id
   and ds.restaurant_guid::text=t.restaurant_ref
   and ds.business_date between t.business_date and least(t.business_date+90,t.as_of)
   and ds.import_state='imported' and ds.coverage_complete and ds.unparsed_count=0
   and ds.recon_state not in ('mismatch','owner_flagged')
 ) c on true
 where (p_from is null or t.business_date>=p_from)
 and (p_to is null or t.business_date<=p_to)
$visits$;
revoke all on function public.customer_visits_for(uuid,date,date) from public,anon;
grant execute on function public.customer_visits_for(uuid,date,date) to authenticated,service_role;

create or replace view public.cv_customer_visits
 (business_id,source,source_ref,status,business_date,identity_ref,identity_state,restaurant_ref,order_ref,
 eligible_check_count,net_sales_cents,known_money_check_count,first_observed_date,last_observed_date,
 previous_observed_date,next_observed_date,observed_visit_number,days_since_previous,days_since_last_observed,
 first_observed_visit,returning_visit,observed_return_7d,observed_return_30d,observed_return_60d,observed_return_90d,
 history_start_date,as_of_date,
 period_account_visits,period_account_net_sales_cents,period_account_revenue_share,period_account_revenue_share_squared,
 history_account_net_sales_cents,observed_prior_cadence_days,observed_reactivation_gap_ratio,observed_lapse_gap_ratio,order_duration_seconds,observed_lapse_flag,observed_reappearance_flag,
 historical_recipe_cost_cents,historical_recipe_contribution_cents)
 with (security_invoker=true) as
 select * from public.customer_visits_for(null,null,null);
revoke all on public.cv_customer_visits from public,anon;
grant select on public.cv_customer_visits to authenticated,service_role;

-- Product/option/basket facts are derived from the SAME source reader,
-- not a new writer, data store, customer identity calculator or scheduler.
-- Keep unknown item refs and quantities visible as null; never use a label
-- as a product key. Only the same verified visit can form a basket pair.
create or replace function public.customer_products_for(p_business_id uuid,p_from date,p_to date)
returns table(business_id uuid,source text,source_ref text,status text,business_date date,
 restaurant_ref text,identity_ref text,visit_ref text,order_ref text,check_ref text,
 visit_class text,fact_kind text,product_ref text,item_group_ref text,modifier_ref text,
 option_group_ref text,paired_product_ref text,quantity numeric,pair_occurrence integer,
 order_channel text,local_hour integer,business_weekday integer)
language sql stable security invoker set search_path=public as $products$
 with visits as materialized (
  select v.business_id,v.source_ref,v.identity_ref,v.status,v.first_observed_visit
  from public.customer_visits_for(p_business_id,p_from,p_to) v
 ), children as materialized (
  select r.*,
   r.data#>>'{aiCafeCustomer,restaurantRef}' location_ref,
   r.data#>>'{aiCafeCustomer,visitRef}' linked_visit,
   case when lower(r.data#>>'{item,guid}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and lower(r.data#>>'{item,guid}')<>'00000000-0000-0000-0000-000000000000'
    then lower(r.data#>>'{item,guid}') end menu_ref,
   case when lower(r.data#>>'{itemGroup,guid}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and lower(r.data#>>'{itemGroup,guid}')<>'00000000-0000-0000-0000-000000000000'
    then lower(r.data#>>'{itemGroup,guid}') end menu_group,
   case when lower(r.data#>>'{optionGroup,guid}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and lower(r.data#>>'{optionGroup,guid}')<>'00000000-0000-0000-0000-000000000000'
    then lower(r.data#>>'{optionGroup,guid}') end option_group,
   count(*) over(partition by r.business_id,r.data#>>'{aiCafeCustomer,restaurantRef}',r.order_ref,r.check_ref,r.record_type,r.record_ref) ref_count
  from public.toast_records_for(p_business_id,p_from,p_to) r
  where r.record_type in ('item','modifier') and r.counts_in_sales and r.business_date is not null
 ), lines as materialized (
  select c.business_id,c.source,c.source_ref,c.status,c.business_date,c.location_ref,
   v.identity_ref,v.source_ref visit_ref,c.order_ref,c.check_ref,
   case when v.source_ref is null then 'unresolved'
    when v.first_observed_visit=1 then 'observed_first' else 'observed_returning' end visit_class,
   c.record_type fact_kind,
   case when c.record_type='item' then c.menu_ref else parent.menu_ref end product_ref,
   case when c.record_type='item' then c.menu_group else parent.menu_group end item_group_ref,
   case when c.record_type='modifier' then c.menu_ref end modifier_ref,
   c.option_group option_group_ref,null::text paired_product_ref,
   case when c.ref_count=1 and nullif(btrim(c.record_ref),'') is not null
    and jsonb_typeof(c.data->'quantity')='number' and (c.data->>'quantity')::numeric>=0
    then (c.data->>'quantity')::numeric end quantity,
   null::integer pair_occurrence,
   c.data#>>'{aiCafeCustomer,orderChannel}' order_channel,
   (c.data#>>'{aiCafeCustomer,localHour}')::integer local_hour,
   (c.data#>>'{aiCafeCustomer,businessWeekday}')::integer business_weekday
  from children c
  left join visits v on v.business_id=c.business_id and v.source_ref=c.linked_visit
  left join children parent on c.record_type='modifier' and parent.record_type='item'
   and parent.business_id=c.business_id and parent.location_ref=c.location_ref
   and parent.order_ref=c.order_ref and parent.check_ref=c.check_ref
   and parent.record_ref=c.data->>'item_ref' and parent.ref_count=1
 ), observed_baskets as (
  select distinct l.business_id,l.business_date,l.location_ref,l.identity_ref,l.visit_ref,
   l.order_ref,l.product_ref,l.visit_class,l.order_channel,l.local_hour,l.business_weekday
  from lines l
  where l.fact_kind='item' and l.visit_ref is not null and l.product_ref is not null and l.quantity>0
 )
 select * from lines
 union all
 select a.business_id,'toast'::text,
  'basket:'||encode(sha256(convert_to(jsonb_build_array(a.visit_ref,a.product_ref,b.product_ref)::text,'UTF8')),'hex'),
  v.status,a.business_date,a.location_ref,a.identity_ref,a.visit_ref,a.order_ref,null::text,
  a.visit_class,'basket_pair'::text,a.product_ref,null::text,null::text,null::text,b.product_ref,
  null::numeric,1,a.order_channel,a.local_hour,a.business_weekday
 from observed_baskets a join observed_baskets b
  on a.business_id=b.business_id and a.visit_ref=b.visit_ref and a.product_ref<b.product_ref
 join visits v on v.business_id=a.business_id and v.source_ref=a.visit_ref
$products$;
revoke all on function public.customer_products_for(uuid,date,date) from public,anon;
grant execute on function public.customer_products_for(uuid,date,date) to authenticated,service_role;

create or replace view public.cv_customer_products
 (business_id,source,source_ref,status,business_date,restaurant_ref,identity_ref,visit_ref,order_ref,check_ref,
 visit_class,fact_kind,product_ref,item_group_ref,modifier_ref,option_group_ref,paired_product_ref,
 quantity,pair_occurrence,order_channel,local_hour,business_weekday)
 with (security_invoker=true) as
 select * from public.customer_products_for(null,null,null);
revoke all on public.cv_customer_products from public,anon;
grant select on public.cv_customer_products to authenticated,service_role;

-- Owner-checked coverage is derived from the same protected archive and
-- location mapping. Do not grant direct mapping or credential access to clients.
create function public.customer_query_coverage(p_business_id uuid,p_date_from date,p_date_to date)
returns jsonb language plpgsql stable security definer set search_path=public as $coverage$
declare v_coverage jsonb;
begin
 if p_business_id is null or p_date_from is null or p_date_to is null
  or p_date_to<p_date_from or not public.toast_records_allowed(p_business_id) then return null;end if;
 with checks as materialized (
   select r.status,r.data#>>'{aiCafeCustomer,restaurantRef}' restaurant_ref,
    r.data#>>'{aiCafeCustomer,identityRef}' identity_ref,
    r.data#>>'{aiCafeCustomer,displayName}' display_name,
    (r.data#>>'{aiCafeCustomer,netSalesCents}')::bigint net
   from public.toast_records_for(p_business_id,p_date_from,p_date_to) r
   where r.record_type='check' and r.counts_in_sales
  ), locations as (
   select distinct restaurant_ref from checks where restaurant_ref is not null
   union
   select m.restaurant_guid::text from public.toast_location_mappings m
   where m.business_id=p_business_id and (m.verified_at is not null or m.info_refreshed_at is not null)
  ), day_counts as (
   select l.restaurant_ref,count(ds.business_date) as complete_days
   from locations l left join public.toast_day_status ds on ds.business_id=p_business_id
    and ds.restaurant_guid::text=l.restaurant_ref and ds.business_date between p_date_from and p_date_to
    and ds.import_state='imported' and ds.coverage_complete and ds.unparsed_count=0
    and ds.recon_state not in ('mismatch','owner_flagged')
   group by l.restaurant_ref
  ), coverage as (
   select count(*) restaurants,coalesce(sum(complete_days),0) complete_location_days,
    coalesce(bool_and(complete_days=p_date_to-p_date_from+1),false) full_window
   from day_counts
  )
  select jsonb_build_object('scope','all_eligible_checks_in_period','eligibleChecks',count(c.status),
   'linkedChecks',count(identity_ref),'namedChecks',count(display_name),
   'knownMoneyChecks',count(net),'linkedKnownMoneyChecks',count(net) filter(where identity_ref is not null),
   'recordedNetCents',sum(net),'linkedRecordedNetCents',sum(net) filter(where identity_ref is not null),
   'expectedLocationDays',cv.restaurants*(p_date_to-p_date_from+1),
   'completeLocationDays',cv.complete_location_days,
   'complete',cv.full_window and cv.restaurants>0 and coalesce(bool_and(status='actual'),true)
      and p_date_to<(now() at time zone (select timezone from public.businesses where id=p_business_id))::date)
  into v_coverage from coverage cv left join checks c on true
  group by cv.restaurants,cv.complete_location_days,cv.full_window;
 return v_coverage;
end $coverage$;
revoke all on function public.customer_query_coverage(uuid,date,date) from public,anon;
grant execute on function public.customer_query_coverage(uuid,date,date) to authenticated,service_role;

-- Extend the SAME invoker-RLS query validation/aggregation and byte limits.
create or replace function public.ai_query_view(
 p_business_id uuid,p_view text,p_columns text[],p_filters jsonb,
 p_group_by text[],p_metrics jsonb,p_date_from date,p_date_to date,
 p_order_by jsonb,p_limit integer
) returns jsonb language plpgsql stable security invoker set search_path=public as $query$
declare
 allowed_views constant text[]=array['cv_sales_days','cv_sales_hours','cv_item_sales',
 'cv_payments','cv_discounts','cv_voids_refunds','cv_card_fees','cv_labor_entries',
 'cv_staff','cv_shifts','cv_menu','cv_bills','cv_inventory','cv_owner_facts','cv_analytics','cv_orders','cv_cash',
 'cv_kitchen','cv_dining_options','cv_toast_records','cv_customer_visits','cv_customer_products'];
 v_col text;v_metric jsonb;v_filter jsonb;v_fn text;v_op text;v_val jsonb;
 v_where text:='business_id = $1';v_select text:='';v_group text:='';
 v_sql text;v_rows jsonb;v_mix jsonb;v_limit integer;v_n integer;
 v_order text:='';v_field text;v_dir text;v_expr text;v_path text[];v_has_data boolean;v_source text;
 v_source_count bigint;v_incomplete boolean;
 v_today date;v_current_day boolean:=false;
 v_bounded jsonb:='[]'::jsonb;v_row jsonb;v_bytes integer:=2;
 v_row_bytes integer;v_bytes_cut boolean:=false;
 v_customer_coverage jsonb;
begin
 if p_view is null or not (p_view=any(allowed_views)) then raise exception 'invalid view';end if;
 if p_business_id is null or p_date_from is null or p_date_to is null or
 p_date_to < p_date_from
 then raise exception 'invalid date range';end if;
 if p_limit is null or p_limit<1 or p_limit>100 then raise exception 'invalid limit';end if;
 if coalesce(array_length(p_columns,1),0)>20 or
 coalesce(array_length(p_group_by,1),0)>4 or
 coalesce(jsonb_array_length(coalesce(p_filters,'[]'::jsonb)),0)>15 or
 coalesce(jsonb_array_length(coalesce(p_metrics,'[]'::jsonb)),0)>10
 then raise exception 'query too large';end if;
 -- Toast records: the owner-checked reader with this café and these dates.
 v_source:=case when p_view='cv_toast_records'
  then format('(select r.*,
  case when r.record_type=''item''
   then public.toast_json_dollars_to_cents(r.data->''price'') end as price_cents,
  case when r.record_type in (''item_discount'',''check_discount'')
   then public.toast_json_dollars_to_cents(r.data->''discountAmount'') end as discount_amount_cents
  from public.toast_records_for($1,%L::date,%L::date) r) money',p_date_from,p_date_to)
  when p_view='cv_customer_visits' then format('public.customer_visits_for($1,%L::date,%L::date)',p_date_from,p_date_to)
  when p_view='cv_customer_products' then format('public.customer_products_for($1,%L::date,%L::date)',p_date_from,p_date_to)
  else format('public.%I',p_view) end;
 v_has_data:=exists(select 1 from information_schema.columns c where c.table_schema='public'
  and c.table_name=p_view and c.column_name='data' and c.data_type='jsonb');
 -- Enforce the physical canonical view's exact column allowlist, or a field path in data.
 foreach v_col in array coalesce(p_columns,array[]::text[]) ||
   coalesce(p_group_by,array[]::text[]) loop
  if not exists(select 1 from information_schema.columns c
    where c.table_schema='public' and c.table_name=p_view and c.column_name=v_col)
   and not (v_has_data and public.ai_query_path(v_col) is not null)
   then raise exception 'invalid column';end if;
 end loop;
 -- Active day comes from the café's actual configured timezone.
 select (now() at time zone b.timezone)::date into v_today
 from public.businesses b where b.id=p_business_id;
 v_current_day:=v_today is not null and v_today between p_date_from and p_date_to
  and p_view in ('cv_sales_days','cv_sales_hours','cv_item_sales','cv_payments',
   'cv_discounts','cv_voids_refunds','cv_card_fees','cv_labor_entries','cv_shifts',
   'cv_inventory','cv_analytics','cv_orders','cv_cash','cv_kitchen',
   'cv_dining_options','cv_toast_records','cv_customer_visits','cv_customer_products');
 if p_view in ('cv_sales_days','cv_sales_hours','cv_item_sales','cv_payments',
 'cv_discounts','cv_voids_refunds','cv_card_fees','cv_labor_entries','cv_shifts',
 'cv_inventory','cv_analytics','cv_orders','cv_cash','cv_kitchen','cv_customer_visits','cv_customer_products') then
 v_where:=v_where||format(' and business_date between %L and %L',p_date_from,p_date_to);
 elsif p_view in ('cv_toast_records','cv_dining_options') then
 -- Undated current Toast setup/configuration is independent of the selected
 -- café business day. Never synthesize a timestamp to satisfy a date filter.
 v_where:=v_where||format(' and (business_date between %L and %L or business_date is null)',p_date_from,p_date_to);
 end if;
 for v_filter in select value from jsonb_array_elements(coalesce(p_filters,'[]'::jsonb)) loop
  v_col:=v_filter->>'column';v_op:=v_filter->>'op';v_val:=v_filter->'value';
  v_path:=case when v_has_data then public.ai_query_path(v_col) end;
  if v_path is null and not exists(select 1 from information_schema.columns c
   where c.table_schema='public' and c.table_name=p_view and c.column_name=v_col)
   then raise exception 'invalid filter column';end if;
  if v_op not in ('=','!=','<','<=','>','>=','in','between','ilike','is_null','is_not_null')
   then raise exception 'invalid operator';end if;
  if v_path is null then v_expr:=format('%I',v_col);
  elsif v_op in ('<','<=','>','>=','between') or jsonb_typeof(v_val)='number' or
   (jsonb_typeof(v_val)='array' and jsonb_typeof(v_val->0)='number') then
   v_expr:=format('(case when jsonb_typeof(data #> %L)=''number'' then (data #>> %L)::numeric end)',v_path,v_path);
  else v_expr:=format('(data #>> %L)',v_path);
  end if;
  if v_op in ('is_null','is_not_null') then
   if v_val is not null and v_val<>'null'::jsonb then raise exception 'invalid null filter';end if;
   v_where:=v_where||format(' and %s is %snull',v_expr,
     case when v_op='is_not_null' then 'not ' else '' end);
  elsif v_op='in' then
   if jsonb_typeof(v_val)<>'array' or jsonb_array_length(v_val)>100 or jsonb_array_length(v_val)=0
   then raise exception 'invalid in';end if;
   v_where:=v_where||format(' and %s in (%s)',v_expr,
    (select string_agg(quote_literal(value#>>'{}'),',')
     from jsonb_array_elements(v_val)));
  elsif v_op='between' then
   if jsonb_typeof(v_val)<>'array' or jsonb_array_length(v_val)<>2
   then raise exception 'invalid between';end if;
   v_where:=v_where||format(' and %s between %L and %L',v_expr,
    v_val->>0,v_val->>1);
  else
   if v_val is null or jsonb_typeof(v_val) not in ('string','number','boolean')
   then raise exception 'invalid scalar';end if;
   v_where:=v_where||format(' and %s %s %L',v_expr,v_op,v_val#>>'{}');
  end if;
 end loop;
 foreach v_col in array coalesce(p_group_by,array[]::text[]) loop
  v_path:=case when v_has_data then public.ai_query_path(v_col) end;
  v_expr:=case when v_path is null then format('%I',v_col) else format('(data #>> %L)',v_path) end;
  v_group:=v_group||case when v_group='' then '' else ',' end||v_expr;
  v_select:=v_select||case when v_select='' then '' else ',' end||format('%s as %I',v_expr,v_col);
 end loop;
 -- Aggregation and grouping are done inside the database, never in model text.
 for v_metric in select value from jsonb_array_elements(coalesce(p_metrics,'[]'::jsonb)) loop
  v_fn:=lower(v_metric->>'fn');v_col:=v_metric->>'column';
  v_path:=case when v_has_data then public.ai_query_path(v_col) end;
  if v_fn not in ('sum','count','count_distinct','avg','min','max') then raise exception 'invalid aggregate';end if;
  if v_path is not null then
   v_expr:=case when v_fn in ('count','count_distinct') then format('nullif(data #> %L,''null''::jsonb)',v_path)
    else format('(case when jsonb_typeof(data #> %L)=''number'' then (data #>> %L)::numeric end)',v_path,v_path) end;
  elsif exists(select 1 from information_schema.columns c
    where c.table_schema='public' and c.table_name=p_view and c.column_name=v_col and
    (v_fn='count' or (v_fn='count_distinct' and c.data_type not in ('json','jsonb','ARRAY')) or
     c.data_type in ('numeric','integer','bigint','smallint','double precision','real'))) then
   v_expr:=format('%I',v_col);
  else raise exception 'invalid aggregate';
  end if;
  v_select:=v_select||case when v_select='' then '' else ',' end||
   format('%s as %I',
    case when v_fn='count_distinct' then format('count(distinct %s)',v_expr)
     else format('%s(%s)',v_fn,v_expr) end,
    v_fn||'_'||v_col);
 end loop;
 if v_select='' then
  for v_col in select unnest(coalesce(p_columns,array['business_id','source','source_ref','status','business_date'])) loop
   v_path:=case when v_has_data then public.ai_query_path(v_col) end;
   v_expr:=case when v_path is null then format('%I',v_col) else format('(data #> %L)',v_path) end;
   v_select:=v_select||case when v_select='' then '' else ',' end||format('%s as %I',v_expr,v_col);
  end loop;
 elsif v_group='' then
  -- Aggregate-only requests cannot add ungrouped columns.
  if coalesce(array_length(p_columns,1),0)>0 then raise exception 'columns require group by';end if;
 elsif exists(select 1 from unnest(p_columns) c where c<>all(p_group_by)) then
  raise exception 'ungrouped columns';
 end if;
 if v_group<>'' then v_group:=' group by '||v_group;end if;
 if p_order_by is not null then
  v_field:=p_order_by->>'column';v_dir:=coalesce(p_order_by->>'direction','asc');
  if v_dir not in ('asc','desc') or not (
   v_field=any(coalesce(p_columns,array[]::text[])) or
   v_field=any(coalesce(p_group_by,array[]::text[])) or
   exists(select 1 from jsonb_array_elements(coalesce(p_metrics,'[]'::jsonb)) m
    where (m->>'fn')||'_'||(m->>'column')=v_field))
  then raise exception 'invalid order by';end if;
  v_order:=format(' order by %I %s',v_field,v_dir);
 end if;
 v_limit:=p_limit+1;
 v_sql:=format('select coalesce(jsonb_agg(to_jsonb(q)),''[]''::jsonb)
 from (select %s from %s where %s%s%s limit %s) q',
  v_select,v_source,v_where,v_group,v_order,v_limit);
 execute v_sql into v_rows using p_business_id;
 v_n:=jsonb_array_length(v_rows);
 -- Count and byte limits are enforced by PostgreSQL, not just the UI.
 -- Keep only a fitting prefix and explicitly mark it truncated.
 for v_row in select value from jsonb_array_elements(v_rows) loop
  exit when jsonb_array_length(v_bounded)>=p_limit;
  v_row_bytes:=octet_length(v_row::text)+1;
  if v_bytes+v_row_bytes>6000 then v_bytes_cut:=true;exit;end if;
  v_bounded:=v_bounded||jsonb_build_array(v_row);
  v_bytes:=v_bytes+v_row_bytes;
 end loop;
 v_rows:=v_bounded;
 execute format('select count(*),coalesce(bool_or(status in (''open'',''estimated'',''needs_match'',''provisional'')),false) from %s where %s',v_source,v_where)
 into v_source_count,v_incomplete using p_business_id;
 execute format('select coalesce(jsonb_object_agg(source,n),''{}''::jsonb) from
 (select source,count(*) n from %s where %s group by source) mix',v_source,v_where)
 into v_mix using p_business_id;
 -- Customer denominator is the full selected period, not the filtered
 -- subset; never imply all-café coverage from a single identity or product.
 if (p_view in ('cv_customer_visits','cv_customer_products') or (p_view='cv_toast_records' and
  position('data.aiCafeCustomer.' in coalesce(p_columns::text,'')||coalesce(p_group_by::text,'')||
    coalesce(p_filters::text,'')||coalesce(p_metrics::text,''))>0))
  then
  v_customer_coverage:=public.customer_query_coverage(p_business_id,p_date_from,p_date_to);
 end if;
 return jsonb_build_object('rows',v_rows,'rowCount',jsonb_array_length(v_rows),
  'truncated',v_n>p_limit or v_bytes_cut,'sourceMix',v_mix,
  'sourceCount',v_source_count,'hasIncomplete',v_incomplete,
  'currentDayIncomplete',v_current_day)||case when v_customer_coverage is null then '{}'::jsonb
  else jsonb_build_object('customerCoverage',v_customer_coverage) end;
end $query$;
revoke all on function public.ai_query_view(uuid,text,text[],jsonb,text[],jsonb,date,date,jsonb,integer)
 from public,anon,authenticated;
grant execute on function public.ai_query_view(uuid,text,text[],jsonb,text[],jsonb,date,date,jsonb,integer)
 to authenticated,service_role;
