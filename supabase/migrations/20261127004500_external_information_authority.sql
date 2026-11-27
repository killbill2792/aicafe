-- Reconciliation ranks evidence on a shared, source-attested identity. It
-- never uses provider names, a fuzzy label, or differences in provider clocks.
create view public.external_identity_authority with (security_invoker=true) as
with candidates as not materialized (
  select distinct i.business_id,i.namespace,i.value,i.provider,i.record_id,i.selector,
    r.entity,r.source_account,r.source_updated_at,r.last_seen,e.status,
    r.payload_origin='provider' and coalesce(e.status='current',false)
      and e.last_complete_at is not null and e.permission_granted is distinct from false as is_current
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
revoke all on public.external_identity_authority from public,anon;
grant select on public.external_identity_authority to authenticated,service_role;
comment on view public.external_identity_authority is
  'Scope by café, namespace and shared identifier. Use one selected original when available. An overlap needs explicit evidence; unconfirmed sources do not establish absence.';

-- A trusted native workflow supplies its stable IDs and source references.
-- Validate both endpoints against the same café before publishing links.
create function public.external_bind_native_identities(
 p_business uuid,p_provider text,p_account text,p_resource text,p_namespace text,
 p_native_table regclass,p_bindings jsonb
) returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare native_name text; seen_at timestamptz; verified jsonb; resolved jsonb;
begin
 if jsonb_typeof(p_bindings) is distinct from 'array' then raise exception 'Invalid native bindings'; end if;
 select n.nspname||'.'||c.relname into strict native_name
 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where c.oid=p_native_table and n.nspname='public' and c.relkind='r' and c.relrowsecurity
   and has_table_privilege('authenticated',c.oid,'select');

 execute format(
   'select coalesce(jsonb_agg(v),''[]''::jsonb) from
      (select distinct b.native_id,b.source_id from jsonb_to_recordset($2) b(native_id uuid,source_id text)
       join %s n on n.id=b.native_id and n.business_id=$1) v',p_native_table)
 into verified using p_business,p_bindings;
 if jsonb_array_length(verified)<>jsonb_array_length(p_bindings) then
   raise exception 'Native identity outside café or duplicated';
 end if;

 -- Serialize link reconciliation for one connector's native relation.
 perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_business,p_provider,p_account,p_resource,native_name)::text,0));
 seen_at:=clock_timestamp();
 select coalesce(jsonb_agg(matches),'[]'::jsonb) into resolved from (
  select b.native_id,b.source_id,(array_agg(i.record_id))[1] as record_id,(array_agg(i.selector))[1] as selector
  from jsonb_to_recordset(verified) b(native_id uuid,source_id text)
  join public.external_identifiers i on i.namespace=p_namespace and i.value=b.source_id
  join public.external_records r on (r.business_id,r.provider,r.id)=(i.business_id,i.provider,i.record_id)
  where (r.business_id,r.provider,r.source_account,r.entity)=(p_business,p_provider,p_account,p_resource)
    and r.payload_origin='provider' and i.relationship='identity' and i.valid_until is null
  group by b.native_id,b.source_id having count(*)=1
 ) matches;

 update public.external_record_links l set valid_until=seen_at
 from public.external_records r
 where (l.business_id,l.provider,l.record_id)=(r.business_id,r.provider,r.id)
   and (r.business_id,r.provider,r.source_account,r.entity)=(p_business,p_provider,p_account,p_resource)
   and l.native_relation=native_name and l.relation='native_identity' and l.valid_until is null
   and l.evidence->>'namespace'=p_namespace
   and not exists(select from jsonb_to_recordset(resolved) b(native_id uuid,record_id uuid,selector jsonb)
      where l.native_key=jsonb_build_object('id',b.native_id) and l.record_id=b.record_id and l.selector=b.selector);

 insert into public.external_record_links
   (business_id,provider,record_id,relation,evidence,selector,native_relation,native_key,observed_at)
 select p_business,p_provider,b.record_id,'native_identity',
   jsonb_build_object('namespace',p_namespace,'value',b.source_id),b.selector,
   native_name,jsonb_build_object('id',b.native_id),seen_at
 from jsonb_to_recordset(resolved) b(native_id uuid,source_id text,record_id uuid,selector jsonb)
 on conflict do nothing;
end $$;
revoke all on function public.external_bind_native_identities(uuid,text,text,text,text,regclass,jsonb)
  from public,anon,authenticated;
grant execute on function public.external_bind_native_identities(uuid,text,text,text,text,regclass,jsonb)
  to service_role;
