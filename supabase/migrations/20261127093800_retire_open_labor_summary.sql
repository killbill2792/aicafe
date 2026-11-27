-- Reason: Preserve unmatched historical evidence and replace all live readers under the same lock before retiring the mirror.
-- squawk-ignore transaction-nesting
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
lock table public.toast_labor_entries in share row exclusive mode;
lock table public.toast_open_labor_summaries in access exclusive mode;

-- This is the owner-readable projection of the existing review stage. Keep
-- unpublished fields and wages of open or unverified entries off this view.
create view public.toast_staged_labor_evidence with (security_barrier=true) as
 select s.business_id,s.restaurant_guid,s.external_time_entry_id,s.external_employee_id,
 s.clock_in,s.clock_out,case when s.clock_out is not null and s.wage_status='verified' then s.hourly_wage_cents end as hourly_wage_cents,
 s.wage_status,s.provider_regular_hours,s.provider_overtime_hours,s.deleted
 from public.toast_labor_entries s
 where current_user in ('postgres','supabase_admin','service_role') or public.scheduling_is_owner(s.business_id)
 union all
 select r.business_id,r.restaurant_guid,r.entity_guid,old.external_employee_id,
 old.clock_in,old.clock_out,old.hourly_wage_cents,
 old.wage_status,old.provider_regular_hours,old.provider_overtime_hours,old.deleted
 from public.external_records r cross join lateral jsonb_to_record(r.payload) old(
  external_employee_id uuid,clock_in timestamptz,clock_out timestamptz,hourly_wage_cents bigint,
  wage_status text,provider_regular_hours numeric,provider_overtime_hours numeric,deleted boolean)
 where r.provider='toast' and r.entity='legacy/open-labor-summary' and r.payload_origin='historical_projection'
 and (current_user in ('postgres','supabase_admin','service_role') or public.scheduling_is_owner(r.business_id))
 and not exists(select from public.toast_labor_entries s
  where (s.business_id,s.restaurant_guid,s.external_time_entry_id)=(r.business_id,r.restaurant_guid,r.entity_guid));
revoke all on public.toast_staged_labor_evidence from public,anon,authenticated;
grant select on public.toast_staged_labor_evidence to authenticated,service_role;

-- Archive exactly the summaries that cannot be reconstructed from the stage,
-- including tombstones, unexpected historical status and explicit nulls.
with differences as (
 select a.*,b.timezone,to_jsonb(a)-array['business_id','restaurant_guid'] as body
 from public.toast_open_labor_summaries a join public.businesses b on b.id=a.business_id
 left join public.toast_staged_labor_evidence e using(business_id,restaurant_guid,external_time_entry_id)
 where (a.external_employee_id,a.clock_in,a.clock_out,a.hourly_wage_cents,a.wage_status,
    a.provider_regular_hours,a.provider_overtime_hours,a.deleted,a.status) is distinct from
   (e.external_employee_id,e.clock_in,e.clock_out,e.hourly_wage_cents,e.wage_status,
    e.provider_regular_hours,e.provider_overtime_hours,e.deleted,
    case when e.clock_out is null then 'open' when e.wage_status='missing' then 'needs_match' else 'actual' end)
)
insert into public.external_records(business_id,provider,source_account,entity,source_key,restaurant_guid,entity_guid,
 business_date,payload,payload_sha256,capture_key,payload_origin)
select business_id,'toast',restaurant_guid::text,'legacy/open-labor-summary',external_time_entry_id::text,
 restaurant_guid,external_time_entry_id,(clock_in at time zone timezone)::date,body,
 encode(sha256(convert_to(body::text,'UTF8')),'hex'),
 'legacy/open-labor-summary:'||restaurant_guid::text||':'||external_time_entry_id::text,'historical_projection'
from differences;

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
  case when p.matched then p.regular_hours else evidence.provider_regular_hours end,
  case when p.matched then p.overtime_hours else evidence.provider_overtime_hours end,
  t.hourly_wage_cents
 from public.timecards t join public.businesses b on b.id=t.business_id
 left join lateral (select p.*,true as matched from public.toast_promoted_clock_source(t) p) p on true
 left join public.toast_staged_labor_evidence evidence on (evidence.business_id,evidence.restaurant_guid,evidence.external_time_entry_id)=
  (t.business_id,case when t.pos_timecard_id like 'toast:%' then public.toast_uuid_or_null(split_part(t.pos_timecard_id,':',2)) end,
   public.toast_uuid_or_null(split_part(t.pos_timecard_id,':',3)))
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
 from public.toast_staged_labor_evidence s
 join public.businesses b on b.id=s.business_id
 where s.deleted=false and not exists(select 1 from public.timecards t
   where t.business_id=s.business_id
    and t.pos_timecard_id='toast:'||s.restaurant_guid::text||':'||s.external_time_entry_id::text);

-- Reason: The existing staging writer and shared archive now cover every summary read.
-- squawk-ignore ban-drop-trigger
drop trigger toast_open_labor_copy on public.toast_labor_entries;
-- Reason: The retired summary trigger was the function's only caller.
-- squawk-ignore ban-drop-function
drop function public.toast_sync_open_labor_summary();
-- Reason: Non-reconstructable summaries are retained in the archive; all readers have moved.
-- squawk-ignore ban-drop-table
drop table public.toast_open_labor_summaries;
-- Reason: Finish the verified copy retirement atomically.
-- squawk-ignore transaction-nesting
commit;
