-- Morning brief: per-café send deadline and a record of every skipped brief.
--
-- Before: the outbox claim only let a daily brief leave between 05:50 and 06:00
-- café time, for every café, so one missed cron run meant no brief that day.
-- Now the producer stores each queued brief's own deadline (30 minutes before
-- that café opens, or 06:30 café time when hours are unknown) in send_before.
-- The claim sends it any time before that deadline on its local day and marks it
-- failed after. The 24-hour customer-service window still applies ONLY to
-- free-text replies; an approved template brief never needs it.
--
-- morning_brief_runs: one row per café, local day, owner, channel and run kind
-- with the step that decided the outcome and why (sent, queued, waiting, skipped,
-- failed). Service role only; shown on /admin/briefs. Café owners never see it.
--
-- Additive and idempotent where possible. Owner applies by hand in the SQL editor.

alter table public.whatsapp_outbox add column if not exists send_before timestamptz;

-- Same function, one new optional argument. Drop the old 8-argument form so
-- PostgREST has exactly one candidate.
drop function if exists public.whatsapp_enqueue_outbound(uuid,text,text,jsonb,jsonb,uuid,text,date);
create or replace function public.whatsapp_enqueue_outbound(p_binding_id uuid,p_key text,p_kind text,
 p_payload jsonb,p_provenance jsonb,p_source_message_id uuid,
 p_in_reply_to text default null,p_business_date date default null,
 p_send_before timestamptz default null)
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
 if p_source_message_id is null or not exists (
   select 1 from public.ai_messages msg where msg.id=p_source_message_id
    and msg.business_id=b.business_id and msg.owner_user_id=b.owner_user_id
    and msg.thread_id=b.thread_id and msg.role='supervisor'
 ) then raise exception 'supervisor_source_required'; end if;
 if p_kind='reply' and (p_in_reply_to is null or not exists
   (select 1 from public.whatsapp_inbound i where i.wamid=p_in_reply_to
    and i.binding_id=b.id and i.state='completed')) then raise exception 'reply_not_ready'; end if;
 if p_kind='daily_brief' and (p_in_reply_to is not null or p_business_date is null)
   then raise exception 'invalid_brief'; end if;
 -- A deadline must be in the future and within a day; a reply never has one.
 if p_kind='daily_brief' and p_send_before is not null and
   (p_send_before<=now() or p_send_before>now()+interval '1 day')
   then raise exception 'invalid_brief_deadline'; end if;
 if p_kind='reply' and (p_business_date is not null or p_send_before is not null)
   then raise exception 'invalid_reply_date'; end if;
 insert into public.whatsapp_outbox(dedupe_key,binding_id,business_id,owner_user_id,
   thread_id,kind,business_date,payload,provenance,in_reply_to,source_message_id,send_before)
 values(p_key,b.id,b.business_id,b.owner_user_id,b.thread_id,
   p_kind,p_business_date,p_payload,p_provenance,p_in_reply_to,p_source_message_id,p_send_before)
 on conflict(dedupe_key) do nothing returning id into result;
 if result is null then
   select id into result from public.whatsapp_outbox
     where dedupe_key=p_key and binding_id=p_binding_id and kind=p_kind;
 end if;
 return result;
end $$;
revoke all on function public.whatsapp_enqueue_outbound(uuid,text,text,jsonb,jsonb,uuid,text,date,timestamptz) from public,anon,authenticated;
grant execute on function public.whatsapp_enqueue_outbound(uuid,text,text,jsonb,jsonb,uuid,text,date,timestamptz) to service_role;

-- A brief queued with send_before leaves any time before it, on its café-local
-- day. A row queued by older code (send_before null) keeps the old 05:50–06:00
-- rule so nothing already queued changes meaning.
create or replace function public.whatsapp_claim_outbound(p_kind text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare b public.whatsapp_owner_bindings; q public.whatsapp_outbox;
begin
 if auth.role()<>'service_role' then raise exception 'service_role_only'; end if;
 if p_kind='daily_brief' then
   update public.whatsapp_outbox o set state='failed',
     failure_code='brief_deadline_expired'
     from public.businesses business
     where o.business_id=business.id and o.kind='daily_brief' and o.state='queued'
       and business.timezone is not null
       and exists (select 1 from pg_catalog.pg_timezone_names z where z.name=business.timezone)
       and ((now() at time zone business.timezone)::date>o.business_date
         or (o.send_before is not null and now()>=o.send_before)
         or (o.send_before is null
           and (now() at time zone business.timezone)::date=o.business_date
           and (now() at time zone business.timezone)::time>=time '06:00:00'));
 end if;
 update public.whatsapp_outbox set state='uncertain',failure_code='lease_expired',
   lease_token=null,leased_until=null
   where state='leased' and leased_until<now();
 for b in select x.* from public.whatsapp_owner_bindings x where x.opted_in
   order by x.id for update skip locked loop
   if not public.whatsapp_binding_active(b.id) or
      not pg_try_advisory_xact_lock(hashtextextended('wa_outbox:'||b.owner_user_id::text,0))
      or exists (
     select 1 from public.whatsapp_outbox a where a.owner_user_id=b.owner_user_id and a.state='leased'
   ) then continue; end if;
   select o.* into q from public.whatsapp_outbox o
     where o.binding_id=b.id and o.state='queued' and o.kind=p_kind and o.attempts<5
       and (o.kind<>'daily_brief' or exists (
         select 1 from public.businesses business
         where business.id=o.business_id and business.timezone is not null
           and exists (select 1 from pg_catalog.pg_timezone_names z
             where z.name=business.timezone)
           and (now() at time zone business.timezone)::date=o.business_date
           and ((o.send_before is not null and now()<o.send_before)
             or (o.send_before is null
               and (now() at time zone business.timezone)::time>=time '05:50:00'
               and (now() at time zone business.timezone)::time<time '06:00:00'))
       ))
     order by o.created_at,o.id limit 1 for update of o skip locked;
   if not found then continue; end if;
   -- Free-text replies only: Meta's 24-hour customer-service window.
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

-- The app sends briefs only when this marker exists, i.e. the claim above is in.
create or replace function public.whatsapp_brief_send_window_ready() returns boolean
  language sql security definer set search_path=public as $$ select true; $$;
revoke all on function public.whatsapp_brief_send_window_ready() from public,anon,authenticated;
grant execute on function public.whatsapp_brief_send_window_ready() to service_role;

create table if not exists public.morning_brief_runs(
 business_id uuid not null references public.businesses(id) on delete cascade,
 local_date date not null,
 -- The owner's user id, or 'cafe' for a café-level step (not due, no owner…).
 owner_key text not null check (length(owner_key) between 1 and 64),
 channel text not null check (channel in ('in_app','whatsapp')),
 run_kind text not null check (run_kind in ('scheduled','test')),
 step text not null check (length(step) between 1 and 64),
 outcome text not null check (outcome in ('sent','queued','waiting','skipped','failed')),
 reason text not null check (length(reason) between 1 and 200),
 details jsonb not null default '{}'::jsonb check (octet_length(details::text)<=4000),
 first_seen_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key (business_id,local_date,owner_key,channel,run_kind)
);
create index if not exists morning_brief_runs_recent on public.morning_brief_runs(local_date desc,updated_at desc);
alter table public.morning_brief_runs enable row level security;
revoke all on public.morning_brief_runs from public,anon,authenticated;
grant select,insert,update,delete on public.morning_brief_runs to service_role;
