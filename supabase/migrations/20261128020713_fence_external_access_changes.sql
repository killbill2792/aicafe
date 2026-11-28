set lock_timeout = '5s';
set statement_timeout = '60s';

alter table public.external_resources add column last_permission_loss_at timestamptz;

update public.external_resources
 set last_permission_loss_at=coalesce(greatest(last_attempt_at,last_discovered_at),clock_timestamp())
 where permission_granted is false;

-- Keep the completed receipts for history. A traversal that crossed a grant
-- change must restart from page one before it can certify a new observation.
create function public.external_fence_lost_permission()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if new.permission_granted is not false then return new; end if;
 if tg_op='INSERT' then
  new.last_permission_loss_at:=clock_timestamp();
  return new;
 end if;
 if old.permission_granted is false then return new; end if;
 new.last_permission_loss_at:=clock_timestamp();
 delete from public.external_observation_members m using public.external_sync_checkpoints c
  where (c.business_id,c.provider,c.source_account,c.resource)=
   (new.business_id,new.provider,new.source_account,new.resource)
   and (m.business_id,m.provider,m.observation_id)=(c.business_id,c.provider,c.active_observation_id);
 update public.external_sync_checkpoints c
  set cursor_state=null,active_observation_id=null,revision=revision+1
  where (c.business_id,c.provider,c.source_account,c.resource)=
   (new.business_id,new.provider,new.source_account,new.resource)
   and c.active_observation_id is not null;
 return new;
end $$;
revoke all on function public.external_fence_lost_permission() from public,anon,authenticated;
create trigger external_fence_lost_permission
 before insert or update of permission_granted on public.external_resources
 for each row execute function public.external_fence_lost_permission();

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
      and (e.last_permission_loss_at is null or c.last_complete_at>=e.last_permission_loss_at)
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

create or replace function public.external_current_observation(r public.external_records,e public.external_resources)
returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
  select coalesce(r.payload_origin='provider' and e.permission_granted is distinct from false and
    (r.business_id,r.provider,r.source_account,r.entity)=(e.business_id,e.provider,e.source_account,e.resource) and
    ((r.source_context->>'observation_mode'='point'
      and r.last_seen>=greatest(e.last_attempt_at,e.last_permission_loss_at,'-infinity'::timestamptz))
    or (e.status='current' and e.last_complete_at is not null and e.last_complete_scope->>'mode'='snapshot'
     and (e.last_permission_loss_at is null or e.last_complete_at>=e.last_permission_loss_at)
     and exists(select from public.external_observation_members m
       where (m.business_id,m.provider,m.observation_id,m.record_id)=
         (r.business_id,r.provider,e.last_complete_commit,r.id)
         and m.observed_sha256=r.payload_sha256))),false);
$$;
