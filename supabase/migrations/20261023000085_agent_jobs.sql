-- Additive migration for owner review; reconcile and apply in staging before production rollout.
-- Background chat turns ("jobs") for the one-loop agent (CHAT_JOBS flag).
-- One row per owner message that started a turn. The row lets a turn keep running
-- after the owner closes/reloads the page, lets the page resume (Realtime, or a short
-- poll fallback), and queues owner messages sent mid-run so the loop reads them
-- before its next step. Rows carry no café data: only ids, tool names and enums.
-- Why not ai_supervisor_progress (073)? It is keyed per client message, has no
-- status/inbox/reply link, and belongs to the retired investigation path.
create table if not exists public.ai_agent_jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  owner_user_id uuid not null,
  thread_id uuid not null,
  owner_message_id uuid not null references public.ai_messages(id) on delete cascade,
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  attempt integer not null default 1 check (attempt between 1 and 5),
  error_code text check (error_code is null or error_code ~ '^[a-z_]{1,60}$'),
  reply_message_id uuid,
  progress jsonb not null default '[]'::jsonb
    check (jsonb_typeof(progress) = 'array' and jsonb_array_length(progress) <= 12),
  inbox uuid[] not null default '{}' check (cardinality(inbox) <= 10),
  consumed uuid[] not null default '{}' check (cardinality(consumed) <= 10),
  heartbeat_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (owner_message_id),
  foreign key (business_id, thread_id, owner_user_id)
    references public.ai_threads (business_id, id, owner_user_id) on delete cascade,
  check ((status = 'running') = (finished_at is null)),
  check (status <> 'failed' or error_code is not null)
);

-- At most one running turn per conversation; later messages queue in its inbox.
create unique index if not exists ai_agent_jobs_one_running_per_thread
  on public.ai_agent_jobs (thread_id) where status = 'running';
create index if not exists ai_agent_jobs_thread_recent_idx
  on public.ai_agent_jobs (business_id, thread_id, created_at desc);

alter table public.ai_agent_jobs enable row level security;

create policy "ai agent jobs owner read" on public.ai_agent_jobs
  for select to authenticated
  using (
    owner_user_id = (select auth.uid())
    and exists (select 1 from memberships m where
      m.business_id = ai_agent_jobs.business_id
      and m.user_id = (select auth.uid()) and m.role = 'owner')
  );

-- Only the server (service role, via the functions below) writes jobs.
grant select on public.ai_agent_jobs to authenticated;
revoke insert, update, delete on public.ai_agent_jobs from authenticated;
revoke all on public.ai_agent_jobs from anon;

-- Realtime lets the page resume without polling. Guarded: local stacks or
-- projects without the publication still migrate cleanly (the client falls back to polling).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ai_agent_jobs')
  then
    execute 'alter publication supabase_realtime add table public.ai_agent_jobs';
  end if;
end $$;

-- Start (or join) the turn for one recorded owner message. Idempotent per message.
-- Modes: started | running | done | absorbed | attached | busy | failed
create or replace function public.ai_agent_job_start(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_owner_message_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  mine public.ai_agent_jobs;
  other public.ai_agent_jobs;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if not exists (select 1 from public.ai_messages m
      where m.id = p_owner_message_id and m.thread_id = p_thread_id
        and m.business_id = p_business_id and m.owner_user_id = p_owner_user_id
        and m.role = 'owner')
  then raise exception 'owner_message_not_found'; end if;

  -- Serialize starts per thread so two tabs cannot both start a turn.
  perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:' || p_thread_id::text, 0));

  -- A turn whose server died (no heartbeat for 180s) is failed, never left spinning.
  update public.ai_agent_jobs
     set status = 'failed', error_code = 'timeout', finished_at = now(), updated_at = now()
   where thread_id = p_thread_id and status = 'running'
     and heartbeat_at < now() - interval '180 seconds';

  select * into mine from public.ai_agent_jobs where owner_message_id = p_owner_message_id;
  if found and mine.status = 'running' then
    return jsonb_build_object('mode', 'running', 'job', to_jsonb(mine));
  elsif found and mine.status = 'done' then
    return jsonb_build_object('mode', 'done', 'job', to_jsonb(mine));
  end if;

  select * into other from public.ai_agent_jobs
   where thread_id = p_thread_id and p_owner_message_id = any(consumed) and status <> 'failed'
   order by created_at desc limit 1;
  if found then return jsonb_build_object('mode', 'absorbed', 'job', to_jsonb(other)); end if;

  select * into other from public.ai_agent_jobs
   where thread_id = p_thread_id and status = 'running' for update;
  if found then
    if p_owner_message_id = any(other.inbox) then
      return jsonb_build_object('mode', 'attached', 'job', to_jsonb(other));
    end if;
    if cardinality(other.inbox) >= 10 then
      return jsonb_build_object('mode', 'busy', 'job', to_jsonb(other));
    end if;
    update public.ai_agent_jobs
       set inbox = inbox || p_owner_message_id, updated_at = now()
     where id = other.id returning * into other;
    return jsonb_build_object('mode', 'attached', 'job', to_jsonb(other));
  end if;

  if mine.id is not null then
    -- Owner pressed retry on a failed turn.
    if mine.attempt >= 5 then return jsonb_build_object('mode', 'failed', 'job', to_jsonb(mine)); end if;
    update public.ai_agent_jobs
       set status = 'running', attempt = attempt + 1, error_code = null, reply_message_id = null,
           progress = '[]'::jsonb, inbox = '{}', consumed = '{}',
           heartbeat_at = now(), updated_at = now(), finished_at = null
     where id = mine.id returning * into mine;
    return jsonb_build_object('mode', 'started', 'job', to_jsonb(mine));
  end if;

  insert into public.ai_agent_jobs (business_id, owner_user_id, thread_id, owner_message_id)
  values (p_business_id, p_owner_user_id, p_thread_id, p_owner_message_id)
  returning * into mine;
  return jsonb_build_object('mode', 'started', 'job', to_jsonb(mine));
end $$;

-- Append one completed step ({"tool": "...", "agent": "..."}) and refresh the heartbeat.
create or replace function public.ai_agent_job_progress(p_job_id uuid, p_step jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if jsonb_typeof(p_step) <> 'object' or octet_length(p_step::text) > 200 then
    raise exception 'invalid_job_step';
  end if;
  update public.ai_agent_jobs
     set progress = case when jsonb_array_length(progress) < 12 then progress || jsonb_build_array(p_step)
                         else progress end,
         heartbeat_at = now(), updated_at = now()
   where id = p_job_id and status = 'running';
end $$;

-- Hand the loop up to p_limit queued owner messages (oldest first), exactly once.
create or replace function public.ai_agent_job_take_inbox(p_job_id uuid, p_limit integer)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  j public.ai_agent_jobs;
  fresh uuid[];
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  select * into j from public.ai_agent_jobs where id = p_job_id for update;
  if not found or j.status <> 'running' then return '[]'::jsonb; end if;
  select coalesce(array_agg(m.id order by m.created_at, m.id), '{}') into fresh
    from (select m.id, m.created_at from public.ai_messages m
           where m.id = any(j.inbox) and not (m.id = any(j.consumed))
             and m.thread_id = j.thread_id and m.role = 'owner'
           order by m.created_at, m.id
           limit greatest(0, least(coalesce(p_limit, 0), 10))) m;
  update public.ai_agent_jobs
     set consumed = consumed || fresh, heartbeat_at = now(), updated_at = now()
   where id = j.id;
  return coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'text', m.text_content)
                     order by m.created_at, m.id)
                     from public.ai_messages m where m.id = any(fresh)), '[]'::jsonb);
end $$;

-- Finish a turn exactly once. If owner messages arrived too late to be read, start one
-- continuation turn for them atomically and return it (the server runs it next).
create or replace function public.ai_agent_job_finish(
  p_job_id uuid, p_status text, p_reply_message_id uuid, p_error_code text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  j public.ai_agent_jobs;
  next_job public.ai_agent_jobs;
  leftovers uuid[];
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if p_status not in ('done', 'failed') then raise exception 'invalid_job_status'; end if;
  -- Same lock order as ai_agent_job_start (thread lock, then row) to avoid deadlocks.
  select * into j from public.ai_agent_jobs where id = p_job_id;
  if not found then raise exception 'job_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:' || j.thread_id::text, 0));
  select * into j from public.ai_agent_jobs where id = p_job_id for update;
  if j.status <> 'running' then
    return jsonb_build_object('job', to_jsonb(j), 'continuation', null);
  end if;
  update public.ai_agent_jobs
     set status = p_status,
         reply_message_id = case when p_status = 'done' then p_reply_message_id end,
         error_code = case when p_status = 'failed' then coalesce(p_error_code, 'agent_turn_failed') end,
         finished_at = now(), heartbeat_at = now(), updated_at = now()
   where id = j.id returning * into j;

  if p_status = 'done' then
    select coalesce(array_agg(m.id order by m.created_at, m.id), '{}') into leftovers
      from public.ai_messages m
     where m.id = any(j.inbox) and not (m.id = any(j.consumed)) and m.role = 'owner';
    if cardinality(leftovers) > 0 then
      insert into public.ai_agent_jobs (business_id, owner_user_id, thread_id, owner_message_id, inbox)
      values (j.business_id, j.owner_user_id, j.thread_id, leftovers[1], leftovers[2:])
      on conflict (owner_message_id) do nothing
      returning * into next_job;
    end if;
  end if;
  return jsonb_build_object('job', to_jsonb(j),
    'continuation', case when next_job.id is null then null else to_jsonb(next_job) end);
end $$;

revoke all on function public.ai_agent_job_start(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.ai_agent_job_progress(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ai_agent_job_take_inbox(uuid, integer) from public, anon, authenticated;
revoke all on function public.ai_agent_job_finish(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.ai_agent_job_start(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.ai_agent_job_progress(uuid, jsonb) to service_role;
grant execute on function public.ai_agent_job_take_inbox(uuid, integer) to service_role;
grant execute on function public.ai_agent_job_finish(uuid, text, uuid, text) to service_role;
