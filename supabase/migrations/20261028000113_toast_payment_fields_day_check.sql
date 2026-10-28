-- Prompt D Follow-up, applied manually after 112. All service-side owner
-- actions remain atomic; no old migrations are edited.
alter table public.toast_day_status
 add column if not exists owner_confirmed_at timestamptz;

-- Durable bounded labor-history checkpoint. A chunk is marked complete ONLY
-- after staging and canonical copy both commit; retries may safely replay it.
create table if not exists public.toast_labor_backfill_progress (
 business_id uuid not null,restaurant_guid uuid not null,
 next_at timestamptz not null,updated_at timestamptz not null default now(),
 primary key(business_id,restaurant_guid),
 foreign key(business_id,restaurant_guid)
 references public.toast_location_mappings(business_id,restaurant_guid)
);
alter table public.toast_labor_backfill_progress enable row level security;
revoke all on public.toast_labor_backfill_progress from public,anon,authenticated;
grant select,insert,update on public.toast_labor_backfill_progress to service_role;



-- Owner acknowledgement never overwrites independent Toast financial evidence.
-- Re-import invalidates only the old acknowledgement, not historical raw facts.
create or replace function public.toast_owner_confirmation_on_reimport()
returns trigger language plpgsql set search_path=public as $owner$
begin
 if new.imported_at is distinct from old.imported_at then
  new.owner_confirmed_at=null;
 end if;
 return new;
end $owner$;
drop trigger if exists toast_owner_confirmation_on_reimport on public.toast_day_status;
create trigger toast_owner_confirmation_on_reimport
 before update of imported_at on public.toast_day_status
 for each row execute function public.toast_owner_confirmation_on_reimport();

-- A re-pull is a NEW one-day repull_modified run. The old backfill RPC is for
-- growing the historical range and can return a progressed active run unchanged.
-- Scheduler runDue processes repull_modified via importToastBusinessDay,
-- the SAME path that commits toast_import_day and resets reconciliation.
create unique index if not exists toast_one_active_owner_repull
 on public.toast_sync_runs(business_id,restaurant_guid,requested_from,requested_to)
 where kind='repull_modified' and state in ('queued','running','paused_rate_limited');

create or replace function public.toast_queue_owner_repull(
 p_business_id uuid,p_restaurant_guid uuid,p_date date)
returns uuid language plpgsql security definer set search_path=public as $repull$
declare v_id uuid;v_zone text;
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 select toast_time_zone into v_zone from public.toast_location_mappings
  where business_id=p_business_id and restaurant_guid=p_restaurant_guid
  and verified_at is not null for share;
 if v_zone is null or p_date<'2015-12-02'::date or
  p_date >= (now() at time zone v_zone)::date
 then raise exception 'invalid repull day';end if;
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,
  requested_from,requested_to,days_total,cursor)
 values(p_business_id,p_restaurant_guid,'repull_modified',p_date,p_date,1,'{}'::jsonb)
 on conflict(business_id,restaurant_guid,requested_from,requested_to)
 where kind='repull_modified' and state in ('queued','running','paused_rate_limited')
 do nothing returning id into v_id;
 if v_id is null then
  select id into v_id from public.toast_sync_runs
   where business_id=p_business_id and restaurant_guid=p_restaurant_guid
    and kind='repull_modified' and requested_from=p_date and requested_to=p_date
    and state in ('queued','running','paused_rate_limited')
   order by id limit 1;
 end if;
 if v_id is null then raise exception 'unable to queue repull';end if;
 return v_id;
end $repull$;
revoke all on function public.toast_queue_owner_repull(uuid,uuid,date)
 from public,anon,authenticated;
grant execute on function public.toast_queue_owner_repull(uuid,uuid,date)
 to service_role;

-- Replaces the original first-import answer RPC with an owner acknowledgement
-- of exactly the latest seven complete dates, retaining audit evidence.
create or replace function public.toast_answer_first_import_check(
 p_business_id uuid,p_answer text,p_days date[],p_note text)
returns void language plpgsql security definer set search_path=public as $answer$
declare d date; loc record; n integer; v_compared date[];
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 if p_answer not in ('looks_right','something_off') or
  cardinality(p_days)>100 or length(coalesce(p_note,''))>2000 or
  (p_answer='something_off' and cardinality(p_days)=0) or
  (p_answer='looks_right' and cardinality(p_days)<>0)
 then raise exception 'invalid answer';end if;
 select array_agg(day order by day desc) into v_compared from (
  select distinct s.business_date as day
  from public.toast_day_status s where s.business_id=p_business_id
   and public.toast_is_complete_business_day(p_business_id,s.business_date)
  order by day desc limit 7
 ) days;
 n:=coalesce(cardinality(v_compared),0);
 if n<7 then raise exception 'not ready';end if;
 insert into public.toast_first_import_check(business_id,answered_at,answer,flagged_dates,note)
 values(p_business_id,now(),p_answer,p_days,p_note)
 on conflict(business_id) do update set answered_at=excluded.answered_at,
 answer=excluded.answer,flagged_dates=excluded.flagged_dates,note=excluded.note
 where public.toast_first_import_check.answered_at is null;
 if not found then raise exception 'already answered';end if;
 if p_answer='looks_right' then
  update public.toast_day_status set owner_confirmed_at=now()
   where business_id=p_business_id and business_date=any(v_compared)
    and import_state='imported';
  update public.toast_day_owner_flags set cleared_at=now()
   where business_id=p_business_id and business_date=any(v_compared)
    and cleared_at is null;
 else
  foreach d in array p_days loop
   if not public.toast_is_complete_business_day(p_business_id,d)
    then raise exception 'invalid flagged date';end if;
   for loc in select m.restaurant_guid from public.toast_location_mappings m
    where m.business_id=p_business_id and m.verified_at is not null
     and (m.toast_start_date is null or d>=m.toast_start_date) loop
    insert into public.toast_day_owner_flags(
      business_id,restaurant_guid,business_date,note)
    values(p_business_id,loc.restaurant_guid,d,p_note)
    on conflict(business_id,restaurant_guid,business_date) do update
    set flagged_at=now(),cleared_at=null,note=excluded.note;
   end loop;
   perform public.toast_certify_day_voids(p_business_id,d);
  end loop;
 end if;
end $answer$;
revoke all on function public.toast_answer_first_import_check(uuid,text,date[],text)
 from public,anon,authenticated;
grant execute on function public.toast_answer_first_import_check(uuid,text,date[],text)
 to service_role;

-- An owner-confirmed historical review is no longer a visible warning;
-- reopening on re-import is handled by the trigger above.
create or replace view public.toast_owner_attention_days_v with(security_invoker=true) as
 select business_id,restaurant_guid,business_date from public.toast_day_status
 where owner_confirmed_at is null and
 (import_state='failed' or recon_state in ('mismatch','coverage_invalid')
  or unparsed_count>0 or (last_error_category is not null and last_error_category not in
   ('analytics_timeout','closeout_changed')))
 union
 select f.business_id,f.restaurant_guid,f.business_date
 from public.toast_day_owner_flags f
 left join public.toast_day_status s
 on s.business_id=f.business_id and s.restaurant_guid=f.restaurant_guid
 and s.business_date=f.business_date
 where f.cleared_at is null and s.owner_confirmed_at is null
 union
 select e.business_id,e.restaurant_guid,e.business_date
 from public.toast_owner_summary_entries e
 left join public.toast_day_status s
 on s.business_id=e.business_id and s.restaurant_guid=e.restaurant_guid
 and s.business_date=e.business_date
 where e.comparison='owner_summary_mismatch' and s.owner_confirmed_at is null;
revoke all on public.toast_owner_attention_days_v from public,anon,authenticated;
grant select on public.toast_owner_attention_days_v to service_role;

-- Issue 9 already fixed by migration 101. Owner verification query:
-- select pg_get_constraintdef(oid) from pg_constraint
-- where conname='toast_sync_phase_errors_phase_check';


-- Complete sanitized payment projection from retained Toast raw payloads.
-- This table stores NO card PAN, guest name, or billing details.
create table if not exists public.toast_payment_facts(
 business_id uuid not null references public.businesses(id) on delete cascade,
 restaurant_guid uuid not null,business_date date not null,
 payment_ref text not null,
 payment_type text,card_type text,card_entry_mode text,
 payment_status text,amount_cents bigint,tip_cents bigint,
 original_processing_fee_cents bigint,
 processing_fee_cents bigint,
 fee_status text not null default 'missing'
  check(fee_status in ('actual','estimated','missing')),
 fee_basis text not null default 'missing'
  check(fee_basis in ('toast','owner_plan','cash_or_gift','missing')),
 status text not null default 'actual'
  check(status in ('actual','estimated','open','needs_match','owner_provided')),
 first_seen timestamptz not null default now(),
 primary key(business_id,restaurant_guid,business_date,payment_ref)
);
create index if not exists toast_payment_facts_day
 on public.toast_payment_facts(business_id,business_date);
alter table public.toast_payment_facts enable row level security;
revoke all on public.toast_payment_facts from public,anon,authenticated;
create policy "owner read" on public.toast_payment_facts for select
 to authenticated using(public.scheduling_is_owner(business_id));
grant select on public.toast_payment_facts to authenticated;
grant select,insert,update,delete on public.toast_payment_facts to service_role;

-- The import transaction has already archived every raw nested payment from
-- every source page. Complete snapshots replace only the CURRENT typed rows.
-- Retained raw records are never updated or removed.
create or replace function public.toast_refresh_typed_payment_facts()
returns trigger language plpgsql security definer set search_path=public as $facts$
begin
 if auth.role()<>'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only';end if;
 if new.import_state<>'imported' or new.last_import_run_id is null
  or (tg_op='UPDATE' and new.imported_at is not distinct from old.imported_at)
 then return new;end if;
 if new.unparsed_count=0 then
  delete from public.toast_payment_facts
  where business_id=new.business_id and restaurant_guid=new.restaurant_guid
   and business_date=new.business_date;
 else
  update public.toast_payment_facts set status='needs_match'
  where business_id=new.business_id and restaurant_guid=new.restaurant_guid
   and business_date=new.business_date;
 end if;
 with raw as (
  select distinct on (
   coalesce(entity_guid::text,
    regexp_replace(capture_key,':[0-9a-f]{64}$','')))
   coalesce(entity_guid::text,
    regexp_replace(capture_key,':[0-9a-f]{64}$','')) as ref,
   payload,first_seen
  from public.toast_raw_records
  where business_id=new.business_id and restaurant_guid=new.restaurant_guid
   and business_date=new.business_date and run_id=new.last_import_run_id
   and entity='payment'
  order by coalesce(entity_guid::text,
   regexp_replace(capture_key,':[0-9a-f]{64}$','')),
    first_seen desc, capture_key desc
 )
 insert into public.toast_payment_facts(
 business_id,restaurant_guid,business_date,payment_ref,payment_type,card_type,
 card_entry_mode,payment_status,amount_cents,tip_cents,
 original_processing_fee_cents,processing_fee_cents,fee_status,fee_basis,status,first_seen)
 select new.business_id,new.restaurant_guid,new.business_date,r.ref,
 left(r.payload->>'type',80),left(r.payload->>'cardType',80),
 left(r.payload->>'cardEntryMode',80),left(r.payload->>'paymentStatus',80),
 case when jsonb_typeof(r.payload->'amount')='number'
  then round((r.payload->>'amount')::numeric*100)::bigint else null end,
 case when jsonb_typeof(r.payload->'tipAmount')='number'
  then round((r.payload->>'tipAmount')::numeric*100)::bigint else null end,
 case when jsonb_typeof(r.payload->'originalProcessingFee')='number'
  then round((r.payload->>'originalProcessingFee')::numeric*100)::bigint else null end,
 case when upper(regexp_replace(coalesce(r.payload->>'type',''),'[^a-zA-Z]','','g'))
  in ('CASH','GIFTCARD','GIFTCERTIFICATE') then 0
  when jsonb_typeof(r.payload->'originalProcessingFee')='number'
  then round((r.payload->>'originalProcessingFee')::numeric*100)::bigint else null end,
 case when upper(regexp_replace(coalesce(r.payload->>'type',''),'[^a-zA-Z]','','g'))
  in ('CASH','GIFTCARD','GIFTCERTIFICATE')
  or jsonb_typeof(r.payload->'originalProcessingFee')='number' then 'actual'
  else 'missing' end,
 case when upper(regexp_replace(coalesce(r.payload->>'type',''),'[^a-zA-Z]','','g'))
  in ('CASH','GIFTCARD','GIFTCERTIFICATE') then 'cash_or_gift'
  when jsonb_typeof(r.payload->'originalProcessingFee')='number' then 'toast'
  else 'missing' end,
 case when jsonb_typeof(r.payload->'amount')='number' then 'actual'
  else 'open' end,r.first_seen
 from raw r
 on conflict(business_id,restaurant_guid,business_date,payment_ref) do update
 set payment_type=excluded.payment_type,card_type=excluded.card_type,
 card_entry_mode=excluded.card_entry_mode,payment_status=excluded.payment_status,
 amount_cents=excluded.amount_cents,tip_cents=excluded.tip_cents,
 original_processing_fee_cents=excluded.original_processing_fee_cents,
 processing_fee_cents=excluded.processing_fee_cents,
 fee_status=excluded.fee_status,fee_basis=excluded.fee_basis,
 status=excluded.status,first_seen=excluded.first_seen;
 return new;
end $facts$;
drop trigger if exists toast_payment_facts_current_on_import on public.toast_day_status;
create trigger toast_payment_facts_current_on_import
 after insert or update of imported_at on public.toast_day_status
 for each row execute function public.toast_refresh_typed_payment_facts();
revoke all on function public.toast_refresh_typed_payment_facts() from public,anon,authenticated;

-- Prefer typed current payment fields, but retain existing sanitized legacy
-- summaries for days predating raw archival.
create or replace view public.cv_payments
 (business_id,source,source_ref,status,business_date,amount_cents,tip_cents,
  data,payment_type,card_type,card_entry_mode,original_processing_fee_cents,
  processing_fee_cents,fee_status)
with (security_invoker=true) as
 select p.business_id,'toast'::text,
  'payment:'||p.restaurant_guid::text||':'||p.payment_ref,
  p.status,p.business_date,p.amount_cents,p.tip_cents,
  jsonb_build_object('type',p.payment_type,'cardType',p.card_type,
   'cardEntryMode',p.card_entry_mode,
   'originalProcessingFeeCents',p.original_processing_fee_cents,
   'feeStatus',p.fee_status,'feeBasis',p.fee_basis) as data,
  p.payment_type,p.card_type,p.card_entry_mode,p.original_processing_fee_cents,
  p.processing_fee_cents,p.fee_status
 from public.toast_payment_facts p
 union all
 select s.business_id,'toast'::text,
  'payment:'||s.restaurant_guid::text||':'||s.payment_ref,
  s.status,s.business_date,s.amount_cents,s.tip_cents,
  jsonb_build_object('type',s.payment_type,'legacy',true),
  s.payment_type,null::text,null::text,null::bigint,null::bigint,'missing'::text
 from public.toast_payment_summaries s
 where not exists(select 1 from public.toast_payment_facts f
  where f.business_id=s.business_id and f.restaurant_guid=s.restaurant_guid
   and f.business_date=s.business_date);
revoke all on public.cv_payments from public,anon;
grant select on public.cv_payments to authenticated,service_role;

-- One selected canonical daily fee fact, not fabricated per-order fee zeros.
create or replace view public.cv_card_fees
 (business_id,source,source_ref,status,business_date,amount_cents,data)
with (security_invoker=true) as
 select f.business_id,
 case when f.provider='Toast' then 'toast' else 'app' end::text,
 'fee:'||f.business_date::text,
 case when f.status='estimated' then 'estimated' else 'actual' end::text,
 f.business_date,f.amount_cents,
 jsonb_build_object('provider',f.provider,'sourceType',f.source_type,
  'sourceReference',f.source_reference,'basis',f.metadata->>'basis') as data
 from public.processing_fee_daily_facts f;
revoke all on public.cv_card_fees from public,anon;
grant select on public.cv_card_fees to authenticated,service_role;


-- Typed order/detail evidence is derived from the immutable raw archive in the
-- same transaction as its capture. Only explicit safe scalar fields are copied;
-- no full guest/check/payment payload is available to the owner-visible table.
create table if not exists public.toast_order_typed_facts (
 raw_record_id uuid primary key references public.toast_raw_records(id) on delete cascade,
 business_id uuid not null references public.businesses(id) on delete cascade,
 restaurant_guid uuid, business_date date, order_guid uuid,
 order_duration_seconds bigint,
 check_discounts jsonb not null default '[]'::jsonb,
 item_discounts jsonb not null default '[]'::jsonb,
 item_taxes jsonb not null default '[]'::jsonb,
 modifier_prices jsonb not null default '[]'::jsonb,
 void_details jsonb not null default '[]'::jsonb,
 refund_details jsonb not null default '[]'::jsonb,
 captured_at timestamptz not null default now()
);
create index if not exists toast_order_typed_day_idx
 on public.toast_order_typed_facts(business_id,restaurant_guid,business_date,order_guid);
alter table public.toast_order_typed_facts enable row level security;
revoke all on public.toast_order_typed_facts from public,anon,authenticated;
create policy "owner read" on public.toast_order_typed_facts for select
 to authenticated using(public.scheduling_is_owner(business_id));
grant select on public.toast_order_typed_facts to authenticated;
grant select,insert on public.toast_order_typed_facts to service_role;

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
   v_amt:=case when jsonb_typeof(d->'nonTaxDiscountAmount')='number'
      then d->>'nonTaxDiscountAmount'
      when jsonb_typeof(d->'discountAmount')='number'
      then d->>'discountAmount' else null end;
   value_cents:=case when v_amt is not null and abs(v_amt::numeric)<100000000
    then round(v_amt::numeric*100)::bigint else null end;
   check_ds:=check_ds||jsonb_build_array(jsonb_build_object('checkGuid',check_guid,
    'name',left(d->>'name',200),'amountCents',value_cents));
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
   v_amt:=case when jsonb_typeof(s->'tax')='number' then s->>'tax' else null end;
   value_cents:=case when v_amt is not null and abs(v_amt::numeric)<100000000
    then round(v_amt::numeric*100)::bigint else null end;
   tax_items:=tax_items||jsonb_build_array(jsonb_build_object(
    'selectionGuid',selection_guid,'taxAmountCents',value_cents,
    'taxRate',case when jsonb_typeof(s->'taxRate')='number' then s->'taxRate' else null end));
   for d in select value from jsonb_array_elements(
    case when jsonb_typeof(s->'appliedDiscounts')='array'
     then s->'appliedDiscounts' else '[]'::jsonb end)
   loop
    v_amt:=case when jsonb_typeof(d->'discountAmount')='number' then d->>'discountAmount'
     when jsonb_typeof(d->'nonTaxDiscountAmount')='number'
      then d->>'nonTaxDiscountAmount' else null end;
    value_cents:=case when v_amt is not null and abs(v_amt::numeric)<100000000
     then round(v_amt::numeric*100)::bigint else null end;
    item_ds:=item_ds||jsonb_build_array(jsonb_build_object(
      'checkGuid',check_guid,'selectionGuid',selection_guid,
      'name',left(d->>'name',200),'amountCents',value_cents));
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
  raw_record_id,business_id,restaurant_guid,business_date,order_guid,
  order_duration_seconds,check_discounts,item_discounts,item_taxes,
  modifier_prices,void_details,refund_details)
 values(v_raw.id,v_raw.business_id,v_raw.restaurant_guid,v_raw.business_date,v_raw.entity_guid,
  duration,check_ds,item_ds,tax_items,mods,voids,refunds)
 on conflict(raw_record_id) do nothing;
 return;
end $typed$;
revoke all on function public.toast_capture_typed_order(uuid) from public,anon,authenticated;
grant execute on function public.toast_capture_typed_order(uuid) to service_role;

create or replace function public.toast_capture_typed_order_trigger()
returns trigger language plpgsql security definer set search_path=public as $trigger$
begin
 perform public.toast_capture_typed_order(new.id);
 return new;
end $trigger$;
revoke all on function public.toast_capture_typed_order_trigger() from public,anon,authenticated;
drop trigger if exists toast_raw_order_typed_capture on public.toast_raw_records;
create trigger toast_raw_order_typed_capture
 after insert on public.toast_raw_records
 for each row when (v_raw.entity='order')
 execute function public.toast_capture_typed_order_trigger();

-- Migration 111 may already hold historical raw rows. Build their typed
-- projections without changing the immutable raw evidence or current sales.
select public.toast_capture_typed_order(id) from public.toast_raw_records
 where entity='order' and not exists(select 1 from public.toast_order_typed_facts f
  where f.raw_record_id=toast_raw_records.id);


-- Exactly provider-reported regular/overtime hours, never calculated from a
-- guessed break or clock-out. Original hourly wage remains in integer cents.
alter table public.toast_labor_entries
 add column if not exists provider_regular_hours numeric,
 add column if not exists provider_overtime_hours numeric;
alter table public.toast_open_labor_summaries
 add column if not exists provider_regular_hours numeric,
 add column if not exists provider_overtime_hours numeric;

CREATE OR REPLACE FUNCTION toast_stage_labor_entries(p_business_id uuid,p_restaurant_guid uuid,
 p_location_id uuid,p_rows jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n integer;
BEGIN
 IF jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows)>100
 OR NOT EXISTS (SELECT 1 FROM toast_location_mappings WHERE business_id=p_business_id
  AND restaurant_guid=p_restaurant_guid AND location_id=p_location_id AND verified_at IS NOT NULL)
 THEN RAISE EXCEPTION 'invalid labor batch'; END IF;
 INSERT INTO toast_labor_entries(
  business_id,restaurant_guid,location_id,external_time_entry_id,external_employee_id,
  clock_in,clock_out,hourly_wage_cents,wage_status,breaks,deleted,provider_modified_at,fetched_at,
  provider_regular_hours,provider_overtime_hours)
 SELECT p_business_id,p_restaurant_guid,p_location_id,t.external_time_entry_id,t.external_employee_id,
  t.clock_in,t.clock_out,t.hourly_wage_cents,t.wage_status,t.breaks,t.deleted,
  t.provider_modified_at,now(),t.provider_regular_hours,t.provider_overtime_hours
 FROM jsonb_to_recordset(p_rows) AS t (
  external_time_entry_id uuid,external_employee_id uuid,clock_in timestamptz,clock_out timestamptz,
  hourly_wage_cents bigint,wage_status text,breaks jsonb,deleted boolean,provider_modified_at timestamptz,
  provider_regular_hours numeric,provider_overtime_hours numeric)
 ON CONFLICT (business_id,restaurant_guid,external_time_entry_id) DO UPDATE SET
  external_employee_id=EXCLUDED.external_employee_id,clock_in=EXCLUDED.clock_in,
  clock_out=EXCLUDED.clock_out,hourly_wage_cents=EXCLUDED.hourly_wage_cents,
  wage_status=EXCLUDED.wage_status,breaks=EXCLUDED.breaks,deleted=EXCLUDED.deleted,
  provider_modified_at=EXCLUDED.provider_modified_at,fetched_at=now(),
  provider_regular_hours=EXCLUDED.provider_regular_hours,
  provider_overtime_hours=EXCLUDED.provider_overtime_hours
 WHERE (EXCLUDED.provider_modified_at IS NOT NULL AND
      (toast_labor_entries.provider_modified_at IS NULL OR
       EXCLUDED.provider_modified_at>=toast_labor_entries.provider_modified_at))
 OR (EXCLUDED.provider_modified_at IS NULL AND toast_labor_entries.provider_modified_at IS NULL);
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN n;
END $$;

create or replace function public.toast_sync_open_labor_summary()
returns trigger language plpgsql security definer set search_path=public as $summary$
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only';end if;
 insert into public.toast_open_labor_summaries(
  business_id,restaurant_guid,external_time_entry_id,external_employee_id,
  clock_in,clock_out,hourly_wage_cents,wage_status,status,provider_regular_hours,provider_overtime_hours)
 values(new.business_id,new.restaurant_guid,new.external_time_entry_id,
  new.external_employee_id,new.clock_in,new.clock_out,
  case when new.clock_out is null or new.wage_status='missing'
   then null else new.hourly_wage_cents end,new.wage_status,
  case when new.clock_out is null then 'open'
   when new.wage_status='missing' then 'needs_match' else 'actual' end,
  new.provider_regular_hours,new.provider_overtime_hours)
 on conflict (business_id,restaurant_guid,external_time_entry_id) do update
 set external_employee_id=excluded.external_employee_id,clock_in=excluded.clock_in,
  clock_out=excluded.clock_out,hourly_wage_cents=excluded.hourly_wage_cents,
  wage_status=excluded.wage_status,status=excluded.status,
  provider_regular_hours=excluded.provider_regular_hours,
  provider_overtime_hours=excluded.provider_overtime_hours;
 return new;
end $summary$;

create or replace view public.cv_labor_entries (business_id,source,source_ref,status,business_date,data,regular_hours,overtime_hours,hourly_wage_cents)
with (security_invoker=true) as
 select t.business_id,
 case when coalesce(t.pos_timecard_id,'') like 'toast:%' then 'toast' else 'app' end::text as source,
 'timecard:'||t.id::text as source_ref,
 case when t.clock_out is null then 'open'
  when t.wage_source='estimate' then 'estimated'
  when t.wage_source='unknown' or t.hourly_wage_cents is null then 'needs_match'
  else 'actual' end::text as status,
 (t.clock_in at time zone b.timezone)::date as business_date,
 jsonb_build_object('id',t.id,'employee_id',t.employee_id,
  'clock_in',t.clock_in,'clock_out',t.clock_out,
  'hourly_wage_cents',t.hourly_wage_cents,'wage_source',t.wage_source,
  'pos_timecard_id',t.pos_timecard_id,'regular_minutes',to_jsonb(t)->'regular_minutes',
  'overtime_minutes',to_jsonb(t)->'overtime_minutes') as data,
  (select l.provider_regular_hours from public.toast_open_labor_summaries l
   where l.business_id=t.business_id and
    t.pos_timecard_id='toast:'||l.restaurant_guid::text||':'||l.external_time_entry_id::text limit 1),
  (select l.provider_overtime_hours from public.toast_open_labor_summaries l
   where l.business_id=t.business_id and
    t.pos_timecard_id='toast:'||l.restaurant_guid::text||':'||l.external_time_entry_id::text limit 1),
  t.hourly_wage_cents
 from public.timecards t join public.businesses b on b.id=t.business_id
 union all
 select s.business_id,'toast'::text,
 'staged-timecard:'||s.restaurant_guid::text||':'||s.external_time_entry_id::text,
 case when s.clock_out is null then 'open'
  when s.wage_status='missing' then 'needs_match' else 'actual' end::text,
 (s.clock_in at time zone b.timezone)::date,
 jsonb_build_object('employee_guid',s.external_employee_id,
  'clock_in',s.clock_in,'clock_out',s.clock_out,
  'hourly_wage_cents',s.hourly_wage_cents,'wage_status',s.wage_status,
  'regularHours',s.provider_regular_hours,'overtimeHours',s.provider_overtime_hours),
 s.provider_regular_hours,s.provider_overtime_hours,s.hourly_wage_cents
 from public.toast_open_labor_summaries s
 join public.businesses b on b.id=s.business_id
 where not exists(select 1 from public.timecards t
   where t.business_id=s.business_id
    and t.pos_timecard_id='toast:'||s.restaurant_guid::text||':'||s.external_time_entry_id::text);


-- Only typed evidence from the last COMMITTED import is projected as current;
-- staging for a failed or in-flight repull remains historical, not certified.
create or replace view public.toast_current_typed_order_facts_v
with (security_invoker=true) as
 select distinct on (t.business_id,t.restaurant_guid,t.business_date,t.order_guid)
  t.business_id,t.restaurant_guid,t.business_date,t.order_guid,
  t.order_duration_seconds,t.check_discounts,t.item_discounts,
  t.item_taxes,t.modifier_prices,t.void_details,t.refund_details
 from public.toast_order_typed_facts t
 join public.toast_raw_records raw on raw.id=t.raw_record_id
 join public.toast_day_status day on day.business_id=t.business_id
  and day.restaurant_guid=t.restaurant_guid
  and day.business_date=t.business_date
  and day.import_state='imported' and day.last_import_run_id=raw.run_id
 order by t.business_id,t.restaurant_guid,t.business_date,t.order_guid,
  raw.first_seen desc,raw.id desc;
revoke all on public.toast_current_typed_order_facts_v from public,anon;
grant select on public.toast_current_typed_order_facts_v to authenticated,service_role;

create or replace view public.cv_item_sales (business_id,source,source_ref,status,business_date,net_sales_cents,quantity,data,order_duration_seconds,item_taxes,modifier_prices) with (security_invoker=true) as
 select o.business_id,
 case when o.pos_order_id like 'toast:%' then 'toast' else 'app' end::text as source,
 'line:'||l.id::text as source_ref,'actual'::text as status,
 o.business_date,l.net_sales_cents,l.quantity as quantity,
 jsonb_build_object('order_id',o.id,'menu_item_id',l.menu_item_id,
  'pos_item_id',l.pos_item_id,'name',l.name,'category',l.category,
  'quantity',l.quantity,'net_sales_cents',l.net_sales_cents,
  'modifiers',l.modifiers,'voided',l.voided) as data,
 t.order_duration_seconds,t.item_taxes,t.modifier_prices
 from public.order_lines l join public.orders o on o.id=l.order_id
 left join public.toast_current_typed_order_facts_v t
  on t.business_id=o.business_id and t.business_date=o.business_date
  and t.order_guid::text=regexp_replace(o.pos_order_id,'^toast:[^:]+:','')
  and t.restaurant_guid::text=split_part(o.pos_order_id,':',2)
 where o.toast_excluded is not true and o.superseded_by is null
 union all
 select m.business_id,'toast'::text,'modified-order:'||m.restaurant_guid::text||':'||m.order_guid::text,
  'needs_match'::text,(m.last_checked_at at time zone b.timezone)::date,
  null::bigint,null::numeric,
  jsonb_build_object('kind','modified_order','order_guid',m.order_guid,
   'reviewed_at',m.last_checked_at,'staging_state',m.state)
 from public.toast_modified_orders_staging m
 join public.businesses b on b.id=m.business_id
 where m.state='review_required';


create or replace view public.cv_discounts (business_id,source,source_ref,status,business_date,amount_cents,data,check_discounts,item_discounts) with (security_invoker=true) as
 select o.business_id,case when o.pos_order_id like 'toast:%' then 'toast' else 'app' end::text as source,
 'order:'||o.id::text as source_ref,'actual'::text as status,
 o.business_date,o.discounts_cents as amount_cents,
 jsonb_build_object('amount_cents',o.discounts_cents,'order_id',o.id) as data,
 t.check_discounts,t.item_discounts
 from public.orders o
 left join public.toast_current_typed_order_facts_v t
  on t.business_id=o.business_id and t.business_date=o.business_date
  and t.order_guid::text=regexp_replace(o.pos_order_id,'^toast:[^:]+:','')
  and t.restaurant_guid::text=split_part(o.pos_order_id,':',2)
 where coalesce(o.discounts_cents,0)<>0 and o.toast_excluded is not true
 and o.superseded_by is null;


create or replace view public.cv_voids_refunds (business_id,source,source_ref,status,business_date,amount_cents,data,provider_details) with (security_invoker=true) as
 select v.business_id,'toast'::text as source,
 'void:'||v.selection_guid::text as source_ref,
 case when v.amount_cents is null then 'open' else 'actual' end::text as status,
 v.void_business_date as business_date,v.amount_cents,
 jsonb_build_object('kind','void','level',v.level,'amount_cents',v.amount_cents,
   'amount_basis',v.amount_basis,'order_guid',v.order_guid,'void_reason_guid',v.void_reason_guid) as data,
 (select t.void_details from public.toast_current_typed_order_facts_v t
  where t.business_id=v.business_id and t.order_guid=v.order_guid
   and t.business_date=v.order_business_date limit 1) as provider_details
 from public.toast_void_facts v
 union all
 select f.business_id,'toast'::text,'refund:'||f.id::text,'actual'::text,
 coalesce(f.refund_business_date,f.order_business_date),f.amount_cents,
 jsonb_build_object('kind','refund','amount_cents',f.amount_cents,
   'order_guid',f.order_guid,'payment_guid',f.payment_guid),
 (select t.refund_details from public.toast_current_typed_order_facts_v t
  where t.business_id=f.business_id and t.restaurant_guid=f.restaurant_guid
   and t.order_guid=f.order_guid and t.business_date=f.order_business_date limit 1)
 from public.toast_refund_facts f;

