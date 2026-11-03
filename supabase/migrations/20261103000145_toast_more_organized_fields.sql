-- More organized Toast fields (AGENTS.md §4b, docs/plans/toast-storage.md step 6).
-- Every field below was already kept in the raw archive; now the app and the AI can
-- read it from the organized tables. Additive only: new nullable columns.
--  * order_lines.ordered_at, fulfillment_status: when each item was rung up and its
--    kitchen status (Toast selection createdDate, fulfillmentStatus).
--  * toast_payment_summaries.server_guid, paid_at: who took each payment and when
--    (Toast payment server.guid, paidDate).
--  * orders.service_charges_cents, gratuity_cents: service charges and gratuity on the
--    order, with the same rule as the day totals (fundraising excluded).
-- (Sales category was already on order_lines.category.)
-- History is filled by toast_fill_organized_fields(), run once on its own after this
-- migration (see the end of this file). Item lines written before migration 141 first get
-- their Toast line ID where the match is certain.

-- Safe casts for Toast text: null instead of an error for a malformed value.
create or replace function public.toast_uuid_or_null(v text) returns uuid
language sql immutable set search_path=public as $u$
 select case when v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v::uuid end
$u$;
create or replace function public.toast_time_or_null(v text) returns timestamptz
language plpgsql stable set search_path=public as $t$
begin
 if v is null or v !~ '^\d{4}-\d{2}-\d{2}T' then return null; end if;
 return v::timestamptz;
exception when others then return null;
end $t$;

-- 1. Columns.
alter table public.order_lines add column if not exists ordered_at timestamptz,
 add column if not exists fulfillment_status text;
alter table public.toast_payment_summaries add column if not exists server_guid uuid,
 add column if not exists paid_at timestamptz;
alter table public.orders add column if not exists service_charges_cents bigint,
 add column if not exists gratuity_cents bigint;

-- 2. Day import (migration 141) also writes item timing and order service charges.
--    Only the order insert/update and the order-line insert differ from 141.
create or replace function public.toast_import_day(
 p_business_id uuid,p_location_id uuid,p_restaurant_guid uuid,
 p_business_date date,p_orders jsonb,p_summary jsonb,p_run_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
 rec jsonb;ln jsonb;v_id uuid;v_item uuid;v_prefix text;
 v_before bigint;v_new bigint;v_net bigint;v_count integer;v_old record;
 v_unparsed_known integer;v_unparsed_cents bigint;v_unparsed_count integer;
 v_coverage_complete boolean;v_eligible_locations integer;v_complete_locations integer;
begin
 if auth.role()<>'service_role'
 or jsonb_typeof(p_orders)<>'array' or jsonb_typeof(p_summary)<>'object'
 or jsonb_typeof(p_summary->'voids')<>'array'
 or jsonb_typeof(p_summary->'unparsed')<>'array'
 or jsonb_array_length(p_orders)>30000
 or not exists(select 1 from public.toast_location_mappings where business_id=p_business_id
  and location_id=p_location_id and restaurant_guid=p_restaurant_guid and verified_at is not null)
 or not exists(select 1 from public.toast_sync_runs where id=p_run_id and business_id=p_business_id
  and restaurant_guid=p_restaurant_guid and state in ('queued','running','paused_rate_limited'))
 then raise exception 'invalid Toast import';end if;
 -- Serialize ALL mapped locations for one business day before touching the shared rollup.
 perform pg_advisory_xact_lock(hashtextextended('toast-day:'||p_business_id::text||':'||p_business_date::text,0));
 v_prefix:='toast:'||p_restaurant_guid::text||':';
 if exists(select 1 from jsonb_array_elements(p_orders) e
   where e->>'posOrderId' not like v_prefix||'%' or jsonb_typeof(e->'lines')<>'array'
     or (e->>'netSalesCents')::bigint is null)
 then raise exception 'invalid Toast order rows';end if;
 if (select count(distinct e->>'posOrderId') from jsonb_array_elements(p_orders)e)
   <>jsonb_array_length(p_orders) then raise exception 'duplicate Toast orders';end if;
 for rec in select value from jsonb_array_elements(p_orders) loop
  select id,net_sales_cents into v_id,v_before from public.orders
  where business_id=p_business_id and pos_order_id=rec->>'posOrderId' for update;
  v_new:=(rec->>'netSalesCents')::bigint;
  if v_id is not null and v_before is distinct from v_new then
   insert into public.toast_order_revisions(business_id,restaurant_guid,business_date,
    pos_order_id,before_cents,after_cents,run_id)
   values(p_business_id,p_restaurant_guid,p_business_date,rec->>'posOrderId',v_before,v_new,p_run_id);
  end if;
  insert into public.orders(business_id,location_id,pos_order_id,closed_at,business_date,
    gross_sales_cents,discounts_cents,refunds_cents,tax_cents,tip_cents,
    processing_fee_cents,processing_fee_status,processing_fee_provider,net_sales_cents,toast_excluded,
    employee_id,dining_option,source_channel,guest_count,service_charges_cents,gratuity_cents)
  values(p_business_id,p_location_id,rec->>'posOrderId',(rec->>'closedAt')::timestamptz,p_business_date,
    (rec->>'grossSalesCents')::bigint,(rec->>'discountsCents')::bigint,
    (rec->>'refundsCents')::bigint,(rec->>'taxCents')::bigint,
    (rec->>'tipCents')::bigint,0,'missing','toast',v_new,false,
    (select e.id from public.employees e
     where e.business_id=p_business_id and (
      e.pos_team_member_id='toast:'||p_restaurant_guid::text||':'||(rec->>'posEmployeeId')
      or e.id in (
       select d.linked_employee_id from public.toast_employee_directory d
       where d.business_id=p_business_id and d.restaurant_guid=p_restaurant_guid
        and d.employee_guid::text=rec->>'posEmployeeId' and d.deleted=false
        and d.linked_employee_id is not null))
     order by e.id limit 1),
    nullif(left(rec->>'diningOption',80),''),
    nullif(left(rec->>'sourceChannel',80),''),
    case when (rec->>'guestCount')~'^[0-9]{1,5}$' and
      (rec->>'guestCount')::integer<=32767
      then (rec->>'guestCount')::smallint else null end,
    case when jsonb_typeof(rec->'serviceChargesCents')='number' then (rec->>'serviceChargesCents')::bigint end,
    case when jsonb_typeof(rec->'gratuityCents')='number' then (rec->>'gratuityCents')::bigint end)
  on conflict(business_id,pos_order_id) do update
   set location_id=excluded.location_id,closed_at=excluded.closed_at,business_date=excluded.business_date,
   gross_sales_cents=excluded.gross_sales_cents,discounts_cents=excluded.discounts_cents,
   refunds_cents=excluded.refunds_cents,tax_cents=excluded.tax_cents,tip_cents=excluded.tip_cents,
   net_sales_cents=excluded.net_sales_cents,toast_excluded=false,
   employee_id=excluded.employee_id,dining_option=excluded.dining_option,
   source_channel=excluded.source_channel,guest_count=excluded.guest_count,
   service_charges_cents=excluded.service_charges_cents,gratuity_cents=excluded.gratuity_cents,
   processing_fee_cents=0,processing_fee_status='missing',processing_fee_provider='toast'
  returning id into v_id;
  delete from public.order_lines where order_id=v_id;
  for ln in select value from jsonb_array_elements(rec->'lines') loop
   select id into v_item from public.menu_items where business_id=p_business_id
    and pos_item_id=ln->>'posItemId' order by id limit 1;
   insert into public.order_lines(order_id,menu_item_id,pos_item_id,name,quantity,net_sales_cents,
    modifiers,voided,voided_by,category,pos_line_id,ordered_at,fulfillment_status)
   values(v_id,v_item,ln->>'posItemId',coalesce(ln->>'name','Menu item'),
    (ln->>'quantity')::numeric,(ln->>'netSalesCents')::bigint,
    coalesce(ln->'modifiers','[]'::jsonb),coalesce((ln->>'voided')::boolean,false),
    null,ln->>'category',nullif(ln->>'posLineId',''),
    public.toast_time_or_null(ln->>'orderedAt'),
    nullif(left(ln->>'fulfillmentStatus',40),''));
  end loop;
 end loop;
 -- Soft-remove absent canonical orders; a later full re-pull may restore them.
 for v_old in select id,pos_order_id,net_sales_cents from public.orders
  where business_id=p_business_id and location_id=p_location_id and business_date=p_business_date
  and pos_order_id like v_prefix||'%' and toast_excluded=false
  and (
   (p_summary->>'unparsed_count')::integer=0
   or (p_summary->'parsed_order_guids') ? substring(orders.pos_order_id from length(v_prefix)+1)
  )
  and not exists(select 1 from jsonb_array_elements(p_orders)e where e->>'posOrderId'=orders.pos_order_id)
  for update
 loop
  insert into public.toast_order_revisions(business_id,restaurant_guid,business_date,
   pos_order_id,before_cents,after_cents,run_id)
  values(p_business_id,p_restaurant_guid,p_business_date,v_old.pos_order_id,v_old.net_sales_cents,0,p_run_id);
  update public.orders set toast_excluded=true where id=v_old.id;
  delete from public.order_lines where order_id=v_old.id;
 end loop;
 -- Retain non-Toast data for rollback, but prevent double counted sales.
 update public.orders set superseded_by='toast'
 where business_id=p_business_id and business_date=p_business_date
 and (location_id=p_location_id or (location_id is null and
  (select count(*) from public.locations where business_id=p_business_id)=1))
 and pos_order_id not like 'toast:%'
 and coalesce((select toast_start_date from public.toast_location_mappings
      where business_id=p_business_id and restaurant_guid=p_restaurant_guid),p_business_date)<=p_business_date;
 -- Incomplete pages preserve the unparsed orders' prior void facts, but
 -- *replace* facts for successfully parsed orders, including orders no longer voided.
 if (p_summary->>'unparsed_count')::integer=0 then
  delete from public.toast_void_facts where business_id=p_business_id
   and location_id=p_location_id and order_business_date=p_business_date;
 else
  delete from public.toast_void_facts where business_id=p_business_id
   and location_id=p_location_id and order_business_date=p_business_date
   and order_guid in (select value::uuid from jsonb_array_elements_text(
     coalesce(p_summary->'parsed_order_guids','[]'::jsonb)));
 end if;
 insert into public.toast_void_facts(business_id,location_id,selection_guid,order_guid,
  check_guid,order_business_date,void_business_date,voided_at,amount_cents,
  amount_basis,void_reason_guid,level)
 select p_business_id,p_location_id,x.selection_guid,x.order_guid,x.check_guid,
  x.order_business_date,x.void_business_date,x.voided_at,x.amount_cents,x.amount_basis,
  x.void_reason_guid,x.level
 from jsonb_to_recordset(p_summary->'voids') as x(
  selection_guid uuid,order_guid uuid,check_guid uuid,order_business_date date,
  void_business_date date,voided_at timestamptz,amount_cents bigint,amount_basis text,
  void_reason_guid uuid,level text)
 on conflict(business_id,selection_guid) do update
 set location_id=excluded.location_id,order_guid=excluded.order_guid,
 check_guid=excluded.check_guid,order_business_date=excluded.order_business_date,
 void_business_date=excluded.void_business_date,voided_at=excluded.voided_at,
 amount_cents=excluded.amount_cents,amount_basis=excluded.amount_basis,
 void_reason_guid=excluded.void_reason_guid,level=excluded.level,last_seen=now();
 if (p_summary->>'unparsed_count')::integer=0 then
  delete from public.toast_refund_facts where business_id=p_business_id
   and restaurant_guid=p_restaurant_guid and order_business_date=p_business_date;
 else
  delete from public.toast_refund_facts where business_id=p_business_id
   and restaurant_guid=p_restaurant_guid and order_business_date=p_business_date
   and order_guid in (select value::uuid from jsonb_array_elements_text(
     coalesce(p_summary->'parsed_order_guids','[]'::jsonb)));
 end if;
 -- One row per refunded payment. Two refunds on one payment (or on payments
 -- without a GUID, which fall back to the order GUID) are added together.
 insert into public.toast_refund_facts(business_id,restaurant_guid,order_guid,payment_guid,
  order_business_date,refund_business_date,amount_cents)
 select p_business_id,p_restaurant_guid,x.order_guid,x.payment_guid,
  min(x.order_business_date),max(x.refund_business_date),sum(x.amount_cents)
 from jsonb_to_recordset(p_summary->'refund_facts') as x(
  order_guid uuid,payment_guid uuid,order_business_date date,refund_business_date date,amount_cents bigint)
 group by x.order_guid,x.payment_guid
 on conflict(business_id,restaurant_guid,order_guid,payment_guid) do update
 set order_business_date=excluded.order_business_date,
  refund_business_date=excluded.refund_business_date,amount_cents=excluded.amount_cents;
 insert into public.toast_unparsed_orders(business_id,restaurant_guid,business_date,
  raw_sha256,order_guid,error_path)
 select p_business_id,p_restaurant_guid,p_business_date,x.raw_sha256,x.order_guid,x.error_path
 from jsonb_to_recordset(p_summary->'unparsed') as x(order_guid uuid,business_date date,
  error_path text,raw_sha256 text)
 on conflict(business_id,restaurant_guid,business_date,raw_sha256) do update set last_seen=now();

 select coalesce(sum(o.net_sales_cents),0),count(*) into v_net,v_count
 from public.orders o where o.business_id=p_business_id and o.business_date=p_business_date
  and o.pos_order_id like v_prefix||'%' and not o.toast_excluded;
 -- A malformed order has no trusted net amount. Only a previously imported
 -- canonical order provides a defensible upper-bound estimate. Unknown new
 -- orders fail closed; never call them $0 merely to hit the 2% allowance.
 v_unparsed_count:=coalesce((p_summary->>'unparsed_count')::integer,0);
 select count(o.id),coalesce(sum(abs(o.net_sales_cents)),0)
 into v_unparsed_known,v_unparsed_cents
 from jsonb_to_recordset(p_summary->'unparsed') as u(order_guid uuid)
 left join public.orders o on o.business_id=p_business_id
  and o.location_id=p_location_id and o.pos_order_id=v_prefix||u.order_guid::text
  and o.business_date=p_business_date and not o.toast_excluded;
 v_coverage_complete := (
  v_unparsed_known=v_unparsed_count
  and v_unparsed_count*100 <= 2*(jsonb_array_length(p_orders)+v_unparsed_count)
  and v_unparsed_cents*100 <= 2*(abs(v_net)+v_unparsed_cents)
  and coalesce((p_summary->'warnings'->>'missing_check_amount')::integer,0)=0
  and coalesce((p_summary->'warnings'->>'missing_deferred_price')::integer,0)=0
  and coalesce((p_summary->'warnings'->>'missing_refund_amount')::integer,0)=0
 );
 if (p_summary->>'unparsed_count')::integer=0 and
 (v_net<>(p_summary->>'net_sales_cents')::bigint
  or v_count<>(p_summary->>'order_count')::integer)
 then raise exception 'Toast canonical sum mismatch';end if;
 insert into public.toast_day_status(business_id,restaurant_guid,business_date,import_state,
  recon_state,imported_at,net_sales_cents,gross_sales_cents,discounts_cents,refunds_cents,
  tax_cents,tip_cents,order_count,open_check_count,service_charges_cents,
  gratuity_cents,unparsed_count,coverage_complete,warnings,orders_snapshot_sha256,last_import_run_id)
 values(p_business_id,p_restaurant_guid,p_business_date,'imported',
  case when (p_summary->>'unparsed_count')::integer>0 or coalesce((p_summary->'warnings'->>'missing_check_amount')::integer,0)>0
    or coalesce((p_summary->'warnings'->>'missing_deferred_price')::integer,0)>0
    or coalesce((p_summary->'warnings'->>'missing_refund_amount')::integer,0)>0
   then 'mismatch' else 'pending' end,
  now(),v_net,(p_summary->>'gross_sales_cents')::bigint,
  (p_summary->>'discounts_cents')::bigint,(p_summary->>'refunds_cents')::bigint,
  (p_summary->>'tax_cents')::bigint,(p_summary->>'tip_cents')::bigint,
  v_count,(p_summary->>'open_check_count')::integer,
  (p_summary->>'service_charges_cents')::bigint,
  (p_summary->>'gratuity_cents')::bigint,(p_summary->>'unparsed_count')::integer,
  v_coverage_complete,coalesce(p_summary->'warnings','{}'::jsonb),p_summary->>'snapshot_sha256',p_run_id)
 on conflict(business_id,restaurant_guid,business_date) do update
 set import_state='imported',recon_state=excluded.recon_state,imported_at=now(),
  net_sales_cents=excluded.net_sales_cents,gross_sales_cents=excluded.gross_sales_cents,
  discounts_cents=excluded.discounts_cents,refunds_cents=excluded.refunds_cents,
  tax_cents=excluded.tax_cents,tip_cents=excluded.tip_cents,order_count=excluded.order_count,
  open_check_count=excluded.open_check_count,service_charges_cents=excluded.service_charges_cents,
  gratuity_cents=excluded.gratuity_cents,unparsed_count=excluded.unparsed_count,
  coverage_complete=excluded.coverage_complete,warnings=excluded.warnings,orders_snapshot_sha256=excluded.orders_snapshot_sha256,
  last_import_run_id=excluded.last_import_run_id;
 -- The sales numbers and the import-state update share this transaction; avoid
 -- putting verified Toast sales in orders while showing stale daily totals.
 -- Preserve existing payroll, recipe and fee costs until the ordinary rollup
 -- recomputation runs, and never certify missing void coverage from import alone.
 insert into public.daily_rollups(business_id,business_date,net_sales_cents,
  orders_count,drinks_count,ingredients_cents,staff_wages_cents,staff_tax_cents,
  card_fees_cents,voids_cents,sales_data_status,labor_wage_status)
 select p_business_id,p_business_date,
   coalesce(sum(o.net_sales_cents),0)::bigint,count(*)::integer,
   coalesce((select sum(l.quantity) from public.order_lines l
    join public.orders x on x.id=l.order_id where x.business_id=p_business_id
     and x.business_date=p_business_date and not x.toast_excluded
     and x.superseded_by is null and not l.voided),0)::integer,
   0,null,null,0,0,'missing','missing'
 from public.orders o where o.business_id=p_business_id
   and o.business_date=p_business_date and not o.toast_excluded
   and o.superseded_by is null
 on conflict(business_id,business_date) do update
 set net_sales_cents=excluded.net_sales_cents,orders_count=excluded.orders_count,
  drinks_count=excluded.drinks_count,sales_data_status=excluded.sales_data_status;
 perform public.pos_rebuild_sales_fact_rollups_v1(p_business_id,p_business_date);
 -- Never certify a multi-location total until every verified/mapped Toast
 -- location applicable to this date has a complete imported snapshot.
 select count(*),count(*) filter(where d.import_state='imported'
  and d.coverage_complete) into v_eligible_locations,v_complete_locations
 from public.toast_location_mappings m
 left join public.toast_day_status d on d.business_id=m.business_id
   and d.restaurant_guid=m.restaurant_guid and d.business_date=p_business_date
 where m.business_id=p_business_id and m.verified_at is not null
   and p_business_date>=coalesce(m.toast_start_date,p_business_date);
 update public.daily_rollups set sales_data_status=
  case when v_eligible_locations>0 and v_complete_locations=v_eligible_locations
   then 'actual' else 'missing' end
 where business_id=p_business_id and business_date=p_business_date;
 -- Unknown-location non-Toast rows at a multi-location café cannot be
 -- automatically attributed to Toast. Do not claim verified aggregate sales.
 if exists(select 1 from public.orders where business_id=p_business_id
  and business_date=p_business_date and location_id is null
  and pos_order_id not like 'toast:%' and superseded_by is null) then
  update public.daily_rollups set sales_data_status='missing'
   where business_id=p_business_id and business_date=p_business_date;
  update public.toast_day_status set recon_state='mismatch',
   warnings=warnings||'{"unallocated_source_overlap":1}'::jsonb
   where business_id=p_business_id and restaurant_guid=p_restaurant_guid
    and business_date=p_business_date;
 end if;
 -- IMPORTANT: completeness remains UNKNOWN until PR2's late-edit re-pull + reconciliation.
 update public.daily_rollups set voids_status='unknown',voids_source=null
 where business_id=p_business_id and business_date=p_business_date;
 update public.toast_sync_runs
 set days_done=days_done+1,
  state=case when days_total>0 and days_done+1>=days_total then 'completed' else 'running' end,
  cursor='{}'::jsonb,resume_at=null,
  orders_unparsed=orders_unparsed+(p_summary->>'unparsed_count')::integer,
  finished_at=case when days_total>0 and days_done+1>=days_total then now() else null end
 where id=p_run_id;
 -- Lossless archive happens in the SAME transaction, before staged pages are cleared.
 perform public.toast_rebuild_day_payments(p_run_id,p_business_id,p_restaurant_guid,p_business_date,
  coalesce((p_summary->>'unparsed_count')::integer,0)=0);
 perform public.toast_archive_day_pages(p_run_id,p_business_date);
 -- The parser uses 1-based source indexes; even orders without a valid GUID link exactly.
 update public.toast_unparsed_orders u set raw_record_id=r.id
 from jsonb_to_recordset(p_summary->'unparsed') as x(
   order_guid uuid,raw_sha256 text,source_page integer,source_index integer)
 join public.toast_raw_records r
   on r.run_id=p_run_id and r.business_date=p_business_date
   and r.source_page=x.source_page and r.source_index=x.source_index
   and r.entity='order' and r.business_id=p_business_id
   and r.first_seen = (
    select max(latest.first_seen) from public.toast_raw_records latest
    where latest.business_id=p_business_id and latest.run_id=p_run_id
     and latest.business_date=p_business_date and latest.entity='order'
     and latest.source_page=x.source_page and latest.source_index=x.source_index
   )
 where u.business_id=p_business_id and u.restaurant_guid=p_restaurant_guid
   and u.business_date=p_business_date and u.raw_sha256=x.raw_sha256
   and u.raw_record_id is distinct from r.id;
 delete from public.toast_day_pages where run_id=p_run_id and business_date=p_business_date;
 return jsonb_build_object('orders',v_count,'net_sales_cents',v_net);
end $$;

-- 3. Payment summaries (toast_rebuild_day_payments, migration 111, as in production) also keep the
--    payment's server and paid time. Only the two new columns differ.
create or replace function public.toast_rebuild_day_payments(p_run_id uuid, p_business_id uuid,
 p_restaurant_guid uuid, p_business_date date, p_complete boolean)
returns void language plpgsql security definer set search_path to 'public' as $function$
begin
 if auth.role()<>'service_role' or not exists(
  select 1 from public.toast_sync_runs where id=p_run_id
   and business_id=p_business_id and restaurant_guid=p_restaurant_guid)
 then raise exception 'unauthorized payments rebuild';end if;
 if p_complete then
  delete from public.toast_payment_summaries
  where business_id=p_business_id and restaurant_guid=p_restaurant_guid
   and business_date=p_business_date;
 end if;
 with source as (
  select item.raw as row,
   row_number() over(partition by coalesce(nullif(item.raw->>'guid',''),
    'guidless:'||page.page::text||':'||item.idx::text)
     order by item.raw->>'modifiedDate' desc nulls last, page.page desc,item.idx desc) rn
  from public.toast_day_pages page
  cross join lateral jsonb_array_elements(page.payload) with ordinality item(raw,idx)
  where page.run_id=p_run_id and page.business_date=p_business_date
 ), checks as (
  select s.row as original,c.value as check_row,c.ordinality as check_idx
  from source s cross join lateral jsonb_array_elements(
   case when jsonb_typeof(s.row->'checks')='array' then s.row->'checks' else '[]'::jsonb end)
    with ordinality as c(value,ordinality)
  where s.rn=1
 ), payments as (
  select
   coalesce(nullif(pay.value->>'guid',''),
    encode(sha256(convert_to(coalesce(c.original->>'guid','unknown')||':'||
    coalesce(c.check_row->>'guid',c.check_idx::text)||':'||pay.ordinality::text,'UTF8')),'hex')) as payment_ref,
   pay.value as payment,coalesce(c.original->>'modifiedDate','') as modified_at
  from checks c cross join lateral jsonb_array_elements(
   case when jsonb_typeof(c.check_row->'payments')='array'
   then c.check_row->'payments' else '[]'::jsonb end)
   with ordinality as pay(value,ordinality)
 ), dedup as (
  select distinct on(payment_ref) payment_ref,payment
  from payments order by payment_ref,modified_at desc
 )
 insert into public.toast_payment_summaries(business_id,restaurant_guid,
 business_date,payment_ref,payment_type,payment_status,amount_cents,tip_cents,status,server_guid,paid_at)
 select p_business_id,p_restaurant_guid,p_business_date,p.payment_ref,
  left(p.payment->>'type',100),left(p.payment->>'paymentStatus',100),
  case when jsonb_typeof(p.payment->'amount')='number'
   then round((p.payment->>'amount')::numeric*100)::bigint else null end,
  case when jsonb_typeof(p.payment->'tipAmount')='number'
   then round((p.payment->>'tipAmount')::numeric*100)::bigint else null end,
  case when jsonb_typeof(p.payment->'amount')='number' then 'actual' else 'open' end,
  public.toast_uuid_or_null(p.payment->'server'->>'guid'),
  public.toast_time_or_null(p.payment->>'paidDate')
 from dedup p
 on conflict(business_id,restaurant_guid,business_date,payment_ref) do update
 set payment_type=excluded.payment_type,payment_status=excluded.payment_status,
 amount_cents=excluded.amount_cents,tip_cents=excluded.tip_cents,
 status=excluded.status,server_guid=excluded.server_guid,paid_at=excluded.paid_at;
end $function$;

-- 4. One-time fill of history from the archive (the order record each day's latest
--    import reads; one record per order since migration 140).
create or replace function public.toast_fill_organized_fields()
returns void language plpgsql security definer set search_path=public as $fill$
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only'; end if;
 update public.toast_payment_summaries s
 set server_guid=public.toast_uuid_or_null(p.value->'server'->>'guid'),
  paid_at=public.toast_time_or_null(p.value->>'paidDate')
 from public.toast_raw_records r
 cross join lateral jsonb_array_elements(case when jsonb_typeof(r.payload->'checks')='array'
  then r.payload->'checks' else '[]'::jsonb end) c
 cross join lateral jsonb_array_elements(case when jsonb_typeof(c.value->'payments')='array'
  then c.value->'payments' else '[]'::jsonb end) p
 where r.entity='order' and s.business_id=r.business_id and s.restaurant_guid=r.restaurant_guid
  and s.business_date=r.business_date and s.payment_ref=p.value->>'guid'
  and s.server_guid is null and s.paid_at is null;

 -- Lines written before migration 141 have no Toast line ID. Give it to them where the
 -- match is certain: same order, and the order's lines and countable Toast items pair
 -- up one-to-one on name, quantity, void flag and net amount (the parser's own rules:
 -- active checks only, deferred and house-account items excluded). Identical items in
 -- one order are interchangeable. Orders that do not pair up exactly are left alone.
 with o as (
  select o.id order_id,r.payload p from public.orders o
  join public.toast_raw_records r on r.entity='order' and r.business_id=o.business_id
   and r.business_date=o.business_date and r.entity_guid::text=split_part(o.pos_order_id,':',3)
   and r.restaurant_guid::text=split_part(o.pos_order_id,':',2)
  where o.pos_order_id like 'toast:%' and not o.toast_excluded
   and not exists(select 1 from public.order_lines x where x.order_id=o.id and x.pos_line_id is not null)
 ), sk as (
  select o.order_id,s.value->>'guid' guid,
   coalesce(nullif(trim(s.value->>'displayName'),''),'Menu item') name,
   coalesce((s.value->>'quantity')::numeric,0) qty,coalesce((s.value->>'voided')::boolean,false) voided,
   case when coalesce((s.value->>'voided')::boolean,false) then 0
    else round(coalesce((s.value->>'price')::numeric,0)*100)
     -round(coalesce((s.value->'refundDetails'->>'refundAmount')::numeric,0)*100) end net
  from o
  cross join lateral jsonb_array_elements(case when jsonb_typeof(o.p->'checks')='array' then o.p->'checks' else '[]'::jsonb end) c
  cross join lateral jsonb_array_elements(case when jsonb_typeof(c.value->'selections')='array' then c.value->'selections' else '[]'::jsonb end) s
  where not coalesce((c.value->>'deleted')::boolean,false) and not coalesce((c.value->>'voided')::boolean,false)
   and not coalesce((s.value->>'deferred')::boolean,false)
   and coalesce(s.value->>'selectionType','')<>'HOUSE_ACCOUNT_PAY_BALANCE'
   and public.toast_uuid_or_null(s.value->>'guid') is not null
 ), lk as (
  select l.id,l.order_id,l.name,l.quantity qty,l.voided,l.net_sales_cents net
  from public.order_lines l where l.order_id in (select order_id from o)
 ), a as (
  select sk.*,row_number() over (partition by order_id,name,qty,voided,net order by guid) rn from sk
 ), b as (
  select lk.*,row_number() over (partition by order_id,name,qty,voided,net order by id) rn from lk
 ), pairs as (
  select b.id line_id,a.guid,b.order_id from b join a using(order_id,name,qty,voided,net,rn)
 ), nl as (select order_id,count(*) n from lk group by 1
 ), ns as (select order_id,count(*) n from sk group by 1
 ), pc as (select order_id,count(*) n from pairs group by 1
 -- Each order's counts are taken once (not re-scanned per order): fast on a year of orders.
 ), whole as (
  select pc.order_id from pc join nl using(order_id) join ns using(order_id)
  where pc.n=nl.n and pc.n=ns.n
 )
 update public.order_lines l set pos_line_id=p.guid
 from pairs p where l.id=p.line_id and p.order_id in (select order_id from whole);

 update public.order_lines l
 set ordered_at=public.toast_time_or_null(sel.value->>'createdDate'),
  fulfillment_status=nullif(left(sel.value->>'fulfillmentStatus',40),'')
 from public.orders o, public.toast_raw_records r
 cross join lateral jsonb_array_elements(case when jsonb_typeof(r.payload->'checks')='array'
  then r.payload->'checks' else '[]'::jsonb end) c
 cross join lateral jsonb_array_elements(case when jsonb_typeof(c.value->'selections')='array'
  then c.value->'selections' else '[]'::jsonb end) sel
 where l.order_id=o.id and o.pos_order_id like 'toast:%' and l.pos_line_id is not null
  and r.entity='order' and r.business_id=o.business_id and r.business_date=o.business_date
  and r.entity_guid::text=split_part(o.pos_order_id,':',3)
  and r.restaurant_guid::text=split_part(o.pos_order_id,':',2)
  and sel.value->>'guid'=l.pos_line_id
  and l.ordered_at is null and l.fulfillment_status is null;

 -- Same rule as the parser: only checks that count (order and check not voided or
 -- deleted, not test mode or excess food); fundraising is not a service charge.
 with charges as (
  select r.business_id,r.business_date,'toast:'||r.restaurant_guid::text||':'||r.entity_guid::text pos_order_id,
   coalesce(sum(round((sc.value->>'chargeAmount')::numeric*100)) filter (where
    coalesce(sc.value->>'serviceChargeCategory','')<>'FUNDRAISING_CAMPAIGN'
    and coalesce((sc.value->>'gratuity')::boolean,false)=false),0)::bigint services,
   coalesce(sum(round((sc.value->>'chargeAmount')::numeric*100)) filter (where
    coalesce(sc.value->>'serviceChargeCategory','')<>'FUNDRAISING_CAMPAIGN'
    and coalesce((sc.value->>'gratuity')::boolean,false)),0)::bigint gratuity
  from public.toast_raw_records r
  cross join lateral jsonb_array_elements(case when jsonb_typeof(r.payload->'checks')='array'
   then r.payload->'checks' else '[]'::jsonb end) c
  left join lateral jsonb_array_elements(case when jsonb_typeof(c.value->'appliedServiceCharges')='array'
   then c.value->'appliedServiceCharges' else '[]'::jsonb end) sc
   on jsonb_typeof(sc.value->'chargeAmount')='number'
  where r.entity='order' and r.entity_guid is not null
   and not coalesce((r.payload->>'deleted')::boolean,false) and not coalesce((r.payload->>'voided')::boolean,false)
   and not coalesce((r.payload->>'excessFood')::boolean,false)
   and not coalesce((r.payload->>'createdInTestMode')::boolean,false)
   and not coalesce((c.value->>'deleted')::boolean,false) and not coalesce((c.value->>'voided')::boolean,false)
  group by 1,2,3
 )
 update public.orders o set service_charges_cents=ch.services,gratuity_cents=ch.gratuity
 from charges ch
 -- An order Toast moved to another day can be archived under both dates: use only
 -- the record filed under the order's own business date.
 where o.business_id=ch.business_id and o.pos_order_id=ch.pos_order_id
  and o.business_date=ch.business_date
  and o.service_charges_cents is null and o.gratuity_cents is null;
end $fill$;
revoke all on function public.toast_fill_organized_fields() from public,anon,authenticated;
grant execute on function public.toast_fill_organized_fields() to service_role;

-- The history fill is NOT run here: adding the columns locks these tables until the
-- migration commits, so a long fill in the same transaction would block the app (and
-- the SQL editor stops long statements). After this migration, run once on its own
-- (row locks only, safe to re-run):
--   select public.toast_fill_organized_fields();
