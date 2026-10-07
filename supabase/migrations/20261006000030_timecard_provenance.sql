-- ===== Staff timecard provenance + expected/actual reconciliation =====
-- Keeps one canonical timecard row while preserving the owner's expected schedule separately.
-- POS/AI CAFE/manual actual attendance can therefore replace a schedule-generated prediction
-- without losing the schedule baseline or double-counting labor.

alter table timecards
  add column if not exists expected_schedule_id uuid references staff_schedules(id) on delete set null;

alter table timecards
  add column if not exists source_type text;

alter table timecards
  add column if not exists source_provider text;

-- Existing schedule-materialized rows are owner-entered expectations.
update timecards
set expected_schedule_id = schedule_id
where expected_schedule_id is null
  and schedule_id is not null;

-- Backfill provenance conservatively from the facts already stored.
update timecards
set source_type = case
  when pos_timecard_id is not null then 'pos'
  when schedule_id is not null then 'owner_manual_schedule'
  else 'owner_manual'
end
where source_type is null;

alter table timecards
  alter column source_type set default 'owner_manual';

alter table timecards
  alter column source_type set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'timecards_source_type_check'
  ) then
    alter table timecards
      add constraint timecards_source_type_check
      check (source_type in ('owner_manual_schedule', 'owner_manual', 'pos', 'ai_cafe'));
  end if;
end
$$;

create index if not exists timecards_expected_schedule_id_idx
  on timecards (expected_schedule_id);

comment on column timecards.expected_schedule_id is
  'Owner-entered schedule used as the expected baseline even after actual attendance replaces the prediction.';

comment on column timecards.source_type is
  'Provenance for the canonical attendance row: owner_manual_schedule, owner_manual, pos, or ai_cafe.';

comment on column timecards.source_provider is
  'Optional concrete source/provider, for example square, toast, csv, or ai_team.';
