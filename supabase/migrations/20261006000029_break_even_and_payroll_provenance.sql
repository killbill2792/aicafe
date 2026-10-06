-- Corrective foundation: distinguish real sales coverage from staff-only rollups and
-- preserve where payroll assumptions/actuals came from for future integrations.
alter table businesses
  add column if not exists payroll_tax_rate_source text not null default 'system_estimate';

alter table daily_rollups
  add column if not exists staff_tax_source text not null default 'system_estimate',
  add column if not exists sales_data_status text not null default 'missing';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'daily_rollups_sales_data_status_check'
  ) then
    alter table daily_rollups
      add constraint daily_rollups_sales_data_status_check
      check (sales_data_status in ('actual', 'missing'));
  end if;
end $$;

-- Existing confirmed fallback rates were owner-entered. Defaults remain system estimates.
update businesses
set payroll_tax_rate_source =
  case when payroll_tax_rate_status = 'confirmed' then 'owner_entered' else 'system_estimate' end
where payroll_tax_rate_source = 'system_estimate';

-- Backfill only dates with positive/observable sales facts as actual. Staff-only rows remain
-- missing, which is intentionally conservative: zero sales cannot be distinguished from no sales
-- coverage without an explicit provider/import coverage signal.
update daily_rollups
set sales_data_status = 'actual'
where orders_count > 0
   or net_sales_cents <> 0
   or drinks_count > 0;

update daily_rollups dr
set staff_tax_source =
  case
    when dr.staff_tax_status = 'actual' then 'legacy_actual'
    else coalesce(
      (select b.payroll_tax_rate_source from businesses b where b.id = dr.business_id),
      'system_estimate'
    )
  end
where dr.staff_tax_source = 'system_estimate';

comment on column businesses.payroll_tax_rate_source is
  'Fallback payroll-rate provenance, e.g. system_estimate, owner_entered, quickbooks. Free text so future providers do not require a schema change.';

comment on column daily_rollups.staff_tax_source is
  'Selected payroll/employer-cost provenance for the day, e.g. owner_entered, quickbooks, imported.';

comment on column daily_rollups.sales_data_status is
  'actual only when sales/order coverage is known for this business date; staff-only rollups stay missing.';
