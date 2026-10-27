-- PR #202 disposable database, never production. Run after all migrations,
-- replay 102 twice, then perform these assertions in a rolled-back transaction.
\set ON_ERROR_STOP on
begin;
do $checks$
declare
 n integer;
 def text;
begin
 select count(*) into n from information_schema.columns where table_schema='public'
 and table_name='businesses' and column_name in
 ('target_ingredient_cost_rate','target_ingredient_cost_rate_status','owner_monthly_payroll_extras_cents','owner_monthly_payroll_extras_updated_at');
 if n<>4 then raise exception 'Financial settings columns missing (%)',n;end if;
 if not exists (select 1 from pg_constraint where conrelid='public.businesses'::regclass
   and conname='businesses_target_ingredient_rate_guard')
 then raise exception 'Ingredient rate CHECK missing';end if;
 if not exists (select 1 from pg_constraint where conrelid='public.businesses'::regclass
   and conname='businesses_owner_payroll_guard')
 then raise exception 'Payroll cents CHECK missing';end if;
 if not exists (select 1 from pg_indexes where schemaname='public'
   and indexname='toast_one_cafe_per_restaurant_uidx')
 then raise exception 'Toast tenant-wide uniqueness missing';end if;
 if not exists (select 1 from pg_indexes where schemaname='public'
   and indexname='square_one_cafe_per_location_uidx')
 then raise exception 'Square tenant-wide uniqueness missing';end if;
 foreach def in array array[
   'toast_rollup_refresh_jobs','toast_analytics_credentials',
   'toast_analytics_rate_calls','toast_first_import_check','square_sync_leases'
 ] loop
  if not exists (select 1 from pg_constraint c where c.contype='f'
    and c.confrelid='public.businesses'::regclass
    and c.conrelid=to_regclass('public.'||def) and c.confdeltype='c')
   then raise exception '% missing business cascading deletion',def;end if;
 end loop;
 if not (select relrowsecurity from pg_class where oid='public.square_sync_leases'::regclass)
 then raise exception 'Square lease RLS missing';end if;
 if has_table_privilege('authenticated','public.square_sync_leases','SELECT')
 then raise exception 'Square service lease leaked to authenticated role';end if;
 if has_function_privilege('authenticated','public.square_claim_sync_lease(uuid,integer)','EXECUTE')
 then raise exception 'Square lease RPC leaked to authenticated role';end if;
 if not has_function_privilege('service_role','public.square_claim_sync_lease(uuid,integer)','EXECUTE')
 then raise exception 'Square service lease RPC unavailable';end if;
 def:=pg_get_functiondef('public.toast_import_day(uuid,uuid,uuid,date,jsonb,jsonb,uuid)'::regprocedure);
 if def not like '%employee_id=excluded.employee_id%' or
    def not like '%source_channel=excluded.source_channel%' or
    def not like '%guest_count=excluded.guest_count%'
 then raise exception 'Toast canonical order enrichment missing';end if;
 def:=pg_get_functiondef('public.pantry_usage_sales_evidence(uuid,date,date)'::regprocedure);
 if def not like '%public.timecards%' or def like '%from public.toast_labor_entries%'
 then raise exception 'Usage still depends on provider-specific Toast attendance';end if;
 if not exists(select 1 from pg_constraint
   where conrelid='public.pos_scheduled_shifts'::regclass
    and conname='pos_scheduled_shifts_supported_provider')
 then raise exception 'Shared Square/Toast scheduled-shift provider CHECK missing';end if;
end $checks$;
-- Two actual ephemeral café rows prove deletion does not delete another tenant,
-- and a duplicated Square location / Toast restaurant cannot be linked twice.
do $tenant$
declare
 a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();
 la uuid:=gen_random_uuid();lb uuid:=gen_random_uuid();
 ga uuid:=gen_random_uuid();gb uuid:=gen_random_uuid();
 duplicateBlocked boolean;
begin
 insert into public.businesses(id,name) values(a,'Migration A'),(b,'Migration B');
 insert into public.locations(id,business_id,name,pos_location_id)
 values(la,a,'A Location','square-'||a::text),(lb,b,'B Location','square-'||b::text);
 duplicateBlocked:=false;
 begin
  update public.locations set pos_location_id='square-'||a::text where id=lb;
 exception when unique_violation then duplicateBlocked:=true;
 end;
 if not duplicateBlocked then raise exception 'Square cross-café location duplicate accepted';end if;
 insert into public.toast_api_credentials(business_id,api_origin,client_id,client_secret_enc)
 values(a,'https://example.invalid','integration-a','synthetic'),
       (b,'https://example.invalid','integration-b','synthetic');
 insert into public.toast_location_mappings(business_id,location_id,restaurant_guid)
 values(a,la,ga);
 duplicateBlocked:=false;
 begin
  insert into public.toast_location_mappings(business_id,location_id,restaurant_guid)
  values(b,lb,ga);
 exception when unique_violation then duplicateBlocked:=true;
 end;
 if not duplicateBlocked then raise exception 'Toast restaurant linked to two cafés';end if;
 insert into public.toast_location_mappings(business_id,location_id,restaurant_guid)
 values(b,lb,gb);
 insert into public.toast_analytics_credentials(
  business_id,management_group_guid,api_origin,client_id,client_secret_enc)
 values(a,gen_random_uuid(),'https://example.invalid','integration-a','synthetic'),
       (b,gen_random_uuid(),'https://example.invalid','integration-b','synthetic');
 insert into public.toast_analytics_rate_calls(business_id,kind)
 values(a,'get'),(b,'get');
 insert into public.toast_first_import_check(business_id) values(a),(b);
 insert into public.toast_rollup_refresh_jobs(business_id,business_date)
 values(a,'2026-10-25'),(b,'2026-10-25');
 insert into public.square_sync_leases(business_id) values(a),(b);
 delete from public.businesses where id=a;
 if exists(select 1 from public.businesses where id=a)
  or exists(select 1 from public.toast_analytics_credentials where business_id=a)
  or exists(select 1 from public.toast_analytics_rate_calls where business_id=a)
  or exists(select 1 from public.toast_first_import_check where business_id=a)
  or exists(select 1 from public.toast_rollup_refresh_jobs where business_id=a)
  or exists(select 1 from public.square_sync_leases where business_id=a)
 then raise exception 'Deleted tenant retained orphan rows';end if;
 if not exists(select 1 from public.businesses where id=b)
  or not exists(select 1 from public.toast_analytics_credentials where business_id=b)
  or not exists(select 1 from public.toast_analytics_rate_calls where business_id=b)
  or not exists(select 1 from public.toast_first_import_check where business_id=b)
  or not exists(select 1 from public.toast_rollup_refresh_jobs where business_id=b)
  or not exists(select 1 from public.square_sync_leases where business_id=b)
 then raise exception 'Tenant deletion damaged a different café';end if;
end $tenant$;

rollback;
