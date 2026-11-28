set lock_timeout = '5s';
set statement_timeout = '60s';
-- A verified source can identify entries inside an original document. A native
-- recipe can join its existing menu identity to one of these references. Keep
-- past associations when an identifier disappears or moves to another object.
create table public.external_identifiers (
 id bigint generated always as identity primary key,
 business_id uuid not null, provider text not null, record_id uuid not null,
 namespace text not null, value text not null, selector jsonb not null,
 valid_from timestamptz not null default clock_timestamp(),valid_until timestamptz,
 relationship text not null default 'identity' check (relationship <> ''),
 shared boolean not null default false,
 foreign key (business_id,provider,record_id) references public.external_records(business_id,provider,id) on delete cascade
);
create unique index external_identifiers_current on public.external_identifiers
 (business_id,provider,record_id,namespace,value,relationship,md5(selector::text))
 where valid_until is null;
create index external_identifiers_match on public.external_identifiers
 (business_id,namespace,value,provider) where valid_until is null;
-- Reason: The new identifier table receives no grants until the café-owner policy is set.
-- squawk-ignore ban-alter-row-level-security
alter table public.external_identifiers enable row level security;
revoke all on public.external_identifiers from public,anon,authenticated;
grant select on public.external_identifiers to authenticated;
grant select,insert,update on public.external_identifiers to service_role;
create policy owner_read on public.external_identifiers for select to authenticated using(public.scheduling_is_owner(business_id));
comment on table public.external_identifiers is
 'Source-attested identifiers shared with other systems or native records. Use namespace and value together within a café. A selector identifies a nested object. Multiple candidates are not an authoritative match.';

create function public.external_observe_identifiers(p_business uuid,p_provider text,p_record uuid,p_aliases jsonb)
returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if jsonb_typeof(p_aliases) is distinct from 'array' then raise exception 'Invalid source identifier list'; end if;
 if exists(select from jsonb_array_elements(p_aliases) a where nullif(a->>'value','') is null
   or nullif(a->>'namespace','') is null or jsonb_typeof(a->'selector') is distinct from 'object') then
    raise exception 'Incomplete source identifier'; end if;
 -- The writer holds the source row lock for the entire observation.
 update public.external_identifiers e set valid_until=clock_timestamp()
 where business_id=p_business and provider=p_provider and record_id=p_record and valid_until is null
 and not exists(select from jsonb_to_recordset(p_aliases) a(namespace text,value text,selector jsonb)
  where (a.namespace,a.value,a.selector)=(e.namespace,e.value,e.selector));
 insert into public.external_identifiers(business_id,provider,record_id,namespace,value,selector)
 select distinct p_business,p_provider,p_record,a.namespace,a.value,a.selector
 from jsonb_to_recordset(p_aliases) a(namespace text,value text,selector jsonb)
 where not exists(select from public.external_identifiers e where e.business_id=p_business and e.provider=p_provider
  and e.record_id=p_record and e.valid_until is null and (e.namespace,e.value,e.selector)=(a.namespace,a.value,a.selector));
end $$;
revoke all on function public.external_observe_identifiers(uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.external_observe_identifiers(uuid,text,uuid,jsonb) to service_role;

create or replace function public.external_commit_page(
  p_business_id uuid,p_provider text,p_account text,p_resource text,p_stream text,
  p_revision bigint,p_next jsonb,p_complete boolean,p_records jsonb
) returns bigint language plpgsql security invoker set search_path=pg_catalog,public as $$
declare state public.external_sync_checkpoints%rowtype; item jsonb; previous public.external_records%rowtype;
  identity_key text; object_key text; body jsonb; hash text; modified timestamptz; delta jsonb;
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
        source_updated_at,payload,payload_sha256,capture_key,source_context,restaurant_guid,entity_guid,business_date)
      values(p_business_id,p_provider,p_account,p_resource,object_key,modified,body,hash,identity_key,
        item->'context',(item->>'restaurant_guid')::uuid,(item->>'entity_guid')::uuid,(item->>'business_date')::date) returning id into previous.id;
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
        source_account=p_account,source_key=object_key,source_context=item->'context',
        business_date=coalesce((item->>'business_date')::date,business_date),
        source_updated_at=coalesce(modified,source_updated_at)
        where business_id=p_business_id and provider=p_provider and id=previous.id;
    else
      continue;
    end if;
    if item ? 'identifiers' then
      perform public.external_observe_identifiers(p_business_id,p_provider,previous.id,item->'identifiers');
    end if;
  end loop;
  update public.external_sync_checkpoints set revision=revision+1,cursor_state=p_next
    where business_id=p_business_id and provider=p_provider and source_account=p_account
      and resource=p_resource and stream=p_stream;
  update public.external_resources set status=case when p_complete then 'current' else 'syncing' end,
    last_attempt_at=clock_timestamp(),last_complete_at=case when p_complete then clock_timestamp() else last_complete_at end
    where business_id=p_business_id and provider=p_provider and source_account=p_account and resource=p_resource;
  return state.revision+1;
end $$;
