set lock_timeout = '5s';
set statement_timeout = '60s';

-- Completed window metadata is scoped by the same visible resource. Opaque
-- continuation state, active observations and writer privileges stay private.
grant select(business_id,provider,source_account,resource,stream,last_complete_observation_id,last_complete_at,
 last_complete_scope,last_complete_mode) on public.external_sync_checkpoints to authenticated;
create policy owner_read_completed_windows on public.external_sync_checkpoints for select to authenticated
using (last_complete_mode='window' and last_complete_observation_id is not null and exists(
 select from public.external_resources e
 where (e.business_id,e.provider,e.source_account,e.resource)=
  (external_sync_checkpoints.business_id,external_sync_checkpoints.provider,
   external_sync_checkpoints.source_account,external_sync_checkpoints.resource)
));

-- A completed Square location must not replace another location's receipt.
create or replace view public.cv_shifts (business_id,source,source_ref,status,business_date,data)
with (security_invoker=true) as
 with observed as not materialized (
  select e.business_id,e.provider,l.id as location_id,r.source_key as shift_key,
   r.payload #>> '{employeeReference,guid}' as employee_key,r.payload #>> '{jobReference,guid}' as job_key,
   t.start_at,t.end_at,r.payload->'deleted'='true'::jsonb as deleted
  from public.external_resources e
  join public.external_sync_checkpoints c using(business_id,provider,source_account,resource)
  join public.locations l on l.business_id=e.business_id and l.id=
   case when pg_input_is_valid(c.last_complete_scope->>'locationId','uuid')
    then (c.last_complete_scope->>'locationId')::uuid end
  join public.external_observation_members m
   on (m.business_id,m.provider,m.observation_id)=(e.business_id,e.provider,c.last_complete_observation_id)
  join public.external_records r on (r.business_id,r.provider,r.id)=(m.business_id,m.provider,m.record_id)
  cross join lateral (select public.toast_time_or_null(r.payload->>'inDate') as start_at,
   public.toast_time_or_null(r.payload->>'outDate') as end_at) t
  where e.provider='toast' and e.resource='labor/v1/shifts' and c.stream='range' and e.permission_granted is true
   and c.last_complete_mode='window'
   and (e.last_permission_loss_at is null or c.last_complete_at>=e.last_permission_loss_at)
   and (r.source_account,r.entity,r.payload_sha256)=(e.source_account,e.resource,m.observed_sha256)
   and r.payload_origin='provider' and r.source_key=r.payload->>'guid'
   and r.payload #>> '{employeeReference,guid}' is not null
   and t.start_at>=public.toast_time_or_null(c.last_complete_scope->>'from')
   and t.end_at<public.toast_time_or_null(c.last_complete_scope->>'until') and t.end_at>t.start_at
  union all
  select e.business_id,e.provider,l.id,r.source_key,
   r.payload #>> '{published_shift_details,team_member_id}',r.payload #>> '{published_shift_details,job_id}',
   t.start_at,t.end_at,r.payload #> '{published_shift_details,is_deleted}'='true'::jsonb
  from public.external_resources e
  join public.external_sync_checkpoints c using(business_id,provider,source_account,resource)
  join public.locations l on l.business_id=e.business_id and l.pos_location_id=c.last_complete_scope->>'location'
  join public.external_observation_members m
   on (m.business_id,m.provider,m.observation_id)=(e.business_id,e.provider,c.last_complete_observation_id)
  join public.external_records r on (r.business_id,r.provider,r.id)=(m.business_id,m.provider,m.record_id)
  cross join lateral (select public.toast_time_or_null(r.payload #>> '{published_shift_details,start_at}') as start_at,
   public.toast_time_or_null(r.payload #>> '{published_shift_details,end_at}') as end_at,
   case when pg_input_is_valid(c.last_complete_scope->>'query','jsonb')
    then (c.last_complete_scope->>'query')::jsonb end as query) t
  where e.provider='square' and e.resource='scheduled_shifts' and c.stream=c.last_complete_scope->>'location'
   and e.permission_granted is true
   and c.last_complete_mode='window'
   and (e.last_permission_loss_at is null or c.last_complete_at>=e.last_permission_loss_at)
   and (r.source_account,r.entity,r.payload_sha256)=(e.source_account,e.resource,m.observed_sha256)
   and r.payload_origin='provider' and r.source_key=r.payload->>'id'
   and r.payload #>> '{published_shift_details,location_id}'=l.pos_location_id
   and r.payload #>> '{published_shift_details,team_member_id}' is not null
   and t.end_at>public.toast_time_or_null(t.query #>> '{query,filter,end,start_at}')
   and t.start_at<public.toast_time_or_null(t.query #>> '{query,filter,start,end_at}') and t.end_at>t.start_at
 )
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
 select o.business_id,o.provider,o.provider||'-shift:'||o.shift_key,'actual'::text,
 (o.start_at at time zone b.timezone)::date,
 jsonb_build_object('provider',o.provider,'employee_id',o.employee_key,'job_id',o.job_key,
   'scheduled_start',o.start_at,'scheduled_end',o.end_at,'location_id',o.location_id,
   'paid',false,'evidence','completed_observation')
 from observed o join public.businesses b on b.id=o.business_id
 where o.deleted is distinct from true
 union all
 select p.business_id,p.provider,
 p.provider||'-shift:'||p.external_shift_id,'actual'::text,
 (p.scheduled_start at time zone b.timezone)::date,
 jsonb_build_object('provider',p.provider,'employee_id',p.external_employee_id,
  'job_id',p.external_job_id,'scheduled_start',p.scheduled_start,
  'scheduled_end',p.scheduled_end,'location_id',p.location_id,'paid',false,'evidence','historical_projection')
 from public.pos_scheduled_shifts p join public.businesses b on b.id=p.business_id
 where not p.deleted and not exists(
  select from observed o where (o.business_id,o.provider,o.location_id,o.shift_key)=
   (p.business_id,p.provider,p.location_id,p.external_shift_id));
