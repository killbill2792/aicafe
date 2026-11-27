set lock_timeout = '5s';
set statement_timeout = '60s';

-- Read connector-attested display paths from the current catalog receipt.
-- The native label may be an owner override and stays independently owned.
create or replace function public.menu_catalog_for(p_business_id uuid)
returns table(business_id uuid,id uuid,name text,base_name text,size_label text,price_cents bigint,
  prep_seconds integer,category text,menu_group text,is_active boolean,pos_item_id text,catalog_source text,
  catalog_last_synced_at timestamptz,description text,pos_visibility text,pos_pricing_strategy text)
language sql stable security invoker set search_path=pg_catalog,public as $$
 select m.business_id,m.id,
   case when src.price_attested then
     case when m.name=m.pos_name and src.display_current then coalesce(src.display_name,m.name) else m.name end
     else coalesce(src.item->>'name',m.name) end,
   case when src.price_attested then coalesce(src.display_name,m.base_name)
     else coalesce(src.item->>'name',m.base_name) end,
   coalesce(src.size_option->>'name',m.size_label),
   case when src.price_attested then
          case when src.source_price=trunc(src.source_price) and abs(src.source_price)<=9007199254740991
           then src.source_price::bigint end
        when src.item is null then m.price_cents
        when abs(pricing.amount)<=90071992547409.91 then round(pricing.amount*100)::bigint end,
   m.prep_seconds,m.category,m.menu_group,m.is_active,m.pos_item_id,m.catalog_source,
   m.catalog_last_synced_at,case when src.display_current then src.display_description
     when src.price_attested or src.item is null then m.description else src.item->>'description' end,
   m.pos_visibility,coalesce(src.item->>'pricingStrategy',m.pos_pricing_strategy)
 from public.menu_items m
 left join lateral (
   select (array_agg(c.item))[1] as item,(array_agg(c.size_option))[1] as size_option,
     bool_or(l.evidence ? 'price_source') as price_attested,
     bool_or(display.current) as display_current,
     (array_agg(case when display.current and jsonb_typeof(fields.name)='string'
       then nullif(btrim(fields.name#>>'{}'),'') end))[1] as display_name,
     (array_agg(case when display.current and jsonb_typeof(fields.description)='string'
       then fields.description#>>'{}' end))[1] as display_description,
     (array_agg(case when public.external_current_observation(r,e)
       then public.external_read_minor_price(r,l.evidence->'price_source') end))[1] as source_price
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
   cross join lateral (select jsonb_typeof(l.selector->'display')='object'
    and public.external_current_observation(r,e)
    and exists(select from public.external_identifiers i
      where (i.business_id,i.provider,i.record_id,i.namespace,i.value,i.selector)=
       (r.business_id,r.provider,r.id,l.evidence->>'namespace',l.evidence->>'value',l.selector)
       and i.relationship='identity' and i.valid_until is null) as current) display
   cross join lateral (select
     case when jsonb_typeof(l.selector#>'{display,name}')='array' then
      r.payload #> array(select jsonb_array_elements_text(l.selector#>'{display,name}')) end as name,
     case when jsonb_typeof(l.selector#>'{display,description}')='array' then
      r.payload #> array(select jsonb_array_elements_text(l.selector#>'{display,description}')) end as description
   ) fields
   where l.business_id=m.business_id and l.provider=m.catalog_source
     and l.native_relation='public.menu_items' and l.native_key=jsonb_build_object('id',m.id)
     and md5(l.native_key::text)=md5(jsonb_build_object('id',m.id)::text)
     and l.relation='native_identity' and l.valid_until is null
     and l.evidence->>'value'=m.pos_item_id
     and ((l.evidence ? 'price_source' and m.is_active)
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
