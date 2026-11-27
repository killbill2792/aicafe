-- Native recipes retain their existing item ID. The same POS identity links to the
-- original publication or catalog object, even when its document path changes.
create or replace view public.cv_menu
 (business_id,source,source_ref,status,business_date,data,id,name,base_name,size_label,price_cents,prep_seconds,category,menu_group,is_active,pos_item_id,catalog_source,catalog_last_synced_at,description,pos_visibility,pos_pricing_strategy) with (security_invoker=true) as
 select m.business_id,case when src.matched or m.catalog_source='toast' then m.catalog_source else 'app' end::text,
 'item:'||m.id::text,'actual'::text,null::date,
 jsonb_build_object('id',m.id,'name',m.name,'price_cents',m.price_cents,
 'category',m.category,'menu_group',m.menu_group,'is_active',m.is_active,'pos_item_id',m.pos_item_id,
 'base_name',m.base_name,'size_label',m.size_label,'prep_seconds',m.prep_seconds,
 'source_record_id',src.record_id,'catalog_source',m.catalog_source,'catalog_last_synced_at',m.catalog_last_synced_at,
 'description',case when src.matched then src.description else m.description end,'pos_visibility',m.pos_visibility,'pos_pricing_strategy',m.pos_pricing_strategy),
 m.id,m.name,m.base_name,m.size_label,m.price_cents,m.prep_seconds,m.category,m.menu_group,m.is_active,m.pos_item_id,m.catalog_source,m.catalog_last_synced_at,case when src.matched then src.description else m.description end,m.pos_visibility,m.pos_pricing_strategy
 from public.menu_items m
 left join lateral (
  select true as matched,(array_agg(r.id))[1] as record_id,
    max((r.payload #> array(select jsonb_array_elements_text(i.selector->'path')))->>'description') as description
  from public.external_identifiers i join public.external_records r on
   (r.business_id,r.provider,r.id)=(i.business_id,i.provider,i.record_id)
  where i.business_id=m.business_id and i.provider=m.catalog_source and i.namespace='pos_item_id'
    and i.value=m.pos_item_id and i.valid_until is null and jsonb_typeof(i.selector->'path')='array'
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
