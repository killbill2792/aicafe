-- Post-PR-A compatibility fix: actual Meta wamid may include Base64 padding.
-- The original A migration remains immutable; apply this in A→C order.
alter table public.whatsapp_inbound drop constraint whatsapp_inbound_wamid_check;
alter table public.whatsapp_inbound add constraint whatsapp_inbound_wamid_check
  check (wamid ~ '^wamid[.][A-Za-z0-9_.:-]{1,240}={0,2}$');

-- PR C: durable recovery of cross-channel Supervisor replies after PR A's
-- signed inbound lease has completed. Staging-only; do NOT apply to production.
-- No new conversation table: ai_messages remains the source of truth.
create function public.whatsapp_ready_supervisor_replies(p_limit integer default 25)
returns jsonb language plpgsql security definer set search_path = public as $$
declare payload jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only' using errcode='42501'; end if;
  if p_limit < 1 or p_limit > 100 then raise exception 'invalid_limit' using errcode='22023'; end if;
  select coalesce(jsonb_agg(to_jsonb(rows)), '[]'::jsonb) into payload
  from (
    select i.wamid, i.binding_id, i.business_id, i.owner_user_id,
      i.thread_id, i.owner_message_id, i.provider_at, m.id as reply_id
    from public.whatsapp_inbound i
    join public.whatsapp_owner_bindings b on b.id=i.binding_id
      and b.business_id=i.business_id and b.owner_user_id=i.owner_user_id
      and b.thread_id=i.thread_id
    join public.ai_messages m on m.business_id=i.business_id
      and m.owner_user_id=i.owner_user_id and m.thread_id=i.thread_id
      and m.role='supervisor'
      and m.grounding->>'ownerMessageId'=i.owner_message_id::text
    where i.state='completed' and i.owner_message_id is not null
      and public.whatsapp_binding_active(i.binding_id)
      and b.last_owner_message_at is not null
      and b.last_owner_message_at <= now()
      and b.last_owner_message_at > now()-interval '24 hours'
      and not exists (select 1 from public.whatsapp_outbox o
        where o.in_reply_to=i.wamid and o.kind='reply')
    order by i.provider_at, i.wamid
    limit p_limit
  ) rows;
  return payload;
end $$;
revoke all on function public.whatsapp_ready_supervisor_replies(integer) from public,anon,authenticated;
grant execute on function public.whatsapp_ready_supervisor_replies(integer) to service_role;

-- A completed inbound may have no answer when its agent process died, or when
-- a web/WhatsApp turn was attached behind a process that later timed out.
-- Retry only stale/failed jobs under the existing agent-job attempt ceiling;
-- never launch a second model while any healthy job is still active.
create function public.whatsapp_pending_supervisor_turns(p_limit integer default 1)
returns jsonb language plpgsql security definer set search_path = public as $$
declare payload jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only' using errcode='42501'; end if;
  if p_limit < 1 or p_limit > 5 then raise exception 'invalid_limit' using errcode='22023'; end if;
  select coalesce(jsonb_agg(to_jsonb(rows)), '[]'::jsonb) into payload from (
    select i.wamid,i.binding_id,i.business_id,i.owner_user_id,i.thread_id,
      i.owner_message_id,i.provider_at,o.text_content
    from public.whatsapp_inbound i
    join public.whatsapp_owner_bindings b on b.id=i.binding_id
    join public.ai_messages o on o.id=i.owner_message_id and o.role='owner'
      and o.business_id=i.business_id and o.owner_user_id=i.owner_user_id
      and o.thread_id=i.thread_id and o.grounding->>'sourceChannel'='whatsapp'
    left join public.ai_agent_jobs j on j.owner_message_id=o.id
    where i.state='completed'
      and public.whatsapp_binding_active(i.binding_id)
      and b.last_owner_message_at is not null
      and b.last_owner_message_at <= now()
      and b.last_owner_message_at > now()-interval '24 hours'
      and not exists (select 1 from public.ai_messages m
        where m.role='supervisor'
          and m.business_id=i.business_id and m.owner_user_id=i.owner_user_id
          and m.thread_id=i.thread_id
          and m.grounding->>'ownerMessageId'=o.id::text)
      and (j.id is null or (j.attempt<5 and
        (j.status='failed' or (j.status='running' and
          j.heartbeat_at < now()-interval '180 seconds'))))
    order by i.provider_at,i.wamid limit p_limit
  ) rows;
  return payload;
end $$;
revoke all on function public.whatsapp_pending_supervisor_turns(integer) from public,anon,authenticated;
grant execute on function public.whatsapp_pending_supervisor_turns(integer) to service_role;
