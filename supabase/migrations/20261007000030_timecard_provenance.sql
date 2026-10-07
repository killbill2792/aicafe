-- Explicit staff/timecard provenance for owner-visible source tags and future AI Cafe clock events.
alter table timecards
  add column if not exists source_type text,
  add column if not exists source_provider text;

update timecards
set source_type = case
  when pos_timecard_id like 'csv-%' then 'imported'
  when pos_timecard_id is not null then 'connected_pos'
  when schedule_id is not null then 'owner_schedule'
  else 'owner_manual'
end
where source_type is null;

update timecards
set source_provider = case
  when source_type = 'imported' then 'CSV'
  when source_type = 'connected_pos' then 'POS'
  when source_type = 'owner_schedule' then 'Owner'
  when source_type = 'owner_manual' then 'Owner'
  when source_type = 'ai_cafe' then 'AI Cafe'
  else source_provider
end
where source_provider is null;

alter table timecards
  alter column source_type set default 'owner_manual',
  alter column source_type set not null;

alter table timecards drop constraint if exists timecards_source_type_check;
alter table timecards
  add constraint timecards_source_type_check
  check (source_type in ('owner_schedule', 'owner_manual', 'connected_pos', 'imported', 'ai_cafe'));

create index if not exists timecards_business_source_idx on timecards (business_id, source_type, clock_in);
