-- Connector declarations are discovery evidence. An authorized route may
-- still be pending, empty, incomplete or temporarily unavailable.
alter table public.external_resources
  add column required_permission text,
  add column permission_granted boolean,
  add column last_discovered_at timestamptz;

comment on column public.external_resources.permission_granted is
  'Result of connector permission discovery; null means the grant is unknown. A granted permission does not certify coverage.';
comment on column public.external_resources.status is
  'Latest resource attempt. Check the source and stream for actual coverage; a completed page can be empty.';

create function public.external_discover_resources(
  p_business uuid,p_provider text,p_account text,p_observed_at timestamptz,p_resources jsonb
) returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  if nullif(p_provider,'') is null or nullif(p_account,'') is null or p_observed_at is null
    or jsonb_typeof(p_resources) is distinct from 'array' then
    raise exception 'Invalid external capability discovery';
  end if;

  insert into public.external_resources as r
    (business_id,provider,source_account,resource,required_permission,permission_granted,last_discovered_at,status)
  select p_business,p_provider,p_account,c.resource,c.permission,c.granted,p_observed_at,
    case when c.granted is false then 'permission_required' else 'pending' end
  from jsonb_to_recordset(p_resources) c(resource text,permission text,granted boolean)
  order by c.resource
  on conflict (business_id,provider,source_account,resource) do update
    set required_permission=excluded.required_permission,
        permission_granted=coalesce(excluded.permission_granted,r.permission_granted),
        last_discovered_at=excluded.last_discovered_at,
        status=case when r.last_attempt_at >= p_observed_at then r.status
                    when excluded.permission_granted is false then 'permission_required'
                    when excluded.permission_granted is true and r.status='permission_required' then 'pending'
                    else r.status end
    where r.last_discovered_at is null or r.last_discovered_at <= p_observed_at;
end $$;

revoke all on function public.external_discover_resources(uuid,text,text,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.external_discover_resources(uuid,text,text,timestamptz,jsonb) to service_role;

-- Success clears a previous retry deadline.
create function public.external_clear_completed_retry()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if new.last_complete_at is distinct from old.last_complete_at then
    new.retry_at := null;
  end if;
  return new;
end $$;
revoke all on function public.external_clear_completed_retry() from public,anon,authenticated;
create trigger external_clear_completed_retry before update of last_complete_at on public.external_resources
  for each row execute function public.external_clear_completed_retry();
