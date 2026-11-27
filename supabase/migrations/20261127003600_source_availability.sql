alter table public.external_resources add column retry_at timestamptz;
comment on column public.external_resources.retry_at is 'Provider or connector retry deadline. Last complete evidence remains available during a failed attempt.';

create function public.external_note_availability(p_business_id uuid,p_provider text,p_account text,
 p_resource text,p_status text,p_attempt timestamptz,p_retry timestamptz)
returns void language sql security invoker set search_path=pg_catalog,public as $$
 insert into public.external_resources as current(business_id,provider,source_account,resource,status,last_attempt_at,retry_at)
 values(p_business_id,p_provider,p_account,p_resource,p_status,p_attempt,p_retry)
 on conflict(business_id,provider,source_account,resource) do update
 set status=excluded.status,last_attempt_at=excluded.last_attempt_at,retry_at=excluded.retry_at
 where current.last_attempt_at is null or excluded.last_attempt_at >= current.last_attempt_at
$$;
revoke all on function public.external_note_availability(uuid,text,text,text,text,timestamptz,timestamptz)
 from public,anon,authenticated;
grant execute on function public.external_note_availability(uuid,text,text,text,text,timestamptz,timestamptz) to service_role;
