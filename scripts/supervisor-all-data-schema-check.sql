-- READ ONLY. Run after migrations 101 and 102 (Supabase SQL editor safe).
-- One row per expected table, column, function, index or constraint.
with expected(kind,relation_name,object_name) as (
 values
  ('table','', 'square_sync_leases'),
  ('column','businesses','target_ingredient_cost_rate'),
  ('column','businesses','target_ingredient_cost_rate_status'),
  ('column','businesses','owner_monthly_payroll_extras_cents'),
  ('column','businesses','owner_monthly_payroll_extras_updated_at'),
  ('column','daily_rollups','labor_wage_status'),
  ('column','daily_rollups','staff_wages_cents'),
  ('column','daily_rollups','staff_tax_cents'),
  ('column','timecards','hourly_wage_cents'),
  ('column','orders','employee_id'),
  ('column','orders','dining_option'),
  ('column','orders','source_channel'),
  ('column','orders','guest_count'),
  ('index','','toast_one_cafe_per_restaurant_uidx'),
  ('index','','square_one_cafe_per_location_uidx'),
  ('function','','toast_import_day(uuid,uuid,uuid,date,jsonb,jsonb,uuid)'),
  ('function','','pantry_usage_sales_evidence(uuid,date,date)'),
  ('function','','square_claim_sync_lease(uuid,integer)'),
  ('constraint','businesses','businesses_target_ingredient_rate_guard'),
  ('constraint','businesses','businesses_ingredient_source_guard'),
  ('constraint','pos_scheduled_shifts','pos_scheduled_shifts_supported_provider')
), checked as (
 select kind, case when relation_name='' then 'public.'||object_name
                   else 'public.'||relation_name||'.'||object_name end as object,
  case kind
   when 'table' then to_regclass('public.'||object_name) is not null
   when 'index' then to_regclass('public.'||object_name) is not null
   when 'function' then to_regprocedure('public.'||object_name) is not null
   when 'column' then exists(
    select 1 from information_schema.columns c
    where c.table_schema='public' and c.table_name=relation_name and c.column_name=object_name)
   when 'constraint' then exists(
    select 1 from pg_constraint c
    where c.conrelid=to_regclass('public.'||relation_name) and c.conname=object_name)
   else false
  end as present
 from expected
)
select kind,object,case when present then 'YES' else 'NO' end as exists_after_migration
from checked order by kind,object;
