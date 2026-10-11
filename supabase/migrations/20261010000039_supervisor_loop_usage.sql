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
    CHECK (model_call_count >= 0),
  ADD COLUMN IF NOT EXISTS tool_call_count integer NOT NULL DEFAULT 0
    CHECK (tool_call_count >= 0);

-- Service-role only; tenant/owner message verified before touching private telemetry.
-- Atomic UPSERT prevents lost increments from concurrent retries or same-owner requests.
CREATE OR REPLACE FUNCTION public.record_supervisor_usage_increment(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_owner_message_id uuid,
  p_model text,p_input_tokens integer,p_output_tokens integer,
  p_model_call_count integer,p_tool_call_count integer,p_estimated_cost_micros bigint
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF p_input_tokens<0 OR p_output_tokens<0 OR p_model_call_count<0 OR p_tool_call_count<0
    OR p_model_call_count>3 OR p_tool_call_count>5 OR
    p_estimated_cost_micros<0 OR length(p_model) NOT BETWEEN 1 AND 80 OR
    NOT EXISTS (SELECT 1 FROM public.ai_messages m
      WHERE m.id=p_owner_message_id AND m.thread_id=p_thread_id
      AND m.business_id=p_business_id AND m.owner_user_id=p_owner_user_id
      AND m.role='owner')
  THEN RAISE EXCEPTION 'Invalid or unauthorized usage increment'; END IF;

  INSERT INTO public.ai_usage_events AS usage (
    business_id,owner_user_id,thread_id,owner_message_id,provider,model,
    input_tokens,output_tokens,model_call_count,tool_call_count,estimated_cost_micros)
  VALUES (p_business_id,p_owner_user_id,p_thread_id,p_owner_message_id,
    'openai',p_model,p_input_tokens,p_output_tokens,
    p_model_call_count,p_tool_call_count,p_estimated_cost_micros)
  ON CONFLICT (owner_message_id) DO UPDATE SET
    model=EXCLUDED.model,
    input_tokens=usage.input_tokens+EXCLUDED.input_tokens,
    output_tokens=usage.output_tokens+EXCLUDED.output_tokens,
    model_call_count=usage.model_call_count+EXCLUDED.model_call_count,
    tool_call_count=usage.tool_call_count+EXCLUDED.tool_call_count,
    estimated_cost_micros=CASE
      WHEN usage.estimated_cost_micros IS NULL OR EXCLUDED.estimated_cost_micros IS NULL
      THEN NULL ELSE usage.estimated_cost_micros+EXCLUDED.estimated_cost_micros END
  WHERE usage.business_id=EXCLUDED.business_id AND usage.owner_user_id=EXCLUDED.owner_user_id
    AND usage.thread_id=EXCLUDED.thread_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Usage owner scope mismatch'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.record_supervisor_usage_increment(
  uuid,uuid,uuid,uuid,text,integer,integer,integer,integer,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_supervisor_usage_increment(
  uuid,uuid,uuid,uuid,text,integer,integer,integer,integer,bigint) TO service_role;
