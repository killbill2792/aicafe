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
declare column_default text;
begin
 select column_default into column_default from information_schema.columns
 where table_schema='public' and table_name='timecards' and column_name='hourly_wage_cents';
 if column_default is not null then
  raise exception 'timecards hourly_wage_cents must not have a synthetic default';
 end if;
end $$;
rollback;
