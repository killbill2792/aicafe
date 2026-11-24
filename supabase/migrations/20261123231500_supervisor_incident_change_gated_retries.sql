-- Incident-scoped source changes, durable owner waiting, bounded technical retries.
-- This extends the existing Supervisor SQL lease/queue; no new scheduler/agent.
-- Preserve the existing claim function and PR #560 Toast gate. The new
-- BEFORE UPDATE pause trigger works for both current and future claim SQL.
set lock_timeout='3s';
set statement_timeout='45s';

CREATE OR REPLACE FUNCTION public.supervisor_enqueue_investigation(p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_source_type text, p_source_id text, p_revision_hash text, p_stable_key text, p_priority integer, p_now timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_open boolean;v_episode uuid;v_anomaly boolean:=false;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required' using errcode='42501'; end if;
  if not public.supervisor_routine_owner_authorized(
    p_business_id,p_owner_user_id,p_thread_id) then
    raise exception 'Investigation owner or thread revoked' using errcode='42501'; end if;
  if p_source_type not in ('alert','operating_task') or
    length(coalesce(p_source_id,'')) not between 1 and 256 or
    p_revision_hash !~ '^[a-f0-9]{64}$' or p_stable_key !~ '^[a-f0-9]{64}$'
    or p_priority is null or p_priority not between 0 and 400
    or p_now is null then raise exception 'Invalid investigation key' using errcode='22023'; end if;
  if p_source_type='alert' then
    select exists(select 1 from public.alerts a
      where a.business_id=p_business_id and a.id::text=p_source_id
        and a.status in ('new','seen')) into v_open;
  else
    select exists(select 1 from public.operating_tasks t
      where t.business_id=p_business_id and t.id=p_source_id
        and t.kind not in ('priority_notice','commitment','event_plan','event_change','event_report','daily_brief')
        and t.status in ('needs_owner','needs_response','watching')
        and (t.owner_user_id is null or t.owner_user_id=p_owner_user_id)) into v_open;
  end if;
  if not v_open then return false; end if;
  -- Rolling business-source data revisions are not a new incident. Keep the
  -- outstanding owner question, answer and episode; fence the old revision.
  if p_source_type='alert' then
    select exists(select 1 from public.alerts a where a.business_id=p_business_id
       and a.id::text=p_source_id and a.kind='business_anomaly') into v_anomaly;
  end if;
  -- A relevant source revision wakes the SAME episode, but leaves its
  -- owner question answerable. The pendingRelevantRevision token is set by
  -- service-only enqueue, consumed by the investigation checkpoint, and
  -- NEVER minted by a periodic cron timestamp or unrelated café row.
  if v_anomaly then
    update public.supervisor_investigations set revision_hash=p_revision_hash,
      stable_key=p_stable_key,priority=p_priority,next_retry_at=p_now,updated_at=p_now,
      evidence=case when phase='awaiting_owner' then
        jsonb_set(coalesce(evidence,'{}'::jsonb),'{pendingRelevantRevision}',
          to_jsonb(p_revision_hash),true) else evidence end,
      failure_count=0,last_error=null
      where business_id=p_business_id and owner_user_id=p_owner_user_id and thread_id=p_thread_id
       and source_type=p_source_type and source_id=p_source_id
       and phase in ('collect','investigate','awaiting_owner')
       and revision_hash<>p_revision_hash and (lease_until is null or lease_until<=p_now);
    if found then return true;end if;
  else
    update public.supervisor_investigations set revision_hash=p_revision_hash,
      stable_key=p_stable_key,priority=p_priority,next_retry_at=p_now,updated_at=p_now,
      evidence=jsonb_set(coalesce(evidence,'{}'::jsonb),
        '{pendingRelevantRevision}',to_jsonb(p_revision_hash),true),
      failure_count=0,last_error=null
      where business_id=p_business_id and owner_user_id=p_owner_user_id and thread_id=p_thread_id
       and source_type=p_source_type and source_id=p_source_id and phase='awaiting_owner'
       and revision_hash<>p_revision_hash and (lease_until is null or lease_until<=p_now);
    if found then return true;end if;
  end if;
  insert into public.supervisor_investigations
    (business_id,owner_user_id,thread_id,source_type,source_id,
     revision_hash,stable_key,priority,next_retry_at)
  values(p_business_id,p_owner_user_id,p_thread_id,p_source_type,p_source_id,
    p_revision_hash,p_stable_key,p_priority,p_now)
  on conflict (business_id,owner_user_id,source_type,source_id)
  do update set episode_id=gen_random_uuid(),
    revision_hash=excluded.revision_hash,stable_key=excluded.stable_key,
    priority=excluded.priority,
    thread_id=excluded.thread_id,phase='collect',step_version=0,
    failure_count=0,lease_token=null,lease_until=null,next_retry_at=p_now,
    evidence='{}'::jsonb,narrative=null,last_error=null,updated_at=p_now
  -- Closed/technical-blocked incidents stay asleep on identical evidence.
  -- A restored owner/member assignment is an independently verified change
  -- of authorization and may restart a previously authorization-blocked row.
  where (public.supervisor_investigations.revision_hash<>excluded.revision_hash
    -- A genuinely reopened source is different from a passive unchanged
    -- incident: an owner-handled task that becomes actionable again may
    -- restart without altering its original material payload.
    or (public.supervisor_investigations.phase='resolved'
      and public.supervisor_investigations.last_error='source_closed')
    or (public.supervisor_investigations.phase='blocked'
      and public.supervisor_investigations.last_error in
        ('source_missing','source_reassigned','authorization_revoked')))
    and (public.supervisor_investigations.lease_until is null
      or public.supervisor_investigations.lease_until<=p_now);
  -- FOUND reports whether a new investigation was inserted or a material
  -- source revision reset it. Repeated identical scans are not new work.
  if found then
    -- A new episode supersedes earlier owner reports for the same exact
    -- business/owner/source. Preserve the report rows as Handled history,
    -- but never leave their old "Needs you" actions open alongside the new
    -- investigation. Rechecks of the SAME active episode do not enter here.
    select episode_id into v_episode from public.supervisor_investigations
      where business_id=p_business_id and owner_user_id=p_owner_user_id
        and source_type=p_source_type and source_id=p_source_id;
    update public.operating_tasks set status='handled',
      resolved_at=coalesce(resolved_at,p_now)
      where business_id=p_business_id and owner_user_id=p_owner_user_id
        and kind='priority_notice' and status in ('needs_owner','needs_response','watching')
        and payload->>'intent'='priority_investigation'
        and payload->>'sourceType'=p_source_type
        and payload->>'sourceId'=p_source_id
        and payload->>'episodeId' is distinct from v_episode::text;
    return true;
  end if;
  -- A priority change updates queue rank without resetting multi-step work.
  update public.supervisor_investigations set priority=p_priority
    where business_id=p_business_id and owner_user_id=p_owner_user_id
      and source_type=p_source_type and source_id=p_source_id
      and revision_hash=p_revision_hash and priority is distinct from p_priority;
  return false;
end $function$
;

-- Do not redefine the claim function here. PR #560 owns its verified-Toast
-- admission gate. Instead, durable due-time policy makes unanswered work
-- impossible to claim regardless of the existing claim SQL implementation.
create or replace function public.supervisor_pause_unanswered_investigation()
returns trigger language plpgsql set search_path=public as $$
begin
  if new.phase='awaiting_owner'
     and (new.last_owner_answer_id is null or
       new.last_owner_answer_id=new.reported_owner_answer_id)
     and new.evidence->>'pendingRelevantRevision' is distinct from new.revision_hash
     -- Maintenance may receive a vendor email outside this database. The
     -- existing bounded lease polls the reply without a model turn and
     -- records an exact event when one arrives. Do not freeze that poll.
     and not (new.source_type='operating_task' and exists(
       select 1 from public.operating_tasks t
       where t.business_id=new.business_id and t.id=new.source_id
         and t.kind='maintenance_issue' and t.status in
           ('needs_owner','needs_response','watching'))) then
    new.next_retry_at='infinity'::timestamptz;
  end if;
  return new;
end $$;
revoke all on function public.supervisor_pause_unanswered_investigation()
  from public,anon,authenticated;
create trigger supervisor_pause_unanswered_investigation
before insert or update on public.supervisor_investigations
for each row execute function public.supervisor_pause_unanswered_investigation();

-- Existing pending owner work must be stopped immediately on rollout; no
-- further model calls until the linked answer or substantive source revision.
update public.supervisor_investigations
set next_retry_at='infinity'::timestamptz
where phase='awaiting_owner'
  and (last_owner_answer_id is null or last_owner_answer_id=reported_owner_answer_id)
  and evidence->>'pendingRelevantRevision' is distinct from revision_hash
  and not (source_type='operating_task' and exists(
    select 1 from public.operating_tasks t
    where t.business_id=supervisor_investigations.business_id
      and t.id=supervisor_investigations.source_id
      and t.kind='maintenance_issue' and t.status in
        ('needs_owner','needs_response','watching')))
  and next_retry_at<>'infinity'::timestamptz;

CREATE OR REPLACE FUNCTION public.supervisor_fail_investigation(p_business_id uuid, p_owner_user_id uuid, p_source_type text, p_source_id text, p_lease_token uuid, p_error text, p_now timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v public.supervisor_investigations;v_count integer;v_hash text;v_msg uuid;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required' using errcode='42501'; end if;
  if p_error not in ('source_unavailable','provider_unavailable','owner_quota_reached','model_incomplete',
    'evidence_incomplete','authorization_revoked','time_exceeded','storage_failed')
  then raise exception 'Invalid investigation error code' using errcode='22023'; end if;
  select * into v from public.supervisor_investigations
    where business_id=p_business_id and owner_user_id=p_owner_user_id
      and source_type=p_source_type and source_id=p_source_id for update;
  if not found or v.lease_token is distinct from p_lease_token
    or v.lease_until<=p_now then return false; end if;
  v_count:=case when p_error='owner_quota_reached' then v.failure_count
    else least(3,v.failure_count+1) end;
  update public.supervisor_investigations set
    -- Three bounded technical retries; a terminal failure remains visible but
    -- does not continue paid work every six hours without new evidence.
    -- Keep the original owner question replyable even after paid model
    -- retries are exhausted. A blocked row clears pending_question_id via
    -- supervisor_reset_investigation_answer_scope and rejects the saved
    -- owner's response. The lease still sleeps indefinitely below.
    phase=case when v.phase='awaiting_owner' and v.pending_question_id is not null
        and (v.last_owner_answer_id is null or
             v.last_owner_answer_id=v.reported_owner_answer_id)
        and p_error<>'authorization_revoked' then 'awaiting_owner'
      when p_error='authorization_revoked' or v_count>=3 then 'blocked'
      else v.phase end,
    failure_count=v_count,
    last_error=p_error,lease_token=null,lease_until=null,
    next_retry_at=case when p_error='owner_quota_reached'
      then (date_trunc('day',p_now at time zone 'UTC')+interval '1 day') at time zone 'UTC'
      when v_count>=3 or p_error='authorization_revoked' then 'infinity'::timestamptz
      else p_now+(interval '1 minute'*least(60,power(2,v_count)::integer)) end,
    updated_at=p_now
  where business_id=p_business_id and owner_user_id=p_owner_user_id
    and source_type=p_source_type and source_id=p_source_id;
  -- Repeated failure is owner-visible, not silently abandoned. No message is
  -- attempted after membership/thread revocation, and no effect is retried.
  if v_count=3 and v.failure_count<3 and public.supervisor_routine_owner_authorized(
    v.business_id,v.owner_user_id,v.thread_id) then
    v_hash:=md5('investigation-blocked:'||v.business_id::text||':'||v.owner_user_id::text||
      ':'||v.source_type||':'||v.source_id||':'||v.revision_hash||':'||v.episode_id::text);
    v_msg:=(substr(v_hash,1,8)||'-'||substr(v_hash,9,4)||'-4'||
      substr(v_hash,14,3)||'-a'||substr(v_hash,18,3)||'-'||substr(v_hash,21,12))::uuid;
    insert into public.ai_messages(id,business_id,thread_id,owner_user_id,role,
      content_type,structured_content,grounding)
    values(v_msg,v.business_id,v.thread_id,v.owner_user_id,'supervisor','blocks',
      jsonb_build_array(jsonb_build_object('type','text','text',
        'Investigation update: I could not verify the café issue after repeated checks. I have paused automatic retries for this investigation. The original attention item remains available. No external action was taken. A verified change in the relevant source evidence can reopen it.')),
      jsonb_build_object('status','verified','intent','priority_investigation_exception',
        'evidence',jsonb_build_array(jsonb_build_object('source',v.source_type,
          'identifier',v.source_id,'asOf',p_now::text))))
    on conflict(id) do nothing;
  end if;
  return true;
end $function$
;

-- A historical daily brief is a dated report, not an autonomous incident.
-- Preserve the original operating task; stop its old paid investigation.
update public.supervisor_investigations i
 set phase='resolved',last_error='nonincident_daily_brief',
     lease_token=null,lease_until=null,updated_at=statement_timestamp()
from public.operating_tasks t
where i.business_id=t.business_id and i.source_type='operating_task'
  and i.source_id=t.id and t.kind='daily_brief'
  and i.phase in ('collect','investigate','awaiting_owner');

-- The originally granted EXECUTE permissions remain unchanged by CREATE OR REPLACE.
