-- Additive migration for owner review; reconcile and apply in staging before production rollout.
-- Eight billed attempts include planning, model-access fallback and independent answer review.
-- Preserve five executable operations, scoped atomic retry accounting and service-only execution.
CREATE OR REPLACE FUNCTION public.record_supervisor_usage_increment(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_owner_message_id uuid,
  p_model text,p_input_tokens integer,p_output_tokens integer,
  p_model_call_count integer,p_tool_call_count integer,p_estimated_cost_micros bigint
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF p_input_tokens IS NULL OR p_output_tokens IS NULL OR p_model_call_count IS NULL
    OR p_tool_call_count IS NULL OR p_model IS NULL OR p_input_tokens<0 OR p_output_tokens<0 OR p_model_call_count<0 OR p_tool_call_count<0
    OR p_model_call_count>8 OR p_tool_call_count>5 OR
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
