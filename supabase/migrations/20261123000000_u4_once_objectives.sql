-- PR #557: one-off owner objectives reuse the existing U4 routine/occurrence ledger.
-- Development migration ONLY. No automatic production application or Watch activation.
set lock_timeout='3s';
set statement_timeout='30s';

alter table public.supervisor_routines
  add column if not exists once_local_date date,
  add column if not exists once_due_at_utc timestamptz;

-- The original table's anonymous checks reject 'once'. Replace only those
-- cadence-bearing checks; keep every other identity, RLS and owner constraint.
do $once_check$ declare c record; begin
  for c in select conname from pg_constraint
    where conrelid='public.supervisor_routines'::regclass and contype='c'
      and pg_get_constraintdef(oid) ~ 'cadence'
      and conname<>'supervisor_routines_once_cadence_check'
  loop
    execute format('alter table public.supervisor_routines drop constraint %I',c.conname);
  end loop;
end $once_check$;
alter table public.supervisor_routines
  add constraint supervisor_routines_once_cadence_check
  check(
    (cadence='once' and cardinality(weekdays)=0
      and once_local_date is not null and once_due_at_utc is not null
      and execution_mode='objective')
    or (cadence='daily' and cardinality(weekdays)=0
      and once_local_date is null and once_due_at_utc is null)
    or (cadence='weekly' and cardinality(weekdays) between 1 and 7
      and once_local_date is null and once_due_at_utc is null)
  ) not valid;
create index if not exists supervisor_once_due_idx
  on public.supervisor_routines(once_due_at_utc,business_id)
  where cadence='once' and status='active';

-- A one-time owner's source is authenticated just like daily U4: the full
-- original owner message, optional later scheduling clarification, never a
-- model-authored title or a second task/agent.
create function public.u4_create_once_objective(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_title text,
  p_due_local_date date,p_local_time time,p_due_at_utc timestamptz,
  p_routine_id uuid,p_owner_message_id uuid,p_goal_source_message_id uuid
) returns public.supervisor_routines
language plpgsql security definer set search_path=''
as $once_goal$
declare m public.ai_messages;g public.ai_messages;
        v public.supervisor_routines;v_zone text;v_goal text;
        v_expected timestamptz;
begin
  if not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
    or p_routine_id is null or p_owner_message_id is null
    or length(btrim(coalesce(p_title,''))) not between 1 and 240
    or p_due_local_date is null or p_local_time is null or p_due_at_utc is null
  then raise exception 'u4_once_schedule_or_authority_invalid' using errcode='42501'; end if;
  select timezone into v_zone from public.businesses where id=p_business_id;
  if v_zone is null or not exists(select 1 from pg_timezone_names where name=v_zone)
    or (p_due_at_utc at time zone v_zone)::date<>p_due_local_date
    or (p_due_at_utc at time zone v_zone)::time<p_local_time
  then raise exception 'u4_once_timezone_invalid' using errcode='22023'; end if;
  select * into m from public.ai_messages
    where id=p_owner_message_id and business_id=p_business_id
      and owner_user_id=p_owner_user_id and author_user_id=p_owner_user_id
      and thread_id=p_thread_id and role='owner' and content_type='text';
  select * into g from public.ai_messages
    where id=coalesce(p_goal_source_message_id,p_owner_message_id)
      and business_id=p_business_id and owner_user_id=p_owner_user_id
      and author_user_id=p_owner_user_id and thread_id=p_thread_id
      and role='owner' and content_type='text' and created_at<=m.created_at;
  if m.id is null or g.id is null
    or length(btrim(coalesce(m.text_content,''))) not between 1 and 4000
    or length(btrim(coalesce(g.text_content,''))) not between 1 and 4000
  then raise exception 'u4_once_original_source_invalid' using errcode='42501'; end if;
  v_goal:=g.text_content;
  if g.id<>m.id then v_goal:=v_goal||E'\nOwner schedule clarification: '||m.text_content; end if;
  if length(btrim(v_goal)) not between 1 and 4000
    then raise exception 'u4_once_goal_too_long' using errcode='22023'; end if;
  -- A same-message retry may happen after the scheduled instant; return
  -- its existing exact saved identity, never insert another occurrence.
  select * into v from public.supervisor_routines
    where business_id=p_business_id and id=p_routine_id
      and owner_user_id=p_owner_user_id and thread_id=p_thread_id
      and title=btrim(p_title) and cadence='once'
      and local_time=p_local_time and once_local_date=p_due_local_date
      and once_due_at_utc=p_due_at_utc and execution_mode='objective'
      and objective_source_message_id=g.id and objective_text=v_goal;
  if found then return v; end if;
  if p_due_at_utc<=statement_timestamp() or
    date_trunc('minute',p_due_at_utc)<>p_due_at_utc then
    raise exception 'u4_once_due_must_be_future' using errcode='22023'; end if;
  -- Verify the exact first eligible DST-aware civil minute independently,
  -- not a client-provided later instant on the same date.
  select min(c.instant) into v_expected from generate_series(
    (p_due_local_date::timestamp at time zone 'UTC')-interval '14 hours',
    (p_due_local_date::timestamp at time zone 'UTC')+interval '38 hours',
    interval '1 minute') as c(instant)
    where (c.instant at time zone v_zone)::date=p_due_local_date
      and (c.instant at time zone v_zone)::time>=p_local_time;
  if v_expected is distinct from p_due_at_utc
  then raise exception 'u4_once_due_instant_mismatch' using errcode='22023';end if;
  insert into public.supervisor_routines(
    business_id,id,owner_user_id,thread_id,title,cadence,weekdays,
    local_time,timezone,execution_mode,objective_text,
    objective_source_message_id,once_local_date,once_due_at_utc)
  values(p_business_id,p_routine_id,p_owner_user_id,p_thread_id,
    btrim(p_title),'once','{}',p_local_time,v_zone,'objective',v_goal,
    g.id,p_due_local_date,p_due_at_utc)
  on conflict(business_id,id) do nothing returning * into v;
  if v.id is null then
    select * into v from public.supervisor_routines
      where business_id=p_business_id and id=p_routine_id
        and owner_user_id=p_owner_user_id and thread_id=p_thread_id
        and title=btrim(p_title) and cadence='once'
        and local_time=p_local_time and once_local_date=p_due_local_date
        and once_due_at_utc=p_due_at_utc and execution_mode='objective'
        and objective_source_message_id=g.id and objective_text=v_goal;
  end if;
  if v.id is null then raise exception 'u4_once_identity_conflict' using errcode='23505'; end if;
  return v;
end
$once_goal$;
revoke all on function public.u4_create_once_objective(
  uuid,uuid,uuid,text,date,time,timestamptz,uuid,uuid,uuid)
  from public,anon;
grant execute on function public.u4_create_once_objective(
  uuid,uuid,uuid,text,date,time,timestamptz,uuid,uuid,uuid)
  to authenticated,service_role;

-- Existing CAS supports pause/resume/edit_goal of once goals, without
-- permitting a date/time or cadence conversion behind the owner's back.
create or replace function public.change_supervisor_routine(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,
  p_routine_id uuid,p_revision bigint,p_patch jsonb
) returns public.supervisor_routines
language plpgsql security definer set search_path=public as $$
declare v_row public.supervisor_routines;v_title text;v_cadence text;
        v_weekdays bigint[];v_local_time time;v_status text;
        v_once_date date;v_once_due timestamptz;v_changed boolean;
begin
  if not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
  then raise exception 'Routine owner or thread not authorized' using errcode='42501'; end if;
  if p_patch is null or jsonb_typeof(p_patch)<>'object'
    or p_patch='{}'::jsonb or exists (
      select 1 from jsonb_object_keys(p_patch) k
      where k not in ('title','cadence','weekdays','localTime','onceLocalDate','status')
    )
  then raise exception 'Invalid routine patch' using errcode='22023'; end if;
  select * into v_row from public.supervisor_routines
    where business_id=p_business_id and id=p_routine_id
      and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
  if not found then raise exception 'Routine unavailable' using errcode='23503'; end if;
  if v_row.revision<>p_revision
  then raise exception 'Routine revision changed' using errcode='40001'; end if;
  if v_row.status='revoked'
  then raise exception 'Revoked routine is terminal' using errcode='23514'; end if;
  v_title:=coalesce(p_patch->>'title',v_row.title);
  v_cadence:=coalesce(p_patch->>'cadence',v_row.cadence);
  v_weekdays:=case when p_patch?'weekdays'
    then array(select jsonb_array_elements_text(p_patch->'weekdays')::bigint)
    else v_row.weekdays end;
  v_local_time:=coalesce((p_patch->>'localTime')::time,v_row.local_time);
  v_status:=coalesce(p_patch->>'status',v_row.status);
  v_once_date:=coalesce((p_patch->>'onceLocalDate')::date,v_row.once_local_date);
  v_once_due:=v_row.once_due_at_utc;
  v_changed:=v_row.cadence='once' and
    (v_once_date is distinct from v_row.once_local_date or
      v_local_time is distinct from v_row.local_time);
  if (v_row.cadence='once')<>(v_cadence='once')
    or (v_cadence<>'once' and p_patch?'onceLocalDate')
    or (v_cadence='once' and v_once_date is null)
    or length(btrim(v_title)) not between 1 and 240 or v_cadence not in ('once','daily','weekly')
    or v_status not in ('active','paused','revoked')
    or (v_cadence='once' and cardinality(v_weekdays)<>0)
    or (v_cadence='daily' and cardinality(v_weekdays)<>0)
    or (v_cadence='weekly' and cardinality(v_weekdays) not between 1 and 7)
    or exists(select 1 from unnest(v_weekdays) n where n not between 1 and 7)
    or (select count(distinct n) from unnest(v_weekdays) n)<>cardinality(v_weekdays)
  then raise exception 'Invalid routine change' using errcode='22023'; end if;
  if v_changed then
    -- A completed one-off instruction cannot be rescheduled to secretly
    -- create a second run. A failed run can be deliberately moved to a
    -- genuinely new date after the owner revises the instruction.
    if exists(select 1 from public.supervisor_routine_occurrences o
        where o.business_id=p_business_id and o.routine_id=p_routine_id
          and (o.state='completed' or o.local_date=v_once_date))
    then raise exception 'u4_once_run_already_claimed' using errcode='23514'; end if;
    select min(c.instant) into v_once_due from generate_series(
      (v_once_date::timestamp at time zone 'UTC')-interval '14 hours',
      (v_once_date::timestamp at time zone 'UTC')+interval '38 hours',
      interval '1 minute') as c(instant)
      where (c.instant at time zone v_row.timezone)::date=v_once_date
        and (c.instant at time zone v_row.timezone)::time>=v_local_time;
    if v_once_due is null or v_once_due<=statement_timestamp()
    then raise exception 'u4_once_change_not_future' using errcode='22023'; end if;
  end if;
  update public.supervisor_routines set
    title=btrim(v_title),cadence=v_cadence,weekdays=v_weekdays,
    local_time=v_local_time,once_local_date=v_once_date,
    once_due_at_utc=v_once_due,status=v_status,revision=revision+1,updated_at=now()
  where business_id=p_business_id and id=p_routine_id returning * into v_row;
  return v_row;
end $$;

-- Same persisted date candidates and lease/fencing as recurring work.
create or replace function public.supervisor_due_routine_dates(
  p_business_id uuid,p_routine_id uuid,p_revision bigint,p_now timestamptz
) returns table(local_date date,scheduled_for_utc timestamptz)
language plpgsql security invoker set search_path=public as $$
declare v public.supervisor_routines;v_today date;v_start date;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required' using errcode='42501'; end if;
  if p_now is null then raise exception 'Invalid instant' using errcode='22023'; end if;
  select * into v from public.supervisor_routines
    where business_id=p_business_id and id=p_routine_id and revision=p_revision
      and status='active';
  if not found then return; end if;
  if not public.supervisor_routine_owner_authorized(v.business_id,v.owner_user_id,v.thread_id)
    then raise exception 'Routine owner lost access' using errcode='42501'; end if;
  if v.cadence='once' then
    if v.once_due_at_utc<=p_now and v.once_local_date is not null and
      not exists(select 1 from public.supervisor_routine_occurrences o
        where o.business_id=v.business_id and o.routine_id=v.id
          and (o.state='completed' or
            (o.local_date=v.once_local_date and o.revision=v.revision and
              (o.state='failed' or
               (o.attempts>=5 and not
                 (o.state='running' and o.lease_until<=p_now))
               or (o.state='running' and o.lease_until>p_now)
               or (o.next_retry_at is not null and o.next_retry_at>p_now)))))
    then
      return query select v.once_local_date,v.once_due_at_utc;
    end if;
    return;
  end if;
  v_today:=(p_now at time zone v.timezone)::date;
  v_start:=(v.updated_at at time zone v.timezone)::date;
  return query
    select dates.candidate_date,dates.candidate_due from (
      -- Existing retry identity survives; use its original scheduled instant.
      select o.local_date as candidate_date,o.scheduled_for_utc as candidate_due
        from public.supervisor_routine_occurrences o
        where o.business_id=v.business_id and o.routine_id=v.id
          and o.revision=v.revision and o.scheduled_for_utc<=p_now
          and o.state in ('pending','running')
          and (o.lease_until is null or o.lease_until<=p_now)
          and (o.next_retry_at is null or o.next_retry_at<=p_now)
      union all
      -- Include all unmaterialized eligible days after the revision began,
      -- including holes from an earlier outage before a later successful tick.
      -- TS uses the existing DST-aware civil-time resolver for new dates.
      select d.civil_date::date,null::timestamptz
        from generate_series(v_start::timestamp,v_today::timestamp,interval '1 day') as d(civil_date)
        where (v.cadence='daily' or extract(isodow from d.civil_date)=any(v.weekdays))
          and not exists (
            select 1 from public.supervisor_routine_occurrences o
              where o.business_id=v.business_id and o.routine_id=v.id and o.local_date=d.civil_date::date)
    ) as dates order by dates.candidate_date asc limit 5;
end $$;

create or replace function public.claim_supervisor_routine_occurrence(
  p_business_id uuid,p_routine_id uuid,p_local_date date,
  p_scheduled_for_utc timestamptz,p_now timestamptz
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_r public.supervisor_routines;v_o public.supervisor_routine_occurrences;
        v_token uuid;v_day integer;
begin
  if coalesce(auth.role(),'')<>'service_role'
  then raise exception 'Service role required' using errcode='42501'; end if;
  if p_now is null or p_scheduled_for_utc is null or p_local_date is null
    or p_scheduled_for_utc>p_now then return null; end if;
  select * into v_r from public.supervisor_routines
    where business_id=p_business_id and id=p_routine_id for update;
  if not found or v_r.status<>'active' then return null; end if;
  if not public.supervisor_routine_owner_authorized(v_r.business_id,v_r.owner_user_id,v_r.thread_id)
    then raise exception 'Routine owner lost access' using errcode='42501'; end if;
  -- No missed pre-creation or pre-resume backlog, even on a late cron.
  if p_scheduled_for_utc<v_r.updated_at then return null; end if;
  if (p_scheduled_for_utc at time zone v_r.timezone)::date<>p_local_date then
    raise exception 'Routine timezone mismatch' using errcode='22023'; end if;
  if v_r.cadence='once' and (p_local_date is distinct from v_r.once_local_date
    or p_scheduled_for_utc is distinct from v_r.once_due_at_utc) then return null; end if;
  v_day:=extract(isodow from p_local_date);
  if v_r.cadence='weekly' and not v_day=any(v_r.weekdays) then return null; end if;
  insert into public.supervisor_routine_occurrences
    (business_id,routine_id,local_date,revision,scheduled_for_utc)
  values(p_business_id,p_routine_id,p_local_date,v_r.revision,p_scheduled_for_utc)
  on conflict do nothing;
  select * into v_o from public.supervisor_routine_occurrences
    where business_id=p_business_id and routine_id=p_routine_id
      and local_date=p_local_date for update;
  -- A fifth worker death must reach a truthful terminal state instead of
  -- preserving an expired running occurrence indefinitely.
  if v_o.revision=v_r.revision and v_o.state='running'
    and v_o.attempts>=5 and v_o.lease_until<=p_now then
    update public.supervisor_routine_occurrences set
      state='failed',lease_token=null,lease_until=null,next_retry_at=null,
      last_error='lease_expired',updated_at=p_now
    where business_id=p_business_id and routine_id=p_routine_id and local_date=p_local_date;
    return null;
  end if;
  if v_o.revision<>v_r.revision or v_o.state in ('completed','failed')
    or v_o.attempts>=5 or (v_o.state='running' and v_o.lease_until>p_now)
    or (v_o.next_retry_at is not null and v_o.next_retry_at>p_now) then return null; end if;
  v_token:=gen_random_uuid();
  update public.supervisor_routine_occurrences set
    state='running',attempts=attempts+1,lease_token=v_token,
    lease_until=p_now+interval '4 minutes',next_retry_at=null,updated_at=p_now
    where business_id=p_business_id and routine_id=p_routine_id
      and local_date=p_local_date returning * into v_o;
  return jsonb_build_object('run_id',v_o.run_id,'lease_token',v_token,'revision',v_o.revision);
end $$;
