-- Task 8B: public occurrence correction, existing identities and private histories.
-- Additive, service-role-only; no production migration authorized by this PR.
alter table public.city_events add column lifecycle jsonb
  check (lifecycle is null or jsonb_typeof(lifecycle)='object'),
 add column start_at timestamptz, add column end_at timestamptz,
 add column source_timezone text,
 add constraint city_event_explicit_interval check (
 (start_at is null and end_at is null and source_timezone is null) or
 (start_at is not null and end_at is not null and source_timezone is not null and end_at>start_at));

create or replace function public.ldi_upsert_city_event(
  p_city_key text, p_identity_key text, p_source_identity_key text,
  p_venue_identity_key text, p_name text, p_kind text,
  p_start_date date, p_end_date date, p_source_url text,
  p_checked_at timestamptz, p_venue text default null, p_venue_address text default null,
  p_venue_key text default null, p_venue_address_key text default null
) returns uuid language plpgsql security invoker set search_path=public as $$
declare
  result_id uuid;
  matching_ids uuid[];
  keys text[];
  current_key text;
begin
  if p_identity_key !~ '^[0-9a-f]{64}$' or
    p_source_identity_key !~ '^[0-9a-f]{64}$' or
    (p_venue_identity_key is not null and p_venue_identity_key !~ '^[0-9a-f]{64}$')
  then raise exception 'invalid_city_event_identity' using errcode='23514'; end if;
  keys:=case when p_venue_identity_key is null
    then array[p_source_identity_key] else array[p_source_identity_key,p_venue_identity_key] end;
  -- Serialize both same-source enrichment and cross-source venue writes.
  -- Sorted advisory locks avoid deadlock when concurrent sources overlap.
  for current_key in select distinct k from unnest(keys) as aliases(k) order by k loop
    perform pg_advisory_xact_lock(hashtextextended('ldi-city-event:'||current_key,0));
  end loop;
  select array_agg(distinct city_event_id) into matching_ids
    from public.city_event_aliases where alias_key=any(keys);
  if cardinality(matching_ids)>1 then
    raise exception 'city_event_identity_conflict_review_required' using errcode='23514';
  end if;
  if cardinality(matching_ids)=1 then
    result_id:=matching_ids[1];
    -- Serialize correction vs rediscovery by locking the same public row.
    perform 1 from public.city_events where id=result_id for update;
    if exists(select 1 from public.city_events where id=result_id
      and city_key=p_city_key and lifecycle is not null) then
      -- A verified correction owns the new interval. A dated historic alias
      -- still resolves, but discovery may not reverse its status/venue/dates.
      -- At the corrected date a strongly corroborated venue (or already
      -- registered source) can attach its additional source, never mutate facts.
      if exists(select 1 from public.city_events e where e.id=result_id
        and e.start_date=p_start_date
        and ((p_venue_key is null or e.venue_key=p_venue_key)
          and (p_venue_address_key is null or e.venue_address_key=p_venue_address_key)))
      then
        insert into public.city_event_aliases(alias_key,city_event_id)
          values(p_source_identity_key,result_id) on conflict(alias_key) do nothing;
        if (select city_event_id from public.city_event_aliases where alias_key=p_source_identity_key)
          is distinct from result_id then raise exception 'city_event_alias_conflict' using errcode='23514'; end if;
        insert into public.city_event_sources(city_event_id,source_url,observed_name,observed_at)
          values(result_id,p_source_url,p_name,p_checked_at)
          on conflict(city_event_id,source_url) do update set
            observed_at=greatest(city_event_sources.observed_at,excluded.observed_at);
      end if;
      return result_id;
    end if;
    -- Compare EXACTLY the normalized keys supplied by cityEventIdentity.ts;
    -- never fuse two confirmed addresses for one source, and never reject
    -- equivalent accent/ampersand spellings as separate venues.
    if exists (
      select 1 from public.city_events e where e.id=result_id and (
        (e.venue_key is not null and p_venue_key is not null and e.venue_key <> p_venue_key)
        or (e.venue_address_key is not null and p_venue_address_key is not null
            and e.venue_address_key <> p_venue_address_key)
      )
    ) then raise exception 'city_event_venue_conflict_review_required' using errcode='23514'; end if;
    update public.city_events set
      last_checked_at=greatest(last_checked_at,p_checked_at),
      venue=coalesce(venue,p_venue),venue_address=coalesce(venue_address,p_venue_address),
      venue_key=coalesce(venue_key,p_venue_key),
      venue_address_key=coalesce(venue_address_key,p_venue_address_key)
    where id=result_id and city_key=p_city_key and start_date=p_start_date;
    if not found then raise exception 'city_event_scope_conflict' using errcode='23514'; end if;
  else
    insert into public.city_events(city_key,identity_key,name,kind,start_date,end_date,
      venue,venue_address,venue_key,venue_address_key,last_checked_at)
    values (p_city_key,p_identity_key,p_name,p_kind,p_start_date,p_end_date,
      p_venue,p_venue_address,p_venue_key,p_venue_address_key,p_checked_at)
    on conflict(identity_key) do update set
      last_checked_at=greatest(city_events.last_checked_at,excluded.last_checked_at),
      venue=coalesce(city_events.venue,excluded.venue),
      venue_address=coalesce(city_events.venue_address,excluded.venue_address),
      venue_key=coalesce(city_events.venue_key,excluded.venue_key),
      venue_address_key=coalesce(city_events.venue_address_key,excluded.venue_address_key)
    where city_events.city_key=excluded.city_key and city_events.start_date=excluded.start_date
    returning id into result_id;
    if result_id is null then raise exception 'city_event_identity_conflict' using errcode='23514'; end if;
  end if;
  foreach current_key in array keys loop
    insert into public.city_event_aliases(alias_key,city_event_id)
      values(current_key,result_id) on conflict(alias_key) do nothing;
    if (select city_event_id from public.city_event_aliases where alias_key=current_key)
      is distinct from result_id then
      raise exception 'city_event_alias_conflict' using errcode='23514';
    end if;
  end loop;
  insert into public.city_event_sources(city_event_id,source_url,observed_name,observed_at)
    values (result_id,p_source_url,p_name,p_checked_at)
    on conflict (city_event_id,source_url) do update set
      observed_at=greatest(city_event_sources.observed_at,excluded.observed_at);
  return result_id;
end $$;

-- Protect newer official revision from the historical enrichment UPDATE path.
create function public.ldi_keep_corrected_occurrence() returns trigger
language plpgsql set search_path=public as $$
begin
 if old.lifecycle is not null and new.lifecycle is not distinct from old.lifecycle then
   new.start_date:=old.start_date; new.end_date:=old.end_date;
   new.venue:=old.venue; new.venue_address:=old.venue_address;
   new.venue_key:=old.venue_key; new.venue_address_key:=old.venue_address_key;
   new.start_time:=old.start_time; new.end_time:=old.end_time;
   new.duration_source_url:=old.duration_source_url;
   new.duration_verified_at:=old.duration_verified_at;
   new.time_source_url:=old.time_source_url;
   new.last_enriched_at:=old.last_enriched_at;
   new.start_at:=old.start_at; new.end_at:=old.end_at; new.source_timezone:=old.source_timezone;
 end if;
 return new;
end $$;
create trigger ldi_keep_corrected_occurrence before update on public.city_events
for each row execute function public.ldi_keep_corrected_occurrence();

-- Same claimed cafe row, existing city identity, exact source and new alias keys.
-- All shared/public and linked private rows are committed or rolled back together.
-- No changes to approvals, POS, stock, staffing, or historical report rows.
create function public.ldi_correct_occurrence(
 p_business_id uuid,p_cafe_event_id uuid,p_city_id uuid,p_claim_at timestamptz,
 p_change jsonb,p_aliases text[]
) returns boolean language plpgsql security invoker set search_path=public as $$
declare e public.city_events%rowtype; c public.cafe_events%rowtype;
 k text; next_start date; next_end date; next_status text; revision jsonb;
 at_time timestamptz; source text; previous_history jsonb;
begin
 at_time:=(p_change->>'verifiedAt')::timestamptz;
 source:=p_change->>'sourceUrl'; next_status:=p_change->>'status';
 if at_time is distinct from p_claim_at or next_status not in ('found','cancelled','moved')
   or source is null or source !~ '^https://' or nullif(btrim(p_change->>'statement'),'') is null
   or cardinality(p_aliases)>100 or exists(select 1 from unnest(p_aliases) a where a !~ '^[0-9a-f]{64}$')
 then raise exception 'invalid_occurrence_correction' using errcode='23514'; end if;
 -- Sorted alias locks match discovery's ordering before row lock.
 for k in select distinct a from unnest(p_aliases) a order by a loop
   perform pg_advisory_xact_lock(hashtextextended('ldi-city-event:'||k,0));
 end loop;
 select * into e from public.city_events where id=p_city_id for update;
 if not found then return false; end if;
 select ce.* into c from public.cafe_events ce
 join public.cafe_city_event_links l on l.business_id=ce.business_id and l.cafe_event_id=ce.id
 where ce.business_id=p_business_id and ce.id=p_cafe_event_id and l.city_event_id=p_city_id
 for update of ce;
 if not found or c.last_verification_attempt_at is distinct from p_claim_at
   or c.status is distinct from p_change->>'previousStatus' then return false; end if;
 if not exists(select 1 from public.city_event_sources s where s.city_event_id=e.id
   and s.source_url=coalesce(p_change->>'originalSourceUrl',source)) then
   raise exception 'occurrence_source_not_linked' using errcode='23514';
 end if;
 if e.lifecycle is not null and (e.lifecycle->>'verifiedAt')::timestamptz>=at_time then return false; end if;
 next_start:=case when p_change->>'newEndDate' is not null then coalesce((p_change->>'newDate')::date,e.start_date) else e.start_date end;
 next_end:=coalesce((p_change->>'newEndDate')::date,e.end_date);
 -- Never move a confirmed interval by guessing its duration.
 if next_start<>e.start_date and p_change->>'newEndDate' is null then
   raise exception 'occurrence_new_end_required' using errcode='23514';
 end if;
 if next_end<next_start then raise exception 'invalid_occurrence_interval' using errcode='23514'; end if;
 if next_start<>e.start_date and coalesce(cardinality(p_aliases),0)=0 then
   raise exception 'occurrence_alias_required' using errcode='23514';
 end if;
 if exists(select 1 from public.city_event_aliases where alias_key=any(p_aliases)
   and city_event_id<>e.id) then
   raise exception 'occurrence_alias_conflict' using errcode='23514';
 end if;
 foreach k in array coalesce(p_aliases,array[]::text[]) loop
   insert into public.city_event_aliases(alias_key,city_event_id) values(k,e.id)
   on conflict(alias_key) do nothing;
   if (select city_event_id from public.city_event_aliases where alias_key=k) is distinct from e.id
   then raise exception 'occurrence_alias_conflict' using errcode='23514'; end if;
 end loop;
 -- Public history deliberately excludes café UUID, private decisions and metrics.
 revision:=jsonb_build_object('status',next_status,'verdict',p_change->>'verdict',
   'verifiedAt',at_time,'sourceUrl',source,'statement',p_change->>'statement',
   'previousStartDate',e.start_date,'previousEndDate',e.end_date,
   'startDate',next_start,'endDate',next_end,
   'history',coalesce(e.lifecycle->'history','[]'::jsonb) ||
     case when e.lifecycle is null then '[]'::jsonb else jsonb_build_array(e.lifecycle-'history') end);
 update public.city_events set lifecycle=revision,start_date=next_start,end_date=next_end,
   venue=coalesce(p_change->>'newVenue',venue),
   venue_address=case when p_change->>'newVenue' is not null then null else venue_address end,
   venue_key=case when p_change->>'newVenue' is not null then null else venue_key end,
   venue_address_key=case when p_change->>'newVenue' is not null then null else venue_address_key end,
   start_time=case when next_start<>e.start_date or p_change->>'newEndDate' is not null then null else start_time end,
   end_time=case when next_start<>e.start_date or p_change->>'newEndDate' is not null then null else end_time end,
   start_at=case when p_change->>'newStartAt' is not null then (p_change->>'newStartAt')::timestamptz
     when next_start<>e.start_date or p_change->>'newEndDate' is not null then null else start_at end,
   end_at=case when p_change->>'newEndAt' is not null then (p_change->>'newEndAt')::timestamptz
     when next_start<>e.start_date or p_change->>'newEndDate' is not null then null else end_at end,
   source_timezone=case when p_change->>'sourceTimezone' is not null then p_change->>'sourceTimezone'
     when next_start<>e.start_date or p_change->>'newEndDate' is not null then null else source_timezone end,
   duration_source_url=case when p_change->>'newEndDate' is not null then source else duration_source_url end,
   duration_verified_at=case when p_change->>'newEndDate' is not null then at_time else duration_verified_at end,
   last_checked_at=greatest(last_checked_at,at_time)
 where id=e.id;
 insert into public.city_event_sources(city_event_id,source_url,observed_name,observed_at)
   values(e.id,source,e.name,at_time)
   on conflict(city_event_id,source_url) do update set
     observed_at=greatest(city_event_sources.observed_at,excluded.observed_at);
 -- Each linked café receives its own pending notice revision, preserving IDs
 -- and historical owner decisions. Later per-café verification claims lose.
 for c in select ce.* from public.cafe_events ce join public.cafe_city_event_links l
   on l.business_id=ce.business_id and l.cafe_event_id=ce.id where l.city_event_id=e.id
   order by ce.id for update of ce loop
   previous_history:=coalesce(c.verification_details->'history','[]'::jsonb);
   if jsonb_array_length(previous_history)=0 and c.verification_details->'change' is not null
     then previous_history:=jsonb_build_array(c.verification_details->'change'); end if;
   update public.cafe_events set start_date=next_start,end_date=next_end,status=next_status,
     venue=coalesce(p_change->>'newVenue',venue),
     venue_address=case when p_change->>'newVenue' is not null then null else venue_address end,
     start_time=case when next_start<>e.start_date or p_change->>'newEndDate' is not null then null else start_time end,
     end_time=case when next_start<>e.start_date or p_change->>'newEndDate' is not null then null else end_time end,
     last_verification_attempt_at=at_time,last_verified_at=at_time,verification_failed_at=null,
     verification_details=jsonb_build_object('change',p_change||jsonb_build_object('id',c.id,
       'previousStatus',c.status,'previousStartDate',c.start_date,'previousEndDate',c.end_date),
       'pendingNotice',true,'history',previous_history||jsonb_build_array(p_change||
       jsonb_build_object('id',c.id,'previousStatus',c.status,'previousStartDate',c.start_date,'previousEndDate',c.end_date)))
   where id=c.id and business_id=c.business_id;
 end loop;
 return true;
end $$;
revoke all on function public.ldi_correct_occurrence(uuid,uuid,uuid,timestamptz,jsonb,text[]) from public,anon,authenticated;
grant execute on function public.ldi_correct_occurrence(uuid,uuid,uuid,timestamptz,jsonb,text[]) to service_role;

-- One existing handled operating-task row owns each cafe-day monitor lease.
-- No new queue or table. A lease may be recovered after a failed worker.
create function public.ldi_claim_monitor(p_business_id uuid,p_owner_id uuid,
 p_proposal_id uuid,p_day date,p_token uuid,p_closure boolean default false)
 returns boolean language plpgsql security invoker set search_path=public as $$
declare task_key text; result_count integer; sampled uuid;
begin
 if not exists(select 1 from public.supervisor_proposals p join public.memberships m
 on m.business_id=p.business_id and m.user_id=p.owner_user_id and m.role='owner'
 where p.business_id=p_business_id and p.owner_user_id=p_owner_id and p.id=p_proposal_id
 and p.capability_id='alex.event_readiness.v1' and p.status in ('draft','approved','committed','manual_confirmed'))
 then return false; end if;
 task_key:=case when p_closure then 'event-observation-closure:'||p_proposal_id::text
 else 'event-observation:'||p_day::text end;
 perform pg_advisory_xact_lock(hashtextextended('ldi-monitor:'||p_business_id::text||':'||task_key,0));
 if not p_closure then
   select s.proposal_id into sampled from public.supervisor_monitor_samples s
   join public.supervisor_proposals p on p.business_id=s.business_id and p.id=s.proposal_id
   where s.business_id=p_business_id and s.business_date=p_day and p.capability_id='alex.event_readiness.v1'
   order by s.recorded_at asc,s.id asc limit 1;
   if sampled is not null and sampled<>p_proposal_id then return false; end if;
 end if;
 insert into public.operating_tasks(business_id,id,agent_id,kind,entity_type,entity_id,status,confidence,payload,evidence)
 values(p_business_id,task_key,'alex','event_assessment','event_day',p_day::text,'handled','low',
 jsonb_build_object('businessDate',p_day,'proposalId',p_proposal_id,'token',p_token,
 'leaseUntil',clock_timestamp()+interval '10 minutes'),'[]'::jsonb)
 on conflict(business_id,id) do update set payload=excluded.payload,updated_at=clock_timestamp()
 where (public.operating_tasks.payload->>'leaseUntil')::timestamptz<=clock_timestamp()
 or public.operating_tasks.payload->>'leaseUntil' is null;
 get diagnostics result_count=row_count;
 return result_count=1;
end $$;
create function public.ldi_release_monitor(p_business_id uuid,p_proposal_id uuid,
 p_day date,p_token uuid,p_closure boolean default false) returns void
 language sql security invoker set search_path=public as $$
 update public.operating_tasks set payload=payload-'leaseUntil',updated_at=clock_timestamp()
 where business_id=p_business_id and id=case when p_closure then 'event-observation-closure:'||p_proposal_id::text
 else 'event-observation:'||p_day::text end
 and payload->>'token'=p_token::text and payload->>'proposalId'=p_proposal_id::text
$$;
revoke all on function public.ldi_claim_monitor(uuid,uuid,uuid,date,uuid,boolean),
 public.ldi_release_monitor(uuid,uuid,date,uuid,boolean) from public,anon,authenticated;
grant execute on function public.ldi_claim_monitor(uuid,uuid,uuid,date,uuid,boolean),
 public.ldi_release_monitor(uuid,uuid,date,uuid,boolean) to service_role;

-- Last-line integrity across competing proposal UUIDs, including a stale worker.
-- Preserve any historically existing rows; never insert a second cafe-day.
create function public.ldi_guard_event_sample() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
 if not exists(select 1 from public.supervisor_proposals p where p.business_id=new.business_id
 and p.id=new.proposal_id and p.capability_id='alex.event_readiness.v1') then return new; end if;
 perform pg_advisory_xact_lock(hashtextextended('ldi-sample:'||new.business_id::text||':'||new.business_date::text,0));
 if exists(select 1 from public.supervisor_monitor_samples s join public.supervisor_proposals p
 on p.business_id=s.business_id and p.id=s.proposal_id where s.business_id=new.business_id
 and s.business_date=new.business_date and s.proposal_id<>new.proposal_id
 and p.capability_id='alex.event_readiness.v1') then
 raise exception 'event_business_day_already_observed' using errcode='23514'; end if;
 return new;
end $$;
create trigger ldi_guard_event_sample before insert or update on public.supervisor_monitor_samples
 for each row execute function public.ldi_guard_event_sample();

-- Serialize the existing assessment/notice writers before a paid model turn.
-- Successful versions are durable until new material evidence changes the key.
create function public.ldi_claim_event_work(p_business_id uuid,p_owner_id uuid,
 p_work_key text,p_day date,p_token uuid) returns boolean
 language plpgsql security invoker set search_path=public as $$
declare affected integer;
begin
 if p_work_key !~ '^event-work:(assessment|change):[0-9a-f-]{36}$'
 or not exists(select 1 from public.memberships where business_id=p_business_id
 and user_id=p_owner_id and role='owner') then return false; end if;
 insert into public.operating_tasks(business_id,id,agent_id,kind,entity_type,entity_id,
 status,confidence,payload,evidence)
 values(p_business_id,p_work_key,'alex','event_assessment','event_day',p_day::text,
 'handled','low',jsonb_build_object('token',p_token,'leaseUntil',clock_timestamp()+interval '10 minutes'),'[]'::jsonb)
 on conflict(business_id,id) do update set payload=excluded.payload,updated_at=clock_timestamp()
 where coalesce((public.operating_tasks.payload->>'complete')::boolean,false)=false
 and ((public.operating_tasks.payload->>'leaseUntil')::timestamptz<=clock_timestamp()
 or public.operating_tasks.payload->>'leaseUntil' is null);
 get diagnostics affected=row_count;
 return affected=1;
end $$;
create function public.ldi_release_event_work(p_business_id uuid,p_work_key text,
 p_token uuid,p_complete boolean) returns void
 language sql security invoker set search_path=public as $$
 update public.operating_tasks set payload=(payload-'leaseUntil')||jsonb_build_object('complete',p_complete),
 updated_at=clock_timestamp()
 where business_id=p_business_id and id=p_work_key and payload->>'token'=p_token::text
$$;
revoke all on function public.ldi_claim_event_work(uuid,uuid,text,date,uuid),
 public.ldi_release_event_work(uuid,text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.ldi_claim_event_work(uuid,uuid,text,date,uuid),
 public.ldi_release_event_work(uuid,text,uuid,boolean) to service_role;
