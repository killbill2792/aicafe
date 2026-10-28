-- D / issue 27-29, lossless Toast input retention (forward-only).
-- DO NOT remove raw records when the provider updates or a daily rollup is replaced.
-- Café deletion still cascades for data-erasure compliance.
create table if not exists public.toast_raw_records (
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null references public.businesses(id) on delete cascade,
 restaurant_guid uuid,
 entity text not null check (length(entity) between 1 and 64),
 entity_guid uuid,
 business_date date,
 payload jsonb not null,
 payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
 first_seen timestamptz not null default now(),
 last_seen timestamptz not null default now(),
 superseded_by uuid,
 run_id uuid, -- intentionally NOT an FK: raw evidence survives run cleanup
 source_page integer,
 source_index integer,
 capture_key text not null,
 unique (business_id,capture_key)
);
create index if not exists toast_raw_records_scope_idx
 on public.toast_raw_records (business_id,entity,business_date,first_seen desc);
create index if not exists toast_raw_records_guid_idx
 on public.toast_raw_records (business_id,restaurant_guid,entity_guid);
alter table public.toast_raw_records enable row level security;
revoke all on public.toast_raw_records from public,anon,authenticated;
grant select,insert on public.toast_raw_records to service_role;
-- Raw Toast data can contain guest/payment details. NEVER grant it to client roles.
-- No UPDATE/DELETE API privileges: every captured revision is immutable.

alter table public.toast_unparsed_orders
 add column if not exists raw_record_id uuid references public.toast_raw_records(id) on delete set null;

-- Current typed ERA values, with immutable versions in toast_raw_records.
create table if not exists public.toast_analytics_results (
 business_id uuid not null references public.businesses(id) on delete cascade,
 restaurant_guid uuid not null, business_date date not null,
 report text not null, metric text not null, value_numeric numeric,
 value_json jsonb, fetched_at timestamptz not null default now(),
 primary key (business_id,restaurant_guid,business_date,report,metric)
);
create index if not exists toast_analytics_results_date_idx
 on public.toast_analytics_results(business_id,business_date);
alter table public.toast_analytics_results enable row level security;
revoke all on public.toast_analytics_results from public,anon,authenticated;
create policy "owner read" on public.toast_analytics_results for select
 to authenticated using (public.scheduling_is_owner(business_id));
grant select on public.toast_analytics_results to authenticated;
grant select,insert,update on public.toast_analytics_results to service_role;

-- Sanitized per-payment facts. Owner/AI reads these, NEVER the raw PII archive.
create table if not exists public.toast_payment_summaries (
 business_id uuid not null references public.businesses(id) on delete cascade,
 restaurant_guid uuid not null,
 business_date date not null,
 payment_ref text not null,
 payment_type text,
 payment_status text,
 amount_cents bigint,
 tip_cents bigint,
 status text not null check(status in ('actual','estimated','open','needs_match','owner_provided')),
 primary key(business_id,restaurant_guid,business_date,payment_ref)
);
alter table public.toast_payment_summaries enable row level security;
revoke all on public.toast_payment_summaries from public,anon,authenticated;
create policy "owner read" on public.toast_payment_summaries for select
 to authenticated using (public.scheduling_is_owner(business_id));
grant select on public.toast_payment_summaries to authenticated;
grant select,insert,update on public.toast_payment_summaries to service_role;

-- Preserve incomplete Toast timecards without inventing wage rates or treating
-- unclocked work as paid time. Closed ones remain in canonical timecards.
create table if not exists public.toast_open_labor_summaries(
 business_id uuid not null references public.businesses(id) on delete cascade,
 restaurant_guid uuid not null,
 external_time_entry_id uuid not null,
 external_employee_id uuid not null,
 clock_in timestamptz not null,
 clock_out timestamptz,
 hourly_wage_cents bigint,
 wage_status text not null,
 status text not null check(status in ('actual','estimated','open','needs_match','owner_provided')),
 primary key(business_id,restaurant_guid,external_time_entry_id)
);
alter table public.toast_open_labor_summaries enable row level security;
revoke all on public.toast_open_labor_summaries from public,anon,authenticated;
create policy "owner read" on public.toast_open_labor_summaries
 for select to authenticated using (public.scheduling_is_owner(business_id));
grant select on public.toast_open_labor_summaries to authenticated;
grant select,insert,update on public.toast_open_labor_summaries to service_role;

create or replace function public.toast_sync_open_labor_summary()
returns trigger language plpgsql security definer set search_path=public as $summary$
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only';end if;
 insert into public.toast_open_labor_summaries(
  business_id,restaurant_guid,external_time_entry_id,external_employee_id,
  clock_in,clock_out,hourly_wage_cents,wage_status,status)
 values(new.business_id,new.restaurant_guid,new.external_time_entry_id,
  new.external_employee_id,new.clock_in,new.clock_out,
  case when new.clock_out is null or new.wage_status='missing'
   then null else new.hourly_wage_cents end,new.wage_status,
  case when new.clock_out is null then 'open'
   when new.wage_status='missing' then 'needs_match' else 'actual' end)
 on conflict (business_id,restaurant_guid,external_time_entry_id) do update
 set external_employee_id=excluded.external_employee_id,clock_in=excluded.clock_in,
  clock_out=excluded.clock_out,hourly_wage_cents=excluded.hourly_wage_cents,
  wage_status=excluded.wage_status,status=excluded.status;
 return new;
end $summary$;
drop trigger if exists toast_open_labor_copy on public.toast_labor_entries;
create trigger toast_open_labor_copy after insert or update on public.toast_labor_entries
 for each row execute function public.toast_sync_open_labor_summary();
insert into public.toast_open_labor_summaries(
 business_id,restaurant_guid,external_time_entry_id,external_employee_id,
 clock_in,clock_out,hourly_wage_cents,wage_status,status)
select business_id,restaurant_guid,external_time_entry_id,external_employee_id,
 clock_in,clock_out,case when clock_out is null or wage_status='missing'
 then null else hourly_wage_cents end,wage_status,
 case when clock_out is null then 'open'
  when wage_status='missing' then 'needs_match' else 'actual' end
from public.toast_labor_entries
on conflict (business_id,restaurant_guid,external_time_entry_id) do update
set external_employee_id=excluded.external_employee_id,
 clock_in=excluded.clock_in,clock_out=excluded.clock_out,
 hourly_wage_cents=excluded.hourly_wage_cents,
 wage_status=excluded.wage_status,status=excluded.status;

-- Capture individual raw orders, including orders the parser cannot recognize.
-- Source page + 1-based array offset make invalid/missing order GUIDs addressable.
create or replace function public.toast_archive_page(
 p_run_id uuid,p_business_date date,p_page integer,p_payload jsonb
) returns void language plpgsql security definer set search_path=public as $archive$
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only'; end if;
 insert into public.toast_raw_records(
  business_id,restaurant_guid,entity,entity_guid,business_date,payload,
  payload_sha256,run_id,source_page,source_index,capture_key)
 select s.business_id,s.restaurant_guid,'order',
   case when item.raw->>'guid' ~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (item.raw->>'guid')::uuid else null end,
   p_business_date,item.raw,
   encode(sha256(convert_to(item.raw::text,'UTF8')),'hex'),
   p_run_id,p_page,item.idx::integer,
   'page:'||p_run_id::text||':'||p_business_date::text||':'||p_page::text||':'||item.idx::text
 from public.toast_sync_runs s
 cross join lateral jsonb_array_elements(p_payload) with ordinality as item(raw,idx)
 where s.id=p_run_id
 on conflict (business_id,capture_key) do nothing;
 -- Whitelist payment aggregates; never expose cards, names or other raw fields.
 insert into public.toast_payment_summaries(
  business_id,restaurant_guid,business_date,payment_ref,payment_type,
  payment_status,amount_cents,tip_cents,status)
 select sync.business_id,sync.restaurant_guid,p_business_date,
  coalesce(nullif(pay.payment->>'guid',''),
   encode(sha256(convert_to(p_run_id::text||':'||p_page::text||':'||
     ord.idx::text||':'||chk.cidx::text||':'||pay.pidx::text,'UTF8')),'hex')),
  left(pay.payment->>'type',100),
  left(pay.payment->>'paymentStatus',100),
  case when jsonb_typeof(pay.payment->'amount')='number'
   then round((pay.payment->>'amount')::numeric*100)::bigint else null end,
  case when jsonb_typeof(pay.payment->'tipAmount')='number'
   then round((pay.payment->>'tipAmount')::numeric*100)::bigint else null end,
  case when jsonb_typeof(pay.payment->'amount')='number' then 'actual' else 'open' end
 from public.toast_sync_runs sync
 cross join lateral jsonb_array_elements(p_payload) with ordinality ord(raw,idx)
 cross join lateral jsonb_array_elements(case when jsonb_typeof(ord.raw->'checks')='array'
   then ord.raw->'checks' else '[]'::jsonb end) with ordinality chk(check_row,cidx)
 cross join lateral jsonb_array_elements(case when jsonb_typeof(chk.check_row->'payments')='array'
   then chk.check_row->'payments' else '[]'::jsonb end) with ordinality pay(payment,pidx)
 where sync.id=p_run_id
 on conflict (business_id,restaurant_guid,business_date,payment_ref) do update
 set payment_type=excluded.payment_type,
  payment_status=excluded.payment_status,
  amount_cents=excluded.amount_cents,
  tip_cents=excluded.tip_cents,
  status=excluded.status;
 -- Each nested check and payment also has its own immutable source record.
 insert into public.toast_raw_records(business_id,restaurant_guid,entity,
  entity_guid,business_date,payload,payload_sha256,run_id,source_page,
  source_index,capture_key)
 select sync.business_id,sync.restaurant_guid,'check',
  case when chk.check_row->>'guid' ~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}
revoke all on function public.toast_archive_page(uuid,date,integer,jsonb) from public,anon,authenticated;
grant execute on function public.toast_archive_page(uuid,date,integer,jsonb) to service_role;

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
  perform public.toast_archive_page(p_run_id,p_business_date,p.page,p.payload);
 end loop;
end $archive$;
revoke all on function public.toast_archive_day_pages(uuid,date) from public,anon,authenticated;
grant execute on function public.toast_archive_day_pages(uuid,date) to service_role;

-- Capture on stage write, not only on a successful import: failed/abandoned
-- imports and other legacy cleanup paths may also delete staged pages.
create or replace function public.toast_archive_page_trigger()
returns trigger language plpgsql security definer set search_path=public as $archive$
begin
 perform public.toast_archive_page(
  case when tg_op='DELETE' then old.run_id else new.run_id end,
  case when tg_op='DELETE' then old.business_date else new.business_date end,
  case when tg_op='DELETE' then old.page else new.page end,
  case when tg_op='DELETE' then old.payload else new.payload end
 );
 if tg_op='DELETE' then return old; end if;
 return new;
end $archive$;
drop trigger if exists toast_archive_page_insert on public.toast_day_pages;
create trigger toast_archive_page_insert after insert or update on public.toast_day_pages
 for each row execute function public.toast_archive_page_trigger();
drop trigger if exists toast_archive_page_delete on public.toast_day_pages;
create trigger toast_archive_page_delete before delete on public.toast_day_pages
 for each row execute function public.toast_archive_page_trigger();

-- Preserve staged fields even when their current canonical copier only accepts
-- closed time entries, matched staff, or part of the published menu.
create or replace function public.toast_archive_stage_snapshot(
 p_row jsonb,p_entity text,p_origin text
) returns void language plpgsql security definer set search_path=public as $archive$
declare v_guid text; v_biz uuid;v_rest uuid;v_day date;v_hash text;
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only'; end if;
 if nullif(p_row->>'business_id','') is null then return; end if;
 v_biz:=(p_row->>'business_id')::uuid;
 v_rest:=nullif(p_row->>'restaurant_guid','')::uuid;
 v_guid:=coalesce(
  nullif(p_row->>'external_time_entry_id',''),
  nullif(p_row->>'employee_guid',''),
  nullif(p_row->>'provider_guid',''),
  nullif(p_row->>'order_guid',''),
  nullif(p_row->>'payment_guid',''),
  nullif(p_row->>'job_guid',''),
  nullif(p_row->>'guid',''));
 v_hash:=encode(sha256(convert_to(p_row::text,'UTF8')),'hex');
 -- A day is optional for snapshots with no business-date field.
 if coalesce(p_row->>'business_date',p_row->>'order_business_date','') ~ '^\d{4}-\d{2}-\d{2}$'
 then v_day:=coalesce(p_row->>'business_date',p_row->>'order_business_date')::date; end if;
 insert into public.toast_raw_records(
  business_id,restaurant_guid,entity,entity_guid,business_date,payload,payload_sha256,capture_key)
 values(v_biz,v_rest,p_entity,
  case when v_guid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   then v_guid::uuid else null end,
  v_day,p_row,v_hash,'stage:'||p_origin||':'||v_hash)
 on conflict (business_id,capture_key) do nothing;
end $archive$;
revoke all on function public.toast_archive_stage_snapshot(jsonb,text,text) from public,anon,authenticated;
grant execute on function public.toast_archive_stage_snapshot(jsonb,text,text) to service_role;

create or replace function public.toast_archive_stage_trigger()
returns trigger language plpgsql security definer set search_path=public as $archive$
begin
 perform public.toast_archive_stage_snapshot(to_jsonb(new),tg_argv[0],tg_table_name);
 return new;
end $archive$;

-- Additive, idempotent backfill and ongoing capture. This DOES NOT pretend to
-- reconstruct imported order pages already deleted before this migration.
do $backfill$
declare v_table text;v_entity text;v_trigger text;
begin
 for v_table,v_entity in select * from (values
  ('toast_labor_entries','time_entry'),
  ('toast_employee_directory','employee'),
  ('toast_job_directory','job'),
  ('toast_catalog_facts','menu_item'),
  ('toast_catalog_price_versions','price_version'),
  ('toast_payment_day_events','payment_day_event'),
  ('toast_modified_orders_staging','modified_order'),
  ('toast_pilot_days','pilot_day'),
  ('toast_void_facts','void'),
  ('toast_refund_facts','refund'),
  ('toast_analytics_jobs','analytics_job')
 ) as v(t,e)
 loop
  if to_regclass('public.'||v_table) is null then continue; end if;
  execute format('select public.toast_archive_stage_snapshot(to_jsonb(t),%L,%L) from public.%I t',
   v_entity,v_table,v_table);
  v_trigger:='toast_archive_'||v_table;
  execute format('drop trigger if exists %I on public.%I',v_trigger,v_table);
  execute format('create trigger %I after insert or update on public.%I for each row execute function public.toast_archive_stage_trigger(%L)',
   v_trigger,v_table,v_entity);
 end loop;
 -- Any pages still staged at migration time must be archived too.
 perform public.toast_archive_page(p.run_id,p.business_date,p.page,p.payload)
 from public.toast_day_pages p;
end $backfill$;

-- Older malformed orders have no recorded source index, so only a GUID match
-- can be recovered. If the GUID is absent, do not fabricate a link.
update public.toast_unparsed_orders u set raw_record_id=(
 select x.id from public.toast_raw_records x
 where x.business_id=u.business_id and x.restaurant_guid=u.restaurant_guid
   and x.business_date=u.business_date and x.entity='order'
   and x.entity_guid=u.order_guid
 order by x.first_seen desc,x.id desc limit 1
)
where u.raw_record_id is null and u.order_guid is not null
 and exists (select 1 from public.toast_raw_records x
 where x.business_id=u.business_id and x.restaurant_guid=u.restaurant_guid
 and x.business_date=u.business_date and x.entity='order' and x.entity_guid=u.order_guid);

-- Keep existing sales/void/refund math strictly byte-identical.

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
    modifiers,voided,voided_by,category)
   values(v_id,v_item,ln->>'posItemId',coalesce(ln->>'name','Menu item'),
    (ln->>'quantity')::numeric,(ln->>'netSalesCents')::bigint,
    coalesce(ln->'modifiers','[]'::jsonb),coalesce((ln->>'voided')::boolean,false),
    null,ln->>'category');
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
 insert into public.toast_refund_facts(business_id,restaurant_guid,order_guid,payment_guid,
  order_business_date,refund_business_date,amount_cents)
 select p_business_id,p_restaurant_guid,x.order_guid,x.payment_guid,
  x.order_business_date,x.refund_business_date,x.amount_cents
 from jsonb_to_recordset(p_summary->'refund_facts') as x(
  order_guid uuid,payment_guid uuid,order_business_date date,refund_business_date date,amount_cents bigint);
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
 perform public.toast_archive_day_pages(p_run_id,p_business_date);
 -- The parser uses 1-based source indexes; even orders without a valid GUID link exactly.
 update public.toast_unparsed_orders u set raw_record_id=r.id
 from jsonb_to_recordset(p_summary->'unparsed') as x(
   order_guid uuid,raw_sha256 text,source_page integer,source_index integer)
 join public.toast_raw_records r
   on r.run_id=p_run_id and r.business_date=p_business_date
   and r.source_page=x.source_page and r.source_index=x.source_index
   and r.entity='order' and r.business_id=p_business_id
 where u.business_id=p_business_id and u.restaurant_guid=p_restaurant_guid
   and u.business_date=p_business_date and u.raw_sha256=x.raw_sha256
   and u.raw_record_id is distinct from r.id;
 delete from public.toast_day_pages where run_id=p_run_id and business_date=p_business_date;
 return jsonb_build_object('orders',v_count,'net_sales_cents',v_net);
end $$;

    then (chk.check_row->>'guid')::uuid else null end,
  p_business_date,chk.check_row,
  encode(sha256(convert_to(chk.check_row::text,'UTF8')),'hex'),
  p_run_id,p_page,ord.idx::integer,
  'check:'||p_run_id::text||':'||p_business_date::text||':'||
    p_page::text||':'||ord.idx::text||':'||chk.cidx::text||':'||
    encode(sha256(convert_to(chk.check_row::text,'UTF8')),'hex')
 from public.toast_sync_runs sync
 cross join lateral jsonb_array_elements(p_payload) with ordinality ord(raw,idx)
 cross join lateral jsonb_array_elements(case when jsonb_typeof(ord.raw->'checks')='array'
  then ord.raw->'checks' else '[]'::jsonb end) with ordinality chk(check_row,cidx)
 where sync.id=p_run_id
 on conflict(business_id,capture_key) do nothing;
 insert into public.toast_raw_records(business_id,restaurant_guid,entity,
  entity_guid,business_date,payload,payload_sha256,run_id,source_page,
  source_index,capture_key)
 select sync.business_id,sync.restaurant_guid,'payment',
  case when pay.payment->>'guid' ~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}
revoke all on function public.toast_archive_page(uuid,date,integer,jsonb) from public,anon,authenticated;
grant execute on function public.toast_archive_page(uuid,date,integer,jsonb) to service_role;

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
  perform public.toast_archive_page(p_run_id,p_business_date,p.page,p.payload);
 end loop;
end $archive$;
revoke all on function public.toast_archive_day_pages(uuid,date) from public,anon,authenticated;
grant execute on function public.toast_archive_day_pages(uuid,date) to service_role;

-- Capture on stage write, not only on a successful import: failed/abandoned
-- imports and other legacy cleanup paths may also delete staged pages.
create or replace function public.toast_archive_page_trigger()
returns trigger language plpgsql security definer set search_path=public as $archive$
begin
 perform public.toast_archive_page(
  case when tg_op='DELETE' then old.run_id else new.run_id end,
  case when tg_op='DELETE' then old.business_date else new.business_date end,
  case when tg_op='DELETE' then old.page else new.page end,
  case when tg_op='DELETE' then old.payload else new.payload end
 );
 if tg_op='DELETE' then return old; end if;
 return new;
end $archive$;
drop trigger if exists toast_archive_page_insert on public.toast_day_pages;
create trigger toast_archive_page_insert after insert or update on public.toast_day_pages
 for each row execute function public.toast_archive_page_trigger();
drop trigger if exists toast_archive_page_delete on public.toast_day_pages;
create trigger toast_archive_page_delete before delete on public.toast_day_pages
 for each row execute function public.toast_archive_page_trigger();

-- Preserve staged fields even when their current canonical copier only accepts
-- closed time entries, matched staff, or part of the published menu.
create or replace function public.toast_archive_stage_snapshot(
 p_row jsonb,p_entity text,p_origin text
) returns void language plpgsql security definer set search_path=public as $archive$
declare v_guid text; v_biz uuid;v_rest uuid;v_day date;v_hash text;
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only'; end if;
 if nullif(p_row->>'business_id','') is null then return; end if;
 v_biz:=(p_row->>'business_id')::uuid;
 v_rest:=nullif(p_row->>'restaurant_guid','')::uuid;
 v_guid:=coalesce(
  nullif(p_row->>'external_time_entry_id',''),
  nullif(p_row->>'employee_guid',''),
  nullif(p_row->>'provider_guid',''),
  nullif(p_row->>'order_guid',''),
  nullif(p_row->>'payment_guid',''),
  nullif(p_row->>'job_guid',''),
  nullif(p_row->>'guid',''));
 v_hash:=encode(sha256(convert_to(p_row::text,'UTF8')),'hex');
 -- A day is optional for snapshots with no business-date field.
 if coalesce(p_row->>'business_date',p_row->>'order_business_date','') ~ '^\d{4}-\d{2}-\d{2}$'
 then v_day:=coalesce(p_row->>'business_date',p_row->>'order_business_date')::date; end if;
 insert into public.toast_raw_records(
  business_id,restaurant_guid,entity,entity_guid,business_date,payload,payload_sha256,capture_key)
 values(v_biz,v_rest,p_entity,
  case when v_guid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   then v_guid::uuid else null end,
  v_day,p_row,v_hash,'stage:'||p_origin||':'||v_hash)
 on conflict (business_id,capture_key) do nothing;
end $archive$;
revoke all on function public.toast_archive_stage_snapshot(jsonb,text,text) from public,anon,authenticated;
grant execute on function public.toast_archive_stage_snapshot(jsonb,text,text) to service_role;

create or replace function public.toast_archive_stage_trigger()
returns trigger language plpgsql security definer set search_path=public as $archive$
begin
 perform public.toast_archive_stage_snapshot(to_jsonb(new),tg_argv[0],tg_table_name);
 return new;
end $archive$;

-- Additive, idempotent backfill and ongoing capture. This DOES NOT pretend to
-- reconstruct imported order pages already deleted before this migration.
do $backfill$
declare v_table text;v_entity text;v_trigger text;
begin
 for v_table,v_entity in select * from (values
  ('toast_labor_entries','time_entry'),
  ('toast_employee_directory','employee'),
  ('toast_job_directory','job'),
  ('toast_catalog_facts','menu_item'),
  ('toast_catalog_price_versions','price_version'),
  ('toast_payment_day_events','payment_day_event'),
  ('toast_modified_orders_staging','modified_order'),
  ('toast_pilot_days','pilot_day'),
  ('toast_void_facts','void'),
  ('toast_refund_facts','refund'),
  ('toast_analytics_jobs','analytics_job')
 ) as v(t,e)
 loop
  if to_regclass('public.'||v_table) is null then continue; end if;
  execute format('select public.toast_archive_stage_snapshot(to_jsonb(t),%L,%L) from public.%I t',
   v_entity,v_table,v_table);
  v_trigger:='toast_archive_'||v_table;
  execute format('drop trigger if exists %I on public.%I',v_trigger,v_table);
  execute format('create trigger %I after insert or update on public.%I for each row execute function public.toast_archive_stage_trigger(%L)',
   v_trigger,v_table,v_entity);
 end loop;
 -- Any pages still staged at migration time must be archived too.
 perform public.toast_archive_page(p.run_id,p.business_date,p.page,p.payload)
 from public.toast_day_pages p;
end $backfill$;

-- Older malformed orders have no recorded source index, so only a GUID match
-- can be recovered. If the GUID is absent, do not fabricate a link.
update public.toast_unparsed_orders u set raw_record_id=(
 select x.id from public.toast_raw_records x
 where x.business_id=u.business_id and x.restaurant_guid=u.restaurant_guid
   and x.business_date=u.business_date and x.entity='order'
   and x.entity_guid=u.order_guid
 order by x.first_seen desc,x.id desc limit 1
)
where u.raw_record_id is null and u.order_guid is not null
 and exists (select 1 from public.toast_raw_records x
 where x.business_id=u.business_id and x.restaurant_guid=u.restaurant_guid
 and x.business_date=u.business_date and x.entity='order' and x.entity_guid=u.order_guid);

-- Keep existing sales/void/refund math strictly byte-identical.

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
    modifiers,voided,voided_by,category)
   values(v_id,v_item,ln->>'posItemId',coalesce(ln->>'name','Menu item'),
    (ln->>'quantity')::numeric,(ln->>'netSalesCents')::bigint,
    coalesce(ln->'modifiers','[]'::jsonb),coalesce((ln->>'voided')::boolean,false),
    null,ln->>'category');
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
 insert into public.toast_refund_facts(business_id,restaurant_guid,order_guid,payment_guid,
  order_business_date,refund_business_date,amount_cents)
 select p_business_id,p_restaurant_guid,x.order_guid,x.payment_guid,
  x.order_business_date,x.refund_business_date,x.amount_cents
 from jsonb_to_recordset(p_summary->'refund_facts') as x(
  order_guid uuid,payment_guid uuid,order_business_date date,refund_business_date date,amount_cents bigint);
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
 perform public.toast_archive_day_pages(p_run_id,p_business_date);
 -- The parser uses 1-based source indexes; even orders without a valid GUID link exactly.
 update public.toast_unparsed_orders u set raw_record_id=r.id
 from jsonb_to_recordset(p_summary->'unparsed') as x(
   order_guid uuid,raw_sha256 text,source_page integer,source_index integer)
 join public.toast_raw_records r
   on r.run_id=p_run_id and r.business_date=p_business_date
   and r.source_page=x.source_page and r.source_index=x.source_index
   and r.entity='order' and r.business_id=p_business_id
 where u.business_id=p_business_id and u.restaurant_guid=p_restaurant_guid
   and u.business_date=p_business_date and u.raw_sha256=x.raw_sha256
   and u.raw_record_id is distinct from r.id;
 delete from public.toast_day_pages where run_id=p_run_id and business_date=p_business_date;
 return jsonb_build_object('orders',v_count,'net_sales_cents',v_net);
end $$;

    then (pay.payment->>'guid')::uuid else null end,
  p_business_date,pay.payment,
  encode(sha256(convert_to(pay.payment::text,'UTF8')),'hex'),
  p_run_id,p_page,ord.idx::integer,
  'payment:'||p_run_id::text||':'||p_business_date::text||':'||
    p_page::text||':'||ord.idx::text||':'||chk.cidx::text||':'||
    pay.pidx::text||':'||encode(sha256(convert_to(pay.payment::text,'UTF8')),'hex')
 from public.toast_sync_runs sync
 cross join lateral jsonb_array_elements(p_payload) with ordinality ord(raw,idx)
 cross join lateral jsonb_array_elements(case when jsonb_typeof(ord.raw->'checks')='array'
  then ord.raw->'checks' else '[]'::jsonb end) with ordinality chk(check_row,cidx)
 cross join lateral jsonb_array_elements(case when jsonb_typeof(chk.check_row->'payments')='array'
  then chk.check_row->'payments' else '[]'::jsonb end) with ordinality pay(payment,pidx)
 where sync.id=p_run_id
 on conflict(business_id,capture_key) do nothing;
end $archive$;
revoke all on function public.toast_archive_page(uuid,date,integer,jsonb) from public,anon,authenticated;
grant execute on function public.toast_archive_page(uuid,date,integer,jsonb) to service_role;

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
  perform public.toast_archive_page(p_run_id,p_business_date,p.page,p.payload);
 end loop;
end $archive$;
revoke all on function public.toast_archive_day_pages(uuid,date) from public,anon,authenticated;
grant execute on function public.toast_archive_day_pages(uuid,date) to service_role;

-- Capture on stage write, not only on a successful import: failed/abandoned
-- imports and other legacy cleanup paths may also delete staged pages.
create or replace function public.toast_archive_page_trigger()
returns trigger language plpgsql security definer set search_path=public as $archive$
begin
 perform public.toast_archive_page(
  case when tg_op='DELETE' then old.run_id else new.run_id end,
  case when tg_op='DELETE' then old.business_date else new.business_date end,
  case when tg_op='DELETE' then old.page else new.page end,
  case when tg_op='DELETE' then old.payload else new.payload end
 );
 if tg_op='DELETE' then return old; end if;
 return new;
end $archive$;
drop trigger if exists toast_archive_page_insert on public.toast_day_pages;
create trigger toast_archive_page_insert after insert or update on public.toast_day_pages
 for each row execute function public.toast_archive_page_trigger();
drop trigger if exists toast_archive_page_delete on public.toast_day_pages;
create trigger toast_archive_page_delete before delete on public.toast_day_pages
 for each row execute function public.toast_archive_page_trigger();

-- Preserve staged fields even when their current canonical copier only accepts
-- closed time entries, matched staff, or part of the published menu.
create or replace function public.toast_archive_stage_snapshot(
 p_row jsonb,p_entity text,p_origin text
) returns void language plpgsql security definer set search_path=public as $archive$
declare v_guid text; v_biz uuid;v_rest uuid;v_day date;v_hash text;
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only'; end if;
 if nullif(p_row->>'business_id','') is null then return; end if;
 v_biz:=(p_row->>'business_id')::uuid;
 v_rest:=nullif(p_row->>'restaurant_guid','')::uuid;
 v_guid:=coalesce(
  nullif(p_row->>'external_time_entry_id',''),
  nullif(p_row->>'employee_guid',''),
  nullif(p_row->>'provider_guid',''),
  nullif(p_row->>'order_guid',''),
  nullif(p_row->>'payment_guid',''),
  nullif(p_row->>'job_guid',''),
  nullif(p_row->>'guid',''));
 v_hash:=encode(sha256(convert_to(p_row::text,'UTF8')),'hex');
 -- A day is optional for snapshots with no business-date field.
 if coalesce(p_row->>'business_date',p_row->>'order_business_date','') ~ '^\d{4}-\d{2}-\d{2}$'
 then v_day:=coalesce(p_row->>'business_date',p_row->>'order_business_date')::date; end if;
 insert into public.toast_raw_records(
  business_id,restaurant_guid,entity,entity_guid,business_date,payload,payload_sha256,capture_key)
 values(v_biz,v_rest,p_entity,
  case when v_guid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   then v_guid::uuid else null end,
  v_day,p_row,v_hash,'stage:'||p_origin||':'||v_hash)
 on conflict (business_id,capture_key) do nothing;
end $archive$;
revoke all on function public.toast_archive_stage_snapshot(jsonb,text,text) from public,anon,authenticated;
grant execute on function public.toast_archive_stage_snapshot(jsonb,text,text) to service_role;

create or replace function public.toast_archive_stage_trigger()
returns trigger language plpgsql security definer set search_path=public as $archive$
begin
 perform public.toast_archive_stage_snapshot(to_jsonb(new),tg_argv[0],tg_table_name);
 return new;
end $archive$;

-- Additive, idempotent backfill and ongoing capture. This DOES NOT pretend to
-- reconstruct imported order pages already deleted before this migration.
do $backfill$
declare v_table text;v_entity text;v_trigger text;
begin
 for v_table,v_entity in select * from (values
  ('toast_labor_entries','time_entry'),
  ('toast_employee_directory','employee'),
  ('toast_job_directory','job'),
  ('toast_catalog_facts','menu_item'),
  ('toast_catalog_price_versions','price_version'),
  ('toast_payment_day_events','payment_day_event'),
  ('toast_modified_orders_staging','modified_order'),
  ('toast_pilot_days','pilot_day'),
  ('toast_void_facts','void'),
  ('toast_refund_facts','refund'),
  ('toast_analytics_jobs','analytics_job')
 ) as v(t,e)
 loop
  if to_regclass('public.'||v_table) is null then continue; end if;
  execute format('select public.toast_archive_stage_snapshot(to_jsonb(t),%L,%L) from public.%I t',
   v_entity,v_table,v_table);
  v_trigger:='toast_archive_'||v_table;
  execute format('drop trigger if exists %I on public.%I',v_trigger,v_table);
  execute format('create trigger %I after insert or update on public.%I for each row execute function public.toast_archive_stage_trigger(%L)',
   v_trigger,v_table,v_entity);
 end loop;
 -- Any pages still staged at migration time must be archived too.
 perform public.toast_archive_page(p.run_id,p.business_date,p.page,p.payload)
 from public.toast_day_pages p;
end $backfill$;

-- Older malformed orders have no recorded source index, so only a GUID match
-- can be recovered. If the GUID is absent, do not fabricate a link.
update public.toast_unparsed_orders u set raw_record_id=(
 select x.id from public.toast_raw_records x
 where x.business_id=u.business_id and x.restaurant_guid=u.restaurant_guid
   and x.business_date=u.business_date and x.entity='order'
   and x.entity_guid=u.order_guid
 order by x.first_seen desc,x.id desc limit 1
)
where u.raw_record_id is null and u.order_guid is not null
 and exists (select 1 from public.toast_raw_records x
 where x.business_id=u.business_id and x.restaurant_guid=u.restaurant_guid
 and x.business_date=u.business_date and x.entity='order' and x.entity_guid=u.order_guid);

-- Keep existing sales/void/refund math strictly byte-identical.

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
    modifiers,voided,voided_by,category)
   values(v_id,v_item,ln->>'posItemId',coalesce(ln->>'name','Menu item'),
    (ln->>'quantity')::numeric,(ln->>'netSalesCents')::bigint,
    coalesce(ln->'modifiers','[]'::jsonb),coalesce((ln->>'voided')::boolean,false),
    null,ln->>'category');
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
 insert into public.toast_refund_facts(business_id,restaurant_guid,order_guid,payment_guid,
  order_business_date,refund_business_date,amount_cents)
 select p_business_id,p_restaurant_guid,x.order_guid,x.payment_guid,
  x.order_business_date,x.refund_business_date,x.amount_cents
 from jsonb_to_recordset(p_summary->'refund_facts') as x(
  order_guid uuid,payment_guid uuid,order_business_date date,refund_business_date date,amount_cents bigint);
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
 perform public.toast_archive_day_pages(p_run_id,p_business_date);
 -- The parser uses 1-based source indexes; even orders without a valid GUID link exactly.
 update public.toast_unparsed_orders u set raw_record_id=r.id
 from jsonb_to_recordset(p_summary->'unparsed') as x(
   order_guid uuid,raw_sha256 text,source_page integer,source_index integer)
 join public.toast_raw_records r
   on r.run_id=p_run_id and r.business_date=p_business_date
   and r.source_page=x.source_page and r.source_index=x.source_index
   and r.entity='order' and r.business_id=p_business_id
 where u.business_id=p_business_id and u.restaurant_guid=p_restaurant_guid
   and u.business_date=p_business_date and u.raw_sha256=x.raw_sha256
   and u.raw_record_id is distinct from r.id;
 delete from public.toast_day_pages where run_id=p_run_id and business_date=p_business_date;
 return jsonb_build_object('orders',v_count,'net_sales_cents',v_net);
end $$;
