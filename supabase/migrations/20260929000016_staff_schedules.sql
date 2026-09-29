-- ===== Recurring staff schedules (pilot café: manual staff roster, no scheduling POS export) =====
-- A weekly (or month-bounded) recurring pattern per employee — day of week + start/end time.
-- `effective_to = null` means "repeats every week, ongoing"; a set `effective_to` bounds it to a
-- specific window (e.g. one month) instead. Materialized into real `timecards` rows for "today"
-- by `lib/data/materializeSchedule.ts` — every downstream cost calculation reads `timecards`
-- exactly as it always has, unaware whether a row came from a schedule, a CSV import, or a manual
-- entry.
create table if not exists staff_schedules (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  employee_id uuid not null references employees on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6), -- 0=Sunday .. 6=Saturday, matches JS Date#getDay()
  start_time time not null,
  end_time time not null,
  unpaid_break_minutes int not null default 0,
  hourly_wage_cents bigint not null,
  effective_from date not null,
  effective_to date,
  active boolean not null default true
);

create index if not exists staff_schedules_business_id_idx on staff_schedules (business_id);
create index if not exists staff_schedules_employee_day_idx on staff_schedules (employee_id, day_of_week);

-- Marks a timecard as "auto-filled from the schedule, not yet confirmed" — cleared to null the
-- moment the owner directly edits that day (see lib/actions/staff.ts's saveShiftForDay).
alter table timecards add column if not exists schedule_id uuid references staff_schedules(id) on delete set null;

-- RLS: same is_member(business_id) predicate as every other direct-business_id table (see
-- 20260926000008_rls.sql). Applied here, self-contained, rather than in that file's generic loop,
-- since this table doesn't exist yet when that earlier-numbered migration runs.
alter table staff_schedules enable row level security;
drop policy if exists "members read" on staff_schedules;
drop policy if exists "members write" on staff_schedules;
create policy "members read" on staff_schedules for select using (is_member(business_id));
create policy "members write" on staff_schedules for all using (is_member(business_id)) with check (is_member(business_id));
