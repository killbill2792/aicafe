-- Lets an owner enter a staff wage as an hourly rate, a monthly salary, or a yearly salary.
-- `default_hourly_wage_cents` keeps its exact existing role (the one field every cost calculation
-- and every new `timecards` row already reads/writes) — for 'hour' employees it equals
-- `wage_amount_cents` directly; for salaried employees it's a cached hourly-equivalent, derived
-- from `wage_amount_cents` and that employee's real weekly scheduled hours (see
-- lib/actions/staff.ts). Past timecards are never touched by any of this — they already carry
-- their own `hourly_wage_cents` snapshot from whenever they were written.
alter table employees add column if not exists wage_period text not null default 'hour'
  check (wage_period in ('hour', 'month', 'year'));
alter table employees add column if not exists wage_amount_cents bigint;

-- Existing employees backfill to hourly mode with their current rate as the amount — zero
-- behavior change for anyone who already has a wage set.
update employees set wage_amount_cents = default_hourly_wage_cents where wage_amount_cents is null;
