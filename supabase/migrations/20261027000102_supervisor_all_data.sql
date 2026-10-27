-- PR #202: exactly one additive, re-runnable migration after #201's 101.
-- No client/server auth bypass: existing businesses membership RLS remains intact.
alter table public.businesses
 add column if not exists target_ingredient_cost_rate numeric(7,6),
 add column if not exists target_ingredient_cost_rate_status text;
do $guard$
begin
 if not exists(select 1 from pg_constraint where conrelid='public.businesses'::regclass
   and conname='businesses_target_ingredient_rate_guard') then
  alter table public.businesses add constraint businesses_target_ingredient_rate_guard
   check(target_ingredient_cost_rate is null or
    (target_ingredient_cost_rate>=0 and target_ingredient_cost_rate<1));
 end if;
 if not exists(select 1 from pg_constraint where conrelid='public.businesses'::regclass
   and conname='businesses_ingredient_source_guard') then
  alter table public.businesses add constraint businesses_ingredient_source_guard
   check(target_ingredient_cost_rate_status is null or
    target_ingredient_cost_rate_status in ('owner','confirmed','estimated','missing'));
 end if;
 -- The existing businesses tenant policy is carried by membership-guarded
 -- application reads and writes. Do not flip RLS in a data-additive PR:
 -- enabling it without migrating its existing policy would lock owners out.
end $guard$;

-- One restaurant/location may belong to only one tenant. Duplicate rows are
-- intentionally rejected rather than repaired by an unsafe automated merge.
do $links$
begin
 if exists(select 1 from public.toast_location_mappings
     group by restaurant_guid having count(distinct business_id)>1)
 then raise exception 'A Toast restaurant is already linked to another café';end if;
 if exists(select 1 from public.locations where pos_location_id is not null
     group by pos_location_id having count(distinct business_id)>1)
 then raise exception 'A Square location is already linked to another café';end if;
end $links$;
create unique index if not exists toast_one_cafe_per_restaurant_uidx
 on public.toast_location_mappings(restaurant_guid);
create unique index if not exists square_one_cafe_per_location_uidx
 on public.locations(pos_location_id) where pos_location_id is not null;

-- Fix deletion FK blockers without changing ACLs, existing policies or data.
do $cascade$
declare tab text; fk record;
begin
 foreach tab in array array[
  'toast_rollup_refresh_jobs','toast_analytics_credentials',
  'toast_analytics_rate_calls','toast_first_import_check'
 ] loop
  if to_regclass('public.'||tab) is null then
   raise exception 'Required Toast lifecycle table % is absent',tab;
  end if;
  for fk in select c.conname from pg_constraint c
   where c.conrelid=to_regclass('public.'||tab)
    and c.confrelid='public.businesses'::regclass and c.contype='f'
  loop
   execute format('alter table public.%I drop constraint %I',tab,fk.conname);
   execute format('alter table public.%I add constraint %I foreign key(business_id) references public.businesses(id) on delete cascade',tab,fk.conname);
  end loop;
  if not exists(select 1 from pg_constraint c
    where c.conrelid=to_regclass('public.'||tab)
      and c.confrelid='public.businesses'::regclass and c.contype='f') then
   execute format('alter table public.%I add constraint %I foreign key(business_id) references public.businesses(id) on delete cascade',
    tab,tab||'_business_fk_cascade');
  end if;
  if not (select relrowsecurity from pg_class where oid=to_regclass('public.'||tab))
   then raise exception 'RLS unexpectedly disabled on %',tab;end if;
 end loop;
end $cascade$;

-- Legacy Toast staging points at canonical rows with ON DELETE RESTRICT.
-- Those links can block owner café deletion after business-owned canonical
-- employees, menu items and modifier recipes are cascaded. Repoint nullable
-- catalog identities to SET NULL (preserve the catalog and its price history)
-- and cascade employee directory identities, whose linked_at check requires
-- the directory row to disappear with the canonical employee.
-- Reapplying migration 102 replaces each constraint with the same definition.
alter table public.toast_catalog_facts
 drop constraint if exists toast_catalog_facts_linked_menu_item_id_fkey;
alter table public.toast_catalog_facts
 add constraint toast_catalog_facts_linked_menu_item_id_fkey
 foreign key(linked_menu_item_id) references public.menu_items(id) on delete set null;
alter table public.toast_catalog_facts
 drop constraint if exists toast_catalog_facts_linked_modifier_recipe_id_fkey;
alter table public.toast_catalog_facts
 add constraint toast_catalog_facts_linked_modifier_recipe_id_fkey
 foreign key(linked_modifier_recipe_id) references public.modifier_recipes(id) on delete set null;
alter table public.toast_employee_directory
 drop constraint if exists toast_employee_directory_linked_employee_id_fkey;
alter table public.toast_employee_directory
 add constraint toast_employee_directory_linked_employee_id_fkey
 foreign key(linked_employee_id) references public.employees(id) on delete cascade;

-- Preserve ALL existing import logic and update only the order's canonical extras.
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

revoke all on function public.toast_import_day(uuid,uuid,uuid,date,jsonb,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.toast_import_day(uuid,uuid,uuid,date,jsonb,jsonb,uuid) to service_role;

-- Usage evidence is now provider-neutral; only canonical paid/clocked timecards
-- and approved canonical modifier mappings qualify.
create or replace function public.pantry_usage_sales_evidence(
 p_business_id uuid,p_from date,p_to date
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_covered boolean;v_staff jsonb;
begin
 if auth.uid() is null or not exists (
  select 1 from public.memberships m where m.business_id=p_business_id
   and m.user_id=auth.uid() and m.role='owner'
 ) then raise exception 'not authorized' using errcode='42501';end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>30
  then raise exception 'invalid usage range';end if;
 select not exists (
  select 1 from generate_series(p_from,p_to,interval '1 day') d
  where not exists (
   select 1 from public.daily_rollups r where r.business_id=p_business_id
    and r.business_date=d::date and r.sales_data_status='actual'
  )
 ) into v_covered;
 select coalesce(jsonb_agg(jsonb_build_object(
   'id',t.id::text,'clockIn',t.clock_in,'clockOut',t.clock_out,
   'locationId',null,'staff',coalesce(e.display_name,'Unlinked employee'),
   'staffId',t.employee_id::text
  ) order by t.clock_in,t.id),'[]'::jsonb) into v_staff
 from public.timecards t
 join public.businesses b on b.id=t.business_id
 left join public.employees e on e.id=t.employee_id and e.business_id=t.business_id
 where t.business_id=p_business_id and t.source_type<>'owner_schedule'
   and t.clock_in < ((p_to+1)::timestamp at time zone b.timezone)
   and coalesce(t.clock_out,now()) >= (p_from::timestamp at time zone b.timezone);
 return jsonb_build_object('covered',v_covered,'staff',v_staff,
  'modifierMappings',coalesce((
    -- Preserve migration 099's linked Toast catalog modifier mappings.
    select jsonb_agg(jsonb_build_object('provider','toast',
     'locationRef',c.restaurant_guid::text,
     'posModifierId',c.provider_guid::text,
     'recipeId',c.linked_modifier_recipe_id::text))
    from public.toast_catalog_facts c
    join public.modifier_recipes cr
     on cr.id=c.linked_modifier_recipe_id and cr.business_id=c.business_id
    where c.business_id=p_business_id and c.kind='modifier'
     and c.linked_modifier_recipe_id is not null
   ),'[]'::jsonb) || coalesce((
    select jsonb_agg(jsonb_build_object('provider',l.provider,'locationRef',l.location_ref,
     'posModifierId',l.pos_modifier_id,'recipeId',l.modifier_recipe_id::text))
    from public.pantry_modifier_links l
    join public.modifier_recipes r on r.id=l.modifier_recipe_id and r.business_id=l.business_id
    where l.business_id=p_business_id
   ),'[]'::jsonb));
end $$;

revoke all on function public.pantry_usage_sales_evidence(uuid,date,date) from public,anon,authenticated;
grant execute on function public.pantry_usage_sales_evidence(uuid,date,date) to authenticated;


-- Square sync lease: safely serialize repeated/overlapping cron invocations.
create table if not exists public.square_sync_leases(
 business_id uuid primary key references public.businesses(id) on delete cascade,
 locked_until timestamptz not null default '-infinity'::timestamptz
);
alter table public.square_sync_leases enable row level security;
revoke all on public.square_sync_leases from public,anon,authenticated;
grant select,insert,update,delete on public.square_sync_leases to service_role;
create or replace function public.square_claim_sync_lease(p_business_id uuid,p_seconds integer)
returns boolean language plpgsql security definer set search_path=public as $lease$
declare claimed integer;
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 if p_seconds<1 or p_seconds>600 then raise exception 'invalid lease';end if;
 insert into public.square_sync_leases(business_id,locked_until)
 values(p_business_id,now()+make_interval(secs=>p_seconds))
 on conflict(business_id) do update set locked_until=excluded.locked_until
 where public.square_sync_leases.locked_until<now();
 get diagnostics claimed=row_count;
 return claimed=1;
end $lease$;
revoke all on function public.square_claim_sync_lease(uuid,integer) from public,anon,authenticated;
grant execute on function public.square_claim_sync_lease(uuid,integer) to service_role;


-- Canonical scheduling facts support both Toast and Square without miscounting
-- scheduled time as paid labor.
do $scheduled$
declare rec record;
begin
 for rec in select conname from pg_constraint
  where conrelid='public.pos_scheduled_shifts'::regclass and contype='c'
   and pg_get_constraintdef(oid) ilike '%provider%'
 loop
  execute format('alter table public.pos_scheduled_shifts drop constraint %I',rec.conname);
 end loop;
 if exists(select 1 from public.pos_scheduled_shifts where provider is null or provider not in ('toast','square')) then
  raise exception 'Migration 102: pos_scheduled_shifts contains unsupported provider; expected toast or square';
 end if;
 if not exists(select 1 from pg_constraint
   where conrelid='public.pos_scheduled_shifts'::regclass
    and conname='pos_scheduled_shifts_supported_provider') then
  alter table public.pos_scheduled_shifts add constraint pos_scheduled_shifts_supported_provider
   check(provider in ('toast','square'));
 end if;
end $scheduled$;


-- Square and other shared adapters must never erase previously imported
-- order lines if one replacement row fails validation. Postgres runs all
-- statements in this RPC in one transaction and rolls them back together.
-- SECURITY INVOKER preserves the caller's RLS (owners) or service role.
create or replace function public.pos_replace_order_lines(
 p_business_id uuid,p_order_id uuid,p_lines jsonb)
returns void language plpgsql security invoker set search_path=public as $lines$
begin
 -- A staff member must not obtain a general order-write capability via RPC.
 -- Privileged ingestion and the database owner remain able to run migrations/tests.
 if current_user not in ('postgres','service_role') and
    not exists(select 1 from public.memberships m
      where m.business_id=p_business_id and m.user_id=auth.uid()
      and m.role='owner') then
  raise exception 'POS order replacement requires café owner'
    using errcode='42501';
 end if;
 if p_business_id is null or p_order_id is null or
   jsonb_typeof(p_lines) is distinct from 'array' or
   jsonb_array_length(p_lines)>2000 then
  raise exception 'invalid POS order-line replacement';
 end if;
 if not exists(select 1 from public.orders
   where id=p_order_id and business_id=p_business_id) then
  raise exception 'POS order is not available in this café';
 end if;
 if exists(
  select 1 from jsonb_to_recordset(p_lines) as x(menu_item_id uuid)
  where x.menu_item_id is not null and not exists(
   select 1 from public.menu_items m
    where m.id=x.menu_item_id and m.business_id=p_business_id)
 ) then raise exception 'POS order line refers to another or missing café item';end if;
 delete from public.order_lines where order_id=p_order_id;
 insert into public.order_lines(
   order_id,pos_item_id,menu_item_id,name,quantity,net_sales_cents,
   modifiers,voided,voided_by,category)
 select p_order_id,lines.pos_item_id,lines.menu_item_id,lines.name,
   lines.quantity,lines.net_sales_cents,coalesce(lines.modifiers,'[]'::jsonb),
   coalesce(lines.voided,false),lines.voided_by,lines.category
 from jsonb_to_recordset(p_lines) as lines(
   pos_item_id text,menu_item_id uuid,name text,quantity numeric,
   net_sales_cents bigint,modifiers jsonb,voided boolean,voided_by text,category text);
end $lines$;
revoke all on function public.pos_replace_order_lines(uuid,uuid,jsonb)
 from public,anon,authenticated;
grant execute on function public.pos_replace_order_lines(uuid,uuid,jsonb)
 to authenticated,service_role;
