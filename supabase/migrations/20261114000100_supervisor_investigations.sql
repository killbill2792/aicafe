-- Task 15A. One durable read-only investigation attached to the existing
-- Supervisor, existing 15-minute refresh cron and existing owner conversation.
-- An investigation can NEVER grant an effect or fabricate an owner message.
create table public.supervisor_investigations (
  business_id uuid not null references public.businesses(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null,
  source_type text not null check (source_type in ('alert','operating_task')),
  source_id text not null,
  revision_hash text not null check (revision_hash ~ '^[a-f0-9]{64}$'),
  stable_key text not null check (stable_key ~ '^[a-f0-9]{64}$'),
  phase text not null default 'collect' check
    (phase in ('collect','investigate','awaiting_owner','resolved','blocked')),
  step_version integer not null default 0 check (step_version >= 0),
  failure_count integer not null default 0 check (failure_count between 0 and 5),
  lease_token uuid,
  lease_until timestamptz,
  next_retry_at timestamptz not null default now(),
  evidence jsonb not null default '{}'::jsonb,
  narrative text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id,owner_user_id,source_type,source_id),
  constraint investigation_lease_pair check
    ((lease_token is null)=(lease_until is null)),
  constraint investigation_evidence_size check (octet_length(evidence::text)<=8192),
  constraint investigation_narrative_size check
    (narrative is null or length(narrative)<=1800)
);
create index supervisor_investigations_due_idx
  on public.supervisor_investigations(next_retry_at,created_at)
  where phase in ('collect','investigate','awaiting_owner');
-- Reason: This is a new table created within this migration; RLS precedes client grants.\n-- squawk-ignore ban-alter-row-level-security
alter table public.supervisor_investigations enable row level security;
create policy supervisor_investigations_owner_read
  on public.supervisor_investigations for select to authenticated
  using (owner_user_id=(select auth.uid()) and exists (
    select 1 from public.memberships m where m.business_id=supervisor_investigations.business_id
      and m.user_id=(select auth.uid()) and m.role='owner'
  ) and exists (
    select 1 from public.ai_threads t where t.id=supervisor_investigations.thread_id
      and t.business_id=supervisor_investigations.business_id
      and t.owner_user_id=(select auth.uid())
  ));
revoke all on public.supervisor_investigations from public,anon,authenticated;
grant select on public.supervisor_investigations to authenticated;
grant all on public.supervisor_investigations to service_role;

-- Enqueue only a live source. Every server-selected owner/thread is checked in
-- Postgres, including the active membership; client/model IDs are never trusted.
create function public.supervisor_enqueue_investigation(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,
  p_source_type text,p_source_id text,p_revision_hash text,p_stable_key text,
  p_now timestamptz
) returns boolean language plpgsql security definer set search_path=public as $$
declare v_open boolean;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required' using errcode='42501'; end if;
  if not public.supervisor_routine_owner_authorized(
    p_business_id,p_owner_user_id,p_thread_id) then
    raise exception 'Investigation owner or thread revoked' using errcode='42501'; end if;
  if p_source_type not in ('alert','operating_task') or
    length(coalesce(p_source_id,'')) not between 1 and 256 or
    p_revision_hash !~ '^[a-f0-9]{64}$' or p_stable_key !~ '^[a-f0-9]{64}$'
    or p_now is null then raise exception 'Invalid investigation key' using errcode='22023'; end if;
  if p_source_type='alert' then
    select exists(select 1 from public.alerts a
      where a.business_id=p_business_id and a.id::text=p_source_id
        and a.status in ('new','seen')) into v_open;
  else
    select exists(select 1 from public.operating_tasks t
      where t.business_id=p_business_id and t.id=p_source_id
        and t.kind not in ('priority_notice','commitment','event_plan','event_change','event_report')
        and t.status in ('needs_owner','needs_response')
        and (t.owner_user_id is null or t.owner_user_id=p_owner_user_id)) into v_open;
  end if;
  if not v_open then return false; end if;
  insert into public.supervisor_investigations
    (business_id,owner_user_id,thread_id,source_type,source_id,
     revision_hash,stable_key,next_retry_at)
  values(p_business_id,p_owner_user_id,p_thread_id,p_source_type,p_source_id,
    p_revision_hash,p_stable_key,p_now)
  on conflict (business_id,owner_user_id,source_type,source_id)
  do update set revision_hash=excluded.revision_hash,stable_key=excluded.stable_key,
    thread_id=excluded.thread_id,phase='collect',step_version=0,
    failure_count=0,lease_token=null,lease_until=null,next_retry_at=p_now,
    evidence='{}'::jsonb,narrative=null,last_error=null,updated_at=p_now
  where public.supervisor_investigations.revision_hash<>excluded.revision_hash
    and (public.supervisor_investigations.lease_until is null
      or public.supervisor_investigations.lease_until<=p_now);
  return true;
end $$;
revoke all on function public.supervisor_enqueue_investigation(uuid,uuid,uuid,text,text,text,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.supervisor_enqueue_investigation(uuid,uuid,uuid,text,text,text,text,timestamptz)
  to service_role;

-- One global fair queue over all cafés; SKIP LOCKED prevents concurrent cron
-- invocations from running the same model step. Lease expiry resumes a *read*
-- from the checkpoint, never an external effect.
create function public.supervisor_claim_investigation(p_now timestamptz)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v public.supervisor_investigations;v_token uuid;v_open boolean;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required' using errcode='42501'; end if;
  if p_now is null then raise exception 'Invalid instant' using errcode='22023'; end if;
  select * into v from public.supervisor_investigations
    where phase in ('collect','investigate','awaiting_owner')
      and next_retry_at<=p_now and (lease_until is null or lease_until<=p_now)
    order by next_retry_at asc,created_at asc,business_id asc,source_id asc
    for update skip locked limit 1;
  if not found then return null; end if;
  if not public.supervisor_routine_owner_authorized(
    v.business_id,v.owner_user_id,v.thread_id) then
    update public.supervisor_investigations set phase='blocked',last_error='authorization_revoked',
      lease_token=null,lease_until=null,updated_at=p_now
    where business_id=v.business_id and owner_user_id=v.owner_user_id
      and source_type=v.source_type and source_id=v.source_id;
    return null;
  end if;
  if v.source_type='alert' then
    select exists(select 1 from public.alerts a
      where a.business_id=v.business_id and a.id::text=v.source_id
        and a.status in ('new','seen')) into v_open;
  else
    select exists(select 1 from public.operating_tasks t
      where t.business_id=v.business_id and t.id=v.source_id
        and t.status in ('needs_owner','needs_response')
        and (t.owner_user_id is null or t.owner_user_id=v.owner_user_id)) into v_open;
  end if;
  if not v_open then
    update public.supervisor_investigations set phase='resolved',last_error='source_closed',
      lease_token=null,lease_until=null,updated_at=p_now
    where business_id=v.business_id and owner_user_id=v.owner_user_id
      and source_type=v.source_type and source_id=v.source_id;
    return null;
  end if;
  v_token:=gen_random_uuid();
  update public.supervisor_investigations set lease_token=v_token,
    lease_until=p_now+interval '3 minutes',updated_at=p_now
    where business_id=v.business_id and owner_user_id=v.owner_user_id
      and source_type=v.source_type and source_id=v.source_id;
  return jsonb_build_object('business_id',v.business_id,'owner_user_id',v.owner_user_id,
    'thread_id',v.thread_id,'source_type',v.source_type,'source_id',v.source_id,
    'revision_hash',v.revision_hash,'stable_key',v.stable_key,
    'phase',v.phase,'evidence',v.evidence,'step_version',v.step_version,
    'lease_token',v_token);
end $$;
revoke all on function public.supervisor_claim_investigation(timestamptz)
  from public,anon,authenticated;
grant execute on function public.supervisor_claim_investigation(timestamptz)
  to service_role;

-- Fenced checkpoint, including a single owner-thread message after a model
-- turn with executed, read-only evidence checks. Never creates an owner turn,
-- approval, effect attempt or claim of provider delivery.
create function public.supervisor_finish_investigation(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,
  p_source_type text,p_source_id text,p_revision_hash text,
  p_lease_token uuid,p_outcome text,p_evidence jsonb,p_narrative text,
  p_now timestamptz
) returns boolean language plpgsql security definer set search_path=public as $$
declare v public.supervisor_investigations;v_phase text;v_hash text;v_msg uuid;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required' using errcode='42501'; end if;
  select * into v from public.supervisor_investigations
    where business_id=p_business_id and owner_user_id=p_owner_user_id
      and source_type=p_source_type and source_id=p_source_id for update;
  if not found or v.thread_id<>p_thread_id or v.revision_hash<>p_revision_hash
    or v.lease_token is distinct from p_lease_token or v.lease_until<=p_now
    or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
  then return false; end if;
  if p_outcome='collected' and v.phase='collect' then v_phase:='investigate';
  elsif p_outcome='investigated' and v.phase='investigate' then v_phase:='awaiting_owner';
  elsif p_outcome='followed_up' and v.phase='awaiting_owner' then v_phase:='awaiting_owner';
  else raise exception 'Invalid investigation transition' using errcode='23514'; end if;
  if p_evidence is null or jsonb_typeof(p_evidence)<>'object'
    or octet_length(p_evidence::text)>8192 then
    raise exception 'Invalid investigation evidence' using errcode='22023'; end if;
  if p_outcome<>'collected' and
    (p_narrative is null or length(btrim(p_narrative)) not between 1 and 1800) then
    raise exception 'Investigation needs a grounded next step' using errcode='22023'; end if;
  update public.supervisor_investigations set phase=v_phase,evidence=p_evidence,
    narrative=case when p_outcome='collected' then narrative else btrim(p_narrative) end,
    step_version=step_version+1,failure_count=0,lease_token=null,lease_until=null,
    next_retry_at=case when p_outcome='collected' then p_now
      else p_now+interval '6 hours' end,
    last_error=null,updated_at=p_now
    where business_id=p_business_id and owner_user_id=p_owner_user_id
      and source_type=p_source_type and source_id=p_source_id;
  if p_outcome<>'collected' then
    v_hash:=md5('investigation:'||p_business_id::text||':'||p_owner_user_id::text||
      ':'||p_source_type||':'||p_source_id||':'||p_revision_hash||':'||(v.step_version+1)::text);
    v_msg:=(substr(v_hash,1,8)||'-'||substr(v_hash,9,4)||'-4'||
      substr(v_hash,14,3)||'-a'||substr(v_hash,18,3)||'-'||substr(v_hash,21,12))::uuid;
    insert into public.ai_messages(id,business_id,thread_id,owner_user_id,role,
      content_type,structured_content,grounding)
    values(v_msg,p_business_id,p_thread_id,p_owner_user_id,'supervisor','blocks',
      jsonb_build_array(jsonb_build_object('type','text','text',btrim(p_narrative))),
      jsonb_build_object('status','verified','intent','priority_investigation',
        'evidence',jsonb_build_array(jsonb_build_object('source',p_source_type,
          'identifier',p_source_id,'revisionHash',p_revision_hash,
          'asOf',p_now::text)),
        'agentMetadata',jsonb_build_object('phase',v_phase,'stepVersion',v.step_version+1)))
    on conflict(id) do nothing;
  end if;
  return true;
end $$;
revoke all on function public.supervisor_finish_investigation(uuid,uuid,uuid,text,text,text,uuid,text,jsonb,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.supervisor_finish_investigation(uuid,uuid,uuid,text,text,text,uuid,text,jsonb,text,timestamptz)
  to service_role;

create function public.supervisor_fail_investigation(
  p_business_id uuid,p_owner_user_id uuid,p_source_type text,p_source_id text,
  p_lease_token uuid,p_error text,p_now timestamptz
) returns boolean language plpgsql security definer set search_path=public as $$
declare v public.supervisor_investigations;v_count integer;v_hash text;v_msg uuid;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required' using errcode='42501'; end if;
  if p_error not in ('source_unavailable','provider_unavailable','model_incomplete',
    'evidence_incomplete','authorization_revoked','time_exceeded','storage_failed')
  then raise exception 'Invalid investigation error code' using errcode='22023'; end if;
  select * into v from public.supervisor_investigations
    where business_id=p_business_id and owner_user_id=p_owner_user_id
      and source_type=p_source_type and source_id=p_source_id for update;
  if not found or v.lease_token is distinct from p_lease_token
    or v.lease_until<=p_now then return false; end if;
  v_count:=least(5,v.failure_count+1);
  update public.supervisor_investigations set
    failure_count=v_count,phase=case when v_count=5 then 'blocked' else phase end,
    last_error=p_error,lease_token=null,lease_until=null,
    next_retry_at=p_now+(interval '1 minute'*least(60,power(2,v_count)::integer)),
    updated_at=p_now
  where business_id=p_business_id and owner_user_id=p_owner_user_id
    and source_type=p_source_type and source_id=p_source_id;
  -- Repeated failure is owner-visible, not silently abandoned. No message is
  -- attempted after membership/thread revocation, and no effect is retried.
  if v_count=5 and public.supervisor_routine_owner_authorized(
    v.business_id,v.owner_user_id,v.thread_id) then
    v_hash:=md5('investigation-blocked:'||v.business_id::text||':'||v.owner_user_id::text||
      ':'||v.source_type||':'||v.source_id||':'||v.revision_hash);
    v_msg:=(substr(v_hash,1,8)||'-'||substr(v_hash,9,4)||'-4'||
      substr(v_hash,14,3)||'-a'||substr(v_hash,18,3)||'-'||substr(v_hash,21,12))::uuid;
    insert into public.ai_messages(id,business_id,thread_id,owner_user_id,role,
      content_type,structured_content,grounding)
    values(v_msg,v.business_id,v.thread_id,v.owner_user_id,'supervisor','blocks',
      jsonb_build_array(jsonb_build_object('type','text','text',
        'Investigation update: I could not verify the café issue after repeated checks. I have paused this investigation; the original attention item remains available. No external action was taken. I will re-examine it if its source evidence changes.')),
      jsonb_build_object('status','verified','intent','priority_investigation_exception',
        'evidence',jsonb_build_array(jsonb_build_object('source',v.source_type,
          'identifier',v.source_id,'asOf',p_now::text))))
    on conflict(id) do nothing;
  end if;
  return true;
end $;
revoke all on function public.supervisor_fail_investigation(uuid,uuid,text,text,uuid,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.supervisor_fail_investigation(uuid,uuid,text,text,uuid,text,timestamptz)
  to service_role;

-- A source closure is the only verified *source* resolution. It is NOT proof
-- that a provider effect committed; those receipts remain in the effect gateway.
create function public.supervisor_settle_investigation_on_source()
returns trigger language plpgsql security definer set search_path=public as $$
declare v public.supervisor_investigations;v_type text;v_hash text;v_msg uuid;
begin
  if tg_table_name='alerts' then
    if new.status in ('new','seen') then return new; end if;
    v_type:='alert';
  else
    if new.kind='priority_notice' or new.status in ('needs_owner','needs_response')
    then return new; end if;
    v_type:='operating_task';
  end if;
  for v in select * from public.supervisor_investigations
    where business_id=new.business_id and source_type=v_type
      and source_id=new.id::text and phase not in ('resolved','blocked')
    for update
  loop
    update public.supervisor_investigations set
      phase='resolved',lease_token=null,lease_until=null,
      last_error='source_closed',updated_at=now()
    where business_id=v.business_id and owner_user_id=v.owner_user_id
      and source_type=v.source_type and source_id=v.source_id;
    if not public.supervisor_routine_owner_authorized(
      v.business_id,v.owner_user_id,v.thread_id) then continue; end if;
    v_hash:=md5('investigation-resolved:'||v.business_id::text||':'||v.owner_user_id::text||
      ':'||v.source_type||':'||v.source_id||':'||v.revision_hash);
    v_msg:=(substr(v_hash,1,8)||'-'||substr(v_hash,9,4)||'-4'||
      substr(v_hash,14,3)||'-a'||substr(v_hash,18,3)||'-'||substr(v_hash,21,12))::uuid;
    insert into public.ai_messages(id,business_id,thread_id,owner_user_id,role,
      content_type,structured_content,grounding)
    values(v_msg,v.business_id,v.thread_id,v.owner_user_id,'supervisor','blocks',
      jsonb_build_array(jsonb_build_object('type','text','text',
        'Follow-up: the original café issue is now closed in its source. I verified that status; this does not prove any external action succeeded.')),
      jsonb_build_object('status','verified','intent','priority_investigation_resolution',
        'evidence',jsonb_build_array(jsonb_build_object('source',v.source_type,
          'identifier',v.source_id,'asOf',now()::text))))
    on conflict(id) do nothing;
  end loop;
  return new;
end $$;
revoke all on function public.supervisor_settle_investigation_on_source() from public,anon,authenticated;
create trigger settle_investigation_on_alert_status
  after update of status on public.alerts
  for each row when (old.status is distinct from new.status)
  execute function public.supervisor_settle_investigation_on_source();
create trigger settle_investigation_on_task_status
  after update of status on public.operating_tasks
  for each row when (old.status is distinct from new.status)
  execute function public.supervisor_settle_investigation_on_source();
