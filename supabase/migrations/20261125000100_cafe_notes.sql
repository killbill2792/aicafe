-- Café notes: what Supervisor has learned about this café (patterns, habits,
-- working assumptions), kept apart from owner_facts, which are owner-typed values
-- that feed screens. A note says where it came from and when it was last confirmed,
-- so a stale one can be rechecked. Live data always wins over a note.

set lock_timeout = '5s';
set statement_timeout = '60s';

create table if not exists public.cafe_notes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  topic text not null check (topic ~ '^[a-z][a-z0-9_.:-]{0,79}$'),
  note text not null check (length(note) between 1 and 1000),
  basis text not null check (length(basis) between 1 and 500),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz not null default now(),
  retired_at timestamptz,
  retired_by uuid references auth.users(id)
);
create unique index if not exists cafe_notes_current_topic
  on public.cafe_notes (business_id, topic) where retired_at is null;
create index if not exists cafe_notes_business_idx on public.cafe_notes (business_id, created_at desc);

-- Reason: the table is created in this same migration, so no existing client loses or gains access.
-- squawk-ignore ban-alter-row-level-security
alter table public.cafe_notes enable row level security;
create policy "cafe notes owner read" on public.cafe_notes
  for select to authenticated using (exists (
    select 1 from public.memberships m where m.business_id = cafe_notes.business_id
      and m.user_id = (select auth.uid()) and m.role in ('owner','manager')));
-- Changes only through the two functions below (history is kept, nothing is edited in place).
grant select on public.cafe_notes to authenticated;
revoke insert, update, delete on public.cafe_notes from authenticated;
revoke all on public.cafe_notes from anon;

create or replace function public.save_cafe_note(
  p_business_id uuid, p_topic text, p_note text, p_basis text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null or not exists (select 1 from public.memberships m
      where m.business_id = p_business_id and m.user_id = v_uid and m.role in ('owner','manager'))
  then raise exception 'cafe_note_forbidden' using errcode = '42501'; end if;
  if (select count(*) from public.cafe_notes where business_id = p_business_id and retired_at is null) >= 300
     and not exists (select 1 from public.cafe_notes where business_id = p_business_id and topic = p_topic and retired_at is null)
  then raise exception 'cafe_notes_full'; end if;
  update public.cafe_notes set retired_at = now(), retired_by = v_uid
   where business_id = p_business_id and topic = p_topic and retired_at is null;
  insert into public.cafe_notes (business_id, topic, note, basis)
    values (p_business_id, p_topic, p_note, p_basis) returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.forget_cafe_note(p_business_id uuid, p_topic text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null or not exists (select 1 from public.memberships m
      where m.business_id = p_business_id and m.user_id = v_uid and m.role in ('owner','manager'))
  then raise exception 'cafe_note_forbidden' using errcode = '42501'; end if;
  update public.cafe_notes set retired_at = now(), retired_by = v_uid
   where business_id = p_business_id and topic = p_topic and retired_at is null;
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

revoke all on function public.save_cafe_note(uuid, text, text, text) from public, anon;
revoke all on function public.forget_cafe_note(uuid, text) from public, anon;
grant execute on function public.save_cafe_note(uuid, text, text, text) to authenticated;
grant execute on function public.forget_cafe_note(uuid, text) to authenticated;
