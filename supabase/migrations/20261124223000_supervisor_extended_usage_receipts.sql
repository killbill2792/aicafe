-- Keep service-only scope, attempt fencing and exact measured counts. Recording
-- completed research is not an admission budget: never reject a valid long turn
-- merely because its measured receipt exceeds the previous planning defaults.

create or replace function public.record_supervisor_usage_increment(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_owner_message_id uuid,
  p_model text,p_input_tokens integer,p_output_tokens integer,
  p_model_call_count integer,p_tool_call_count integer,p_estimated_cost_micros bigint
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF p_input_tokens IS NULL OR p_output_tokens IS NULL OR p_model_call_count IS NULL
    OR p_tool_call_count IS NULL OR p_model IS NULL OR p_input_tokens<0 OR p_output_tokens<0 OR p_model_call_count<0 OR p_tool_call_count<0
    OR coalesce(auth.role(),'')<>'service_role' OR
    p_estimated_cost_micros<0 OR length(p_model) NOT BETWEEN 1 AND 80 OR
    NOT EXISTS (SELECT 1 FROM public.ai_messages m
      WHERE m.id=p_owner_message_id AND m.thread_id=p_thread_id
      AND m.business_id=p_business_id AND m.owner_user_id=p_owner_user_id
      AND m.role='owner')
  THEN RAISE EXCEPTION 'Invalid or unauthorized usage increment'; END IF;

  INSERT INTO public.ai_usage_events AS usage (
    business_id,owner_user_id,thread_id,owner_message_id,provider,model,
    input_tokens,output_tokens,model_call_count,tool_call_count,estimated_cost_micros,attempt_day)
  VALUES (p_business_id,p_owner_user_id,p_thread_id,p_owner_message_id,
    'openai',p_model,p_input_tokens,p_output_tokens,
    p_model_call_count,p_tool_call_count,p_estimated_cost_micros,
    (statement_timestamp() AT TIME ZONE 'UTC')::date)
  ON CONFLICT (owner_message_id, attempt_day) DO UPDATE SET
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

create or replace function public.supervisor_record_durable_usage_increment(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_owner_message_id uuid,
  p_run_id uuid,p_attempt_ids uuid[],p_model text,p_input_tokens integer,p_output_tokens integer,
  p_model_call_count integer,p_tool_call_count integer,p_estimated_cost_micros bigint
) returns void language plpgsql security definer set search_path=public as $$
declare v_count integer;v_day date;
begin
  if coalesce(auth.role(),'')<>'service_role' or p_attempt_ids is null
    or cardinality(p_attempt_ids)<1
    or p_model_call_count is distinct from cardinality(p_attempt_ids)
    then raise exception 'durable_usage_invalid' using errcode='42501'; end if;
  v_day:=(statement_timestamp() at time zone 'UTC')::date;
  perform pg_advisory_xact_lock(hashtextextended(
    p_business_id::text||':'||p_owner_user_id::text||':'||v_day::text,0));
  perform 1 from public.supervisor_system_usage_events e
    where e.attempt_id=any(p_attempt_ids) and e.business_id=p_business_id
      and e.owner_user_id=p_owner_user_id and e.thread_id=p_thread_id
      and e.owner_message_id=p_owner_message_id and e.source_type='durable_run'
      and e.source_id=p_run_id::text and e.accounted_at is null
    order by e.attempt_id for update;
  get diagnostics v_count=row_count;
  if v_count<>cardinality(p_attempt_ids)
    then raise exception 'durable_usage_scope_or_replay' using errcode='42501'; end if;
  perform public.record_supervisor_usage_increment(p_business_id,p_owner_user_id,p_thread_id,
    p_owner_message_id,p_model,p_input_tokens,p_output_tokens,p_model_call_count,
    p_tool_call_count,p_estimated_cost_micros);
  update public.ai_usage_events set reserved_model_call_count=reserved_model_call_count+v_count
    where business_id=p_business_id and owner_user_id=p_owner_user_id and thread_id=p_thread_id
      and owner_message_id=p_owner_message_id and attempt_day=v_day;
  if not found then raise exception 'durable_usage_summary_missing'; end if;
  update public.supervisor_system_usage_events set accounted_at=clock_timestamp()
    where attempt_id=any(p_attempt_ids);
end $$;

create or replace function public.record_supervisor_usage_increment(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_owner_message_id uuid,
 p_model text,p_input_tokens integer,p_output_tokens integer,
 p_model_call_count integer,p_tool_call_count integer,p_estimated_cost_micros bigint,
 p_execution_metrics jsonb
) returns void language plpgsql security invoker set search_path=public as $$
begin
 if coalesce(auth.role(),'')<>'service_role'
   or jsonb_typeof(p_execution_metrics) is distinct from 'object'
   or jsonb_typeof(p_execution_metrics->'requests') is distinct from 'array'
   or jsonb_typeof(p_execution_metrics->'tools') is distinct from 'array'
 then raise exception 'execution_metrics_invalid' using errcode='42501'; end if;
 if jsonb_array_length(p_execution_metrics->'requests')<>p_model_call_count
   or jsonb_array_length(p_execution_metrics->'tools')>p_tool_call_count
 then raise exception 'execution_metrics_count_invalid' using errcode='22023'; end if;
 perform public.record_supervisor_usage_increment(p_business_id,p_owner_user_id,p_thread_id,p_owner_message_id,
   p_model,p_input_tokens,p_output_tokens,p_model_call_count,p_tool_call_count,p_estimated_cost_micros);
 update public.ai_usage_events set execution_metrics=coalesce(execution_metrics,'[]'::jsonb)||jsonb_build_array(p_execution_metrics)
 where business_id=p_business_id and owner_user_id=p_owner_user_id and thread_id=p_thread_id
   and owner_message_id=p_owner_message_id and attempt_day=(statement_timestamp() at time zone 'UTC')::date;
 if not found then raise exception 'execution_metrics_scope_mismatch' using errcode='42501'; end if;
end $$;

create or replace function public.supervisor_record_durable_usage_increment(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_owner_message_id uuid,
 p_run_id uuid,p_attempt_ids uuid[],p_model text,p_input_tokens integer,p_output_tokens integer,
 p_model_call_count integer,p_tool_call_count integer,p_estimated_cost_micros bigint,p_execution_metrics jsonb
) returns void language plpgsql security invoker set search_path=public as $$
begin
 if coalesce(auth.role(),'')<>'service_role'
   or jsonb_typeof(p_execution_metrics) is distinct from 'object'
   or jsonb_typeof(p_execution_metrics->'requests') is distinct from 'array'
   or jsonb_typeof(p_execution_metrics->'tools') is distinct from 'array'
 then raise exception 'execution_metrics_invalid' using errcode='42501'; end if;
 if jsonb_array_length(p_execution_metrics->'requests')<>p_model_call_count
   or jsonb_array_length(p_execution_metrics->'tools')>p_tool_call_count
 then raise exception 'execution_metrics_count_invalid' using errcode='22023'; end if;
 perform public.supervisor_record_durable_usage_increment(p_business_id,p_owner_user_id,p_thread_id,p_owner_message_id,
   p_run_id,p_attempt_ids,p_model,p_input_tokens,p_output_tokens,p_model_call_count,p_tool_call_count,p_estimated_cost_micros);
 update public.ai_usage_events set execution_metrics=coalesce(execution_metrics,'[]'::jsonb)||jsonb_build_array(p_execution_metrics)
 where business_id=p_business_id and owner_user_id=p_owner_user_id and thread_id=p_thread_id
   and owner_message_id=p_owner_message_id and attempt_day=(statement_timestamp() at time zone 'UTC')::date;
 if not found then raise exception 'execution_metrics_scope_mismatch' using errcode='42501'; end if;
 update public.supervisor_system_usage_events e set execution_metrics=coalesce(e.execution_metrics,p_execution_metrics->'requests'->((a.ordinality-1)::integer))
 from unnest(p_attempt_ids) with ordinality a(id,ordinality)
 where e.attempt_id=a.id and e.business_id=p_business_id and e.owner_user_id=p_owner_user_id
   and e.thread_id=p_thread_id and e.source_type='durable_run' and e.source_id=p_run_id::text
   and e.owner_message_id=p_owner_message_id;
end $$;
