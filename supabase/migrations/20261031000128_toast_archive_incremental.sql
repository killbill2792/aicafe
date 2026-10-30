-- Toast archive: save only new or changed records.
--
-- Every re-import of a business day archived every order, check and payment
-- again, because each archived row belonged to the import run that fetched it
-- (the capture key contains the run id). One café's archive reached ~577 MB of
-- mostly identical copies and the database ran out of disk budget.
--
-- Now a record is identified by its Toast GUID and exact content (sha256 of
-- the redacted payload). Content Toast already gave us is never stored again:
--  * When a page is staged, unchanged records are only marked "seen" by that
--    run (seen_run_id); new or changed records are inserted as before.
--  * When the day import commits (toast_archive_day_pages, same transaction),
--    unchanged records move to the committed run (run_id), so every reader
--    that selects "the latest import's records" sees the complete day.
--  * The card-fee trigger fires before that commit step, so it reads records
--    either created by or seen by the latest import.
-- A failed or abandoned import never moves run_id, so the previous good import
-- stays complete. Every distinct version Toast sends is still kept.

alter table public.toast_raw_records add column if not exists seen_run_id uuid;

-- One row per archived item of a staged page: same keys and hashes as
-- migrations 120/126 (orders, nested checks, nested payments).
create or replace function public.toast_archive_items(
 p_run_id uuid,p_business_date date,p_page integer,p_payload jsonb
) returns table(
 business_id uuid,restaurant_guid uuid,entity text,entity_guid uuid,
 payload jsonb,sha text,source_index integer,capture_key text
) language sql stable security definer set search_path=public as $items$
 with run as (
  select s.business_id,s.restaurant_guid from public.toast_sync_runs s where s.id=p_run_id
 ), orders as (
  select o.raw,o.idx from jsonb_array_elements(
   case when jsonb_typeof(p_payload)='array' then p_payload else '[]'::jsonb end
  ) with ordinality as o(raw,idx)
 ), checks as (
  select o.idx as o_idx,c.raw,c.idx as c_idx from orders o
  cross join lateral jsonb_array_elements(case when jsonb_typeof(o.raw->'checks')='array'
   then o.raw->'checks' else '[]'::jsonb end) with ordinality as c(raw,idx)
 ), payments as (
  select c.o_idx,c.c_idx,p.raw,p.idx as p_idx from checks c
  cross join lateral jsonb_array_elements(case when jsonb_typeof(c.raw->'payments')='array'
   then c.raw->'payments' else '[]'::jsonb end) with ordinality as p(raw,idx)
 ), all_items as (
  select 'order'::text as entity,o.raw,o.idx::integer as source_index,
   'page:'||p_run_id::text||':'||p_business_date::text||':'||p_page::text||':'||o.idx::text as key_prefix
  from orders o
  union all
  select 'check',c.raw,c.o_idx::integer,
   'check:'||p_run_id::text||':'||p_business_date::text||':'||p_page::text||':'||c.o_idx::text||':'||c.c_idx::text
  from checks c
  union all
  select 'payment',p.raw,p.o_idx::integer,
   'payment:'||p_run_id::text||':'||p_business_date::text||':'||p_page::text||':'||p.o_idx::text||':'||p.c_idx::text||':'||p.p_idx::text
  from payments p
 )
 select run.business_id,run.restaurant_guid,a.entity,
  case when a.raw->>'guid' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   then (a.raw->>'guid')::uuid else null end,
  a.raw,h.sha,a.source_index,a.key_prefix||':'||h.sha
 from all_items a
 cross join run
 cross join lateral (select encode(sha256(convert_to(a.raw::text,'UTF8')),'hex') as sha) h;
$items$;
revoke all on function public.toast_archive_items(uuid,date,integer,jsonb) from public,anon,authenticated;
grant execute on function public.toast_archive_items(uuid,date,integer,jsonb) to service_role;

-- p_commit=false: staging (page insert/update/delete triggers).
-- p_commit=true: the day import transaction (toast_archive_day_pages).
create or replace function public.toast_archive_page(
 p_run_id uuid,p_business_date date,p_page integer,p_payload jsonb,p_commit boolean
) returns void language plpgsql security definer set search_path=public as $archive$
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only'; end if;
 -- Unchanged records: mark them seen by this run; on commit, move them to it.
 with items as (
  select * from public.toast_archive_items(p_run_id,p_business_date,p_page,p_payload) i
  where i.entity_guid is not null
 ), moved as (
  update public.toast_raw_records r set
   seen_run_id=p_run_id,last_seen=now(),
   run_id=case when p_commit then p_run_id else r.run_id end,
   source_page=case when p_commit then p_page else r.source_page end,
   source_index=case when p_commit then i.source_index else r.source_index end
  from items i
  where r.business_id=i.business_id and r.restaurant_guid is not distinct from i.restaurant_guid
   and r.business_date=p_business_date and r.entity=i.entity
   and r.entity_guid=i.entity_guid and r.payload_sha256=i.sha
   and (r.seen_run_id is distinct from p_run_id or (p_commit and r.run_id is distinct from p_run_id))
  returning r.id,r.entity
 )
 update public.toast_order_typed_facts t set run_id=p_run_id
 from moved m
 where p_commit and m.entity='order' and t.raw_record_id=m.id
  and t.run_id is distinct from p_run_id;
 -- New or changed records (and records without a GUID, which cannot be
 -- matched) are inserted exactly as before.
 insert into public.toast_raw_records(
  business_id,restaurant_guid,entity,entity_guid,business_date,payload,
  payload_sha256,run_id,seen_run_id,source_page,source_index,capture_key)
 select i.business_id,i.restaurant_guid,i.entity,i.entity_guid,p_business_date,i.payload,
  i.sha,p_run_id,p_run_id,p_page,i.source_index,i.capture_key
 from (
  select distinct on (x.entity,coalesce(x.entity_guid::text,x.capture_key),x.sha) x.*
  from public.toast_archive_items(p_run_id,p_business_date,p_page,p_payload) x
  order by x.entity,coalesce(x.entity_guid::text,x.capture_key),x.sha,x.capture_key
 ) i
 where i.business_id is not null and (i.entity_guid is null or not exists(
  select 1 from public.toast_raw_records r
  where r.business_id=i.business_id and r.restaurant_guid is not distinct from i.restaurant_guid
   and r.business_date=p_business_date and r.entity=i.entity
   and r.entity_guid=i.entity_guid and r.payload_sha256=i.sha))
 on conflict (business_id,capture_key) do nothing;
end $archive$;
revoke all on function public.toast_archive_page(uuid,date,integer,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.toast_archive_page(uuid,date,integer,jsonb,boolean) to service_role;

-- Same signature the page triggers already call: staging mode.
create or replace function public.toast_archive_page(
 p_run_id uuid,p_business_date date,p_page integer,p_payload jsonb
) returns void language plpgsql security definer set search_path=public as $archive$
begin
 perform public.toast_archive_page(p_run_id,p_business_date,p_page,p_payload,false);
end $archive$;
revoke all on function public.toast_archive_page(uuid,date,integer,jsonb) from public,anon,authenticated;
grant execute on function public.toast_archive_page(uuid,date,integer,jsonb) to service_role;

-- Called by toast_import_day in the committing transaction: commit mode.
create or replace function public.toast_archive_day_pages(
 p_run_id uuid,p_business_date date
) returns void language plpgsql security definer set search_path=public as $archive$
declare p record;
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only'; end if;
 for p in select page,payload from public.toast_day_pages
  where run_id=p_run_id and business_date=p_business_date order by page
 loop
  perform public.toast_archive_page(p_run_id,p_business_date,p.page,p.payload,true);
 end loop;
end $archive$;
revoke all on function public.toast_archive_day_pages(uuid,date) from public,anon,authenticated;
grant execute on function public.toast_archive_day_pages(uuid,date) to service_role;

-- Card fees: identical to migration 113 except it also reads payments that the
-- latest import saw unchanged (they keep their earlier row).
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
   and business_date=new.business_date
   and (run_id=new.last_import_run_id or seen_run_id=new.last_import_run_id)
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
revoke all on function public.toast_refresh_typed_payment_facts() from public,anon,authenticated;

-- The fee trigger filters by day and then by run or seen run.
create index if not exists toast_raw_records_seen_run_idx
 on public.toast_raw_records (seen_run_id) where seen_run_id is not null;
