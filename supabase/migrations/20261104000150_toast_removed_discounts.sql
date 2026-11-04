-- Toast discounts removed at the register are no longer counted.
--
-- When staff apply a discount and then remove it, Toast keeps it on the order
-- with processingState 'VOID'. It never lowered the price, and Toast's own
-- reports leave it out. We counted it: on Nov 2 one drink's student discount
-- was counted twice (6 instead of Toast's 5, $6.69 instead of $5.81). Seiyun's
-- history has 4 such removed discounts ($12.39), on Aug 30, Sep 14, Oct 19, Nov 2.
-- Net sales were never affected (Toast's check amount already excludes it).
--
-- Same rule everywhere (the app's day parser uses isRemovedToastDiscount):
--  1. Typed order details (the discounts view the screens and the AI read)
--     skip removed discounts. Identical to migration 113 except those two lines.
--  2. Existing typed details of orders with a removed discount are rebuilt.
--  3. The AI's Toast records still show a removed discount (every field is
--     kept) but with counts_in_sales = false.
-- Order totals (orders.discounts_cents, gross sales, day totals) come from the
-- app's import; the 4 affected days are re-imported after this ships.

-- 1.
create or replace function public.toast_capture_typed_order(p_raw_id uuid)
returns void language plpgsql security definer set search_path=public as $typed$
declare
 c jsonb;s jsonb;d jsonb;p jsonb;m jsonb;
 check_guid text;selection_guid text;
 check_ds jsonb:='[]'::jsonb;item_ds jsonb:='[]'::jsonb;
 tax_items jsonb:='[]'::jsonb;mods jsonb:='[]'::jsonb;
 voids jsonb:='[]'::jsonb;refunds jsonb:='[]'::jsonb;
 duration bigint;begin_at timestamptz;close_at timestamptz;
 value_cents bigint; v_amt text;
 v_raw public.toast_raw_records%rowtype;
begin
 select * into v_raw from public.toast_raw_records where id=p_raw_id;
 if not found or v_raw.entity<>'order' then return;end if;
 begin
  begin_at:=(v_raw.payload->>'openedDate')::timestamptz;
  close_at:=(v_raw.payload->>'closedDate')::timestamptz;
  if close_at>=begin_at then
    duration:=round(extract(epoch from close_at-begin_at))::bigint;
  end if;
 exception when others then duration:=null;
 end;
 if v_raw.payload->>'voided'='true' then
  voids:=voids||jsonb_build_array(jsonb_build_object('level','order',
   'guid',v_raw.payload->>'guid','businessDate',v_raw.payload->>'voidBusinessDate',
   'reasonGuid',v_raw.payload->'voidReason'->>'guid'));
 end if;
 for c in select value from jsonb_array_elements(
   case when jsonb_typeof(v_raw.payload->'checks')='array'
    then v_raw.payload->'checks' else '[]'::jsonb end)
 loop
  check_guid:=c->>'guid';
  if c->>'voided'='true' then
   voids:=voids||jsonb_build_array(jsonb_build_object('level','check',
    'guid',check_guid,'businessDate',c->>'voidBusinessDate',
    'reasonGuid',c->'voidReason'->>'guid'));
  end if;
  for d in select value from jsonb_array_elements(
   case when jsonb_typeof(c->'appliedDiscounts')='array'
    then c->'appliedDiscounts' else '[]'::jsonb end)
  loop
   -- Removed at the register: Toast keeps it with processingState VOID.
   continue when d->>'processingState'='VOID';
   v_amt:=case when jsonb_typeof(d->'nonTaxDiscountAmount')='number'
      then d->>'nonTaxDiscountAmount'
      when jsonb_typeof(d->'discountAmount')='number'
      then d->>'discountAmount' else null end;
   value_cents:=case when v_amt is not null and abs(v_amt::numeric)<100000000
    then round(v_amt::numeric*100)::bigint else null end;
   check_ds:=check_ds||jsonb_build_array(jsonb_build_object('checkGuid',check_guid,
    'name',public.toast_safe_business_label(d->>'name'),'amountCents',value_cents));
  end loop;
  for s in select value from jsonb_array_elements(
   case when jsonb_typeof(c->'selections')='array'
    then c->'selections' else '[]'::jsonb end)
  loop
   selection_guid:=s->>'guid';
   if s->>'voided'='true' then
    voids:=voids||jsonb_build_array(jsonb_build_object('level','selection',
     'guid',selection_guid,'businessDate',s->>'voidBusinessDate',
     'reasonGuid',s->'voidReason'->>'guid'));
   end if;
   v_amt:=case when jsonb_typeof(s->'tax')='number' then s->>'tax'
    when jsonb_typeof(s->'taxAmount')='number' then s->>'taxAmount'
    else null end;
   value_cents:=case when v_amt is not null and abs(v_amt::numeric)<100000000
    then round(v_amt::numeric*100)::bigint else null end;
   tax_items:=tax_items||jsonb_build_array(jsonb_build_object(
    'selectionGuid',selection_guid,'taxAmountCents',value_cents,
    'taxRate',case when jsonb_typeof(s->'taxRate')='number' then s->'taxRate' else null end));
   for d in select value from jsonb_array_elements(
    case when jsonb_typeof(s->'appliedDiscounts')='array'
     then s->'appliedDiscounts' else '[]'::jsonb end)
   loop
    continue when d->>'processingState'='VOID';
    v_amt:=case when jsonb_typeof(d->'discountAmount')='number' then d->>'discountAmount'
     when jsonb_typeof(d->'nonTaxDiscountAmount')='number'
      then d->>'nonTaxDiscountAmount' else null end;
    value_cents:=case when v_amt is not null and abs(v_amt::numeric)<100000000
     then round(v_amt::numeric*100)::bigint else null end;
    item_ds:=item_ds||jsonb_build_array(jsonb_build_object(
      'checkGuid',check_guid,'selectionGuid',selection_guid,
      'name',public.toast_safe_business_label(d->>'name'),'amountCents',value_cents));
   end loop;
   for m in select value from jsonb_array_elements(
    case when jsonb_typeof(s->'modifiers')='array'
     then s->'modifiers' else '[]'::jsonb end)
   loop
    v_amt:=case when jsonb_typeof(m->'price')='number' then m->>'price' else null end;
    value_cents:=case when v_amt is not null and abs(v_amt::numeric)<100000000
     then round(v_amt::numeric*100)::bigint else null end;
    mods:=mods||jsonb_build_array(jsonb_build_object(
      'selectionGuid',selection_guid,'modifierGuid',m->'item'->>'guid',
      'priceCents',value_cents));
   end loop;
   if jsonb_typeof(s->'refundDetails')='object' then
    d:=s->'refundDetails';
    v_amt:=case when jsonb_typeof(d->'refundAmount')='number' then d->>'refundAmount' else null end;
    value_cents:=case when v_amt is not null and abs(v_amt::numeric)<100000000
     then round(v_amt::numeric*100)::bigint else null end;
    refunds:=refunds||jsonb_build_array(jsonb_build_object('level','selection',
      'guid',selection_guid,'amountCents',value_cents,
      'businessDate',d->>'refundBusinessDate'));
   end if;
  end loop;
  for p in select value from jsonb_array_elements(
   case when jsonb_typeof(c->'payments')='array'
    then c->'payments' else '[]'::jsonb end)
  loop
   if jsonb_typeof(p->'refund')='object' then
    d:=p->'refund';
    v_amt:=case when jsonb_typeof(d->'refundAmount')='number' then d->>'refundAmount' else null end;
    value_cents:=case when v_amt is not null and abs(v_amt::numeric)<100000000
     then round(v_amt::numeric*100)::bigint else null end;
    refunds:=refunds||jsonb_build_array(jsonb_build_object('level','payment',
     'guid',p->>'guid','amountCents',value_cents,
     'businessDate',d->>'refundBusinessDate'));
   end if;
  end loop;
 end loop;
 insert into public.toast_order_typed_facts(
  raw_record_id,business_id,restaurant_guid,business_date,order_guid,run_id,
  order_duration_seconds,source_seen_at,check_discounts,item_discounts,item_taxes,
  modifier_prices,void_details,refund_details)
 values(v_raw.id,v_raw.business_id,v_raw.restaurant_guid,v_raw.business_date,v_raw.entity_guid,
  v_raw.run_id,duration,v_raw.first_seen,check_ds,item_ds,tax_items,mods,voids,refunds)
 on conflict(raw_record_id) do nothing;
 return;
end $typed$;
revoke all on function public.toast_capture_typed_order(uuid) from public,anon,authenticated;
grant execute on function public.toast_capture_typed_order(uuid) to service_role;

-- 2. Rebuild typed details for orders that carry a removed discount (keeps run_id).
do $rebuild$
declare r record;
begin
 for r in select t.id from public.toast_raw_records t
  where t.entity='order' and jsonb_typeof(t.payload)='object'
   and jsonb_path_exists(t.payload,'lax $.checks[*].**.appliedDiscounts[*] ? (@.processingState == "VOID")')
 loop
  delete from public.toast_order_typed_facts where raw_record_id=r.id;
  perform public.toast_capture_typed_order(r.id);
 end loop;
end $rebuild$;

-- 3. As migration 149, with removed discounts marked as not counting.
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
samples as not materialized (
 select s.*,
  s.endpoint not in ('labor/v1/shifts','labor/v1/timeEntries','cashmgmt/v1/deposits',
   'cashmgmt/v1/entries','kitchen/v1/export/itemFulfillments') and s.endpoint not like 'era/%' setup
 from public.toast_raw_samples s
 where s.http_status between 200 and 299 and s.error_code is null
  and s.endpoint not like 'orders/%' and s.endpoint not like '%{%'
  and (p_business_id is null or s.business_id=p_business_id)
  and case when p_business_id is not null then (select public.toast_records_allowed(p_business_id))
   else public.toast_records_allowed(s.business_id) end
  and coalesce(s.capture_id::text,'row:'||s.id::text)=(
   select coalesce(t.capture_id::text,'row:'||t.id::text) from public.toast_raw_samples t
   where t.business_id=s.business_id and t.restaurant_guid=s.restaurant_guid
    and t.endpoint=s.endpoint and t.http_status between 200 and 299 and t.error_code is null
    and (t.business_date is not distinct from s.business_date or
     s.endpoint not in ('labor/v1/shifts','labor/v1/timeEntries','cashmgmt/v1/deposits',
      'cashmgmt/v1/entries','kitchen/v1/export/itemFulfillments') and s.endpoint not like 'era/%')
   order by t.fetched_at desc,t.id desc limit 1))
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
select s.business_id,'toast','toast-capture:'||s.id::text||':'||x.n,'actual',
 case when s.setup then null::date else s.business_date end,
 s.endpoint,x.v->>'guid',null,null,null::boolean,x.v
from samples s cross join lateral jsonb_array_elements(case when jsonb_typeof(s.sample)='array' then s.sample
 when jsonb_typeof(s.sample->'data')='array' then s.sample->'data'
 when jsonb_typeof(s.sample->'results')='array' then s.sample->'results'
 when jsonb_typeof(s.sample->'menus')='array' then s.sample->'menus'
 else jsonb_build_array(s.sample) end) with ordinality x(v,n)
where jsonb_typeof(x.v)='object'
 and (s.setup or ((p_from is null or s.business_date>=p_from) and (p_to is null or s.business_date<=p_to)))
$records$;
revoke all on function public.toast_records_for(uuid,date,date) from public,anon;
grant execute on function public.toast_records_for(uuid,date,date) to authenticated,service_role;
