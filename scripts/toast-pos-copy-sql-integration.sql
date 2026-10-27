-- Disposable Supabase after ALL migrations. Never target the owner's production DB.
\set ON_ERROR_STOP on
begin;
do $$
declare n integer;
begin
 select count(*) into n from information_schema.columns
 where table_schema='public' and table_name='businesses'
 and column_name in ('owner_monthly_payroll_extras_cents','owner_monthly_payroll_extras_updated_at');
 if n<>2 then raise exception 'owner monthly payroll setting is missing: %',n;end if;
 select count(*) into n from information_schema.columns
 where table_schema='public' and table_name='menu_items'
 and column_name in ('description','pos_visibility','pos_pricing_strategy','pos_archived_at','pos_name','pos_metadata');
 if n<>6 then raise exception 'menu_items Toast columns incomplete: %',n;end if;
 select count(*) into n from information_schema.columns
 where table_schema='public' and table_name='modifier_recipes'
 and column_name in ('price_cents','pos_group_id','pos_group_name','is_active','catalog_source','catalog_last_synced_at');
 if n<>6 then raise exception 'modifier_recipes Toast columns incomplete: %',n;end if;
 if not exists(select 1 from information_schema.columns
 where table_schema='public' and table_name='timecards'
 and column_name='hourly_wage_cents' and is_nullable='YES')
 then raise exception 'unknown timecard wage must be nullable';end if;
 if not exists(select 1 from information_schema.columns
 where table_schema='public' and table_name='timecards'
 and column_name='wage_source') then raise exception 'wage provenance missing';end if;
 if not exists(select 1 from information_schema.columns
 where table_schema='public' and table_name='daily_rollups'
 and column_name='labor_wage_status') then raise exception 'labor quality missing';end if;
 if not exists(select 1 from pg_indexes where schemaname='public'
 and tablename='modifier_recipes' and indexname='modifier_recipes_business_pos_uidx')
 then raise exception 'unique modifier ID missing';end if;
 if not exists(select 1 from pg_indexes where schemaname='public'
 and tablename='pos_item_aliases' and indexname='pos_item_aliases_pkey')
 then raise exception 'CSV alias uniqueness missing';end if;
 select count(*) into n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
 where ns.nspname='public' and c.relname in
 ('menu_item_modifier_groups','pos_item_aliases','pos_import_reviews') and c.relrowsecurity;
 if n<>3 then raise exception 'catalog/review RLS incomplete %',n;end if;
 select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
 where ns.nspname='public' and p.proname in
 ('pos_relink_toast_lines','pos_import_toast_attendance') and p.prosecdef
 and p.proconfig @> array['search_path=public'];
 if n<>2 then raise exception 'service-only SQL handlers not hardened: %',n;end if;
 if not exists(select 1 from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
  where ns.nspname='public' and p.proname='toast_business_scope_summary'
   and p.prosecdef and p.proconfig @> array['search_path=public'])
 then raise exception 'Toast owner-only scopes function not secured';end if;
 if has_function_privilege('anon','public.toast_business_scope_summary(uuid)','EXECUTE')
 then raise exception 'anonymous role can read Toast scopes';end if;
end $$;
-- A missing wage round-trips as SQL NULL; there must be no forced-zero fallback.
do $$
declare v_default text;
begin
 select c.column_default into v_default from information_schema.columns c
 where table_schema='public' and table_name='timecards' and column_name='hourly_wage_cents';
 if v_default is not null then
  raise exception 'timecards hourly_wage_cents must not have a synthetic default';
 end if;
end $$;

-- S4-S7: per-entry automatic attendance is idempotent, nullable and isolated.
-- All fixtures are synthetic and rolled back with the outer transaction.
select set_config('request.jwt.claim.role','service_role',true);
-- Owner scope function must never reveal data to the service role or strangers.
do $$
begin
 begin
  perform public.toast_business_scope_summary('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  raise exception 'Toast owner-only scope function accepted service role';
 exception when sqlstate '42501' then null;
 end;
end $$;
insert into public.businesses(id,name,is_demo)
 values('cccccccc-cccc-4ccc-8ccc-cccccccccccc','Toast 101 disposable café',false);
insert into public.locations(id,business_id,name)
 values('cccccccc-cccc-4ccc-8ccc-cccccccccc01','cccccccc-cccc-4ccc-8ccc-cccccccccccc','Disposable register');
-- Owner input is separate from Toast hourly wages, can be zero when explicitly
-- stated, and survives independent attendance re-imports.
update public.businesses
 set owner_monthly_payroll_extras_cents=37500,owner_monthly_payroll_extras_updated_at=now()
 where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
do $$ begin
 if (select owner_monthly_payroll_extras_cents from public.businesses
     where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc')<>37500
 then raise exception 'owner-stated monthly payroll not saved';end if;
 begin
  update public.businesses set owner_monthly_payroll_extras_cents=-1
   where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  raise exception 'negative monthly payroll costs must be rejected';
 exception when check_violation then null;
 end;
end $$;
select public.toast_save_configuration('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
 'https://ws-api.toasttab.com','disposable_test','synthetic_ciphertext',
 '[{"location_id":"cccccccc-cccc-4ccc-8ccc-cccccccccc01","restaurant_guid":"cccccccc-cccc-4ccc-8ccc-ccccccccff01"}]'::jsonb);
update public.toast_location_mappings set verified_at=now()
 where business_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'
 and restaurant_guid='cccccccc-cccc-4ccc-8ccc-ccccccccff01';
do $integration$
declare b uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 r uuid:='cccccccc-cccc-4ccc-8ccc-ccccccccff01';
 loc uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccc01';
 a uuid; unknown_employee uuid; changes jsonb; n integer;
begin
 insert into public.employees(business_id,display_name,default_hourly_wage_cents)
  values(b,'Linked barista',1500) returning id into a;
 insert into public.employees(business_id,display_name,default_hourly_wage_cents)
  values(b,'Unknown-wage barista',null) returning id into unknown_employee;
 insert into public.toast_employee_directory(
  business_id,restaurant_guid,employee_guid,display_name,linked_employee_id,linked_at)
 values
 (b,r,'cccccccc-cccc-4ccc-8ccc-cccccccc0011','Linked barista',a,now()),
 (b,r,'cccccccc-cccc-4ccc-8ccc-cccccccc0012','Unknown-wage barista',unknown_employee,now());
 insert into public.timecards(business_id,employee_id,clock_in,clock_out,
   hourly_wage_cents,source_type,source_provider)
 values(b,a,'2026-10-27T13:00:00Z','2026-10-27T14:00:00Z',
   2300,'owner_manual','Owner');
 insert into public.timecards(business_id,employee_id,clock_in,clock_out,
  hourly_wage_cents,source_type,source_provider)
 values(b,a,'2026-11-01T09:00:00Z','2026-11-01T11:00:00Z',
  null,'owner_schedule','Owner');
 insert into public.toast_labor_entries(business_id,restaurant_guid,location_id,
  external_time_entry_id,external_employee_id,clock_in,clock_out,
  hourly_wage_cents,wage_status,breaks,deleted)
 values
 (b,r,loc,'cccccccc-cccc-4ccc-8ccc-cccccccc0021',
  'cccccccc-cccc-4ccc-8ccc-cccccccc0011',
  '2026-10-26T06:00:00Z','2026-10-26T09:00:00Z',2000,'verified','[]',false),
 (b,r,loc,'cccccccc-cccc-4ccc-8ccc-cccccccc0022',
  'cccccccc-cccc-4ccc-8ccc-cccccccc0011',
  '2026-10-28T10:00:00Z','2026-10-28T12:00:00Z',null,'missing','[]',false),
 (b,r,loc,'cccccccc-cccc-4ccc-8ccc-cccccccc0023',
  'cccccccc-cccc-4ccc-8ccc-cccccccc0012',
  '2026-10-29T10:00:00Z','2026-10-29T12:00:00Z',null,'missing','[]',false),
 (b,r,loc,'cccccccc-cccc-4ccc-8ccc-cccccccc0024',
  'cccccccc-cccc-4ccc-8ccc-cccccccc0011',
  '2026-10-27T12:00:00Z','2026-10-27T15:00:00Z',1800,'verified','[]',false),
 (b,r,loc,'cccccccc-cccc-4ccc-8ccc-cccccccc0025',
  'cccccccc-cccc-4ccc-8ccc-cccccccc0012',
  '2026-10-30T10:00:00Z',null,null,'missing','[]',false),
 (b,r,loc,'cccccccc-cccc-4ccc-8ccc-cccccccc0026',
  'cccccccc-cccc-4ccc-8ccc-cccccccc0012',
  '2026-10-31T10:00:00Z','2026-10-31T12:00:00Z',2000,'verified','[]',true),
 (b,r,loc,'cccccccc-cccc-4ccc-8ccc-cccccccc0027',
  'cccccccc-cccc-4ccc-8ccc-cccccccc0011',
  '2026-11-01T09:00:00Z','2026-11-01T11:00:00Z',2000,'verified','[]',false);
 select public.pos_import_toast_attendance(b,r) into changes;
 if (changes->>'changed')::int<>4 or (changes->>'skipped')::int<>1 then
  raise exception 'attendance must import four valid entries and review one paid overlap: %',changes;
 end if;
 select count(*) into n from public.timecards
  where business_id=b and source_provider='Toast';
 if n<>4 then raise exception 'automatic attendance row count: %',n;end if;
 if not exists(select 1 from public.timecards
  where business_id=b and pos_timecard_id='toast:'||r::text||':cccccccc-cccc-4ccc-8ccc-cccccccc0022'
  and hourly_wage_cents=1500 and wage_source='estimate')
 then raise exception 'employee default wage must be explicitly estimated';end if;
 if not exists(select 1 from public.timecards
  where business_id=b and pos_timecard_id='toast:'||r::text||':cccccccc-cccc-4ccc-8ccc-cccccccc0023'
  and hourly_wage_cents is null and wage_source='unknown')
 then raise exception 'unknown hourly wage must remain SQL NULL';end if;
 if exists(select 1 from public.timecards where business_id=b
  and source_type='owner_schedule' and employee_id=a)
 then raise exception 'owner plan was not replaced by Toast clock-in';end if;
 if not exists(select 1 from public.timecards where business_id=b
  and pos_timecard_id='toast:'||r::text||':cccccccc-cccc-4ccc-8ccc-cccccccc0027')
 then raise exception 'Toast actual timecard failed to replace plan';end if;
 if exists(select 1 from public.pos_import_reviews where business_id=b
  and review_type='overlapping_timecard'
  and source_key='toast:'||r::text||':cccccccc-cccc-4ccc-8ccc-cccccccc0027')
 then raise exception 'plan must not create a paid-overlap review';end if;
 if not exists(select 1 from public.pos_import_reviews
  where business_id=b and review_type='overlapping_timecard'
  and source_key='toast:'||r::text||':cccccccc-cccc-4ccc-8ccc-cccccccc0024')
 then raise exception 'overlapping owner timecard must be reviewed';end if;
 select public.pos_import_toast_attendance(b,r) into changes;
 if (changes->>'changed')::int<>0 then
  raise exception 'second attendance import changed canonical rows: %',changes;end if;
 select count(*) into n from public.pos_import_reviews
  where business_id=b and review_type='overlapping_timecard';
 if n<>1 then raise exception 'one review for true paid overlap; no duplicate reviews';end if;
 update public.toast_labor_entries set clock_out='2026-10-26T10:00:00Z'
  where business_id=b and restaurant_guid=r
  and external_time_entry_id='cccccccc-cccc-4ccc-8ccc-cccccccc0021';
 select public.pos_import_toast_attendance(b,r) into changes;
 if (changes->>'changed')::int<>1 or
    jsonb_array_length(changes->'changedIntervals')<>2 then
  raise exception 'corrected interval must include new+old days: %',changes;end if;
 update public.timecards set pos_owner_edited=true,wage_source='owner'
  where business_id=b and pos_timecard_id='toast:'||r::text||':cccccccc-cccc-4ccc-8ccc-cccccccc0021';
 update public.toast_labor_entries set clock_out='2026-10-26T11:00:00Z'
  where business_id=b and restaurant_guid=r
  and external_time_entry_id='cccccccc-cccc-4ccc-8ccc-cccccccc0021';
 select public.pos_import_toast_attendance(b,r) into changes;
 if (changes->>'changed')::int<>0 or not exists(
  select 1 from public.pos_import_reviews where business_id=b
  and review_type='shift_corrected'
  and source_key='toast:'||r::text||':cccccccc-cccc-4ccc-8ccc-cccccccc0021')
 then raise exception 'owner-edited shift must never be replaced by Toast';end if;
 if (select clock_out from public.timecards where business_id=b
   and pos_timecard_id='toast:'||r::text||':cccccccc-cccc-4ccc-8ccc-cccccccc0021')
    <>'2026-10-26T10:00:00Z'::timestamptz then
  raise exception 'provider overwrite of owner-controlled timecard';end if;
end
$integration$;


-- G6/G7/G10/G11: sold-only GUIDs are archived once, sized lines recover
-- after the catalog arrives, and re-link never touches another café's sales.
do $catalog_link$
declare b uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 r uuid:='cccccccc-cccc-4ccc-8ccc-ccccccccff01';
 loc uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccc01';
 item_guid text:='cccccccc-cccc-4ccc-8ccc-cccccccc0030';
 size_guid text:='cccccccc-cccc-4ccc-8ccc-cccccccc0040';
 pos text;test_order_id uuid;line_id uuid;archived_id uuid;sized_id uuid;
 actual_id uuid; n integer;
begin
 pos:='toast:'||r::text||':'||item_guid;
 insert into public.orders(business_id,location_id,pos_order_id,closed_at,
  business_date,gross_sales_cents,net_sales_cents)
 values(b,loc,'toast:copy-synthetic-001','2026-10-26T18:00:00Z',
   '2026-10-26',550,550) returning id into test_order_id;
 insert into public.order_lines(order_id,pos_item_id,name,quantity,
  net_sales_cents,voided,modifiers)
 values(test_order_id,pos,'Latte sold before menu import',1,550,false,
   jsonb_build_array(jsonb_build_object(
    'posModifierId',size_guid,'name','Large','quantity',1)))
 returning id into line_id;
 perform public.pos_relink_toast_lines(b,r);
 select menu_item_id into archived_id from public.order_lines where id=line_id;
 if archived_id is null or not exists(select 1 from public.menu_items
   where id=archived_id and business_id=b and is_active=false
   and price_cents is null and pos_item_id=pos)
 then raise exception 'unknown sold-only item must be one archived null-price row';end if;
 perform public.pos_relink_toast_lines(b,r);
 select count(*) into n from public.menu_items where business_id=b and pos_item_id=pos;
 if n<>1 then raise exception 'repeated sold-only relink duplicated menu identity';end if;
 insert into public.menu_items(business_id,pos_item_id,name,base_name,
   size_label,price_cents,is_active,catalog_source)
 values(b,pos||':size:'||size_guid,'Latte','Latte','Large',550,true,'toast')
 returning id into sized_id;
 perform public.pos_relink_toast_lines(b,r);
 select menu_item_id into actual_id from public.order_lines where id=line_id;
 if actual_id is distinct from sized_id then
  raise exception 'sold base guid and size modifier did not relink to canonical size';end if;
 if not exists(select 1 from public.menu_items where id=archived_id
   and is_active=false)then
  raise exception 'relink must retain archived item and historical identity';end if;
 perform public.pos_relink_toast_lines(b,r);
 if (select menu_item_id from public.order_lines where id=line_id)
   is distinct from sized_id then
  raise exception 'second sized relink changed canonical identity';end if;
 if (select count(*) from public.order_lines l where l.order_id=test_order_id)<>1 then
  raise exception 'relink must not duplicate sales lines';end if;
end
$catalog_link$;

rollback;
