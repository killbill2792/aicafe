-- A provider's point read verifies one record. It cannot replace a full
-- collection receipt or make the other records appear missing.
set lock_timeout = '5s';
set statement_timeout = '60s';

create or replace function public.external_commit_page(
  p_business_id uuid,p_provider text,p_account text,p_resource text,p_stream text,
  p_revision bigint,p_next jsonb,p_complete boolean,p_records jsonb
) returns bigint language plpgsql security invoker set search_path=pg_catalog,public as $$
declare state public.external_sync_checkpoints%rowtype; item jsonb; previous public.external_records%rowtype;
  identity_key text; object_key text; body jsonb; hash text; modified timestamptz; delta jsonb; receipt uuid; archive_reader uuid;
  point boolean:=coalesce(p_next->>'mode'='point',false); context jsonb;
begin
  if nullif(p_provider,'') is null or nullif(p_account,'') is null or nullif(p_resource,'') is null
     or nullif(p_stream,'') is null or p_complete is null or p_revision is null
     or jsonb_typeof(p_records) is distinct from 'array' then raise exception 'Invalid external page'; end if;
  if point and (not p_complete or jsonb_array_length(p_records)<>1 or p_next->>'cursor' is not null) then
    raise exception 'A point observation requires exactly one record and no continuation';
  end if;
  insert into public.external_resources(business_id,provider,source_account,resource)
    values(p_business_id,p_provider,p_account,p_resource) on conflict do nothing;
  select e.reader_owner_user_id into strict archive_reader from public.external_resources e
    where (e.business_id,e.provider,e.source_account,e.resource)=(p_business_id,p_provider,p_account,p_resource)
    for update;
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
    context := coalesce(item->'context','{}'::jsonb) ||
      jsonb_build_object('observation_mode',case when point then 'point' else 'collection' end);
    identity_key := coalesce(item->>'archive_key','external:'||encode(sha256(convert_to(jsonb_build_array(p_account,p_resource,object_key)::text,'UTF8')),'hex'));
    perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_business_id,p_provider,identity_key)::text,0));
    select * into previous from public.external_records
      where business_id=p_business_id and provider=p_provider and capture_key=identity_key for update;
    hash := encode(sha256(convert_to(body::text,'UTF8')),'hex');
    if found and (previous.entity<>p_resource or previous.reader_owner_user_id is distinct from archive_reader or
        coalesce(previous.source_account,previous.restaurant_guid::text) is distinct from p_account) then
      raise exception 'Existing external identity belongs to another resource';
    end if;
    if previous.id is null then
      insert into public.external_records(business_id,provider,source_account,entity,source_key,
        source_updated_at,payload,payload_sha256,capture_key,source_context,restaurant_guid,entity_guid,business_date,commit_id,reader_owner_user_id)
      values(p_business_id,p_provider,p_account,p_resource,object_key,modified,body,hash,identity_key,
        context,(item->>'restaurant_guid')::uuid,(item->>'entity_guid')::uuid,(item->>'business_date')::date,receipt,archive_reader) returning id into previous.id;
    elsif previous.source_updated_at is null or modified >= previous.source_updated_at or
      (modified is null and previous.payload=body) then
      if previous.payload is distinct from body then
        select jsonb_agg(d order by d->'path') into delta from public.external_json_delta(previous.payload,body) d;
        insert into public.external_record_changes(business_id,provider,source_account,entity,source_key,record_id,changes,
          restaurant_guid,entity_guid,business_date,reader_owner_user_id)
          values(p_business_id,p_provider,previous.source_account,p_resource,object_key,previous.id,delta,
          previous.restaurant_guid,previous.entity_guid,previous.business_date,archive_reader);
      end if;
      update public.external_records set payload=body,payload_sha256=hash,last_seen=clock_timestamp(),
        source_account=p_account,source_key=object_key,source_context=context,commit_id=receipt,
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
  if not point then
  update public.external_resources set status=case when p_complete then 'current' else 'syncing' end,
    last_attempt_at=clock_timestamp(),
    last_complete_at=case when p_complete then clock_timestamp() else last_complete_at end,
    last_complete_commit=case when p_complete then receipt else last_complete_commit end,
    last_complete_scope=case when p_complete then jsonb_build_object('stream',p_stream) ||
      coalesce(p_next->'scope','{}'::jsonb) else last_complete_scope end
    where business_id=p_business_id and provider=p_provider and source_account=p_account and resource=p_resource;
  end if;
  return state.revision+1;
end $$;

-- Owner SQL may verify membership of records already admitted by archive RLS.
grant select on public.external_observation_members to authenticated;
create policy owner_read on public.external_observation_members for select to authenticated using (exists(
  select from public.external_records r where (r.business_id,r.provider,r.id)=
    (external_observation_members.business_id,external_observation_members.provider,external_observation_members.record_id)
));

create function public.external_current_observation(r public.external_records,e public.external_resources)
returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
  select coalesce(r.payload_origin='provider' and e.permission_granted is distinct from false and
    (r.business_id,r.provider,r.source_account,r.entity)=(e.business_id,e.provider,e.source_account,e.resource) and
    ((r.source_context->>'observation_mode'='point' and r.last_seen>=coalesce(e.last_attempt_at,'-infinity'::timestamptz))
    or (e.status='current' and e.last_complete_at is not null and
     (r.commit_id=e.last_complete_commit or exists(select from public.external_observation_members m
       where (m.business_id,m.provider,m.observation_id,m.record_id)=
         (r.business_id,r.provider,e.last_complete_commit,r.id))))),false);
$$;
revoke all on function public.external_current_observation(public.external_records,public.external_resources)
  from public,anon;
grant execute on function public.external_current_observation(public.external_records,public.external_resources)
  to authenticated,service_role;

create or replace function public.toast_stage_operational_batch(
 p_business_id uuid,p_restaurant_guid uuid,p_endpoint text,
 p_business_date date,p_objects jsonb
) returns integer language plpgsql security invoker set search_path=pg_catalog,public as $$
<<observation>>
declare
 item jsonb;
 records jsonb;
 prior record;
 stream text := coalesce(p_business_date::text,'current');
 revision bigint;
 point boolean := coalesce(p_objects->0->>'observation_kind'='point',false);
begin
 if not exists(select 1 from public.toast_location_mappings
   where business_id=p_business_id and restaurant_guid=p_restaurant_guid and verified_at is not null)
 then raise exception 'Unverified Toast account' using errcode='42501'; end if;
 if p_endpoint is null or p_endpoint not in ('cashmgmt/v1/entries','cashmgmt/v1/deposits',
   'stock/v1/inventory','kitchen/v1/export/itemFulfillments','kitchen/v1/published/prepStations',
   'restaurant-availability/v1/availability','ordermgmt-config/v1/published/orderingSchedule')
   or jsonb_typeof(p_objects) is distinct from 'array' or jsonb_array_length(p_objects)>5000
 then raise exception 'Invalid operational source page' using errcode='22023'; end if;
 if point then
  if p_endpoint<>'stock/v1/inventory' or jsonb_array_length(p_objects)<>1
    or nullif(p_objects->0->>'provider_key','') is null
  then raise exception 'Invalid Toast point observation' using errcode='22023'; end if;
  stream := 'point:'||(p_objects->0->>'provider_key');
 end if;
 -- Multiple date windows and a webhook may observe the same current object.
 perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
   'toast-operational',p_business_id,p_restaurant_guid,p_endpoint)::text,0));
 for item in select value from jsonb_array_elements(p_objects) loop
   if jsonb_typeof(item->'payload') is distinct from 'object' or nullif(item->>'provider_key','') is null
     or item->>'business_id' is distinct from p_business_id::text
     or item->>'restaurant_guid' is distinct from p_restaurant_guid::text
     or item->>'endpoint' is distinct from p_endpoint
     or (item->'payload' ? 'restaurantGuid' and lower(item->'payload'->>'restaurantGuid') is distinct from p_restaurant_guid::text)
     or (p_business_date is not null and item->>'business_date' is distinct from p_business_date::text)
   then raise exception 'Invalid source record scope' using errcode='22023'; end if;
   select r.payload,r.source_context into prior from public.external_records r
   where r.business_id=p_business_id and r.provider='toast'
     and r.capture_key='stage:toast_operational_current:key:'||
       public.toast_stage_object_key('toast_operational_current',item);
   if found and public.toast_operational_has_missing_keys(
     case when prior.source_context is not null then prior.payload else prior.payload-array[
       'business_id','restaurant_guid','endpoint','provider_key','source_key_kind',
       'operational_object_uuid','business_date','source_business_date_kind',
       'fetched_at','lastSuccessAt','checked_at','last_checked_at'] end,
     item->'payload')
   then raise exception 'Incomplete operational source record' using errcode='22023'; end if;
 end loop;
 select coalesce(jsonb_agg(jsonb_build_object(
    'key',v->>'provider_key','payload',v->'payload','context',v-'payload',
    'archive_key','stage:toast_operational_current:key:'||public.toast_stage_object_key('toast_operational_current',v),
    'restaurant_guid',p_restaurant_guid,'business_date',p_business_date,
    'entity_guid',coalesce(v->'payload'->>'guid',v->>'operational_object_uuid'))),'[]'::jsonb) into records
 from jsonb_array_elements(p_objects) v;
 select c.revision into revision from public.external_sync_checkpoints c where
   business_id=p_business_id and provider='toast' and source_account=p_restaurant_guid::text
   and resource=p_endpoint and c.stream=observation.stream;
 perform public.external_commit_page(p_business_id,'toast',p_restaurant_guid::text,p_endpoint,stream,
   coalesce(revision,0),case when point then jsonb_build_object('mode','point')
     else jsonb_build_object('scope',jsonb_strip_nulls(jsonb_build_object('business_date',p_business_date))) end,
   true,records);
 return jsonb_array_length(p_objects);
end $$;

create or replace function public.inventory_evidence_for(p_business_id uuid,p_from date,p_to date)
returns table(
  business_id uuid,source text,source_ref text,status text,business_date date,
  data jsonb,menu_item_ref text,stock_status text,quantity numeric
) language sql stable security invoker set search_path=pg_catalog,public as $$
  select i.business_id,'app','stock:'||i.id,'actual',i.count_date,
    jsonb_build_object('ingredient_id',i.ingredient_id,'ingredient_name',ingredient.name,
     'base_unit',ingredient.base_unit,'count_date',i.count_date,'quantity_base',i.quantity_base,
     'evidence_state','dated_owner_count'),
    null::text,null::text,i.quantity_base::numeric
  from public.pantry_stock_counts i
  left join public.ingredients ingredient on (ingredient.business_id,ingredient.id)=(i.business_id,i.ingredient_id)
  where i.business_id=p_business_id and i.count_date between p_from and p_to
  union all
  select r.business_id,r.provider,'toast-current:'||r.id,'open',shown.business_date,
    jsonb_build_object('menu_item_ref',r.source_key,'reported_stock_status',r.payload->>'status',
      'quantity',q.quantity,'source_as_of',r.source_context->>'lastSuccessAt',
      'observed_business_date',r.business_date,'checked_at',e.last_attempt_at,
      'source_status',e.status,'evidence_state',shown.evidence_state),
    r.source_key,case when shown.evidence_state='observed_current' then r.payload->>'status' end,q.quantity
  from public.external_records r
  join public.businesses b on b.id=r.business_id
  left join public.external_resources e on (e.business_id,e.provider,e.source_account,e.resource)=
    (r.business_id,r.provider,r.source_account,r.entity)
  cross join lateral (
    select case when e.last_complete_at is not null or r.source_context->>'observation_mode'='point' then (now() at time zone b.timezone)::date
                else r.business_date end as business_date,
      case when public.external_current_observation(r,e) then 'observed_current'
           when e.last_complete_commit is null then 'source_unverified'
           when e.status<>'current' then 'source_failed'
           else 'not_observed' end as evidence_state
  ) shown
  cross join lateral (
    select case when shown.evidence_state='observed_current' and jsonb_typeof(r.payload->'quantity')='number'
          then case when (r.payload->>'quantity')::numeric>=0 then (r.payload->>'quantity')::numeric end
           end as quantity
  ) q
  where r.business_id=p_business_id and r.provider='toast' and r.entity='stock/v1/inventory'
    and r.source_account is not null and shown.business_date between p_from and p_to
$$;

create or replace view public.external_identity_authority with (security_invoker=true) as
with candidates as not materialized (
  select distinct i.business_id,i.namespace,i.value,i.provider,i.record_id,i.selector,
    r.entity,r.source_account,r.source_updated_at,r.last_seen,e.status,
    public.external_current_observation(r,e) as is_current
  from public.external_identifiers i
  join public.external_records r on (r.business_id,r.provider,r.id)=(i.business_id,i.provider,i.record_id)
  left join public.external_resources e on (e.business_id,e.provider,e.source_account,e.resource)=
    (r.business_id,r.provider,r.source_account,r.entity)
  where i.relationship='identity' and i.shared and i.valid_until is null
), decisions as (
  select c.*,
    c.is_current and not exists(
      select from candidates other
      where (other.business_id,other.namespace,other.value)=(c.business_id,c.namespace,c.value)
        and other.is_current and (other.provider,other.record_id,other.selector)<>(c.provider,c.record_id,c.selector)
        and not exists(
          select from public.external_record_links link
          where link.business_id=c.business_id and link.provider=c.provider and link.record_id=c.record_id
            and link.selector=c.selector and link.target_provider=other.provider and link.target_id=other.record_id
            and link.relation='authoritative_for' and link.valid_until is null
            and link.evidence @> jsonb_build_object('namespace',c.namespace,'value',c.value,'target_selector',other.selector)
        )
    ) as preferred
  from candidates c
)
select d.*,
  case when not is_current then 'unconfirmed'
       when preferred and count(*) filter(where preferred) over(partition by business_id,namespace,value)=1 then 'selected'
       else 'overlap' end as authority
from decisions d;
