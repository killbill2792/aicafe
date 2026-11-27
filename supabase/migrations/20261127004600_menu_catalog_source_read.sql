-- Preserve the native recipe key and prep settings. Connected prices and
-- descriptions use the exact object in the certified provider publication.
create function public.menu_catalog_for(p_business_id uuid)
returns table(business_id uuid,id uuid,name text,base_name text,size_label text,price_cents bigint,
  prep_seconds integer,category text,menu_group text,is_active boolean,pos_item_id text,catalog_source text,
  catalog_last_synced_at timestamptz,description text,pos_visibility text,pos_pricing_strategy text)
language sql stable security invoker set search_path=pg_catalog,public as $$
 select m.business_id,m.id,coalesce(src.item->>'name',m.name),coalesce(src.item->>'name',m.base_name),
   coalesce(src.size_option->>'name',m.size_label),
   case when src.item is null then m.price_cents
        when abs(pricing.amount)<=90071992547409.91 then round(pricing.amount*100)::bigint end,
   m.prep_seconds,m.category,m.menu_group,m.is_active,m.pos_item_id,m.catalog_source,
   m.catalog_last_synced_at,case when src.item is null then m.description else src.item->>'description' end,
   m.pos_visibility,coalesce(src.item->>'pricingStrategy',m.pos_pricing_strategy)
 from public.menu_items m
 left join lateral (
   select (array_agg(c.item))[1] as item,(array_agg(c.size_option))[1] as size_option
   from public.external_record_links l
   join public.external_records r on (r.business_id,r.provider,r.id)=(l.business_id,l.provider,l.record_id)
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
     and r.provider='toast' and r.entity='menus/v2/menus' and r.payload_origin='provider'
     and m.toast_publication_state='active'
     and r.source_updated_at=public.toast_time_or_null(m.toast_publication_version)
     and c.item->>'guid'=l.selector->>'itemGuid'
     and (l.selector->>'sizeOptionGuid' is null or c.size_option->>'guid'=l.selector->>'sizeOptionGuid')
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
revoke all on function public.menu_catalog_for(uuid) from public,anon;
grant execute on function public.menu_catalog_for(uuid) to authenticated,service_role;
