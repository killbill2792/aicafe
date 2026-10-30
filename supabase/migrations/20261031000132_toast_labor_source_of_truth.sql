-- Toast is the source of truth for every shift it reports.
--  * Wage: exactly Toast's hourlyWage. Toast leaves it out for salaried jobs and jobs with no
--    wage set (for example the online-orders login), and its own labor cost for those shifts is
--    $0, so the shift is stored at $0. The app's own staff wage is never filled in.
--  * Hours: Toast's regularHours and overtimeHours are stored on the shift and used for pay.
--  * Edits: a shift changed in the app, or an app/CSV shift for the same person and time, is
--    replaced by Toast's version. A shift Toast deletes is removed.
-- Every changed day is queued for the normal cost recompute (toast_rollup_refresh_jobs).

alter table public.timecards
 add column if not exists provider_regular_hours numeric,
 add column if not exists provider_overtime_hours numeric;

create or replace function public.pos_import_toast_attendance(p_business_id uuid,p_restaurant_guid uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r record;v_id text;
 v_existing public.timecards%rowtype; v_count integer:=0;v_skipped integer:=0;
 v_intervals jsonb:='[]'::jsonb;
begin
 if auth.role()<>'service_role' or not exists(
  select 1 from public.toast_location_mappings where business_id=p_business_id
    and restaurant_guid=p_restaurant_guid and verified_at is not null)
 then raise exception 'attendance unauthorized' using errcode='42501';end if;

 -- A shift Toast deleted is no longer a shift.
 with gone as (
  delete from public.timecards t
  using public.toast_labor_entries l
  where l.business_id=p_business_id and l.restaurant_guid=p_restaurant_guid and l.deleted
    and t.business_id=p_business_id
    and t.pos_timecard_id='toast:'||p_restaurant_guid::text||':'||l.external_time_entry_id::text
  returning t.clock_in,t.clock_out
 )
 select v_intervals||coalesce(jsonb_agg(jsonb_build_object('start',clock_in,'end',coalesce(clock_out,clock_in+interval '1 second'))),'[]'::jsonb),
   v_count+count(*)::integer
  into v_intervals,v_count from gone;

 for r in select l.*,d.linked_employee_id
  from public.toast_labor_entries l
  left join public.toast_employee_directory d on d.business_id=l.business_id
   and d.restaurant_guid=l.restaurant_guid and d.employee_guid=l.external_employee_id
  where l.business_id=p_business_id and l.restaurant_guid=p_restaurant_guid
  and not l.deleted and l.clock_out is not null and l.clock_out>l.clock_in
  order by l.external_time_entry_id
 loop
  v_id:='toast:'||p_restaurant_guid::text||':'||r.external_time_entry_id::text;
  if r.linked_employee_id is null then
   insert into public.pos_import_reviews(business_id,provider,review_type,source_key,detail)
   values(p_business_id,'toast','unlinked_timecard',v_id,jsonb_build_object('employeeGuid',r.external_employee_id))
   on conflict do nothing;
   v_skipped:=v_skipped+1;continue;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pos-staff:'||p_business_id::text||':'||r.linked_employee_id::text,0));
  select * into v_existing from public.timecards
   where business_id=p_business_id and pos_timecard_id=v_id for update;

  -- App, CSV and planned shifts for the same person and time are replaced by Toast's shift.
  -- Other Toast shifts are left alone: each one is Toast's own record.
  with removed as (
   delete from public.timecards t where t.business_id=p_business_id
     and t.employee_id=r.linked_employee_id
     and coalesce(t.pos_timecard_id,'') not like 'toast:%'
     and t.clock_in<r.clock_out
     and coalesce(t.clock_out,'infinity'::timestamptz)>r.clock_in
   returning t.clock_in,t.clock_out
  )
  select v_intervals||coalesce(jsonb_agg(jsonb_build_object(
   'start',clock_in,'end',coalesce(clock_out,r.clock_out))),'[]'::jsonb)
   into v_intervals from removed;

  insert into public.timecards(business_id,employee_id,pos_timecard_id,clock_in,clock_out,
   hourly_wage_cents,wage_source,source_type,source_provider,breaks,pos_last_synced_at,
   provider_regular_hours,provider_overtime_hours,pos_owner_edited)
  values(p_business_id,r.linked_employee_id,v_id,r.clock_in,r.clock_out,
   coalesce(r.hourly_wage_cents,0),'pos','connected_pos','Toast',r.breaks,now(),
   r.provider_regular_hours,r.provider_overtime_hours,false)
  on conflict(business_id,pos_timecard_id) do update set
   employee_id=excluded.employee_id,clock_in=excluded.clock_in,clock_out=excluded.clock_out,
   hourly_wage_cents=excluded.hourly_wage_cents,wage_source=excluded.wage_source,
   source_type=excluded.source_type,source_provider=excluded.source_provider,
   breaks=excluded.breaks,pos_last_synced_at=now(),
   provider_regular_hours=excluded.provider_regular_hours,
   provider_overtime_hours=excluded.provider_overtime_hours,
   pos_owner_edited=false
  where row(public.timecards.employee_id,public.timecards.clock_in,public.timecards.clock_out,
    public.timecards.hourly_wage_cents,public.timecards.wage_source,public.timecards.breaks,
    public.timecards.provider_regular_hours,public.timecards.provider_overtime_hours,
    public.timecards.pos_owner_edited)
    is distinct from row(excluded.employee_id,excluded.clock_in,excluded.clock_out,
    excluded.hourly_wage_cents,excluded.wage_source,excluded.breaks,
    excluded.provider_regular_hours,excluded.provider_overtime_hours,false);
  if found then
   v_count:=v_count+1;
   -- Both the new and the old day range need their costs recomputed.
   v_intervals:=v_intervals||jsonb_build_array(
    jsonb_build_object('start',r.clock_in,'end',r.clock_out));
   if v_existing.id is not null then
    v_intervals:=v_intervals||jsonb_build_array(
     jsonb_build_object('start',v_existing.clock_in,'end',coalesce(v_existing.clock_out,r.clock_out)));
   end if;
  end if;
 end loop;
 return jsonb_build_object('changed',v_count,'skipped',v_skipped,'changedIntervals',v_intervals);
end $$;
revoke all on function public.pos_import_toast_attendance(uuid,uuid) from public,anon,authenticated;
grant execute on function public.pos_import_toast_attendance(uuid,uuid) to service_role;

-- Bring shifts already saved in line with Toast now, then queue both their old and new days for
-- recompute (a shift moved in the app leaves stale costs on the day it was moved to).
-- "before" reads the rows as they were, since every part of one statement sees the same snapshot.
with before as (
 select t.id,t.business_id,t.clock_in,t.clock_out from public.timecards t
 join public.toast_labor_entries l on t.business_id=l.business_id
  and t.pos_timecard_id='toast:'||l.restaurant_guid::text||':'||l.external_time_entry_id::text
 where not l.deleted and l.clock_out is not null and l.clock_out>l.clock_in
), fixed as (
 update public.timecards t set
  hourly_wage_cents=coalesce(l.hourly_wage_cents,0),wage_source='pos',
  clock_in=l.clock_in,clock_out=l.clock_out,breaks=l.breaks,
  provider_regular_hours=l.provider_regular_hours,
  provider_overtime_hours=l.provider_overtime_hours,
  pos_owner_edited=false
 from public.toast_labor_entries l
 where t.business_id=l.business_id
  and t.pos_timecard_id='toast:'||l.restaurant_guid::text||':'||l.external_time_entry_id::text
  and not l.deleted and l.clock_out is not null and l.clock_out>l.clock_in
  and row(t.hourly_wage_cents,t.wage_source,t.clock_in,t.clock_out,t.breaks,
   t.provider_regular_hours,t.provider_overtime_hours,t.pos_owner_edited)
   is distinct from row(coalesce(l.hourly_wage_cents,0),'pos'::text,l.clock_in,l.clock_out,l.breaks,
   l.provider_regular_hours,l.provider_overtime_hours,false)
 returning t.id,t.business_id,t.clock_in,t.clock_out
), spans as (
 select business_id,clock_in,clock_out from fixed
 union all
 select b.business_id,b.clock_in,b.clock_out from before b join fixed f on f.id=b.id
), days as (
 select distinct f.business_id,d::date as business_date
 from spans f join public.businesses b on b.id=f.business_id
 cross join lateral generate_series(
  (f.clock_in at time zone b.timezone)::date,
  (coalesce(f.clock_out,f.clock_in) at time zone b.timezone)::date,
  interval '1 day') d
)
insert into public.toast_rollup_refresh_jobs(business_id,business_date)
select business_id,business_date from days
on conflict(business_id,business_date) do update set
 generation=gen_random_uuid(),requested_at=now(),retry_at=now(),
 attempts=0,last_error_category=null;
