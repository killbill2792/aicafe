-- Supervisor SQL research: refuse diagnostic and test sources in the executor itself (not just in discovery),
-- so operational café evidence is the only thing a query can return.
set lock_timeout = '5s';
set statement_timeout = '60s';

-- The research function, now also refusing diagnostic sources.
create or replace function public.supervisor_research_sql(
  p_business_id uuid,
  p_owner_user_id uuid,
  p_sql text
) returns json
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows json;
  v_count integer;
  v_message text; v_detail text; v_hint text; v_state text;
  v_sql text := regexp_replace(coalesce(p_sql, ''), '[\s;]+$', '');
  v_plan text;
begin
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

  begin
    -- Operational sources only: the plan lists every table the statement reads, views included.
    execute format('explain (format json) select json_agg(q), count(*) from (%s) q', v_sql) into v_plan;
    if v_plan ~ '"Relation Name": ?"(toast_raw_sample[a-z_]*|diag_[^"]*|diagnostic_[^"]*|test_[^"]*|fixture_[^"]*)"' then
      return json_build_object('ok', false, 'error',
        'This statement reads a diagnostic or test source (for example the raw Toast sample tables). Those are never café evidence; use the operational tables listed by describe_database.');
    end if;
  exception when others then
    -- A statement that cannot be planned fails again below with PostgreSQL's own message.
    null;
  end;

  begin
    execute format('select json_agg(q), count(*) from (%s) q', v_sql) into v_rows, v_count;
  exception when others then
    get stacked diagnostics v_message = message_text, v_detail = pg_exception_detail,
      v_hint = pg_exception_hint, v_state = returned_sqlstate;
    return json_build_object('ok', false, 'error', v_message, 'sqlstate', v_state,
      'detail', nullif(v_detail, ''), 'hint', nullif(v_hint, ''));
  end;

  return json_build_object('ok', true, 'row_count', v_count, 'rows', coalesce(v_rows, '[]'::json));
end;
$$;

-- Runs as `authenticated`: only its privileges and RLS policies apply.
-- ALTER OWNER needs CREATE on the schema for the new owner; grant it only for
-- this statement when the platform has not already granted it.
do $$
declare had_create boolean := has_schema_privilege('authenticated', 'public', 'create');
begin
  if not had_create then execute 'grant create on schema public to authenticated'; end if;
  execute 'alter function public.supervisor_research_sql(uuid, uuid, text) owner to authenticated';
  if not had_create then execute 'revoke create on schema public from authenticated'; end if;
end $$;
revoke all on function public.supervisor_research_sql(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.supervisor_research_sql(uuid, uuid, text) to service_role;

comment on function public.supervisor_research_sql(uuid, uuid, text) is
  'Supervisor research: one read-only SELECT as the verified café owner under RLS, narrowed to one café. Server-only.';
