-- Tightens migration 149. Its owner-row stamp check compared values that can be
-- NULL (a missing receivedAt, sourceChannel or attachmentIds key). A CHECK that
-- evaluates to NULL passes, so a stamp missing a key was accepted. It also called
-- jsonb_array_length before knowing attachmentIds was an array, which raises an
-- error instead of a clean check failure.
--
-- Same rules as 149, written so every branch is TRUE or FALSE, never NULL:
-- an owner row's grounding is NULL, or exactly
-- {sourceChannel:"whatsapp", receivedAt:<20-40 char string>, attachmentIds:<array of at most 3>}.
-- Every supervisor rule is unchanged.
alter table public.ai_messages drop constraint ai_messages_supervisor_content_check;
alter table public.ai_messages add constraint ai_messages_supervisor_content_check check (
  (role = 'owner'
    and author_user_id is not null and author_user_id = owner_user_id
    and content_type = 'text' and text_content is not null
    and char_length(btrim(text_content)) between 1 and 4000
    and structured_content is null
    and (grounding is null or coalesce(
      case when jsonb_typeof(grounding) = 'object'
        and jsonb_typeof(grounding->'attachmentIds') = 'array'
        and jsonb_typeof(grounding->'receivedAt') = 'string'
      then grounding->>'sourceChannel' = 'whatsapp'
        and char_length(grounding->>'receivedAt') between 20 and 40
        and jsonb_array_length(grounding->'attachmentIds') <= 3
        and (grounding - 'sourceChannel' - 'receivedAt' - 'attachmentIds') = '{}'::jsonb
      else false end, false))
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
