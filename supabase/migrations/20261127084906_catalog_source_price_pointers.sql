-- A connector compiles the precise numeric source path after verifying the
-- original collection. The app resolves that path without a provider-specific reader.
set lock_timeout = '5s';
set statement_timeout = '45s';

create or replace function public.external_bind_native_identities(
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
      (select distinct b.native_id,b.source_id,b.price_source,p.binding ? ''price_source'' as price_attested
       from jsonb_array_elements($2) p(binding)
       cross join lateral jsonb_to_record(p.binding) b(native_id uuid,source_id text,price_source jsonb)
       join %s n on n.id=b.native_id and n.business_id=$1) v',p_native_table)
 into verified using p_business,p_bindings;
 if jsonb_array_length(verified)<>jsonb_array_length(p_bindings) then
   raise exception 'Native identity outside café or duplicated';
 end if;

 -- Serialize link reconciliation for one connector's native relation.
 perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_business,p_provider,p_account,p_resource,native_name)::text,0));
 seen_at:=clock_timestamp();
 select coalesce(jsonb_agg(matches),'[]'::jsonb) into resolved from (
  select b.native_id,b.source_id,b.price_source,b.price_attested,
    (array_agg(i.record_id))[1] as record_id,(array_agg(i.selector))[1] as selector
  from jsonb_to_recordset(verified) b(native_id uuid,source_id text,price_source jsonb,price_attested boolean)
  join public.external_identifiers i on i.namespace=p_namespace and i.value=b.source_id
  join public.external_records r on (r.business_id,r.provider,r.id)=(i.business_id,i.provider,i.record_id)
  where (r.business_id,r.provider,r.source_account,r.entity)=(p_business,p_provider,p_account,p_resource)
    and r.payload_origin='provider' and i.relationship='identity' and i.valid_until is null
  group by b.native_id,b.source_id,b.price_source,b.price_attested having count(*)=1
 ) matches;

 update public.external_record_links l set valid_until=seen_at
 from public.external_records r
 where (l.business_id,l.provider,l.record_id)=(r.business_id,r.provider,r.id)
   and (r.business_id,r.provider,r.source_account,r.entity)=(p_business,p_provider,p_account,p_resource)
   and l.native_relation=native_name and l.relation='native_identity' and l.valid_until is null
   and l.evidence->>'namespace'=p_namespace
   and not exists(select from jsonb_to_recordset(resolved) b(native_id uuid,record_id uuid,selector jsonb,price_source jsonb,price_attested boolean)
      where l.native_key=jsonb_build_object('id',b.native_id) and l.record_id=b.record_id and l.selector=b.selector
      and l.evidence->'price_source' is not distinct from
        (case when b.price_attested then coalesce(b.price_source,'null'::jsonb) end));

 insert into public.external_record_links
   (business_id,provider,record_id,relation,evidence,selector,native_relation,native_key,observed_at)
 select p_business,p_provider,b.record_id,'native_identity',
   jsonb_build_object('namespace',p_namespace,'value',b.source_id)
     ||case when b.price_attested then jsonb_build_object('price_source',b.price_source) else '{}'::jsonb end,b.selector,
   native_name,jsonb_build_object('id',b.native_id),seen_at
 from jsonb_to_recordset(resolved) b(native_id uuid,source_id text,record_id uuid,selector jsonb,price_source jsonb,price_attested boolean)
 on conflict do nothing;
end $$;

create function public.external_read_minor_price(anchor public.external_records,pointer jsonb)
returns numeric language sql stable security invoker set search_path=pg_catalog,public as $$
  select case when count(*)=1 then max(case when jsonb_typeof(v.amount)='number'
    then (v.amount #>> '{}')::numeric end) end
  from public.external_records r
  join public.external_resources e on (e.business_id,e.provider,e.source_account,e.resource)=
    (r.business_id,r.provider,r.source_account,r.entity)
  cross join lateral (select case when jsonb_typeof(pointer->'path')='array' then
    r.payload #> array(select jsonb_array_elements_text(pointer->'path')) end as amount) v
  where (r.business_id,r.provider,r.source_account,r.entity,r.source_key)=
    (anchor.business_id,anchor.provider,anchor.source_account,anchor.entity,pointer->>'recordKey')
    and public.external_current_observation(r,e);
$$;
revoke all on function public.external_read_minor_price(public.external_records,jsonb) from public,anon;
grant execute on function public.external_read_minor_price(public.external_records,jsonb) to authenticated,service_role;

create or replace function public.menu_catalog_for(p_business_id uuid)
returns table(business_id uuid,id uuid,name text,base_name text,size_label text,price_cents bigint,
  prep_seconds integer,category text,menu_group text,is_active boolean,pos_item_id text,catalog_source text,
  catalog_last_synced_at timestamptz,description text,pos_visibility text,pos_pricing_strategy text)
language sql stable security invoker set search_path=pg_catalog,public as $$
 select m.business_id,m.id,case when src.price_attested then m.name else coalesce(src.item->>'name',m.name) end,
   case when src.price_attested then m.base_name else coalesce(src.item->>'name',m.base_name) end,
   coalesce(src.size_option->>'name',m.size_label),
   case when src.price_attested then
          case when src.source_price=trunc(src.source_price) and abs(src.source_price)<=9007199254740991
           then src.source_price::bigint end
        when src.item is null then m.price_cents
        when abs(pricing.amount)<=90071992547409.91 then round(pricing.amount*100)::bigint end,
   m.prep_seconds,m.category,m.menu_group,m.is_active,m.pos_item_id,m.catalog_source,
   m.catalog_last_synced_at,case when src.price_attested or src.item is null then m.description else src.item->>'description' end,
   m.pos_visibility,coalesce(src.item->>'pricingStrategy',m.pos_pricing_strategy)
 from public.menu_items m
 left join lateral (
   select (array_agg(c.item))[1] as item,(array_agg(c.size_option))[1] as size_option,
     bool_or(l.evidence ? 'price_source') as price_attested,
     (array_agg(public.external_read_minor_price(r,l.evidence->'price_source')))[1] as source_price
   from public.external_record_links l
   join public.external_records r on (r.business_id,r.provider,r.id)=(l.business_id,l.provider,l.record_id)
   left join public.external_resources e on (e.business_id,e.provider,e.source_account,e.resource)=
     (r.business_id,r.provider,r.source_account,r.entity)
   cross join lateral (
     select case when jsonb_typeof(l.selector->'path')='array' then
       r.payload #> array(select jsonb_array_elements_text(l.selector->'path')) end as item,
       case when jsonb_typeof(l.selector->'sizeOptionPath')='array' then
       r.payload #> array(select jsonb_array_elements_text(l.selector->'sizeOptionPath')) end as size_option
   ) c
   where l.business_id=m.business_id and l.provider=m.catalog_source
     and l.native_relation='public.menu_items' and l.native_key=jsonb_build_object('id',m.id)
     and md5(l.native_key::text)=md5(jsonb_build_object('id',m.id)::text)
     and l.relation='native_identity' and l.valid_until is null
     and l.evidence->>'value'=m.pos_item_id
     and ((l.evidence ? 'price_source' and m.is_active and public.external_current_observation(r,e))
       or (r.provider='toast' and r.entity='menus/v2/menus' and r.payload_origin='provider'
         and m.toast_publication_state='active'
         and r.source_updated_at=public.toast_time_or_null(m.toast_publication_version)
         and c.item->>'guid'=l.selector->>'itemGuid'
         and (l.selector->>'sizeOptionGuid' is null or c.size_option->>'guid'=l.selector->>'sizeOptionGuid')))
   having count(*)=1
 ) src on true
 cross join lateral (select coalesce(src.size_option,src.item) as body) selected
 cross join lateral (
   select case
     when selected.body->>'pricingStrategy' in ('BASE_PRICE','MENU_SPECIFIC_PRICE','GROUP_PRICE','TIME_SPECIFIC_PRICE')
       and jsonb_typeof(selected.body->'price')='number' then (selected.body->>'price')::numeric
     when selected.body->>'pricingStrategy'='TIME_SPECIFIC_PRICE' then (
       select min((v->>'basePrice')::numeric)
       from jsonb_array_elements(case
         when jsonb_typeof(selected.body#>'{pricingRules,timeSpecificPricingRules}')='array'
         then selected.body#>'{pricingRules,timeSpecificPricingRules}' else '[]'::jsonb end) v
       where jsonb_typeof(v->'basePrice')='number'
       having count(distinct (v->>'basePrice')::numeric)=1)
     end as amount
 ) pricing
 where m.business_id=p_business_id;
$$;

-- Keep the existing SQL catalog contract on the same values as Menu.
create or replace view public.cv_menu
 (business_id,source,source_ref,status,business_date,data,id,name,base_name,size_label,price_cents,prep_seconds,category,menu_group,is_active,pos_item_id,catalog_source,catalog_last_synced_at,description,pos_visibility,pos_pricing_strategy) with (security_invoker=true) as
 select m.business_id,case when src.matched or m.catalog_source='toast' then m.catalog_source else 'app' end::text,
 'item:'||m.id::text,'actual'::text,null::date,
 jsonb_build_object('id',m.id,'name',m.name,'price_cents',m.price_cents,
 'category',m.category,'menu_group',m.menu_group,'is_active',m.is_active,'pos_item_id',m.pos_item_id,
 'base_name',m.base_name,'size_label',m.size_label,'prep_seconds',m.prep_seconds,
 'source_record_id',src.record_id,'catalog_source',m.catalog_source,'catalog_last_synced_at',m.catalog_last_synced_at,
 'description',m.description,'pos_visibility',m.pos_visibility,'pos_pricing_strategy',m.pos_pricing_strategy),
 m.id,m.name,m.base_name,m.size_label,m.price_cents,m.prep_seconds,m.category,m.menu_group,m.is_active,m.pos_item_id,m.catalog_source,m.catalog_last_synced_at,m.description,m.pos_visibility,m.pos_pricing_strategy
 from public.businesses b
 cross join lateral public.menu_catalog_for(b.id) m
 left join lateral (
  select true as matched,(array_agg(r.id))[1] as record_id
  from public.external_record_links l join public.external_records r on
    (r.business_id,r.provider,r.id)=(l.business_id,l.provider,l.record_id)
  where l.business_id=m.business_id and l.provider=m.catalog_source
    and l.native_relation='public.menu_items' and l.native_key=jsonb_build_object('id',m.id)
    and l.relation='native_identity' and l.valid_until is null
  having count(*)=1
 ) src on true
 union all
 select r.business_id,'toast'::text,'review:'||r.review_type||':'||r.source_key,
 'needs_match'::text,null::date,jsonb_build_object('review_type',r.review_type,'source_key',r.source_key,'detail',r.detail),
 null::uuid,null::text,null::text,null::text,null::bigint,null::integer,null::text,null::text,null::boolean,null::text,null::text,null::timestamp with time zone,null::text,null::text,null::text
 from public.pos_import_reviews r where r.provider='toast' and r.review_type in ('catalog_item','menu_identity','item_identity')
 and r.status='needs_owner'
 union all
 select v.business_id,'toast'::text,
 'price-version:'||v.restaurant_guid::text||':'||v.kind||':'||v.provider_guid::text||':'||v.price_fingerprint,
 'actual'::text,null::date,jsonb_build_object('kind','price_version','provider_guid',v.provider_guid,
 'entity_kind',v.kind,'name',v.name,'category',v.category,'price_cents',v.price_cents,'observed_at',v.observed_at),
 null::uuid,null::text,null::text,null::text,null::bigint,null::integer,null::text,null::text,null::boolean,null::text,null::text,null::timestamp with time zone,null::text,null::text,null::text
 from public.toast_catalog_price_versions v;
