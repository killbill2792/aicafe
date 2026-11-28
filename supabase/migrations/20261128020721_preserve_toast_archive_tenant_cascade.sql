set lock_timeout = '5s';
set statement_timeout = '30s';

create or replace function public.toast_archive_stage_trigger()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 -- Cascading link removal can update staging rows after their café is deleted.
 if not exists(select 1 from public.businesses b where b.id=new.business_id) then
  return new;
 end if;
 if tg_relid='public.toast_labor_entries'::regclass then
  if exists(select from public.toast_labor_source(new.business_id,new.restaurant_guid::text,new.external_time_entry_id::text) s
   where (s.employee_key,s.clock_in,s.clock_out,s.hourly_wage_cents,s.regular_hours,s.overtime_hours,s.breaks,s.deleted,s.modified_at)
    is not distinct from
    (new.external_employee_id::text,new.clock_in,new.clock_out,new.hourly_wage_cents,
     new.provider_regular_hours,new.provider_overtime_hours,public.toast_labor_break_times(new.breaks),new.deleted,new.provider_modified_at))
  then return new; end if;
 end if;
 perform public.toast_archive_stage_snapshot(to_jsonb(new),tg_argv[0],tg_table_name);
 return new;
end $$;
