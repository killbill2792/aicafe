-- Owner economics settings: editable payroll burden + café-specific operating-margin goal.
-- Existing cafés keep today's behavior until the owner confirms values.
alter table businesses
  add column if not exists payroll_tax_rate_status text not null default 'estimated',
  add column if not exists target_operating_margin numeric(5,4) not null default 0.15,
  add column if not exists target_operating_margin_status text not null default 'default';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'businesses_payroll_tax_rate_status_check'
  ) then
    alter table businesses
      add constraint businesses_payroll_tax_rate_status_check
      check (payroll_tax_rate_status in ('estimated', 'confirmed'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'businesses_target_operating_margin_check'
  ) then
    alter table businesses
      add constraint businesses_target_operating_margin_check
      check (target_operating_margin >= 0 and target_operating_margin <= 0.80);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'businesses_target_operating_margin_status_check'
  ) then
    alter table businesses
      add constraint businesses_target_operating_margin_status_check
      check (target_operating_margin_status in ('default', 'confirmed'));
  end if;
end $$;

-- Rate-based payroll burden is an estimate. A future payroll connector can write an actual
-- day-level burden and mark it actual; rollup recomputation must preserve that actual value.
alter table daily_rollups
  add column if not exists staff_tax_status text not null default 'estimated';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'daily_rollups_staff_tax_status_check'
  ) then
    alter table daily_rollups
      add constraint daily_rollups_staff_tax_status_check
      check (staff_tax_status in ('estimated', 'actual'));
  end if;
end $$;
