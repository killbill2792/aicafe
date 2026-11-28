set lock_timeout = '5s';
set statement_timeout = '60s';

-- Provider schedules remain planned evidence. Keep the stored provider in
-- their shared read so a Square shift cannot be attributed to Toast.
create or replace view public.cv_shifts (business_id,source,source_ref,status,business_date,data)
with (security_invoker=true) as
 select s.business_id,'app'::text,
 'shift:'||s.id::text,
 case when s.status='draft' then 'open' else 'actual' end::text,
 s.local_date,
 jsonb_build_object('id',s.id,'employee_id',s.employee_id,
  'start_local',s.start_local,'end_local',s.end_local,
  'day',s.local_date,'shift_status',s.status,'overnight',s.overnight,
  'break_minutes',s.break_minutes)
 from public.scheduled_shifts s
 union all
 select p.business_id,p.provider,
 p.provider||'-shift:'||p.external_shift_id,'actual'::text,
 (p.scheduled_start at time zone b.timezone)::date,
 jsonb_build_object('provider',p.provider,'employee_id',p.external_employee_id,
  'job_id',p.external_job_id,'scheduled_start',p.scheduled_start,
  'scheduled_end',p.scheduled_end,'location_id',p.location_id,'paid',false)
 from public.pos_scheduled_shifts p join public.businesses b on b.id=p.business_id
 where not p.deleted;
