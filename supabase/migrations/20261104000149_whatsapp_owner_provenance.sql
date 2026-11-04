-- WhatsApp owner turns could never be answered: lib/ai/conversations/authorizedTurn.server.ts
-- (markWhatsAppOwnerProvenance) stamps the owner's message with where it came from,
-- {sourceChannel:"whatsapp", receivedAt, attachmentIds}, and the reply reconcile SQL
-- (20261031000135) reads it back. But ai_messages_supervisor_content_check required
-- grounding IS NULL on every owner row, so the stamp failed and every WhatsApp message
-- or button tap retried until it gave up ("dispatcher_failed").
--
-- Allow exactly that stamp on owner rows and nothing else. Every other owner and
-- supervisor rule is copied unchanged from the live constraint.
alter table public.ai_messages drop constraint ai_messages_supervisor_content_check;
alter table public.ai_messages add constraint ai_messages_supervisor_content_check check (
  (role = 'owner'
    and author_user_id is not null and author_user_id = owner_user_id
    and content_type = 'text' and text_content is not null
    and char_length(btrim(text_content)) between 1 and 4000
    and structured_content is null
    and (grounding is null or (
      jsonb_typeof(grounding) = 'object'
      and grounding->>'sourceChannel' = 'whatsapp'
      and jsonb_typeof(grounding->'receivedAt') = 'string'
      and char_length(grounding->>'receivedAt') between 20 and 40
      and jsonb_typeof(grounding->'attachmentIds') = 'array'
      and jsonb_array_length(grounding->'attachmentIds') <= 3
      and (grounding - 'sourceChannel' - 'receivedAt' - 'attachmentIds') = '{}'::jsonb))
    and client_message_id is not null)
  or
  (role = 'supervisor'
    and author_user_id is null and content_type = 'blocks'
    and text_content is null and structured_content is not null
    and grounding is not null
    and case when jsonb_typeof(structured_content) = 'array'
      then jsonb_array_length(structured_content) between 1 and 30
      else false end
    and jsonb_typeof(grounding) = 'object'
    and coalesce(grounding->>'status','') in
      ('verified','estimated','partial','unavailable','insufficient_evidence','requires_owner_input')
    and (coalesce(grounding->>'status','') <> 'requires_owner_input'
      or jsonb_typeof(grounding->'ownerInput') = 'object'))
);

-- Only the server (service role, after the signed-webhook and phone-binding checks)
-- may stamp WhatsApp provenance. A signed-in owner inserting from the website must
-- still send grounding = null, exactly as before this migration.
drop policy "ai messages owner create" on public.ai_messages;
create policy "ai messages owner create" on public.ai_messages
  for insert to authenticated
  with check (
    role = 'owner'
    and author_user_id = (select auth.uid())
    and owner_user_id = (select auth.uid())
    and grounding is null
    and exists (
      select 1 from public.memberships m
      where m.business_id = ai_messages.business_id
        and m.user_id = (select auth.uid())
        and m.role = 'owner'
    )
  );
