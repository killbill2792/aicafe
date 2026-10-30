-- Toast archive: keep each order once, with its checks and payments inside it.
--
-- The archive stored every order three times: the order (which already holds
-- its checks and payments), plus each check and each payment again as their
-- own rows. Nothing in the app or the AI reads those check and payment rows;
-- only the card-fee trigger read the payment rows. From now on:
--  * only the full order is archived (no separate check or payment rows);
--  * the card-fee trigger reads payments from inside the latest import's
--    orders, with the same payment refs and the same fee rules as before.
-- Every field Toast sends is still kept, inside the order. Existing check and
-- payment rows are not deleted here; they can be removed later on their own.

-- Archive items: orders only (same keys and hashes as migration 128).
create or replace function public.toast_archive_items(
 p_run_id uuid,p_business_date date,p_page integer,p_payload jsonb
) returns table(
 business_id uuid,restaurant_guid uuid,entity text,entity_guid uuid,
 payload jsonb,sha text,source_index integer,capture_key text
) language sql stable security definer set search_path=public as $items$
 select s.business_id,s.restaurant_guid,'order'::text,
  case when o.raw->>'guid' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   then (o.raw->>'guid')::uuid else null end,
  o.raw,h.sha,o.idx::integer,
  'page:'||p_run_id::text||':'||p_business_date::text||':'||p_page::text||':'||o.idx::text||':'||h.sha
 from public.toast_sync_runs s
 cross join lateral jsonb_array_elements(
  case when jsonb_typeof(p_payload)='array' then p_payload else '[]'::jsonb end
 ) with ordinality as o(raw,idx)
 cross join lateral (select encode(sha256(convert_to(o.raw::text,'UTF8')),'hex') as sha) h
 where s.id=p_run_id;
$items$;
revoke all on function public.toast_archive_items(uuid,date,integer,jsonb) from public,anon,authenticated;
grant execute on function public.toast_archive_items(uuid,date,integer,jsonb) to service_role;

-- Card fees: same as migration 128 except payments come from inside the orders.
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
 -- Payments are read from inside the latest import's orders (the archive no
 -- longer keeps separate payment rows). Same payment refs as before: the
 -- payment GUID, else its position in the order's import page.
 with orders as (
  select r.payload,r.first_seen,r.run_id,r.source_page,r.source_index
  from public.toast_raw_records r
  where r.business_id=new.business_id and r.restaurant_guid=new.restaurant_guid
   and r.business_date=new.business_date and r.entity='order'
   and (r.run_id=new.last_import_run_id or r.seen_run_id=new.last_import_run_id)
 ), pays as (
  select coalesce(
    case when p.raw->>'guid' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     then ((p.raw->>'guid')::uuid)::text end,
    'payment:'||o.run_id::text||':'||new.business_date::text||':'||o.source_page::text||':'||
     o.source_index::text||':'||c.idx::text||':'||p.idx::text) as ref,
   p.raw as payload,o.first_seen
  from orders o
  cross join lateral jsonb_array_elements(case when jsonb_typeof(o.payload->'checks')='array'
   then o.payload->'checks' else '[]'::jsonb end) with ordinality as c(raw,idx)
  cross join lateral jsonb_array_elements(case when jsonb_typeof(c.raw->'payments')='array'
   then c.raw->'payments' else '[]'::jsonb end) with ordinality as p(raw,idx)
 ), raw as (
  select distinct on (ref) ref,payload,first_seen from pays
  order by ref,first_seen desc
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
