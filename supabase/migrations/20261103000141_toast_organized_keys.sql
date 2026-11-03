-- Organized Toast tables: one row per POS object, enforced by the database
-- (AGENTS.md §4b, docs/plans/toast-storage.md step 3).
--
-- Already enforced before this migration:
--   orders               one row per (café, Toast order)        orders_business_id_pos_order_id_key
--   toast_payment_facts  one row per (café, restaurant, day, payment)
--   toast_payment_summaries, toast_void_facts, daily/hourly/employee rollups
-- Added here:
--   order_lines          one row per (order, Toast selection GUID). Lines are still
--                        replaced per order on import; the key makes a double line
--                        impossible instead of merely unlikely. Lines written before
--                        this migration have no GUID and get it on their next import.
--   toast_refund_facts   one row per (café, restaurant, order, payment).
-- Only the order-line insert and the refund insert differ from toast_import_day in
-- migration 111 (which is the version running in production).

-- 1. Toast selection GUID on order lines (null for CSV and other POS lines).
alter table public.order_lines add column if not exists pos_line_id text;
create unique index if not exists order_lines_one_pos_line
 on public.order_lines(order_id,pos_line_id) where pos_line_id is not null;

-- 2. Refund facts: merge any existing repeats, then enforce one row per payment.
with merged as (
 delete from public.toast_refund_facts t
 using (select business_id,restaurant_guid,order_guid,payment_guid,min(id) keep_id
   from public.toast_refund_facts group by 1,2,3,4 having count(*)>1) d
 where t.business_id=d.business_id and t.restaurant_guid=d.restaurant_guid
  and t.order_guid=d.order_guid and t.payment_guid is not distinct from d.payment_guid
  and t.id<>d.keep_id
 returning d.keep_id,t.amount_cents
)
update public.toast_refund_facts t set amount_cents=t.amount_cents+m.extra
from (select keep_id,sum(amount_cents) extra from merged group by 1) m where t.id=m.keep_id;
create unique index if not exists toast_refund_facts_one_payment
 on public.toast_refund_facts(business_id,restaurant_guid,order_guid,payment_guid) nulls not distinct;

-- 3. Day import writes the line GUID (changed) and one refund row per payment (changed).
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
    employee_id,dining_option,source_channel,guest_count)
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
      then (rec->>'guestCount')::smallint else null end)
  on conflict(business_id,pos_order_id) do update
   set location_id=excluded.location_id,closed_at=excluded.closed_at,business_date=excluded.business_date,
   gross_sales_cents=excluded.gross_sales_cents,discounts_cents=excluded.discounts_cents,
   refunds_cents=excluded.refunds_cents,tax_cents=excluded.tax_cents,tip_cents=excluded.tip_cents,
   net_sales_cents=excluded.net_sales_cents,toast_excluded=false,
   employee_id=excluded.employee_id,dining_option=excluded.dining_option,
   source_channel=excluded.source_channel,guest_count=excluded.guest_count,
   processing_fee_cents=0,processing_fee_status='missing',processing_fee_provider='toast'
  returning id into v_id;
  delete from public.order_lines where order_id=v_id;
  for ln in select value from jsonb_array_elements(rec->'lines') loop
   select id into v_item from public.menu_items where business_id=p_business_id
    and pos_item_id=ln->>'posItemId' order by id limit 1;
   insert into public.order_lines(order_id,menu_item_id,pos_item_id,name,quantity,net_sales_cents,
    modifiers,voided,voided_by,category,pos_line_id)
   values(v_id,v_item,ln->>'posItemId',coalesce(ln->>'name','Menu item'),
    (ln->>'quantity')::numeric,(ln->>'netSalesCents')::bigint,
    coalesce(ln->'modifiers','[]'::jsonb),coalesce((ln->>'voided')::boolean,false),
    null,ln->>'category',nullif(ln->>'posLineId',''));
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
