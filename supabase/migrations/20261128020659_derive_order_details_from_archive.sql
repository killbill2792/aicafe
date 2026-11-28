-- Reason: Supabase applies individual statements. Keep the historical parity check, replacement reader and retirement under the same lock.
-- squawk-ignore transaction-nesting
begin;
set local statement_timeout = '60s';
-- Keep financial detail semantics and derive the fields from the certified
-- archive row at read time. No new projection is persisted.
set local lock_timeout='5s';
lock table public.toast_raw_records in share row exclusive mode;
lock table public.toast_order_typed_facts in access exclusive mode;

-- Only a source receipt can promote archived evidence to original-provider
-- status. A bookkeeping update by a historical staging writer cannot.
create or replace function public.external_record_provider_observed()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if new.source_account is not null and new.commit_id is distinct from old.commit_id then
    new.payload_origin := 'provider';
  end if;
  return new;
end $$;

create function public.toast_order_details(p_payload jsonb)
returns table(order_duration_seconds bigint,check_discounts jsonb,item_discounts jsonb,
 item_taxes jsonb,modifier_prices jsonb,void_details jsonb,refund_details jsonb)
language plpgsql stable security invoker set search_path=pg_catalog,public as $typed$
declare
 c jsonb;s jsonb;d jsonb;p jsonb;m jsonb;
 check_guid text;selection_guid text;
 check_ds jsonb:='[]'::jsonb;item_ds jsonb:='[]'::jsonb;
 tax_items jsonb:='[]'::jsonb;mods jsonb:='[]'::jsonb;
 voids jsonb:='[]'::jsonb;refunds jsonb:='[]'::jsonb;
 duration bigint;begin_at timestamptz;close_at timestamptz;
 value_cents bigint; v_amt text;
begin
 begin
  begin_at:=(p_payload->>'openedDate')::timestamptz;
  close_at:=(p_payload->>'closedDate')::timestamptz;
  if close_at>=begin_at then
    duration:=round(extract(epoch from close_at-begin_at))::bigint;
  end if;
 exception when others then duration:=null;
 end;
 if p_payload->>'voided'='true' then
  voids:=voids||jsonb_build_array(jsonb_build_object('level','order',
   'guid',p_payload->>'guid','businessDate',p_payload->>'voidBusinessDate',
   'reasonGuid',p_payload->'voidReason'->>'guid'));
 end if;
 for c in select value from jsonb_array_elements(
   case when jsonb_typeof(p_payload->'checks')='array'
    then p_payload->'checks' else '[]'::jsonb end)
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

 return query select duration,check_ds,item_ds,tax_items,mods,voids,refunds;
end $typed$;
revoke all on function public.toast_order_details(jsonb) from public,anon;
grant execute on function public.toast_order_details(jsonb) to authenticated,service_role;

-- Every old detail must be derivable before the former stored copy is removed.
-- Certified rows must also have passed archive provenance and retention review.
do $$
begin
 if exists (
  select from public.toast_order_typed_facts stored
  join public.external_records r on r.id=stored.raw_record_id and r.provider='toast'
    and r.business_id=stored.business_id
  cross join lateral public.toast_order_details(r.payload) derived
  where (stored.order_duration_seconds,stored.check_discounts,stored.item_discounts,
         stored.item_taxes,stored.modifier_prices,stored.void_details,stored.refund_details)
        is distinct from
        (derived.order_duration_seconds,derived.check_discounts,derived.item_discounts,
         derived.item_taxes,derived.modifier_prices,derived.void_details,derived.refund_details)
 ) then raise exception 'Stored order details differ from original archive'; end if;

 -- The archive scope columns are new in this upgrade. Establish scope for
 -- existing certified detail rows from their exact archived order, committed
 -- import and verified restaurant. Equality with the existing credential
 -- filter keeps this an attribution only: nothing is rewritten or exposed
 -- if it needs separate historical retention review.
 update public.external_records r set
   source_account=r.restaurant_guid::text,source_key=r.entity_guid::text,
   payload_origin='historical_provider'
 from public.toast_order_typed_facts stored
 join public.toast_day_status d on (d.business_id,d.restaurant_guid,d.business_date,d.last_import_run_id)=
   (stored.business_id,stored.restaurant_guid,stored.business_date,stored.run_id) and d.import_state='imported'
 join public.toast_location_mappings mapping on (mapping.business_id,mapping.restaurant_guid)=
   (stored.business_id,stored.restaurant_guid) and mapping.verified_at is not null
 where (r.business_id,r.id,r.restaurant_guid,r.business_date,r.entity_guid,r.run_id)=
   (stored.business_id,stored.raw_record_id,stored.restaurant_guid,stored.business_date,stored.order_guid,stored.run_id)
   and r.provider='toast' and r.entity='order' and r.source_account is null and r.superseded_by is null
   and r.payload->>'guid'=r.entity_guid::text and jsonb_typeof(r.payload->'checks')='array'
   and public.ai_safe_retained_json(r.payload)=r.payload;

 if exists (
  select from public.toast_order_typed_facts stored
  join public.toast_day_status d on (d.business_id,d.restaurant_guid,d.business_date,d.last_import_run_id)=
   (stored.business_id,stored.restaurant_guid,stored.business_date,stored.run_id) and d.import_state='imported'
  join public.external_records r on r.id=stored.raw_record_id and r.provider='toast'
    and r.business_id=stored.business_id
  where r.source_account is distinct from stored.restaurant_guid::text
    or r.source_key is distinct from stored.order_guid::text
    or r.run_id is distinct from stored.run_id
 ) then raise exception 'Certified archive history needs provenance review before cutover'; end if;
end $$;

create or replace view public.toast_current_typed_order_facts_v with (security_invoker=true) as
select r.business_id,r.restaurant_guid,r.business_date,r.entity_guid as order_guid,d.*
from (
 select distinct on (record.business_id,record.restaurant_guid,record.business_date,record.entity_guid)
  record.business_id,record.restaurant_guid,record.business_date,record.entity_guid,record.payload
 from public.external_records record
 join public.toast_day_status day on
  (day.business_id,day.restaurant_guid,day.business_date,day.last_import_run_id)=
  (record.business_id,record.restaurant_guid,record.business_date,record.run_id)
  and day.import_state='imported'
 where record.provider='toast' and record.entity='order'
 order by record.business_id,record.restaurant_guid,record.business_date,record.entity_guid,
  record.first_seen desc nulls last,record.id desc
) r
cross join lateral public.toast_order_details(r.payload) d;

create or replace function public.toast_archive_order(
 p_business_id uuid,p_restaurant_guid uuid,p_entity_guid uuid,p_business_date date,
 p_payload jsonb,p_sha text,p_run_id uuid,p_page integer,p_source_index integer,
 p_capture_key text,p_commit boolean
) returns text language plpgsql security definer set search_path=public as $order$
declare cur public.external_records%rowtype; diff jsonb; new_id uuid;
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only'; end if;
 for attempt in 1..2 loop
  select * into cur from public.external_records r
  where r.provider='toast' and r.business_id=p_business_id and r.restaurant_guid is not distinct from p_restaurant_guid
   and r.business_date=p_business_date and r.entity='order' and r.entity_guid=p_entity_guid
  order by r.last_seen desc,r.id desc limit 1 for update;
  exit when found;
  -- Two writers can meet on a new order (the live job and a chat refresh).
  -- The loser of the race reads the winner's record and continues from it.
  insert into public.external_records(provider,source_account,source_key,source_updated_at,business_id,restaurant_guid,entity,entity_guid,
   business_date,payload,payload_sha256,run_id,seen_run_id,source_page,source_index,capture_key)
  values('toast',p_restaurant_guid::text,p_entity_guid::text,public.toast_time_or_null(p_payload->>'modifiedDate'),
   p_business_id,p_restaurant_guid,'order',p_entity_guid,p_business_date,p_payload,
   p_sha,p_run_id,p_run_id,p_page,p_source_index,p_capture_key)
  on conflict do nothing returning id into new_id;
  if new_id is not null then return 'inserted'; end if;
 end loop;
 if cur.id is null then raise exception 'toast archive: order record not readable'; end if;
 if p_run_id is null and (cur.run_id is not null or cur.seen_run_id is not null) then
  -- Live mode: an import already owns this record. The import is the authority.
  return 'skipped';
 end if;
 if cur.payload_sha256<>p_sha
  and p_payload->>'modifiedDate' is not null and cur.payload->>'modifiedDate' is not null
  and public.toast_time_or_null(p_payload->>'modifiedDate')<public.toast_time_or_null(cur.payload->>'modifiedDate') then
  -- An older version than the one stored: never replace newer data with older data.
  return 'older';
 elsif cur.payload_sha256<>p_sha then
  -- Preserve the original ordered arrays when recording the change.
  select jsonb_agg(change order by change->'segments') into diff
    from public.external_json_delta(cur.payload,p_payload) change;
  if diff is not null then
    insert into public.external_record_changes(provider,source_account,source_key,record_id,business_id,
      restaurant_guid,entity,entity_guid,business_date,run_id,changes)
    values('toast',cur.source_account,p_entity_guid::text,cur.id,p_business_id,p_restaurant_guid,
      'order',p_entity_guid,cur.business_date,p_run_id,diff);
  end if;
  update public.external_records set payload=p_payload,payload_sha256=p_sha,
   source_account=p_restaurant_guid::text,source_key=p_entity_guid::text,payload_origin='provider',
   source_updated_at=public.toast_time_or_null(p_payload->>'modifiedDate'),
   seen_run_id=p_run_id,last_seen=now(),
   run_id=case when p_commit then p_run_id else run_id end,
   source_page=case when p_commit then p_page else source_page end,
   source_index=case when p_commit then p_source_index else source_index end
  where provider='toast' and business_id=p_business_id and id=cur.id;
  return 'changed';
 elsif (cur.payload_origin<>'provider' and cur.payload=p_payload)
  or (cur.source_account is null and cur.payload=p_payload) or cur.seen_run_id is distinct from p_run_id
  or (p_commit and cur.run_id is distinct from p_run_id) then
  update public.external_records set seen_run_id=p_run_id,last_seen=now(),
   source_account=case when cur.payload=p_payload then p_restaurant_guid::text else cur.source_account end,
   payload_origin=case when cur.payload=p_payload then 'provider' else cur.payload_origin end,
   source_key=p_entity_guid::text,source_updated_at=public.toast_time_or_null(cur.payload->>'modifiedDate'),
   run_id=case when p_commit then p_run_id else run_id end,
   source_page=case when p_commit then p_page else source_page end,
   source_index=case when p_commit then p_source_index else source_index end
  where provider='toast' and business_id=p_business_id and id=cur.id;
 end if;
 return 'same';
end $order$;

-- Reason: The new order reader derives the detail from retained source JSON and does not need this duplicate materialization trigger.
-- squawk-ignore ban-drop-trigger
drop trigger toast_raw_order_typed_capture on public.toast_raw_records;
-- Reason: The replacing archive reader no longer uses this removed trigger entry point.
-- squawk-ignore ban-drop-function
drop function public.toast_capture_typed_order_trigger();
-- Reason: The replacement reader and writer no longer call the legacy order materializer.
-- squawk-ignore ban-drop-function
drop function public.toast_capture_typed_order(uuid);
-- Reason: The migration validates derived detail parity against original archived orders before retiring this copy.
-- squawk-ignore ban-drop-table
drop table public.toast_order_typed_facts;
-- Reason: Commit the verified cutover as one transaction.
-- squawk-ignore transaction-nesting
commit;
