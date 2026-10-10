-- Phase 3: private, append-only Supervisor conversation foundation.
-- Apply deliberately; do not run an unreconciled Supabase migration history via db push.
-- All access is owner+business scoped; the authenticated role may NEVER author Supervisor output.

create table if not exists ai_threads (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  client_request_id uuid not null,
  title text not null default 'New conversation'
    check (char_length(title) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz,
  unique (business_id, id, owner_user_id),
  unique (business_id, owner_user_id, client_request_id)
);
create index if not exists ai_threads_owner_recent_idx
  on ai_threads (business_id, owner_user_id, created_at desc, id desc);

create table if not exists ai_messages (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  thread_id uuid not null,
  owner_user_id uuid not null,
  author_user_id uuid,
  role text not null check (role in ('owner', 'supervisor')),
  content_type text not null check (content_type in ('text', 'blocks')),
  text_content text,
  structured_content jsonb,
  grounding jsonb,
  client_message_id uuid,
  created_at timestamptz not null default now(),
  foreign key (business_id, thread_id, owner_user_id)
    references ai_threads (business_id, id, owner_user_id) on delete cascade,
  unique (thread_id, client_message_id),
  check (
    (role = 'owner'
      and author_user_id = owner_user_id
      and content_type = 'text'
      and text_content is not null
      and char_length(btrim(text_content)) between 1 and 4000
      and structured_content is null
      and grounding is null
      and client_message_id is not null)
    or
    (role = 'supervisor'
      and author_user_id is null
      and content_type = 'blocks'
      and text_content is null
      and structured_content is not null
      and grounding is not null
      and jsonb_typeof(structured_content) = 'array'
      and jsonb_array_length(structured_content) between 1 and 30
      and jsonb_typeof(grounding) = 'object'
      and grounding ? 'status')
  )
);
create index if not exists ai_messages_thread_recent_idx
  on ai_messages (business_id, thread_id, created_at desc, id desc);

-- Explicit owner role is required. A manager or another owner in the same café
-- must never be able to view or alter someone else's private conversation.
alter table ai_threads enable row level security;
alter table ai_messages enable row level security;

create policy "ai threads owner read" on ai_threads
  for select to authenticated
  using (
    owner_user_id = (select auth.uid())
    and exists (select 1 from memberships m where
      m.business_id = ai_threads.business_id
      and m.user_id = (select auth.uid()) and m.role = 'owner')
  );

create policy "ai threads owner create" on ai_threads
  for insert to authenticated
  with check (
    owner_user_id = (select auth.uid())
    and exists (select 1 from memberships m where
      m.business_id = ai_threads.business_id
      and m.user_id = (select auth.uid()) and m.role = 'owner')
  );

create policy "ai messages owner read" on ai_messages
  for select to authenticated
  using (
    owner_user_id = (select auth.uid())
    and exists (select 1 from memberships m where
      m.business_id = ai_messages.business_id
      and m.user_id = (select auth.uid()) and m.role = 'owner')
  );

-- This is intentionally NOT a policy for ALL roles: only owner-authored text
-- messages may enter through cookie/session authenticated PostgREST.
-- Supervisor/AI replies must be written through a separately reviewed,
-- server-authorized path after the grounding gate is implemented in Phase 4.
create policy "ai messages owner create" on ai_messages
  for insert to authenticated
  with check (
    role = 'owner'
    and author_user_id = (select auth.uid())
    and owner_user_id = (select auth.uid())
    and exists (select 1 from memberships m where
      m.business_id = ai_messages.business_id
      and m.user_id = (select auth.uid()) and m.role = 'owner')
  );

-- No authenticated UPDATE/DELETE policies: conversation history is append-only.
grant select, insert on ai_threads, ai_messages to authenticated;
revoke update, delete on ai_threads, ai_messages from authenticated;

-- Only a successful first insert advances the thread timestamp.
-- Trigger is privileged to touch the parent because its UPDATE is not user-granted;
-- the composite FK guarantees all tenant and owner columns agree.
create or replace function touch_ai_thread_on_message_insert()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  update ai_threads
  set last_message_at = new.created_at, updated_at = new.created_at
  where id = new.thread_id and business_id = new.business_id
    and owner_user_id = new.owner_user_id
    and (last_message_at is null or last_message_at <= new.created_at);
  return new;
end;
$$;
revoke all on function touch_ai_thread_on_message_insert() from public;
drop trigger if exists ai_messages_touch_thread on ai_messages;
create trigger ai_messages_touch_thread after insert on ai_messages
  for each row execute function touch_ai_thread_on_message_insert();
