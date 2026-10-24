-- PR1: disabled-by-default Toast day import foundation.
alter table public.toast_location_mappings
 add column if not exists toast_time_zone text,
 add column if not exists closeout_hour smallint check(closeout_hour between 0 and 12),
 add column if not exists info_refreshed_at timestamptz,
 add column if not exists toast_start_date date;
alter table public.toast_api_credentials add column if not exists scopes_available jsonb not null default '{}'::jsonb;
alter table public.orders add column if not exists toast_excluded boolean not null default false;
alter table public.orders add column if not exists superseded_by text;
alter table public.daily_rollups add column if not exists voids_status text not null default 'unknown'
 check(voids_status in ('unknown','complete'));
alter table public.daily_rollups add column if not exists voids_source text;

create table public.toast_sync_runs(
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null,restaurant_guid uuid not null,
 kind text not null check(kind in ('daily','backfill','repull_modified','reconcile','menu','labor')),
 requested_from date,requested_to date,
 state text not null default 'queued' check(state in ('queued','running','paused_rate_limited','completed','failed')),
 cursor jsonb not null default '{}'::jsonb,
 days_done integer not null default 0,days_total integer not null default 0,
 orders_seen integer not null default 0,orders_unparsed integer not null default 0,
 api_calls integer not null default 0,rate_limited_count integer not null default 0,
 last_error_category text,resume_at timestamptz,started_at timestamptz,
 finished_at timestamptz,lease_until timestamptz,lease_nonce uuid,
 foreign key(business_id,restaurant_guid) references public.toast_location_mappings(business_id,restaurant_guid)
);
create table public.toast_day_pages(
 run_id uuid not null references public.toast_sync_runs(id) on delete cascade,
 business_date date not null,page integer not null check(page between 1 and 300),
 payload jsonb not null check(jsonb_typeof(payload)='array' and jsonb_array_length(payload)<=100),
 primary key(run_id,business_date,page)
);
create table public.toast_day_status(
 business_id uuid not null,restaurant_guid uuid not null,business_date date not null,
 import_state text not null default 'missing' check(import_state in ('missing','imported','failed')),
 recon_state text not null default 'pending' check(recon_state in ('pending','matched','mismatch','checked_internal','owner_flagged')),
 imported_at timestamptz,net_sales_cents bigint,gross_sales_cents bigint,
 discounts_cents bigint,refunds_cents bigint,tax_cents bigint,tip_cents bigint,
 order_count integer,open_check_count integer,service_charges_cents bigint,
 gratuity_cents bigint,
 toast_net_sales_cents bigint,toast_orders_count integer,toast_discount_cents bigint,
 toast_refund_cents bigint,delta_net_cents bigint,delta_orders integer,
 recon_source text check(recon_source in ('toast_analytics','internal')),
 reconciled_at timestamptz,unparsed_count integer not null default 0,
 coverage_complete boolean not null default false,
 warnings jsonb not null default '{}'::jsonb,orders_snapshot_sha256 text,
 last_import_run_id uuid references public.toast_sync_runs(id),
 last_error_category text,
 primary key(business_id,restaurant_guid,business_date),
 foreign key(business_id,restaurant_guid) references public.toast_location_mappings(business_id,restaurant_guid)
);
create table public.toast_unparsed_orders(
 business_id uuid not null,restaurant_guid uuid not null,business_date date not null,
 raw_sha256 text not null check(length(raw_sha256)=64),
 order_guid uuid,error_path text not null,
 first_seen timestamptz not null default now(),last_seen timestamptz not null default now(),
 primary key(business_id,restaurant_guid,business_date,raw_sha256),
 foreign key(business_id,restaurant_guid) references public.toast_location_mappings(business_id,restaurant_guid)
);
create table public.toast_order_revisions(
 id bigint generated always as identity primary key,
 business_id uuid not null,restaurant_guid uuid not null,
 business_date date not null,pos_order_id text not null,
 before_cents bigint,after_cents bigint,observed_at timestamptz not null default now(),
 run_id uuid references public.toast_sync_runs(id),
 foreign key(business_id,restaurant_guid) references public.toast_location_mappings(business_id,restaurant_guid)
);
create table public.toast_void_facts(
 business_id uuid not null,location_id uuid not null,
 selection_guid uuid not null,order_guid uuid not null,check_guid uuid,
 order_business_date date not null,void_business_date date not null,
 voided_at timestamptz,amount_cents bigint,
 amount_basis text not null check(amount_basis in ('preDiscountPrice','price','receiptLinePrice','amount_missing')),
 void_reason_guid uuid,level text not null check(level in ('selection','check','order')),
 first_seen timestamptz not null default now(),last_seen timestamptz not null default now(),
 primary key(business_id,selection_guid),
 foreign key(business_id,location_id) references public.locations(business_id,id)
);
create index toast_void_facts_day on public.toast_void_facts(business_id,void_business_date);
create table public.toast_refund_facts(
 business_id uuid not null,restaurant_guid uuid not null,order_guid uuid not null,
 payment_guid uuid,order_business_date date not null,
 refund_business_date date,amount_cents bigint not null,
 id bigint generated always as identity primary key,
 foreign key(business_id,restaurant_guid) references public.toast_location_mappings(business_id,restaurant_guid)
);

-- New facts are owner-readable but no browser role may mutate them.
do $$
declare t text;
begin
 foreach t in array array['toast_sync_runs','toast_day_pages','toast_day_status',
  'toast_unparsed_orders','toast_order_revisions','toast_void_facts','toast_refund_facts'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  if t<>'toast_day_pages' then
   execute format('create policy "owner read" on public.%I for select to authenticated using (public.scheduling_is_owner(business_id))',t);
   execute format('grant select on public.%I to authenticated',t);
  end if;
  execute format('grant select,insert,update,delete on public.%I to service_role',t);
 end loop;
end $$;

create or replace function public.toast_stage_day_page(
 p_business_id uuid,p_restaurant_guid uuid,p_run_id uuid,
 p_business_date date,p_page integer,p_payload jsonb)
returns void language plpgsql security definer set search_path=public as $$
begin
 if auth.role()<>'service_role' or p_page not between 1 and 300
  or jsonb_typeof(p_payload)<>'array' or jsonb_array_length(p_payload)>100
  or not exists(select 1 from public.toast_sync_runs r where r.id=p_run_id
   and r.business_id=p_business_id and r.restaurant_guid=p_restaurant_guid
   and r.state in ('queued','running','paused_rate_limited'))
 then raise exception 'invalid Toast page';end if;
 insert into public.toast_day_pages(run_id,business_date,page,payload)
 values(p_run_id,p_business_date,p_page,p_payload)
 on conflict do nothing;
 update public.toast_sync_runs set cursor=jsonb_build_object('business_date',p_business_date,'page',p_page+1),
  api_calls=api_calls+1,orders_seen=orders_seen+jsonb_array_length(p_payload),state='running',
  started_at=coalesce(started_at,now()) where id=p_run_id;
end $$;
create or replace function public.toast_pause_day_run(
 p_run_id uuid,p_business_id uuid,p_restaurant_guid uuid,p_business_date date,
 p_page integer,p_resume_at timestamptz)
returns void language plpgsql security definer set search_path=public as $$
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 update public.toast_sync_runs set state='paused_rate_limited',resume_at=p_resume_at,
  rate_limited_count=rate_limited_count+1,
  cursor=jsonb_build_object('business_date',p_business_date,'page',p_page)
 where id=p_run_id and business_id=p_business_id and restaurant_guid=p_restaurant_guid;
end $$;
create or replace function public.toast_mark_day_failed(
 p_business_id uuid,p_restaurant_guid uuid,p_business_date date,p_run_id uuid,p_category text)
returns void language plpgsql security definer set search_path=public as $$
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 insert into public.toast_day_status(business_id,restaurant_guid,business_date,import_state,recon_state,last_error_category)
 values(p_business_id,p_restaurant_guid,p_business_date,'failed','pending',p_category)
 on conflict(business_id,restaurant_guid,business_date) do update
 set import_state='failed',coverage_complete=false,last_error_category=excluded.last_error_category;
 update public.daily_rollups set sales_data_status='missing' where business_id=p_business_id and business_date=p_business_date;
 update public.toast_sync_runs set state='failed',last_error_category=p_category,finished_at=now()
 where id=p_run_id and business_id=p_business_id and restaurant_guid=p_restaurant_guid;
end $$;

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
    processing_fee_cents,processing_fee_status,processing_fee_provider,net_sales_cents,toast_excluded)
  values(p_business_id,p_location_id,rec->>'posOrderId',(rec->>'closedAt')::timestamptz,p_business_date,
    (rec->>'grossSalesCents')::bigint,(rec->>'discountsCents')::bigint,
    (rec->>'refundsCents')::bigint,(rec->>'taxCents')::bigint,
    (rec->>'tipCents')::bigint,0,'missing','toast',v_new,false)
  on conflict(business_id,pos_order_id) do update
   set location_id=excluded.location_id,closed_at=excluded.closed_at,business_date=excluded.business_date,
   gross_sales_cents=excluded.gross_sales_cents,discounts_cents=excluded.discounts_cents,
   refunds_cents=excluded.refunds_cents,tax_cents=excluded.tax_cents,tip_cents=excluded.tip_cents,
   net_sales_cents=excluded.net_sales_cents,toast_excluded=false,
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
  card_fees_cents,voids_cents,sales_data_status)
 select p_business_id,p_business_date,
   coalesce(sum(o.net_sales_cents),0)::bigint,count(*)::integer,
   coalesce((select sum(l.quantity) from public.order_lines l
    join public.orders x on x.id=l.order_id where x.business_id=p_business_id
     and x.business_date=p_business_date and not x.toast_excluded
     and x.superseded_by is null and not l.voided),0)::integer,
   0,0,0,0,0,'missing'
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
 delete from public.toast_day_pages where run_id=p_run_id and business_date=p_business_date;
 return jsonb_build_object('orders',v_count,'net_sales_cents',v_net);
end $$;
do $$
declare signature text;
begin
 foreach signature in array array[
 'toast_stage_day_page(uuid,uuid,uuid,date,integer,jsonb)',
 'toast_pause_day_run(uuid,uuid,uuid,date,integer,timestamptz)',
 'toast_mark_day_failed(uuid,uuid,date,uuid,text)',
 'toast_import_day(uuid,uuid,uuid,date,jsonb,jsonb,uuid)'
 ] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',signature);
  execute format('grant execute on function public.%s to service_role',signature);
 end loop;
end $$;
revoke execute on function public.toast_promote_reconciled_day(uuid,uuid,uuid,date,text) from service_role;


-- The original 084 SQL rollup function doesn't recognize soft-excluded or
-- superseded rows. Replace its projection, retaining its permission contract.
create or replace function public.pos_rebuild_sales_fact_rollups_v1(
 p_business_id uuid,p_business_date date)
returns void language plpgsql security invoker set search_path=public as $rollup$
declare v_timezone text;
begin
 if p_business_id is null or p_business_date is null then raise exception 'Missing day';end if;
 if auth.role() is distinct from 'service_role'
  and not public.scheduling_is_owner(p_business_id) then raise exception 'Not allowed';end if;
 select b.timezone into v_timezone from public.businesses b where b.id=p_business_id;
 if v_timezone is null then raise exception 'Missing timezone';end if;
 perform pg_advisory_xact_lock(hashtextextended(
  'pos-sales-rollup:'||p_business_id::text||':'||p_business_date::text,0));
 delete from public.hourly_sales_rollup where business_id=p_business_id and business_date=p_business_date;
 insert into public.hourly_sales_rollup(business_id,location_id,business_date,hour_local,net_sales_cents,orders_count)
 select o.business_id,o.location_id,o.business_date,
  extract(hour from o.closed_at at time zone v_timezone)::smallint,
  sum(o.net_sales_cents)::bigint,count(*)::integer
 from public.orders o
 where o.business_id=p_business_id and o.business_date=p_business_date
  and not o.toast_excluded and o.superseded_by is null and o.pos_order_id not like 'csv-%'
 group by o.business_id,o.location_id,o.business_date,
  extract(hour from o.closed_at at time zone v_timezone)::smallint;
 delete from public.employee_sales_rollup where business_id=p_business_id and business_date=p_business_date;
 insert into public.employee_sales_rollup(business_id,employee_id,business_date,net_sales_cents,orders_count)
 select o.business_id,o.employee_id,o.business_date,sum(o.net_sales_cents)::bigint,count(*)::integer
 from public.orders o join public.employees e on e.id=o.employee_id and e.business_id=o.business_id
 where o.business_id=p_business_id and o.business_date=p_business_date
  and not o.toast_excluded and o.superseded_by is null
 group by o.business_id,o.employee_id,o.business_date;
end $rollup$;

create view public.toast_sync_health_v with (security_invoker=true) as
select m.business_id,m.restaurant_guid,
 (select max(r.finished_at) from public.toast_sync_runs r where r.business_id=m.business_id
   and r.restaurant_guid=m.restaurant_guid and r.state='completed'
   and r.orders_unparsed=0) as last_good_sync_at,
 (select min(s.business_date) from public.toast_day_status s where s.business_id=m.business_id
   and s.restaurant_guid=m.restaurant_guid and s.import_state='missing') as oldest_missing_day,
 (select count(*) from public.toast_day_status s where s.business_id=m.business_id
   and s.restaurant_guid=m.restaurant_guid and
   (s.import_state='failed' or s.recon_state in ('mismatch','owner_flagged'))) as days_needing_look,
 (select r.state from public.toast_sync_runs r where r.business_id=m.business_id
   and r.restaurant_guid=m.restaurant_guid order by r.started_at desc nulls last limit 1) as current_run_state
from public.toast_location_mappings m;
revoke all on public.toast_sync_health_v from public,anon,authenticated;
grant select on public.toast_sync_health_v to service_role;


-- Restore the existing invoker-RLS menu quantity endpoint with source-aware
-- order filtering. All consumers (pricing, snapshots, chat, product math) use it.
create or replace function public.menu_item_quantities_sold(
 p_business_id uuid,p_from date,p_to date)
returns table(menu_item_id uuid,total_quantity numeric)
language sql stable security invoker set search_path=public as $menu$
 select ol.menu_item_id,sum(ol.quantity)
 from public.order_lines ol
 join public.orders o on o.id=ol.order_id
 where o.business_id=p_business_id and o.business_date between p_from and p_to
  and not o.toast_excluded and o.superseded_by is null
  and not ol.voided and ol.menu_item_id is not null
 group by ol.menu_item_id
$menu$;

-- Non-Toast writers (CSV, Square, re-sync) must not re-activate a replaced
-- source on INSERT or UPDATE after the Toast day was imported.
create or replace function public.toast_supersede_non_toast_order()
returns trigger language plpgsql security invoker set search_path=public as $supersede$
begin
 if new.pos_order_id not like 'toast:%' and exists (
  select 1 from public.toast_day_status d
  join public.toast_location_mappings m
   on m.business_id=d.business_id and m.restaurant_guid=d.restaurant_guid
  where d.business_id=new.business_id and d.business_date=new.business_date
   and d.import_state='imported' and m.verified_at is not null
   and new.business_date>=coalesce(m.toast_start_date,new.business_date)
   and (m.location_id=new.location_id or
      (new.location_id is null and
       (select count(*) from public.locations where business_id=new.business_id)=1))
 ) then
  new.superseded_by='toast';
 end if;
 return new;
end $supersede$;
create trigger toast_supersede_late_order
 before insert or update of business_id,location_id,business_date,pos_order_id,superseded_by
 on public.orders for each row execute function public.toast_supersede_non_toast_order();

-- Preserve the coverage decision even if a later Square/CSV sync recomputes
-- the shared daily row after the Toast import. The trigger applies only to
-- dates with an actual Toast import, leaving unrelated POS days unchanged.
create or replace function public.toast_guard_daily_sales_coverage()
returns trigger language plpgsql security invoker set search_path=public as $guard$
begin
 if new.sales_data_status='actual' and exists (
  select 1 from public.toast_day_status d where d.business_id=new.business_id
   and d.business_date=new.business_date and d.import_state='imported'
 ) and (
  exists (
   select 1 from public.toast_location_mappings m
   left join public.toast_day_status d on d.business_id=m.business_id
    and d.restaurant_guid=m.restaurant_guid and d.business_date=new.business_date
   where m.business_id=new.business_id and m.verified_at is not null
    and new.business_date>=coalesce(m.toast_start_date,new.business_date)
    and (d.import_state is distinct from 'imported' or not coalesce(d.coverage_complete,false))
  ) or exists (
   select 1 from public.orders o
   where o.business_id=new.business_id and o.business_date=new.business_date
    and o.location_id is null and o.pos_order_id not like 'toast:%'
    and o.superseded_by is null
  )
 ) then
  new.sales_data_status='missing';
 end if;
 return new;
end $guard$;
create trigger toast_guard_daily_coverage
 before insert or update of sales_data_status
 on public.daily_rollups for each row
 execute function public.toast_guard_daily_sales_coverage();

-- Exact-order sales proof used by initiative monitors must agree with other
-- effective-order readers after a Toast/CSV overlap.
create or replace function public.initiative_daily_order_sales_proof(
 p_business_id uuid,p_date date)
returns table(order_count bigint,net_sales_cents bigint,synthetic_count bigint)
language sql security definer set search_path=public as $proof$
 select count(*)::bigint,coalesce(sum(o.net_sales_cents),0)::bigint,
 count(*) filter(where o.pos_order_id is null
  or o.pos_order_id like 'csv-%' or o.pos_order_id like 'csv:%')::bigint
 from public.orders o where o.business_id=p_business_id and o.business_date=p_date
  and not o.toast_excluded and o.superseded_by is null
$proof$;
