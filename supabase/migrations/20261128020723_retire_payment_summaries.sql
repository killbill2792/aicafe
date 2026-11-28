-- Reason: Move unmatched history before removing the old closeout writer and its table.
-- squawk-ignore transaction-nesting
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
lock table public.toast_payment_summaries in access exclusive mode;

-- Only discard the duplicate when the exact payment in an already attributed
-- original reconstructs all previously stored fields.
with scopes as materialized (
 select distinct business_id,restaurant_guid,business_date from public.toast_payment_summaries
), originals as materialized (
 select r.business_id,r.restaurant_guid,r.business_date,x.payment->>'guid' as ref,x.payment,
 count(*) over(partition by r.business_id,r.restaurant_guid,r.business_date,x.payment->>'guid') as matches
 from scopes s join public.toast_day_status d using(business_id,restaurant_guid,business_date)
 join public.external_records r using(business_id,restaurant_guid,business_date)
 cross join lateral public.toast_order_payment_members(r.payload) x
 where r.provider='toast' and r.entity='order' and r.superseded_by is null
   and r.source_account=r.restaurant_guid::text and r.source_key=r.entity_guid::text
   and r.payload_origin in ('provider','historical_provider') and d.import_state='imported'
   and (r.run_id=d.last_import_run_id or r.seen_run_id=d.last_import_run_id)
   and public.toast_uuid_or_null(x.payment->>'guid')::text=x.payment->>'guid'
), historical as (
 select s.*,to_jsonb(s)-array['business_id','restaurant_guid','business_date'] as body
 from public.toast_payment_summaries s
 where not exists(select from originals o
  where (o.business_id,o.restaurant_guid,o.business_date,o.ref)=(s.business_id,s.restaurant_guid,s.business_date,s.payment_ref)
   and o.matches=1 and (s.payment_type,s.payment_status,s.amount_cents,s.tip_cents,s.status,s.server_guid,s.paid_at)
   is not distinct from (left(o.payment->>'type',80),left(o.payment->>'paymentStatus',80),
    case when jsonb_typeof(o.payment->'amount')='number' then round((o.payment->>'amount')::numeric*100)::bigint end,
    case when jsonb_typeof(o.payment->'tipAmount')='number' then round((o.payment->>'tipAmount')::numeric*100)::bigint end,
    case when jsonb_typeof(o.payment->'amount')='number' then 'actual' else 'open' end,
    public.toast_uuid_or_null(o.payment#>>'{server,guid}'),public.toast_time_or_null(o.payment->>'paidDate')))
)
insert into public.external_records(business_id,provider,source_account,entity,source_key,restaurant_guid,
 business_date,payload,payload_sha256,capture_key,payload_origin)
select business_id,'toast',restaurant_guid::text,'legacy/payment-summary',payment_ref,restaurant_guid,
 business_date,body,encode(sha256(convert_to(body::text,'UTF8')),'hex'),
 'legacy/payment-summary:'||encode(sha256(convert_to(jsonb_build_array(restaurant_guid,business_date,payment_ref)::text,'UTF8')),'hex'),
 'historical_projection' from historical;

-- An unresolved order still carries real provider payment evidence. Attest its
-- committed page identity without inventing an order GUID or certifying sales.
create or replace function public.toast_archive_page(
 p_run_id uuid,p_business_date date,p_page integer,p_payload jsonb,p_commit boolean
) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare it record;
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only'; end if;
 for it in select * from public.toast_archive_items(p_run_id,p_business_date,p_page,p_payload) loop
  continue when it.business_id is null;
  if it.entity_guid is null then
   insert into public.toast_raw_records as r(business_id,restaurant_guid,entity,entity_guid,
    business_date,payload,payload_sha256,run_id,seen_run_id,source_page,source_index,capture_key,source_account,source_key)
   values(it.business_id,it.restaurant_guid,it.entity,null,p_business_date,it.payload,it.sha,
    p_run_id,p_run_id,p_page,it.source_index,it.capture_key,
    case when p_commit then it.restaurant_guid::text end,case when p_commit then it.capture_key end)
   on conflict (business_id,capture_key) do update set source_account=excluded.source_account,source_key=excluded.source_key
    where p_commit and r.source_account is null and r.payload_sha256=excluded.payload_sha256;
  else
   perform public.toast_archive_order(it.business_id,it.restaurant_guid,it.entity_guid,
    p_business_date,it.payload,it.sha,p_run_id,p_page,it.source_index,it.capture_key,p_commit);
  end if;
 end loop;
end $$;

-- Keep the active importer and historical line-repair functions. Remove only
-- their calls and writes to the payment copy, and fail on an unexpected body.
do $replace$
declare importer text; line_fill text;
 old_writer constant text:=$writer$ perform public.toast_rebuild_day_payments(p_run_id,p_business_id,p_restaurant_guid,p_business_date,
  coalesce((p_summary->>'unparsed_count')::integer,0)=0);
$writer$;
begin
 importer:=pg_get_functiondef('public.toast_import_day(uuid,uuid,uuid,date,jsonb,jsonb,uuid)'::regprocedure);
 if strpos(importer,old_writer)=0 then raise exception 'Unexpected Toast closeout writer'; end if;
 execute replace(importer,old_writer,'');
 line_fill:=pg_get_functiondef('public.toast_fill_organized_fields(integer)'::regprocedure);
 if strpos(line_fill,'if p_step=1 then')=0 or strpos(line_fill,'elsif p_step=2 then')=0
  then raise exception 'Unexpected Toast historical line repair'; end if;
 line_fill:=regexp_replace(line_fill,'if p_step=1 then.*?elsif p_step=2 then','if p_step=2 then');
 execute replace(replace(line_fill,'between 1 and 4','between 2 and 4'),'1 to 4','2 to 4');
end $replace$;

create or replace function public.toast_fill_organized_fields()
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 for s in 2..4 loop perform public.toast_fill_organized_fields(s); end loop;
end $$;

-- Reason: Closeout uses the retained order and the reader retains unmatched history.
-- squawk-ignore ban-drop-function
drop function public.toast_rebuild_day_payments(uuid,uuid,uuid,date,boolean);
-- Reason: Every remaining reader uses the shared archive and the historical fields have been preserved.
-- squawk-ignore ban-drop-table
drop table public.toast_payment_summaries;
-- Reason: Complete the archive cutover and legacy retirement together.
-- squawk-ignore transaction-nesting
commit;
