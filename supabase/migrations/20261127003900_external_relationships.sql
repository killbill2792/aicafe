set lock_timeout = '5s';
set statement_timeout = '60s';
-- Identity claims and references use the same index. The connector determines
-- whether a namespace is local to its account or independently shared.
create or replace function public.external_observe_identifiers(p_business uuid,p_provider text,p_record uuid,p_aliases jsonb)
returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  if jsonb_typeof(p_aliases) is distinct from 'array' then raise exception 'Invalid source identifier list'; end if;
  if exists(select from jsonb_array_elements(p_aliases) a where nullif(a->>'value','') is null
    or nullif(a->>'namespace','') is null or jsonb_typeof(a->'selector') is distinct from 'object') then
    raise exception 'Incomplete source identifier'; end if;
  update public.external_identifiers e set valid_until=clock_timestamp()
  where business_id=p_business and provider=p_provider and record_id=p_record and valid_until is null
  and not exists(select from jsonb_to_recordset(p_aliases)
    a(namespace text,value text,selector jsonb,relationship text,shared boolean)
    where (a.namespace,a.value,a.selector,coalesce(a.relationship,'identity'),coalesce(a.shared,false))=
          (e.namespace,e.value,e.selector,e.relationship,e.shared));

  insert into public.external_identifiers(business_id,provider,record_id,namespace,value,selector,relationship,shared)
  select distinct p_business,p_provider,p_record,a.namespace,a.value,a.selector,
    coalesce(a.relationship,'identity'),coalesce(a.shared,false)
  from jsonb_to_recordset(p_aliases) a(namespace text,value text,selector jsonb,relationship text,shared boolean)
  where not exists(select from public.external_identifiers e where
    e.business_id=p_business and e.provider=p_provider and e.record_id=p_record and e.valid_until is null
    and (e.namespace,e.value,e.selector,e.relationship,e.shared)=
        (a.namespace,a.value,a.selector,coalesce(a.relationship,'identity'),coalesce(a.shared,false)));
end $$;

-- One query can resolve any connector's stable references, including those
-- observed before their targets arrive. Multiple authorities remain candidates.
create view public.external_relationship_candidates with (security_invoker=true) as
select i.business_id,i.provider,i.record_id,i.selector,i.relationship,i.namespace,i.value,
  j.provider as target_provider,j.record_id as target_id,j.selector as target_selector,
  case when j.id is null then 'unresolved'
       when count(j.id) over(partition by i.id)>1 then 'ambiguous'
       else 'matched' end as match_status
from public.external_identifiers i
join public.external_records r on (r.business_id,r.provider,r.id)=(i.business_id,i.provider,i.record_id)
left join lateral (
  select t.id,t.provider,t.record_id,t.selector from public.external_identifiers t
  join public.external_records other on (other.business_id,other.provider,other.id)=
    (t.business_id,t.provider,t.record_id)
  where (t.business_id,t.namespace,t.value)=(i.business_id,i.namespace,i.value)
    and t.relationship='identity' and t.valid_until is null
    and (t.provider,t.record_id,t.selector)<>(i.provider,i.record_id,i.selector)
    and ((t.provider= i.provider and other.source_account=r.source_account) or (i.shared and t.shared))
) j on true
where i.valid_until is null and (i.relationship<>'identity' or i.shared);
revoke all on public.external_relationship_candidates from public,anon;
grant select on public.external_relationship_candidates to authenticated,service_role;
comment on view public.external_relationship_candidates is
  'Exact source identifiers provide candidate relationships. Ambiguous and unresolved references must not be counted as matched accounts or used to overwrite other facts. Explicit evidence lives in external_record_links.';

-- Explicit assertions support native business data as well as provider objects.
-- Native identities are relation and primary key, separate from source payload.
create unique index external_explicit_source_link on public.external_record_links
  (business_id,provider,record_id,relation,target_provider,target_id,md5(selector::text))
  where target_id is not null and valid_until is null;
create unique index external_explicit_native_link on public.external_record_links
  (business_id,native_relation,relation,md5(native_key::text),
   provider,record_id,md5(selector::text))
  where native_relation is not null and valid_until is null;
comment on table public.external_record_links is
  'Durable, time-scoped relationship and authority assertions with evidence. A native relation/key identifies an independent app record in the same café. Provider and native values remain in their original stores.';
