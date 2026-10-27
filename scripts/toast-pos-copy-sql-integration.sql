-- Disposable Supabase after ALL migrations. Never target the owner's production DB.
\set ON_ERROR_STOP on
begin;
do $$
declare n integer;
begin
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
insert into public.businesses(id,name,is_demo)
 values('cccccccc-cccc-4ccc-8ccc-cccccccccccc','Toast 101 disposable café',false);
insert into public.locations(id,business_id,name)
 values('cccccccc-cccc-4ccc-8ccc-cccccccccc01','cccccccc-cccc-4ccc-8ccc-cccccccccccc','Disposable register');
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
  '2026-10-31T10:00:00Z','2026-10-31T12:00:00Z',2000,'verified','[]',true);
 select public.pos_import_toast_attendance(b,r) into changes;
 if (changes->>'changed')::int<>3 or (changes->>'skipped')::int<>1 then
  raise exception 'attendance must import three valid entries, skip only overlap: %',changes;
 end if;
 select count(*) into n from public.timecards
  where business_id=b and source_provider='Toast';
 if n<>3 then raise exception 'automatic attendance row count: %',n;end if;
 if not exists(select 1 from public.timecards
  where business_id=b and pos_timecard_id='toast:'||r::text||':cccccccc-cccc-4ccc-8ccc-cccccccc0022'
  and hourly_wage_cents=1500 and wage_source='estimate')
 then raise exception 'employee default wage must be explicitly estimated';end if;
 if not exists(select 1 from public.timecards
  where business_id=b and pos_timecard_id='toast:'||r::text||':cccccccc-cccc-4ccc-8ccc-cccccccc0023'
  and hourly_wage_cents is null and wage_source='unknown')
 then raise exception 'unknown hourly wage must remain SQL NULL';end if;
 if not exists(select 1 from public.pos_import_reviews
  where business_id=b and review_type='overlapping_timecard'
  and source_key='toast:'||r::text||':cccccccc-cccc-4ccc-8ccc-cccccccc0024')
 then raise exception 'overlapping owner timecard must be reviewed';end if;
 select public.pos_import_toast_attendance(b,r) into changes;
 if (changes->>'changed')::int<>0 then
  raise exception 'second attendance import changed canonical rows: %',changes;end if;
 select count(*) into n from public.pos_import_reviews
  where business_id=b and review_type='overlapping_timecard';
 if n<>1 then raise exception 'duplicate overlap review rows';end if;
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

rollback;
