-- A completed observation covers all of its pages, including pages saved by
-- a prior worker. Membership stores record IDs only, with no duplicate payloads.
set lock_timeout = '5s';
set statement_timeout = '45s';

alter table public.external_sync_checkpoints
  add column active_observation_id uuid,
  add column last_complete_observation_id uuid;

-- Pre-existing incomplete traversals lack membership for their first pages.
-- Restart those safely with the same record identities.
update public.external_sync_checkpoints set cursor_state=null,revision=revision+1
  where cursor_state is not null and cursor_state<>'null'::jsonb;

create table public.external_observation_members (
  business_id uuid not null,
  provider text not null,
  observation_id uuid not null,
  record_id uuid not null,
  primary key(business_id,provider,observation_id,record_id),
  foreign key(business_id,provider,record_id)
    references public.external_records(business_id,provider,id) on delete cascade
);
create index external_observation_record_idx
  on public.external_observation_members (business_id,provider,record_id);
-- Reason: The new observation membership table is service-only and RLS is enabled before access grants.
-- squawk-ignore ban-alter-row-level-security
alter table public.external_observation_members enable row level security;
revoke all on public.external_observation_members from public,anon,authenticated;
grant select,insert,delete on public.external_observation_members to service_role;

create or replace function public.external_commit_page(
  p_business_id uuid,p_provider text,p_account text,p_resource text,p_stream text,
  p_revision bigint,p_next jsonb,p_complete boolean,p_records jsonb
) returns bigint language plpgsql security invoker set search_path=pg_catalog,public as $$
declare state public.external_sync_checkpoints%rowtype; item jsonb; previous public.external_records%rowtype;
  identity_key text; object_key text; body jsonb; hash text; modified timestamptz; delta jsonb; receipt uuid;
begin
  if nullif(p_provider,'') is null or nullif(p_account,'') is null or nullif(p_resource,'') is null
     or nullif(p_stream,'') is null or p_complete is null or p_revision is null
     or jsonb_typeof(p_records) is distinct from 'array' then raise exception 'Invalid external page'; end if;
  insert into public.external_resources(business_id,provider,source_account,resource)
    values(p_business_id,p_provider,p_account,p_resource) on conflict do nothing;
  insert into public.external_sync_checkpoints(business_id,provider,source_account,resource,stream)
    values(p_business_id,p_provider,p_account,p_resource,p_stream) on conflict do nothing;
  select * into strict state from public.external_sync_checkpoints
    where business_id=p_business_id and provider=p_provider and source_account=p_account
      and resource=p_resource and stream=p_stream for update;
  if state.revision <> p_revision then raise exception 'Stale external page checkpoint' using errcode='40001'; end if;
  -- Null cursor on a non-final call explicitly discards an expired traversal.
  if p_next is null and not p_complete and jsonb_array_length(p_records)<>0 then
    raise exception 'Non-final external page needs a continuation';
  end if;
  receipt := coalesce(state.active_observation_id,gen_random_uuid());
  for item in select value from jsonb_array_elements(p_records) with ordinality order by value->>'key', ordinality loop
    object_key := item->>'key'; body := item->'payload'; modified := (item->>'updated_at')::timestamptz;
    if jsonb_typeof(item->'key') is distinct from 'string' or object_key='' or body is null then
      raise exception 'Missing external record identity or payload';
    end if;
    identity_key := coalesce(item->>'archive_key','external:'||encode(sha256(convert_to(jsonb_build_array(p_account,p_resource,object_key)::text,'UTF8')),'hex'));
    perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_business_id,p_provider,identity_key)::text,0));
    select * into previous from public.external_records
      where business_id=p_business_id and provider=p_provider and capture_key=identity_key for update;
    hash := encode(sha256(convert_to(body::text,'UTF8')),'hex');
    if found and (previous.entity<>p_resource or
        coalesce(previous.source_account,previous.restaurant_guid::text) is distinct from p_account) then
      raise exception 'Existing external identity belongs to another resource';
    end if;
    if previous.id is null then
      insert into public.external_records(business_id,provider,source_account,entity,source_key,
        source_updated_at,payload,payload_sha256,capture_key,source_context,restaurant_guid,entity_guid,business_date,commit_id)
      values(p_business_id,p_provider,p_account,p_resource,object_key,modified,body,hash,identity_key,
        item->'context',(item->>'restaurant_guid')::uuid,(item->>'entity_guid')::uuid,(item->>'business_date')::date,receipt) returning id into previous.id;
    elsif previous.source_updated_at is null or modified >= previous.source_updated_at or
      (modified is null and previous.payload=body) then
      if previous.payload is distinct from body then
        select jsonb_agg(d order by d->'path') into delta from public.external_json_delta(previous.payload,body) d;
        insert into public.external_record_changes(business_id,provider,source_account,entity,source_key,record_id,changes,
          restaurant_guid,entity_guid,business_date)
          values(p_business_id,p_provider,previous.source_account,p_resource,object_key,previous.id,delta,
          previous.restaurant_guid,previous.entity_guid,previous.business_date);
      end if;
      update public.external_records set payload=body,payload_sha256=hash,last_seen=clock_timestamp(),
        source_account=p_account,source_key=object_key,source_context=item->'context',commit_id=receipt,
        business_date=coalesce((item->>'business_date')::date,business_date),
        source_updated_at=coalesce(modified,source_updated_at)
        where business_id=p_business_id and provider=p_provider and id=previous.id;
    else
      -- The provider returned this identity, even if a newer payload is known.
      insert into public.external_observation_members values(p_business_id,p_provider,receipt,previous.id)
        on conflict do nothing;
      continue;
    end if;
    if item ? 'identifiers' then
      perform public.external_observe_identifiers(p_business_id,p_provider,previous.id,item->'identifiers');
    end if;
    insert into public.external_observation_members values(p_business_id,p_provider,receipt,previous.id)
      on conflict do nothing;
  end loop;
  if p_complete or p_next is null then
    delete from public.external_observation_members
     where (business_id,provider,observation_id)=(p_business_id,p_provider,
       case when p_complete then state.last_complete_observation_id else state.active_observation_id end);
  end if;
  update public.external_sync_checkpoints set revision=revision+1,cursor_state=p_next,
    active_observation_id=case when not p_complete and p_next is not null then receipt end,
    last_complete_observation_id=case when p_complete then receipt else last_complete_observation_id end
    where business_id=p_business_id and provider=p_provider and source_account=p_account
      and resource=p_resource and stream=p_stream;
  update public.external_resources set status=case when p_complete then 'current' else 'syncing' end,
    last_attempt_at=clock_timestamp(),
    last_complete_at=case when p_complete then clock_timestamp() else last_complete_at end,
    last_complete_commit=case when p_complete then receipt else last_complete_commit end,
    last_complete_scope=case when p_complete then jsonb_build_object('stream',p_stream) ||
      coalesce(p_next->'scope','{}'::jsonb) else last_complete_scope end
    where business_id=p_business_id and provider=p_provider and source_account=p_account and resource=p_resource;
  return state.revision+1;
end $$;

comment on column public.external_resources.last_complete_commit is
  'Receipt of the latest completed observation across all its pages. For scoped reads, match the intended stream and coverage.';
