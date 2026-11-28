set lock_timeout = '5s';
set statement_timeout = '60s';

create or replace function public.external_read_observation(
  p_business_id uuid,p_provider text,p_account text,p_resource text,p_stream text,
  p_revision bigint,p_after uuid,p_scope jsonb default null,p_mode text default null
) returns table(record_id uuid,payload jsonb)
language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare observation uuid; member record;
begin
  select c.last_complete_observation_id into observation
    from public.external_sync_checkpoints c
    join public.external_resources e using(business_id,provider,source_account,resource)
    where (c.business_id,c.provider,c.source_account,c.resource,c.stream,c.last_complete_revision)=
      (p_business_id,p_provider,p_account,p_resource,p_stream,p_revision)
      and (p_scope is null or c.last_complete_scope=p_scope)
      and (p_mode is null or c.last_complete_mode=p_mode)
      and e.permission_granted is distinct from false
      -- An unrelated point may restore access to the resource. It cannot
      -- make a point observed before the last failure eligible again.
      and (c.last_complete_mode is distinct from 'point' or e.last_attempt_at is null
        or c.last_complete_at>=e.last_attempt_at);
  if observation is null then raise exception 'Stale external observation' using errcode='40001'; end if;
  for member in
    select m.record_id,r.payload,
      (r.source_account,r.entity,r.payload_sha256)=(p_account,p_resource,m.observed_sha256) as matches
    from public.external_observation_members m
    join public.external_records r on (r.business_id,r.provider,r.id)=(m.business_id,m.provider,m.record_id)
    where (m.business_id,m.provider,m.observation_id)=(p_business_id,p_provider,observation)
      and (p_after is null or m.record_id>p_after)
    order by m.record_id limit 500
  loop
    if member.matches is distinct from true then
      raise exception 'External observation payload has changed' using errcode='55000';
    end if;
    record_id := member.record_id;
    payload := member.payload;
    return next;
  end loop;
end $$;
