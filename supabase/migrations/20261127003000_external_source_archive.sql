-- Reason: The legacy archive heaps, sequence and scoped grants change together while existing writers keep their original relation identities.
-- squawk-ignore transaction-nesting
begin;
set local statement_timeout = '60s';
-- Attach the existing heaps in place. Existing Toast foreign keys, triggers, IDs
-- and indexes keep pointing at the same rows. Other providers share one default
-- partition and do not need their own schema or tables.
set local lock_timeout = '5s';
alter table public.toast_raw_records
  -- Reason: The shared archive accepts authenticated resource identifiers from connector contracts. Toast scope and record identity checks remain in its writers.
  -- squawk-ignore ban-drop-constraint
  drop constraint toast_raw_records_entity_check,
  add column provider text not null default 'toast' check (provider = 'toast'),
  add column source_account text,
  add column source_key text,
  add column source_updated_at timestamptz,
  add column source_context jsonb;
alter table public.toast_raw_changes
  add column provider text not null default 'toast' check (provider = 'toast'),
  add column source_account text,
  add column source_key text,
  add column record_id uuid,
  -- Reason: Non-UUID provider identities use source_key. Original Toast GUIDs and UUID-based joins retain their existing values.
  -- squawk-ignore ban-drop-not-null
  alter column entity_guid drop not null;

create table public.external_records (like public.toast_raw_records including defaults)
  partition by list (provider);
alter table public.external_records attach partition public.toast_raw_records for values in ('toast');
create table public.external_records_other partition of public.external_records default;
alter table public.external_records_other add foreign key (business_id) references public.businesses(id) on delete cascade;
alter table public.external_records add unique (business_id,provider,id);
create unique index external_other_object_idx on public.external_records_other
  (business_id,provider,capture_key);
create index external_source_lookup_idx on public.external_records
  (business_id,provider,source_account,entity,source_key) where source_account is not null;

-- PG17 partitions inherit the parent's identity. Preserve existing change IDs,
-- and allocate all future change IDs from the same sequence for either route.
create table public.external_record_changes
  (like public.toast_raw_changes including defaults including identity) partition by list (provider);
select setval(pg_get_serial_sequence('public.external_record_changes','id'),
  greatest(1,coalesce((select max(id) from public.toast_raw_changes),0)+1),false);
-- Reason: The same transaction attaches this heap to the PG17 parent identity. The sequence is seeded above all preserved IDs before any writer can use it.
-- squawk-ignore ban-alter-identity
alter table public.toast_raw_changes alter column id drop identity;
alter table public.external_record_changes attach partition public.toast_raw_changes for values in ('toast');
create table public.external_changes_other partition of public.external_record_changes default;
alter table public.external_changes_other add foreign key (business_id) references public.businesses(id) on delete cascade;
create index external_change_record_idx on public.external_record_changes
  (business_id,provider,record_id,id) where record_id is not null;

-- A resource describes an actual observed remote collection. Opaque pagination
-- state is server-only. Availability is independent of the last good observation.
create table public.external_resources (
  business_id uuid not null references public.businesses(id) on delete cascade,
  provider text not null, source_account text not null, resource text not null,
  status text not null default 'pending' check (status in
    ('pending','syncing','current','permission_required','unavailable','incomplete','unsupported')),
  last_attempt_at timestamptz, last_complete_at timestamptz,
  primary key(business_id,provider,source_account,resource)
);
create table public.external_sync_checkpoints (
  business_id uuid not null, provider text not null, source_account text not null, resource text not null,
  stream text not null, revision bigint not null default 0, cursor_state jsonb,
  primary key(business_id,provider,source_account,resource,stream),
  foreign key(business_id,provider,source_account,resource)
    references public.external_resources on delete cascade
);
-- Links are explicit evidence of identity or another relationship. An overlap
-- never overwrites either provider's record or silently adds their amounts.
create table public.external_record_links (
  business_id uuid not null, provider text not null, record_id uuid not null,
  relation text not null, target_provider text, target_id uuid,
  evidence jsonb not null, observed_at timestamptz not null default now(),
  id bigint generated always as identity primary key,
  selector jsonb not null default '{}' check (jsonb_typeof(selector)='object'),
  native_relation text,
  native_key jsonb,
  valid_until timestamptz,
  check (valid_until is null or valid_until>=observed_at),
  check (
    (target_provider is not null and target_id is not null and native_relation is null and native_key is null) or
    (target_provider is null and target_id is null and nullif(native_relation,'') is not null and
     jsonb_typeof(native_key) is not distinct from 'object')
  ),
  foreign key(business_id,provider,record_id) references public.external_records(business_id,provider,id) on delete cascade,
  foreign key(business_id,target_provider,target_id) references public.external_records(business_id,provider,id) on delete cascade
);

-- Reason: Protect the new archive relation before applying its role grants and owner policies.
-- squawk-ignore ban-alter-row-level-security
alter table public.external_records enable row level security;
-- Reason: Protect the new archive relation before applying its role grants and owner policies.
-- squawk-ignore ban-alter-row-level-security
alter table public.external_record_changes enable row level security;
-- Reason: Protect the new archive relation before applying its role grants and owner policies.
-- squawk-ignore ban-alter-row-level-security
alter table public.external_records_other enable row level security;
-- Reason: Protect the new archive relation before applying its role grants and owner policies.
-- squawk-ignore ban-alter-row-level-security
alter table public.external_changes_other enable row level security;
-- Reason: Protect the new archive relation before applying its role grants and owner policies.
-- squawk-ignore ban-alter-row-level-security
alter table public.external_resources enable row level security;
-- Reason: Protect the new archive relation before applying its role grants and owner policies.
-- squawk-ignore ban-alter-row-level-security
alter table public.external_sync_checkpoints enable row level security;
-- Reason: Protect the new archive relation before applying its role grants and owner policies.
-- squawk-ignore ban-alter-row-level-security
alter table public.external_record_links enable row level security;
revoke all on public.external_records,public.external_record_changes,public.external_records_other,
  public.external_changes_other,public.external_resources,public.external_sync_checkpoints,
  public.external_record_links from public,anon,authenticated;
grant select on public.external_records,public.external_record_changes,public.external_resources,
  public.external_record_links to authenticated;
grant select,insert,update,delete on public.external_records,public.external_record_changes,
  public.external_resources,public.external_sync_checkpoints,public.external_record_links to service_role;
-- Legacy historical payloads have different retention contracts. Original
-- payloads become owner-readable through the common archive when reobserved.
create policy owner_read on public.external_records for select to authenticated
  using (source_account is not null and public.scheduling_is_owner(business_id));
create policy owner_read on public.external_record_changes for select to authenticated
  using (source_account is not null and public.scheduling_is_owner(business_id));
create policy owner_read on public.external_resources for select to authenticated using (public.scheduling_is_owner(business_id));
create policy owner_read on public.external_record_links for select to authenticated using (public.scheduling_is_owner(business_id));
comment on table public.external_records is 'Original provider business records. Scope by café, provider, source account and resource (entity). The original JSON is payload.';
comment on table public.external_record_changes is 'Observed changes to original provider records. New deltas use JSON key paths and distinguish missing keys from JSON null.';
comment on table public.external_resources is 'Observed collection availability and last complete synchronization. An unavailable collection is not evidence that its records are absent.';

-- Keep ordered arrays as values. Payloads can contain duplicate items and
-- arbitrary keys, so paths are JSON arrays and never dot-concatenated strings.
create function public.external_json_delta(a jsonb,b jsonb,path text[] default '{}')
returns setof jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare k text; i integer;
begin
  if a is not distinct from b then return; end if;
  if jsonb_typeof(a)='object' and jsonb_typeof(b)='object' then
    for k in select jsonb_object_keys(a) union select jsonb_object_keys(b) loop
      return query select * from public.external_json_delta(a->k,b->k,array_append(path,k));
    end loop;
  elsif jsonb_typeof(a)='array' and jsonb_typeof(b)='array' then
    for i in 0..greatest(jsonb_array_length(a),jsonb_array_length(b))-1 loop
      return query select * from public.external_json_delta(a->i,b->i,array_append(path,i::text));
    end loop;
  else
    return next jsonb_build_object('segments',path,'path',case when cardinality(path)=0 then '$' else '.'||array_to_string(path,'.') end,'before_present',a is not null,'before',a,
                                   'after_present',b is not null,'after',b);
  end if;
end $$;

create function public.external_commit_page(
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
        item->'context',(item->>'restaurant_guid')::uuid,(item->>'entity_guid')::uuid,(item->>'business_date')::date);
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
revoke all on function public.external_commit_page(uuid,text,text,text,text,bigint,jsonb,boolean,jsonb)
 from public,anon,authenticated;
grant execute on function public.external_commit_page(uuid,text,text,text,text,bigint,jsonb,boolean,jsonb) to service_role;
-- Reason: Commit the verified cutover as one transaction.
-- squawk-ignore transaction-nesting
commit;
