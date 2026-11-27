begin;
set local lock_timeout='5s';
lock table public.toast_void_reason_directory in access exclusive mode;

-- These narrow historical rows predate direct configuration capture. Retain
-- their known fields and dates as archive evidence; a later source observation
-- adopts the same identity and fills any earlier gaps.
with projected as (
  select d.*,d.restaurant_guid::text as account,d.reason_guid::text as record_key,
    jsonb_build_object('guid',d.reason_guid,'name',d.name,'entityType',d.entity_type) as body
  from public.toast_void_reason_directory d
)
insert into public.external_records
  (business_id,provider,source_account,entity,source_key,restaurant_guid,entity_guid,
   payload,payload_sha256,capture_key,first_seen,last_seen,payload_origin)
select business_id,'toast',account,'config/v2/voidReasons',record_key,restaurant_guid,reason_guid,
  body,encode(sha256(convert_to(body::text,'UTF8')),'hex'),
  case when exists (select from public.external_records r where r.business_id=d.business_id
    and r.provider='toast' and r.entity='config/v2/voidReasons' and r.source_account=d.account
    and r.source_key=d.record_key)
    then 'historical-config:' else 'external:' end ||
    encode(sha256(convert_to(jsonb_build_array(account,'config/v2/voidReasons',record_key)::text,'UTF8')),'hex'),
  fetched_at,fetched_at,'historical_projection'
from projected d;

create function public.external_change_provenance()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  select coalesce(r.payload_origin,'provider') into new.delta_origin
  from public.external_records r
  where (r.business_id,r.provider,r.id)=(new.business_id,new.provider,new.record_id);
  new.delta_origin:=coalesce(new.delta_origin,'provider');
  return new;
end $$;
revoke all on function public.external_change_provenance() from public,anon,authenticated;
create trigger external_change_provenance before insert on public.external_record_changes
  for each row execute function public.external_change_provenance();

drop table public.toast_void_reason_directory;
alter table public.toast_optional_sync_state drop column void_reasons_local_day;
commit;
