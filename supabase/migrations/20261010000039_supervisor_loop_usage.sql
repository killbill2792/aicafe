-- Reviewed, additive Supervisor loop migration. Apply only after migration reconciliation in staging.
-- Preserve append-only owner-only conversation permissions and the existing owner message predicate.
DO $$
DECLARE prior_constraint text;
BEGIN
  SELECT conname INTO prior_constraint
  FROM pg_constraint
  WHERE conrelid = 'public.ai_messages'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%insufficient_evidence%'
  LIMIT 1;
  IF prior_constraint IS NULL THEN
    RAISE EXCEPTION 'Expected Supervisor message content check not found; review migration history first';
  END IF;
  EXECUTE format('ALTER TABLE public.ai_messages DROP CONSTRAINT %I', prior_constraint);
  ALTER TABLE public.ai_messages ADD CONSTRAINT ai_messages_supervisor_content_check CHECK (
    (role = 'owner'
      and author_user_id is not null
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
      and case when jsonb_typeof(structured_content) = 'array'
        then jsonb_array_length(structured_content) between 1 and 30
        else false end
      and jsonb_typeof(grounding) = 'object'
      and coalesce(grounding->>'status', '') in
        ('verified', 'estimated', 'partial', 'unavailable', 'insufficient_evidence'))
  );
END $$;

-- One owner turn may invoke several bounded Responses rounds and approved read-only tools.
ALTER TABLE public.ai_usage_events
  ADD COLUMN IF NOT EXISTS model_call_count integer NOT NULL DEFAULT 1
    CHECK (model_call_count BETWEEN 0 AND 3),
  ADD COLUMN IF NOT EXISTS tool_call_count integer NOT NULL DEFAULT 0
    CHECK (tool_call_count BETWEEN 0 AND 5);
