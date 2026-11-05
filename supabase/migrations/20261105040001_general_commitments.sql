-- PR 3: owner-only durable commitments in the existing operating_tasks inbox.
-- No new task table; previous task families retain their policies and transitions.
alter table public.operating_tasks
  add column if not exists origin text,
  add column if not exists owner_user_id uuid references auth.users(id) on delete cascade,
  add column if not exists due_local_date date,
  add column if not exists due_local_time time without time zone,
  add column if not exists due_timezone text,
  add column if not exists due_at timestamptz,
  add column if not exists dedupe_key text;

alter table public.operating_tasks add constraint operating_commitment_fields check (
  kind <> 'commitment' or (
    origin in ('owner_chat','supervisor_followup') and owner_user_id is not null
    and due_local_date is not null and due_timezone is not null and due_at is not null
    and nullif(dedupe_key,'') is not null
    and nullif(payload->>'title','') is not null
    and nullif(payload->>'threadId','') is not null
  )
);
create unique index operating_commitment_dedupe_idx
  on public.operating_tasks (business_id, owner_user_id, dedupe_key) where kind='commitment';
create index operating_commitment_due_idx on public.operating_tasks (due_at)
  where kind='commitment' and status='watching';

-- The legacy members-read policy must not disclose an owner's private reminder.
create policy operating_commitments_owner_only on public.operating_tasks
  as restrictive for all to authenticated
  using (kind <> 'commitment' or (
    owner_user_id=(select auth.uid()) and exists (
      select 1 from public.memberships m where m.business_id=operating_tasks.business_id
        and m.user_id=(select auth.uid()) and m.role='owner'
    )
  ))
  with check (kind <> 'commitment' or (
    owner_user_id=(select auth.uid()) and exists (
      select 1 from public.memberships m where m.business_id=operating_tasks.business_id
        and m.user_id=(select auth.uid()) and m.role='owner'
    )
  ));

-- Commitment writes only enter through the audited create/due/close functions.
-- The old member-write policy remains intact for every other task kind.
create policy operating_commitments_no_direct_insert on public.operating_tasks
  as restrictive for insert to authenticated with check (kind <> 'commitment');
create policy operating_commitments_no_direct_update on public.operating_tasks
  as restrictive for update to authenticated
  using (kind <> 'commitment') with check (kind <> 'commitment');
create policy operating_commitments_no_direct_delete on public.operating_tasks
  as restrictive for delete to authenticated using (kind <> 'commitment');

-- Never permit a task to be reopened or rewritten (including via the old member-write policy).
create function public.guard_operating_commitment_update() returns trigger
language plpgsql set search_path=public as $$
begin
  if old.kind='commitment' or new.kind='commitment' then
    if old.kind <> 'commitment' or new.kind <> 'commitment'
      or new.id is distinct from old.id or new.business_id is distinct from old.business_id
      or new.owner_user_id is distinct from old.owner_user_id
      or new.origin is distinct from old.origin or new.dedupe_key is distinct from old.dedupe_key
      or new.due_local_date is distinct from old.due_local_date
      or new.due_local_time is distinct from old.due_local_time
      or new.due_timezone is distinct from old.due_timezone
      or new.due_at is distinct from old.due_at
      or new.payload is distinct from old.payload
      or new.entity_type is distinct from old.entity_type
      or new.entity_id is distinct from old.entity_id then
      raise exception 'Commitment identity and contents are immutable' using errcode='23514';
    end if;
    if new.status <> old.status and not (
      (old.status='watching' and new.status in ('needs_owner','handled'))
      or (old.status='needs_owner' and new.status='handled')
    ) then raise exception 'Invalid commitment transition' using errcode='23514'; end if;
    if old.status='watching' and new.status='needs_owner'
      and coalesce(auth.role(),'') <> 'service_role' then
      raise exception 'Only the scheduled server can mark a commitment due' using errcode='42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_operating_commitment_update() from public;
create trigger operating_commitment_update_guard before update on public.operating_tasks
  for each row execute function public.guard_operating_commitment_update();

-- Create once. The database derives the key so two distinct chat messages with
-- the same owner, text and café-local due date/time still point to one commitment.
create function public.create_operating_commitment(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid,
  p_title text, p_origin text, p_due_date date, p_due_time time default null
) returns public.operating_tasks
language plpgsql security definer set search_path=public as $$
declare v_timezone text; v_at timestamptz; v_title text; v_key text;
        v_id text; v_task public.operating_tasks;
begin
  if auth.uid() is distinct from p_owner_user_id and coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Commitment owner mismatch' using errcode='42501';
  end if;
  if not exists (select 1 from public.memberships m
      where m.business_id=p_business_id and m.user_id=p_owner_user_id and m.role='owner')
    or not exists (select 1 from public.ai_threads t
      where t.id=p_thread_id and t.business_id=p_business_id and t.owner_user_id=p_owner_user_id)
  then raise exception 'Commitment thread or owner not authorized' using errcode='42501'; end if;
  select b.timezone into v_timezone from public.businesses b where b.id=p_business_id;
  if v_timezone is null or not exists (
    select 1 from pg_catalog.pg_timezone_names z where z.name=v_timezone
  ) then raise exception 'Café timezone unavailable' using errcode='22023'; end if;
  v_title:=regexp_replace(btrim(p_title),'[[:space:]]+',' ','g');
  if length(v_title)<1 or length(v_title)>240 or p_origin not in ('owner_chat','supervisor_followup')
    or p_due_date is null then
    raise exception 'Invalid commitment details' using errcode='22023';
  end if;
  -- Date-only requests become due when the named café-local day begins; no invented clock time.
  v_at:=(p_due_date + coalesce(p_due_time,time '00:00')) at time zone v_timezone;
  if p_due_time is not null and (v_at at time zone v_timezone)::timestamp
      is distinct from (p_due_date+p_due_time) then
    raise exception 'Nonexistent local time during daylight-saving change' using errcode='22023';
  end if;
  v_key:=encode(sha256(convert_to(p_owner_user_id::text||':'||lower(v_title)||':'||
          p_due_date::text||':'||coalesce(p_due_time::text,''),'UTF8')),'hex');
  v_id:='commitment:'||v_key;
  insert into public.operating_tasks (
    business_id,id,owner_user_id,origin,due_local_date,due_local_time,due_timezone,
    due_at,dedupe_key,agent_id,kind,status,payload,confidence,evidence,entity_type
  ) values (
    p_business_id,v_id,p_owner_user_id,p_origin,p_due_date,p_due_time,v_timezone,
    v_at,v_key,'leo','commitment','watching',
    jsonb_build_object('title',v_title,'threadId',p_thread_id::text),
    'high','[]'::jsonb,'owner_commitment'
  ) on conflict do nothing;
  select * into v_task from public.operating_tasks
    where business_id=p_business_id and id=v_id and kind='commitment'
      and owner_user_id=p_owner_user_id;
  if not found then raise exception 'Commitment could not be saved'; end if;
  return v_task;
end $$;
revoke all on function public.create_operating_commitment(uuid,uuid,uuid,text,text,date,time)
  from public,anon;
grant execute on function public.create_operating_commitment(uuid,uuid,uuid,text,text,date,time)
  to authenticated,service_role;

-- Due transition + private chat message commit in ONE transaction. Concurrent crons
-- serialize on the row; either both writes succeed or neither does.
create function public.deliver_due_operating_commitment(
  p_business_id uuid, p_owner_user_id uuid, p_task_id text, p_now timestamptz
) returns boolean
language plpgsql security definer set search_path=public as $$
declare v_task public.operating_tasks; v_thread uuid; v_hash text; v_message_id uuid;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required' using errcode='42501'; end if;
  if not exists(select 1 from public.memberships m where m.business_id=p_business_id
      and m.user_id=p_owner_user_id and m.role='owner') then
    raise exception 'Owner membership required' using errcode='42501'; end if;
  select * into v_task from public.operating_tasks
    where business_id=p_business_id and owner_user_id=p_owner_user_id
      and id=p_task_id and kind='commitment' and status='watching'
      and due_at<=p_now for update;
  if not found then return false; end if;
  v_thread:=(v_task.payload->>'threadId')::uuid;
  if not exists(select 1 from public.ai_threads t where t.id=v_thread
      and t.business_id=p_business_id and t.owner_user_id=p_owner_user_id) then
    raise exception 'Commitment chat thread unavailable' using errcode='23503'; end if;
  v_hash:=md5('commitment-due:'||p_business_id::text||':'||p_task_id);
  v_message_id:=(substr(v_hash,1,8)||'-'||substr(v_hash,9,4)||'-4'||
    substr(v_hash,14,3)||'-a'||substr(v_hash,18,3)||'-'||substr(v_hash,21,12))::uuid;
  insert into public.ai_messages(id,business_id,thread_id,owner_user_id,role,
    content_type,structured_content,grounding)
  values (v_message_id,p_business_id,v_thread,p_owner_user_id,'supervisor','blocks',
    jsonb_build_array(jsonb_build_object('type','text','text',
      'Reminder: '||(v_task.payload->>'title'))),
    jsonb_build_object('status','verified','intent','operating_tasks',
      'evidence',jsonb_build_array(jsonb_build_object('source','operating_tasks',
        'identifier',p_task_id,'asOf',p_now::text))))
  on conflict (id) do nothing;
  update public.operating_tasks set status='needs_owner',updated_at=p_now
    where business_id=p_business_id and id=p_task_id and status='watching';
  return true;
end $$;
revoke all on function public.deliver_due_operating_commitment(uuid,uuid,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.deliver_due_operating_commitment(uuid,uuid,text,timestamptz)
  to service_role;

create function public.close_operating_commitment(
  p_business_id uuid,p_owner_user_id uuid,p_task_id text
) returns boolean
language plpgsql security definer set search_path=public as $$
declare v_task public.operating_tasks;
begin
  if auth.uid() is distinct from p_owner_user_id and coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Commitment owner mismatch' using errcode='42501'; end if;
  if not exists (select 1 from public.memberships m
    where m.business_id=p_business_id and m.user_id=p_owner_user_id and m.role='owner') then
    raise exception 'Owner membership required' using errcode='42501'; end if;
  select * into v_task from public.operating_tasks
    where business_id=p_business_id and owner_user_id=p_owner_user_id
      and id=p_task_id and kind='commitment' for update;
  if not found then return false; end if;
  if v_task.status='handled' then return true; end if;
  if v_task.status not in ('watching','needs_owner') then return false; end if;
  update public.operating_tasks set status='handled',resolved_at=now(),updated_at=now()
    where business_id=p_business_id and id=p_task_id;
  return true;
end $$;
revoke all on function public.close_operating_commitment(uuid,uuid,text) from public,anon;
grant execute on function public.close_operating_commitment(uuid,uuid,text)
  to authenticated,service_role;
