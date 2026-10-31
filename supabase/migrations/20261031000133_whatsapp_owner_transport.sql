-- Staging-only until the owner explicitly approves production SQL.
-- Dedicated WhatsApp transport ledgers; ai_threads/ai_messages remain the only chat history.
create table public.whatsapp_owner_bindings (
  id uuid primary key default gen_random_uuid(),
  phone_number_id text not null check (phone_number_id ~ '^[0-9]{8,20}$'),
  wa_id text not null check (wa_id ~ '^[1-9][0-9]{7,14}$'),
  business_id uuid not null,
  owner_user_id uuid not null,
  thread_id uuid not null,
  opted_in boolean not null default false,
  verified_at timestamptz,
  consent_at timestamptz,
  revoked_at timestamptz,
  last_owner_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (business_id, thread_id, owner_user_id)
    references public.ai_threads (business_id, id, owner_user_id) on delete cascade,
  unique (id, business_id, owner_user_id, thread_id),
  check (not opted_in or (verified_at is not null and consent_at is not null and revoked_at is null))
);
create unique index whatsapp_one_active_selected_cafe
  on public.whatsapp_owner_bindings (phone_number_id, wa_id)
  where opted_in and revoked_at is null;
create index whatsapp_bindings_owner on public.whatsapp_owner_bindings (owner_user_id,business_id);
alter table public.whatsapp_owner_bindings enable row level security;
create policy whatsapp_binding_owner_read on public.whatsapp_owner_bindings for select to authenticated
  using (owner_user_id = (select auth.uid()) and exists
    (select 1 from public.memberships m where m.business_id = whatsapp_owner_bindings.business_id
       and m.user_id = (select auth.uid()) and m.role = 'owner'));
create policy whatsapp_binding_owner_create on public.whatsapp_owner_bindings for insert to authenticated
  with check (owner_user_id = (select auth.uid()) and exists
    (select 1 from public.memberships m where m.business_id = whatsapp_owner_bindings.business_id
       and m.user_id = (select auth.uid()) and m.role = 'owner'));
create policy whatsapp_binding_owner_update on public.whatsapp_owner_bindings for update to authenticated
  using (owner_user_id = (select auth.uid()) and exists
    (select 1 from public.memberships m where m.business_id = whatsapp_owner_bindings.business_id
       and m.user_id = (select auth.uid()) and m.role = 'owner'))
  with check (owner_user_id = (select auth.uid()) and exists
    (select 1 from public.memberships m where m.business_id = whatsapp_owner_bindings.business_id
       and m.user_id = (select auth.uid()) and m.role = 'owner'));
grant select,insert,update on public.whatsapp_owner_bindings to authenticated;
revoke delete on public.whatsapp_owner_bindings from authenticated;

-- Only the authenticated owner may establish/replace consent using a currently verified
-- Auth phone. The thread is selected explicitly (composite FK) in the signed-in app.
-- A webhook phone or display name is NEVER used to create a binding.
create function public.whatsapp_guard_binding() returns trigger
  language plpgsql security definer set search_path = public as $$
declare phone text;
begin
  -- Inbound service RPC may advance only the provider timestamp on an already
  -- confirmed binding. It must not alter consent, ownership, receiver or thread.
  if auth.role() = 'service_role' and tg_op = 'UPDATE' then
    if (new.id,new.phone_number_id,new.wa_id,new.business_id,new.owner_user_id,
        new.thread_id,new.opted_in,new.verified_at,new.consent_at,new.revoked_at)
       is distinct from
       (old.id,old.phone_number_id,old.wa_id,old.business_id,old.owner_user_id,
        old.thread_id,old.opted_in,old.verified_at,old.consent_at,old.revoked_at)
       or new.last_owner_message_at is null
       or (old.last_owner_message_at is not null
           and new.last_owner_message_at < old.last_owner_message_at) then
      raise exception 'binding_immutable' using errcode = '42501';
    end if;
    return new;
  end if;
  if auth.role() <> 'authenticated' or new.owner_user_id <> auth.uid() then
    raise exception 'authenticated_owner_required' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (old.id,old.phone_number_id,old.wa_id,
      old.business_id,old.owner_user_id,old.thread_id,old.verified_at,old.consent_at)
       is distinct from
      (new.id,new.phone_number_id,new.wa_id,new.business_id,
       new.owner_user_id,new.thread_id,new.verified_at,new.consent_at) then
    raise exception 'binding_immutable_reselect_in_app' using errcode = '42501';
  end if;
  if not exists (select 1 from public.memberships m where m.business_id = new.business_id
    and m.user_id = auth.uid() and m.role = 'owner') then
    raise exception 'owner_membership_required' using errcode = '42501';
  end if;
  select replace(u.phone, '+', '') into phone from auth.users u
    where u.id = auth.uid() and u.phone_confirmed_at is not null;
  if phone is null or phone <> new.wa_id then
    raise exception 'verified_phone_required' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.opted_in and new.consent_at is null then
      raise exception 'consent_required' using errcode = '23514';
    end if;
    new.verified_at := now();
  end if;
  if tg_op = 'UPDATE' and old.revoked_at is not null then
    raise exception 'revoked_binding_immutable' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.opted_in and not new.opted_in then
    new.revoked_at := now();
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke all on function public.whatsapp_guard_binding() from public,anon,authenticated;
create trigger whatsapp_binding_guard before insert or update on public.whatsapp_owner_bindings
  for each row execute function public.whatsapp_guard_binding();

create table public.whatsapp_inbound (
  wamid text primary key check (wamid ~ '^wamid[.][A-Za-z0-9_.:-]{1,240}$'),
  binding_id uuid not null,
  business_id uuid not null,
  owner_user_id uuid not null,
  thread_id uuid not null,
  kind text not null check (kind in ('text','button','image','document')),
  text_content text check (text_content is null or length(text_content) between 1 and 4000),
  button_payload text check (button_payload is null or button_payload in
    ('money_went','peak_today','slowest_yesterday','event_today')),
  media_id text check (media_id is null or length(media_id) between 1 and 255),
  provider_at timestamptz not null,
  state text not null default 'queued' check
    (state in ('queued','leased','completed','ignored','failed')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  lease_token uuid,
  leased_until timestamptz,
  error_code text,
  owner_message_id uuid unique references public.ai_messages(id),
  received_at timestamptz not null default now(),
  foreign key (binding_id,business_id,owner_user_id,thread_id)
    references public.whatsapp_owner_bindings(id,business_id,owner_user_id,thread_id),
  check ((kind = 'text' and text_content is not null and button_payload is null and media_id is null)
    or (kind = 'button' and button_payload is not null and text_content is null and media_id is null)
    or (kind in ('image','document') and media_id is not null
        and text_content is null and button_payload is null))
);
create index whatsapp_inbound_claim_idx on public.whatsapp_inbound (state,received_at);
alter table public.whatsapp_inbound enable row level security;

create table public.whatsapp_outbox (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique check (length(dedupe_key) between 8 and 180),
  binding_id uuid not null,
  business_id uuid not null,
  owner_user_id uuid not null,
  thread_id uuid not null,
  kind text not null check(kind in ('daily_brief','reply')),
  payload jsonb not null,
  provenance jsonb not null default '{}'::jsonb,
  in_reply_to text references public.whatsapp_inbound(wamid),
  state text not null default 'queued' check
    (state in ('queued','leased','accepted','sent','delivered','read','failed','uncertain')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  lease_token uuid,
  leased_until timestamptz,
  provider_wamid text unique,
  failure_code text,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  delivered_at timestamptz,
  foreign key (binding_id,business_id,owner_user_id,thread_id)
    references public.whatsapp_owner_bindings(id,business_id,owner_user_id,thread_id)
);
create index whatsapp_outbox_claim_idx on public.whatsapp_outbox (state,created_at);
create unique index whatsapp_outbox_one_lease_per_binding on public.whatsapp_outbox(binding_id)
  where state = 'leased';
alter table public.whatsapp_outbox enable row level security;

create table public.whatsapp_status_ledger (
  provider_wamid text primary key,
  state text not null check (state in ('sent','delivered','read','failed')),
  rank smallint not null check (rank between 1 and 4),
  updated_at timestamptz not null default now()
);
alter table public.whatsapp_status_ledger enable row level security;
-- Service-role-only queues, status records and outbound payloads: no grants or owner RLS policies.
revoke all on public.whatsapp_inbound,public.whatsapp_outbox,
  public.whatsapp_status_ledger from anon,authenticated;

-- Recheck verified Auth phone, active selected café, membership AND thread at every boundary.
create function public.whatsapp_binding_active(p_id uuid) returns boolean
  language sql security definer set search_path = public as $$
  select exists (
    select 1 from public.whatsapp_owner_bindings b
    join public.memberships m on m.business_id=b.business_id and m.user_id=b.owner_user_id and m.role='owner'
    join auth.users u on u.id=b.owner_user_id and u.phone_confirmed_at is not null
    where b.id=p_id and b.opted_in and b.revoked_at is null
      and b.verified_at is not null and b.consent_at is not null
      and replace(u.phone,'+','')=b.wa_id
      and exists (select 1 from public.ai_threads t where t.id=b.thread_id
        and t.business_id=b.business_id and t.owner_user_id=b.owner_user_id)
  );
  $$;
revoke all on function public.whatsapp_binding_active(uuid) from public,anon,authenticated;
grant execute on function public.whatsapp_binding_active(uuid) to service_role;

-- Transactional accept: duplicate wamid cannot create a second inbound turn. Caller uses
-- only verified-signature, bounded envelopes; we still enforce identity and shape in SQL.
create function public.whatsapp_accept_inbound(
 p_phone_id text,p_wa_id text,p_wamid text,p_kind text,p_text text,
 p_button_payload text,p_media_id text,p_provider_at timestamptz
) returns text language plpgsql security definer set search_path=public as $$
declare b public.whatsapp_owner_bindings; new_id text; old_time timestamptz;
begin
 if auth.role()<>'service_role' then raise exception 'service_role_only'; end if;
 select * into b from public.whatsapp_owner_bindings
   where phone_number_id=p_phone_id and wa_id=p_wa_id and opted_in and revoked_at is null
   for update;
 if not found or not public.whatsapp_binding_active(b.id) then return 'unauthorized'; end if;
 if p_provider_at < now()-interval '24 hours' or p_provider_at > now()+interval '5 minutes'
   or p_kind not in ('text','button','image','document') then return 'ignored'; end if;
 old_time := b.last_owner_message_at;
 insert into public.whatsapp_inbound(wamid,binding_id,business_id,owner_user_id,thread_id,
   kind,text_content,button_payload,media_id,provider_at,state)
 values (p_wamid,b.id,b.business_id,b.owner_user_id,b.thread_id,
   p_kind,p_text,p_button_payload,p_media_id,p_provider_at,
   case when old_time is not null and p_provider_at < old_time then 'ignored' else 'queued' end)
 on conflict (wamid) do nothing returning wamid into new_id;
 if new_id is null then return 'duplicate'; end if;
 if old_time is null or p_provider_at > old_time then
   update public.whatsapp_owner_bindings set last_owner_message_at=p_provider_at where id=b.id;
 end if;
 return case when old_time is not null and p_provider_at < old_time then 'ignored' else 'queued' end;
end $$;
revoke all on function public.whatsapp_accept_inbound(text,text,text,text,text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.whatsapp_accept_inbound(text,text,text,text,text,text,text,timestamptz) to service_role;

-- Every status is durable, including callbacks that race the API receipt.
create function public.whatsapp_record_status(p_wamid text,p_state text)
returns void language plpgsql security definer set search_path=public as $$
declare r smallint;
begin
 if auth.role()<>'service_role' then raise exception 'service_role_only'; end if;
 r:=case p_state when 'sent' then 1 when 'failed' then 2
   when 'delivered' then 3 when 'read' then 4 else null end;
 if r is null or length(p_wamid) > 250 then raise exception 'invalid_status'; end if;
 insert into public.whatsapp_status_ledger(provider_wamid,state,rank)
 values(p_wamid,p_state,r)
 on conflict(provider_wamid) do update set state=excluded.state,rank=excluded.rank,updated_at=now()
 where excluded.rank > whatsapp_status_ledger.rank;
 update public.whatsapp_outbox o set state=s.state,
   delivered_at=case when s.state in ('delivered','read') then now() else o.delivered_at end
 from public.whatsapp_status_ledger s
 where o.provider_wamid=p_wamid and s.provider_wamid=p_wamid
   and o.state in ('accepted','sent','delivered','failed');
end $$;
revoke all on function public.whatsapp_record_status(text,text) from public,anon,authenticated;
grant execute on function public.whatsapp_record_status(text,text) to service_role;

-- The producer (B) and shared-agent adapter (C) may only queue against a live binding.
create function public.whatsapp_enqueue_outbound(p_binding_id uuid,p_key text,p_kind text,
 p_payload jsonb,p_provenance jsonb,p_in_reply_to text default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare b public.whatsapp_owner_bindings; result uuid;
begin
 if auth.role()<>'service_role' then raise exception 'service_role_only'; end if;
 select * into b from public.whatsapp_owner_bindings where id=p_binding_id;
 if not found or not public.whatsapp_binding_active(b.id) then raise exception 'unverified_binding'; end if;
 if p_kind not in ('daily_brief','reply') or length(p_key) not between 8 and 180
   or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>10000
   or jsonb_typeof(p_provenance)<>'object' or octet_length(p_provenance::text)>3000
 then raise exception 'invalid_outbound'; end if;
 if p_kind='reply' and (p_in_reply_to is null or not exists
   (select 1 from public.whatsapp_inbound i where i.wamid=p_in_reply_to
    and i.binding_id=b.id and i.state='completed')) then raise exception 'reply_not_ready'; end if;
 if p_kind='daily_brief' and p_in_reply_to is not null then raise exception 'invalid_brief'; end if;
 insert into public.whatsapp_outbox(dedupe_key,binding_id,business_id,owner_user_id,
   thread_id,kind,payload,provenance,in_reply_to)
 values(p_key,b.id,b.business_id,b.owner_user_id,b.thread_id,
   p_kind,p_payload,p_provenance,p_in_reply_to)
 on conflict(dedupe_key) do nothing returning id into result;
 if result is null then
   select id into result from public.whatsapp_outbox
     where dedupe_key=p_key and binding_id=p_binding_id and kind=p_kind;
 end if;
 return result;
end $$;
revoke all on function public.whatsapp_enqueue_outbound(uuid,text,text,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.whatsapp_enqueue_outbound(uuid,text,text,jsonb,jsonb,text) to service_role;

-- A lease is never blindly replayed after a provider timeout. Worker chooses one binding at
-- a time; locking the binding prevents two workers from claiming the same owner concurrently.
create function public.whatsapp_claim_outbound(p_kind text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare b public.whatsapp_owner_bindings; q public.whatsapp_outbox;
begin
 if auth.role()<>'service_role' then raise exception 'service_role_only'; end if;
 update public.whatsapp_outbox set state='uncertain',failure_code='lease_expired',
   lease_token=null,leased_until=null
   where state='leased' and leased_until<now();
 for b in select x.* from public.whatsapp_owner_bindings x where x.opted_in
   order by x.id for update skip locked loop
   if not public.whatsapp_binding_active(b.id) then continue; end if;
   select * into q from public.whatsapp_outbox
     where binding_id=b.id and state='queued' and kind=p_kind and attempts<5
     order by created_at,id limit 1 for update skip locked;
   if not found then continue; end if;
   if q.kind='reply' and
     (b.last_owner_message_at is null or b.last_owner_message_at<=now()-interval '24 hours') then
      update public.whatsapp_outbox set state='failed',failure_code='outside_service_window' where id=q.id;
      continue;
   end if;
   update public.whatsapp_outbox set state='leased',attempts=attempts+1,
     lease_token=gen_random_uuid(),leased_until=now()+interval '2 minutes'
     where id=q.id returning * into q;
   return to_jsonb(q) || jsonb_build_object('wa_id',b.wa_id,'phone_number_id',b.phone_number_id);
 end loop;
 return null;
end $$;
revoke all on function public.whatsapp_claim_outbound(text) from public,anon,authenticated;
grant execute on function public.whatsapp_claim_outbound(text) to service_role;

create function public.whatsapp_finish_outbound(p_id uuid,p_token uuid,p_outcome text,
 p_provider_wamid text default null,p_error text default null)
returns boolean language plpgsql security definer set search_path=public as $$
declare q public.whatsapp_outbox; s public.whatsapp_status_ledger;
begin
 if auth.role()<>'service_role' then raise exception 'service_role_only'; end if;
 select * into q from public.whatsapp_outbox where id=p_id for update;
 if not found or q.state<>'leased' or q.lease_token<>p_token then return false; end if;
 if p_outcome not in ('accepted','retry','uncertain','failed') then raise exception 'invalid_outcome'; end if;
 if p_outcome='accepted' and (p_provider_wamid is null or p_provider_wamid !~ '^wamid[.]')
   then raise exception 'missing_provider_wamid'; end if;
 select * into s from public.whatsapp_status_ledger where provider_wamid=p_provider_wamid;
 update public.whatsapp_outbox set
   state=case when p_outcome='retry' then 'queued'
     when p_outcome='accepted' and s.state is not null then s.state else p_outcome end,
   provider_wamid=case when p_outcome='accepted' then p_provider_wamid else null end,
   accepted_at=case when p_outcome='accepted' then now() else null end,
   delivered_at=case when s.state in ('delivered','read') then now() else null end,
   failure_code=p_error, lease_token=null,leased_until=null
 where id=p_id;
 return true;
end $$;
revoke all on function public.whatsapp_finish_outbound(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.whatsapp_finish_outbound(uuid,uuid,text,text,text) to service_role;

-- PR C will consume this lease to insert one owner turn in ai_messages by stable
-- client_message_id, then use the existing serialized Supervisor agent-job service.
create function public.whatsapp_claim_inbound() returns jsonb
language plpgsql security definer set search_path=public as $$
declare b public.whatsapp_owner_bindings; i public.whatsapp_inbound;
begin
 if auth.role()<>'service_role' then raise exception 'service_role_only'; end if;
 update public.whatsapp_inbound set state=case when attempts>=5 then 'failed' else 'queued' end,
   error_code='lease_expired',lease_token=null,leased_until=null
   where state='leased' and leased_until<now();
 for b in select x.* from public.whatsapp_owner_bindings x where x.opted_in
   order by x.id for update skip locked loop
   if not public.whatsapp_binding_active(b.id) then continue; end if;
   if exists (select 1 from public.whatsapp_inbound j where j.binding_id=b.id and j.state='leased')
     then continue; end if;
   select * into i from public.whatsapp_inbound
     where binding_id=b.id and state='queued' and attempts<5
     order by provider_at,received_at limit 1 for update skip locked;
   if not found then continue; end if;
   update public.whatsapp_inbound set state='leased',attempts=attempts+1,
     lease_token=gen_random_uuid(),leased_until=now()+interval '3 minutes'
     where wamid=i.wamid returning * into i;
   return to_jsonb(i);
 end loop;
 return null;
end $$;
revoke all on function public.whatsapp_claim_inbound() from public,anon,authenticated;
grant execute on function public.whatsapp_claim_inbound() to service_role;

create function public.whatsapp_finish_inbound(p_wamid text,p_token uuid,p_state text,
 p_owner_message_id uuid default null,p_error text default null) returns boolean
language plpgsql security definer set search_path=public as $$
declare i public.whatsapp_inbound;
begin
 if auth.role()<>'service_role' then raise exception 'service_role_only'; end if;
 if p_state not in ('completed','queued','failed') then raise exception 'invalid_inbound_state'; end if;
 select * into i from public.whatsapp_inbound where wamid=p_wamid for update;
 if not found or i.state<>'leased' or i.lease_token<>p_token then return false; end if;
 if p_state='completed' and (p_owner_message_id is null or not exists (
   select 1 from public.ai_messages m where m.id=p_owner_message_id
    and m.thread_id=i.thread_id and m.business_id=i.business_id
    and m.owner_user_id=i.owner_user_id and m.role='owner')) then
   raise exception 'missing_authenticated_owner_turn';
 end if;
 update public.whatsapp_inbound set state=p_state,owner_message_id=case
   when p_state='completed' then p_owner_message_id else owner_message_id end,
   error_code=p_error,lease_token=null,leased_until=null where wamid=p_wamid;
 return true;
end $$;
revoke all on function public.whatsapp_finish_inbound(text,uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.whatsapp_finish_inbound(text,uuid,text,uuid,text) to service_role;
