alter table public.external_records
  add column payload_origin text not null default 'provider'
    check (payload_origin in ('provider','historical_provider','historical_projection'));
alter table public.external_record_changes
  add column delta_origin text not null default 'provider'
    check (delta_origin in ('provider','historical_provider','historical_projection'));

comment on column public.external_records.payload_origin is
  'Historical rows are retained evidence. Older provider rows may be incomplete; historical_projection was produced by the former application staging pipeline.';
comment on column public.external_record_changes.delta_origin is
  'Segment arrays encode exact JSON paths. Older deltas without segments retain their original path notation and may have discarded distinctions such as null versus absent.';

-- The service-side cutover process reviews historical rows before exposing them.
-- A concurrent new provider observation wins the compare-and-swap.
create function public.external_adopt_historical_record(
  p_business uuid,p_provider text,p_record uuid,p_before_hash text,p_payload jsonb,
  p_account text,p_key text,p_projected boolean
) returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  if p_payload is null or nullif(p_account,'') is null or nullif(p_key,'') is null or p_projected is null then
    raise exception 'Historical record has incomplete identity';
  end if;
  update public.external_records set payload=p_payload,
      payload_sha256=case when payload is distinct from p_payload
        then encode(sha256(convert_to(p_payload::text,'UTF8')),'hex') else payload_sha256 end,
      source_account=p_account,source_key=p_key,
      payload_origin=case when p_projected then 'historical_projection' else 'historical_provider' end
    where business_id=p_business and provider=p_provider and id=p_record
      and source_account is null and payload_sha256=p_before_hash;
  return found;
end $$;
revoke all on function public.external_adopt_historical_record(uuid,text,uuid,text,jsonb,text,text,boolean)
  from public,anon,authenticated;
grant execute on function public.external_adopt_historical_record(uuid,text,uuid,text,jsonb,text,text,boolean)
  to service_role;

-- The existing writers still use the same heaps. A newly accepted provider
-- observation supersedes a historical payload, even when the JSON is unchanged.
create function public.external_record_provider_observed()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if new.source_account is not null and new.last_seen is distinct from old.last_seen then
    new.payload_origin := 'provider';
  end if;
  return new;
end $$;
revoke all on function public.external_record_provider_observed() from public,anon,authenticated;
create trigger external_record_provider_observed before update of last_seen on public.external_records
  for each row execute function public.external_record_provider_observed();

create index external_records_source_history_idx on public.external_records
  (business_id,provider,source_account,entity,business_date,source_key)
  where source_account is not null;
create index external_changes_source_history_idx on public.external_record_changes
  (business_id,provider,source_account,entity,source_key,changed_at)
  where source_account is not null;
