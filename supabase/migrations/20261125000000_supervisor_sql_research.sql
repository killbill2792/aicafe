-- Supervisor direct SQL research: the server runs one model-written SELECT as
-- the verified owner under RLS, read-only, narrowed to the chat's café.
-- Errors come back as data so the model can fix its SQL.

set lock_timeout = '5s';
set statement_timeout = '60s';

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
  -- Unchanged except the last condition (fixed demo café id as before).
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
create policy "supervisor research cafe scope" on public.memberships
  as restrictive for select
  using (coalesce(nullif(current_setting('app.supervisor_research_business_id', true), ''),
                  business_id::text) = business_id::text);

-- 2. The research function.
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
