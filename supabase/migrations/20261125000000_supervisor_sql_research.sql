-- Supervisor direct SQL research (owner request, Nov 25 2026).
--
-- One function lets the server run a model-written, read-only SELECT against
-- the café's own data. Security comes from the database, not from the model:
--   * Only the server (service_role) may call it. Browsers cannot.
--   * It runs as the `authenticated` role (SECURITY DEFINER owned by
--     `authenticated`), with auth.uid() set to the verified café owner, so the
--     existing row level security decides every row it can see.
--   * The transaction is switched to READ ONLY before the query runs.
--     PostgreSQL never lets a transaction go back to read-write after its
--     first query, so no write, DDL or grant can happen.
--   * app.supervisor_research_business_id narrows every membership check to
--     the one café of this chat, so an owner of two cafés gets one café.
--   * Text that could change the session identity (set_config, SQL-in-a-string
--     helpers, unicode-escaped identifiers) is refused. The server also parses
--     the statement and refuses anything but one SELECT before calling this.
-- Errors are returned as data (message, detail, hint, position) so the model
-- can correct its SQL. The platform's existing statement timeout still applies.

-- 1. Café narrowing for the definer membership helpers. When the setting is
--    unset (every existing code path) behaviour is unchanged.
create or replace function public.is_member(target_business_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from memberships m
    where m.business_id = target_business_id and m.user_id = auth.uid()
  ) and coalesce(nullif(current_setting('app.supervisor_research_business_id', true), ''),
                 target_business_id::text) = target_business_id::text;
$$;

create or replace function public.scheduling_is_owner(p_business_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $$
  -- The shared demo café has a fixed identity seeded by the existing
  -- demo-access migration. Its mutable businesses.is_demo flag is not an
  -- authorization root: a demo member can change it to false.
  select p_business_id is distinct from '11111111-1111-1111-1111-111111111111'::uuid
    and exists (select 1 from public.memberships
      where business_id=p_business_id and user_id=auth.uid() and role='owner')
    and coalesce(nullif(current_setting('app.supervisor_research_business_id', true), ''),
                 p_business_id::text) = p_business_id::text;
$$;

create or replace function public.toast_is_business_member(p_business_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $$
 select auth.uid() is not null and exists(
  select 1 from public.memberships m where m.business_id=p_business_id and m.user_id=auth.uid()
 ) and coalesce(nullif(current_setting('app.supervisor_research_business_id', true), ''),
                p_business_id::text) = p_business_id::text;
$$;

-- Policies that check memberships directly (not through a helper) read it
-- under RLS, so one restrictive policy narrows them too.
drop policy if exists "supervisor research cafe scope" on public.memberships;
create policy "supervisor research cafe scope" on public.memberships
  as restrictive for select
  using (coalesce(nullif(current_setting('app.supervisor_research_business_id', true), ''),
                  business_id::text) = business_id::text);

-- 2. The research function.
create or replace function public.supervisor_research_sql(
  p_business_id uuid,
  p_owner_user_id uuid,
  p_sql text,
  p_max_rows integer default 2000
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
  v_limit integer := greatest(1, least(coalesce(p_max_rows, 2000), 2000));
  v_sql text := regexp_replace(coalesce(p_sql, ''), '[\s;]+$', '');
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
    execute format('select json_agg(q), count(*) from (select * from (%s) research_query limit %s) q',
                   v_sql, v_limit + 1)
      into v_rows, v_count;
  exception when others then
    get stacked diagnostics v_message = message_text, v_detail = pg_exception_detail,
      v_hint = pg_exception_hint, v_state = returned_sqlstate;
    return json_build_object('ok', false, 'error', v_message, 'sqlstate', v_state,
      'detail', nullif(v_detail, ''), 'hint', nullif(v_hint, ''));
  end;

  if v_count > v_limit then
    -- Drop the probe row; tell the model there is more so it can aggregate.
    v_rows := (select json_agg(e order by i) from json_array_elements(v_rows) with ordinality t(e, i)
                where i <= v_limit);
  end if;
  return json_build_object('ok', true, 'row_count', least(v_count, v_limit),
    'truncated', v_count > v_limit, 'rows', coalesce(v_rows, '[]'::json));
end;
$$;

-- Runs as `authenticated`: only its privileges and RLS policies apply.
-- ALTER OWNER needs CREATE on the schema for the new owner; grant it only for
-- this statement when the platform has not already granted it.
do $$
declare had_create boolean := has_schema_privilege('authenticated', 'public', 'create');
begin
  if not had_create then execute 'grant create on schema public to authenticated'; end if;
  execute 'alter function public.supervisor_research_sql(uuid, uuid, text, integer) owner to authenticated';
  if not had_create then execute 'revoke create on schema public from authenticated'; end if;
end $$;
revoke all on function public.supervisor_research_sql(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.supervisor_research_sql(uuid, uuid, text, integer) to service_role;

comment on function public.supervisor_research_sql(uuid, uuid, text, integer) is
  'Supervisor research: one read-only SELECT as the verified café owner under RLS, narrowed to one café. Server-only.';
