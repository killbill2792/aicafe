-- Staged separately from PR A. No tables, readers or alternate delivery system.
-- Guard the EXISTING outbox claim so a global worker can never lease a different
-- café's future/stale morning brief merely because another café is at 05:50.
-- UTC/DST conversion uses the café timezone at claim time; a missing/invalid
-- timezone never authorizes a send. Owner approval required before production SQL.
create or replace function public.whatsapp_claim_outbound(p_kind text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare b public.whatsapp_owner_bindings; q public.whatsapp_outbox;
begin
 if auth.role()<>'service_role' then raise exception 'service_role_only'; end if;
 if p_kind='daily_brief' then
   -- The one canonical outbox also records deadline misses as failed.
   update public.whatsapp_outbox o set state='failed',
     failure_code='brief_deadline_expired'
     from public.businesses business
     where o.business_id=business.id and o.kind='daily_brief' and o.state='queued'
       and business.timezone is not null
       and exists (select 1 from pg_catalog.pg_timezone_names z where z.name=business.timezone)
       and ((now() at time zone business.timezone)::date>o.business_date
         or ((now() at time zone business.timezone)::date=o.business_date
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
           and (now() at time zone business.timezone)::time>=time '05:50:00'
           and (now() at time zone business.timezone)::time<time '06:00:00'
       ))
     order by o.created_at,o.id limit 1 for update of o skip locked;
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
-- A worker is NEVER allowed to fall back to the pre-guarded claim implementation.
-- This service-only capability marker exists only when the guarded claim is applied.
create function public.whatsapp_brief_dispatch_ready() returns boolean
  language sql security definer set search_path=public as $$ select true; $$;
revoke all on function public.whatsapp_brief_dispatch_ready() from public,anon,authenticated;
grant execute on function public.whatsapp_brief_dispatch_ready() to service_role;

-- A daily-brief inbox row links to the owner's private ai_threads record.
-- Existing operating_tasks policies admit every café member, so constrain these
-- NEW owner-specific entries without changing the shared inbox for other kinds.
-- Legacy café-level daily rows remain visible ONLY to the saved message owner.
create policy whatsapp_owner_daily_brief_inbox_scope
 on public.operating_tasks as restrictive for all to authenticated
 using (kind<>'daily_brief'
   or payload->>'ownerUserId'=(select auth.uid())::text
   or (payload->>'ownerUserId' is null and exists (
     select 1 from public.ai_messages m
     where m.id::text=payload->>'messageId'
       and m.business_id=operating_tasks.business_id
       and m.owner_user_id=(select auth.uid()))))
 with check (kind<>'daily_brief'
   or payload->>'ownerUserId'=(select auth.uid())::text
   or (payload->>'ownerUserId' is null and exists (
     select 1 from public.ai_messages m
     where m.id::text=payload->>'messageId'
       and m.business_id=operating_tasks.business_id
       and m.owner_user_id=(select auth.uid()))));
