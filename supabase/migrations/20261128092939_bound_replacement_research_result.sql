set lock_timeout = '3s';
set statement_timeout = '30s';

-- Share the café-scoped executor and keep the original request signature.
-- Replacement callers bind a transport byte limit independent of the query.
create function public.supervisor_research_sql(
  p_business_id uuid,
  p_owner_user_id uuid,
  p_sql text,
  p_result_bytes integer
) returns json
language plpgsql
volatile
security definer
set search_path = public, pg_temp
set statement_timeout = 0
as $$
declare
  v_rows json;
  v_result json;
  v_count integer := 0;
  v_row text;
  v_json_rows text[] := '{}';
  v_bytes integer := 2;
  v_message text; v_detail text; v_hint text; v_state text;
  v_sql text := regexp_replace(coalesce(p_sql, ''), '[\s;]+$', '');
  v_plan text;
begin
  if nullif(current_setting('app.supervisor_research_business_id', true), '') is not null then
    raise exception 'supervisor_research_nested_scope_denied' using errcode='42501';
  end if;
  if p_result_bytes is not null and p_result_bytes not between 1 and 272000 then
    raise exception 'supervisor_research_bad_result_bound' using errcode='22023';
  end if;
  if p_business_id is null or p_owner_user_id is null or btrim(v_sql) = '' then
    raise exception 'supervisor_research_bad_request';
  end if;
  -- Functions that change session identity or run SQL held in a string could
  -- be used to step outside this owner's rows. Unicode-escaped identifiers
  -- could hide those names. Everything else is the owner's normal read access.
  if v_sql ~* '(set_config|_to_xml|ts_stat|crosstab|connectby|dblink)' or v_sql ~* 'u&["'']' then
    return json_build_object('ok', false, 'error',
      'This statement calls a function that is not available for research (session settings or SQL held in text). Rewrite it as a plain SELECT.');
  end if;

  -- Read only for the rest of the transaction; cannot be switched back.
  perform set_config('transaction_read_only', 'on', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_owner_user_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_owner_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('app.supervisor_research_business_id', '', true);
  -- Owner identity and café are verified here (under RLS), not trusted from the caller.
  if not exists (select 1 from public.memberships m
                  where m.business_id = p_business_id and m.user_id = p_owner_user_id
                    and m.role = 'owner') then
    raise exception 'supervisor_research_not_owner';
  end if;
  perform set_config('app.supervisor_research_business_id', p_business_id::text, true);

  <<research>>
  begin
    begin
      -- Operational sources only: the plan lists every table the statement reads, views included.
      execute format('explain (format json) select json_agg(q), count(*) from (%s) q', v_sql) into v_plan;
      if v_plan ~ '"Relation Name": ?"(toast_raw_sample[a-z_]*|diag_[^"]*|diagnostic_[^"]*|test_[^"]*|fixture_[^"]*)"' then
        v_result := json_build_object('ok', false, 'error',
          'This statement reads a diagnostic or test source (for example the raw Toast sample tables). Those are never café evidence; use the operational tables listed by describe_database.');
        exit research;
      end if;
    exception when others then
      -- A statement that cannot be planned fails again below with PostgreSQL's own message.
      null;
    end;

    begin
      if p_result_bytes is null then
        execute format('select json_agg(q), count(*) from (%s) q', v_sql) into v_rows, v_count;
      else
        -- Consume a cursor of actual result rows. Stop before building or
        -- transferring an oversized aggregate. The authored SELECT keeps its
        -- own grouping, joins and ordering. Never return a partial row set.
        for v_row in execute format('select row_to_json(q)::text from (%s) q', v_sql)
        loop
          v_bytes := v_bytes + octet_length(v_row) + 1;
          if v_bytes > p_result_bytes then
            v_result := json_build_object('ok',false,'error','tool_result_exceeds_provider_capacity',
              'detail','Request a smaller result. Select relevant fields, aggregate, or page the results.');
            exit research;
          end if;
          v_json_rows := array_append(v_json_rows, v_row);
          v_count := v_count + 1;
        end loop;
        v_rows := ('[' || array_to_string(v_json_rows, ',') || ']')::json;
      end if;
    exception when others then
      get stacked diagnostics v_message = message_text, v_detail = pg_exception_detail,
        v_hint = pg_exception_hint, v_state = returned_sqlstate;
      v_result := json_build_object('ok', false, 'error', v_message, 'sqlstate', v_state,
        'detail', nullif(v_detail, ''), 'hint', nullif(v_hint, ''));
      exit research;
    end;

    v_result := json_build_object('ok', true, 'row_count', v_count, 'rows', coalesce(v_rows, '[]'::json));
  end research;
  perform set_config('app.supervisor_research_business_id', '', true);
  return v_result;
end;
$$;

do $$
declare had_create boolean := has_schema_privilege('authenticated', 'public', 'create');
begin
  if not had_create then execute 'grant create on schema public to authenticated'; end if;
  execute 'alter function public.supervisor_research_sql(uuid, uuid, text, integer) owner to authenticated';
  if not had_create then execute 'revoke create on schema public from authenticated'; end if;
end $$;
revoke all on function public.supervisor_research_sql(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.supervisor_research_sql(uuid, uuid, text, integer) to service_role, supervisor_research_transport;

create or replace function public.supervisor_research_sql(p_business_id uuid, p_owner_user_id uuid, p_sql text)
returns json language sql volatile security invoker set search_path = '' set statement_timeout = 0 as $$
  select public.supervisor_research_sql(p_business_id, p_owner_user_id, p_sql, null::integer);
$$;
