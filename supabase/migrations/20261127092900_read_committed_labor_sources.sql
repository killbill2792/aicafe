set lock_timeout = '5s';
set statement_timeout = '60s';

-- The authorized body remains the only provider copy. The existing typed
-- attendance row supplies promotion/owner decisions and historical fallback.
create function public.toast_labor_source(
 p_business uuid,p_account text,p_entry text
) returns table(employee_key text,clock_in timestamptz,clock_out timestamptz,
 hourly_wage_cents bigint,regular_hours numeric,overtime_hours numeric,
 breaks jsonb,deleted boolean,modified_at timestamptz)
language sql stable security invoker set search_path=pg_catalog,public as $$
 select r.payload#>>'{employeeReference,guid}',
  public.toast_time_or_null(r.payload->>'inDate'),public.toast_time_or_null(r.payload->>'outDate'),
  case when jsonb_typeof(r.payload->'hourlyWage')='number' then
   case when abs((r.payload->>'hourlyWage')::numeric)<100000000
    then round((r.payload->>'hourlyWage')::numeric*100)::bigint end end,
  case when jsonb_typeof(r.payload->'regularHours')='number' then (r.payload->>'regularHours')::numeric end,
  case when jsonb_typeof(r.payload->'overtimeHours')='number' then (r.payload->>'overtimeHours')::numeric end,
  coalesce((select jsonb_agg(jsonb_build_object('start',public.toast_time_or_null(br.value->>'inDate'),
    'end',public.toast_time_or_null(br.value->>'outDate'),'paid',coalesce(br.value->'paid'='true'::jsonb,false)) order by br.idx)
   from jsonb_array_elements(case when jsonb_typeof(r.payload->'breaks')='array'
    then r.payload->'breaks' else '[]'::jsonb end) with ordinality br(value,idx)
   where public.toast_time_or_null(br.value->>'inDate') is not null
    and public.toast_time_or_null(br.value->>'outDate') is not null), '[]'::jsonb),
  coalesce(r.payload->'deleted'='true'::jsonb,false),r.source_updated_at
 from public.external_records r
 join public.external_resources e on
  (e.business_id,e.provider,e.source_account,e.resource)=(r.business_id,r.provider,r.source_account,r.entity)
 join public.external_observation_members m on
  (m.business_id,m.provider,m.observation_id,m.record_id,m.observed_sha256)=
  (r.business_id,r.provider,e.last_complete_commit,r.id,r.payload_sha256)
 where r.business_id=p_business and r.provider='toast' and r.source_account=p_account
  and r.entity='labor/v1/timeEntries' and r.source_key=p_entry and r.payload->>'guid'=p_entry
  and r.payload_origin='provider' and e.permission_granted is true
  and (e.last_permission_loss_at is null or e.last_complete_at>=e.last_permission_loss_at)
  and e.last_complete_scope->>'mode' in ('window','incremental')
  and r.payload#>>'{employeeReference,guid}' is not null
$$;
revoke all on function public.toast_labor_source(uuid,text,text) from public,anon;
grant execute on function public.toast_labor_source(uuid,text,text) to authenticated,service_role;

-- Bring the staged breaks to a comparable timestamp representation without
-- replacing the independently retained original JSON or break metadata.
create function public.toast_labor_break_times(p_breaks jsonb)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object('start',public.toast_time_or_null(b.value->>'start'),
    'end',public.toast_time_or_null(b.value->>'end'),'paid',coalesce(b.value->'paid'='true'::jsonb,false))
    order by b.idx),'[]'::jsonb)
 from jsonb_array_elements(case when jsonb_typeof(p_breaks)='array' then p_breaks else '[]'::jsonb end)
 with ordinality b(value,idx)
$$;
revoke all on function public.toast_labor_break_times(jsonb) from public,anon;
grant execute on function public.toast_labor_break_times(jsonb) to authenticated,service_role;

-- Never discard a projection before exact matching evidence is committed.
-- Operational stage rows still participate in payroll review and promotion.
create or replace function public.toast_archive_stage_trigger()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
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

-- A newer unpromoted provider revision does not replace a paid entry.
-- Keep the original wage separately readable from the accepted payroll wage,
-- including provider null, explicit zero, and independently entered wages.
create function public.toast_promoted_clock_source(p_card public.timecards)
returns table(hourly_wage_cents bigint,regular_hours numeric,overtime_hours numeric)
language sql stable security invoker set search_path=pg_catalog,public as $$
 select s.hourly_wage_cents,s.regular_hours,s.overtime_hours
 from public.toast_labor_source(p_card.business_id,split_part(p_card.pos_timecard_id,':',2),
   split_part(p_card.pos_timecard_id,':',3)) s
 where p_card.source_type='connected_pos' and not p_card.pos_owner_edited
  and p_card.wage_source='pos' and p_card.pos_timecard_id like 'toast:%'
  and s.clock_out is not null and not s.deleted
  and (p_card.clock_in,p_card.clock_out,p_card.hourly_wage_cents,
   p_card.provider_regular_hours,p_card.provider_overtime_hours,public.toast_labor_break_times(p_card.breaks))
   is not distinct from (s.clock_in,s.clock_out,coalesce(s.hourly_wage_cents,0),s.regular_hours,s.overtime_hours,s.breaks)
$$;
revoke all on function public.toast_promoted_clock_source(public.timecards) from public,anon;
grant execute on function public.toast_promoted_clock_source(public.timecards) to authenticated,service_role;

create or replace view public.cv_staff_clock_entries with (security_invoker=true) as
with adopted as not materialized (
 select t.*,coalesce(s.hourly_wage_cents,t.hourly_wage_cents) as observed_wage,
  coalesce(s.matched,false) as source_proven,s.hourly_wage_cents as provider_hourly_wage_cents
 from public.timecards t left join lateral (
  select p.*,true as matched from public.toast_promoted_clock_source(t) p
 ) s on true
), entries as (
 select t.business_id,coalesce(t.source_provider,'app')::text as source,'staff-clock:'||t.id as source_ref,
 case when t.source_type='owner_schedule' then 'estimated'
      when t.clock_out is null or t.clock_out>now() then 'provisional'
      when t.observed_wage is null then 'open' else 'actual' end::text as status,
 (t.clock_in at time zone b.timezone)::date as business_date,
 t.id,t.employee_id,t.schedule_id,t.source_type,t.source_provider,t.clock_in,t.clock_out,
 t.observed_wage as hourly_wage_cents,t.breaks,t.provider_regular_hours,t.provider_overtime_hours,
 e.display_name as employee_name,e.role as employee_role,now() as as_of,
 b.payroll_tax_rate,t.pos_timecard_id,t.wage_source,t.source_proven,t.provider_hourly_wage_cents,
 case when t.observed_wage is null then null
 when t.clock_out is not null and (t.provider_regular_hours is not null or t.provider_overtime_hours is not null)
  and coalesce(t.provider_regular_hours,0)>=0 and coalesce(t.provider_overtime_hours,0)>=0
 then (coalesce(t.provider_regular_hours,0)+coalesce(t.provider_overtime_hours,0)*1.5)*t.observed_wage
 else greatest(0,extract(epoch from least(coalesce(t.clock_out,now()),now())-t.clock_in)
   - coalesce((select sum(greatest(0,extract(epoch from
      (br->>'end')::timestamptz-(br->>'start')::timestamptz)))
     from jsonb_array_elements(t.breaks) br where not coalesce((br->>'paid')::boolean,false)),0))
   /3600*t.observed_wage end::numeric as wages_cents
 from adopted t join public.businesses b on b.id=t.business_id
 left join public.employees e on e.id=t.employee_id and e.business_id=t.business_id
)
select business_id,source,source_ref,status,business_date,id,employee_id,schedule_id,source_type,source_provider,
 clock_in,clock_out,hourly_wage_cents,breaks,provider_regular_hours,provider_overtime_hours,
 employee_name,employee_role,as_of,wages_cents,wages_cents*(1+payroll_tax_rate) as loaded_cost_cents,
 hourly_wage_cents*(1+payroll_tax_rate) as loaded_hourly_cents,
 case when count(*) filter(where wages_cents is null) over(partition by business_id,business_date)>0 then null
 else sum(wages_cents*(1+payroll_tax_rate)) over(partition by business_id,business_date) end as day_loaded_cost_cents,
 pos_timecard_id,wage_source,source_proven,provider_hourly_wage_cents
from entries;

create or replace view public.cv_labor_entries (business_id,source,source_ref,status,business_date,data,regular_hours,overtime_hours,hourly_wage_cents)
with (security_invoker=true) as
 select t.business_id,
 case when coalesce(t.pos_timecard_id,'') like 'toast:%' then 'toast'
  else coalesce(lower(t.source_provider),'app') end::text as source,
 'timecard:'||t.id::text as source_ref,
 case when t.clock_out is null then 'open'
  when t.wage_source='estimate' then 'estimated'
  when t.wage_source='unknown' or t.hourly_wage_cents is null then 'needs_match'
  else 'actual' end::text as status,
 (t.clock_in at time zone b.timezone)::date as business_date,
 jsonb_build_object('id',t.id,'employee_id',t.employee_id,
  'clock_in',t.clock_in,'clock_out',t.clock_out,
  'hourly_wage_cents',t.hourly_wage_cents,'wage_source',t.wage_source,
  'pos_timecard_id',t.pos_timecard_id,'regular_minutes',to_jsonb(t)->'regular_minutes',
  'overtime_minutes',to_jsonb(t)->'overtime_minutes',
  'provider_hourly_wage_cents',p.hourly_wage_cents,
  'evidence',case when p.matched then 'completed_observation'
    when t.source_type='connected_pos' then 'historical_projection' else 'app_record' end) as data,
  case when p.matched then p.regular_hours else (select l.provider_regular_hours from public.toast_open_labor_summaries l
   where l.business_id=t.business_id and
    t.pos_timecard_id='toast:'||l.restaurant_guid::text||':'||l.external_time_entry_id::text limit 1) end,
  case when p.matched then p.overtime_hours else (select l.provider_overtime_hours from public.toast_open_labor_summaries l
   where l.business_id=t.business_id and
    t.pos_timecard_id='toast:'||l.restaurant_guid::text||':'||l.external_time_entry_id::text limit 1) end,
  t.hourly_wage_cents
 from public.timecards t join public.businesses b on b.id=t.business_id
 left join lateral (select p.*,true as matched from public.toast_promoted_clock_source(t) p) p on true
 where t.source_type is distinct from 'owner_schedule'
 union all
 select s.business_id,'toast'::text,
 'staged-timecard:'||s.restaurant_guid::text||':'||s.external_time_entry_id::text,
 case when s.clock_out is null then 'open'
  when s.wage_status='missing' then 'needs_match' else 'actual' end::text,
 (s.clock_in at time zone b.timezone)::date,
 jsonb_build_object('employee_guid',s.external_employee_id,
  'clock_in',s.clock_in,'clock_out',s.clock_out,
  'hourly_wage_cents',s.hourly_wage_cents,'wage_status',s.wage_status,
  'regularHours',s.provider_regular_hours,'overtimeHours',s.provider_overtime_hours),
 s.provider_regular_hours,s.provider_overtime_hours,s.hourly_wage_cents
 from public.toast_open_labor_summaries s
 join public.businesses b on b.id=s.business_id
 where s.deleted=false and not exists(select 1 from public.timecards t
   where t.business_id=s.business_id
    and t.pos_timecard_id='toast:'||s.restaurant_guid::text||':'||s.external_time_entry_id::text);
