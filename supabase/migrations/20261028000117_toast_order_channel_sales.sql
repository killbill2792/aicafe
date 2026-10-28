-- Migration 117: enable channel/dining-option sales queries from the existing
-- order amount without inventing or duplicating any calculation.
-- Excluded and superseded orders stay visible as review evidence with a NULL
-- *current* sales amount. They are never silently counted as current sales.
create or replace view public.cv_orders
 (business_id,source,source_ref,status,business_date,order_ref,dining_option,
 source_channel,guest_count,data,net_sales_cents)
 with (security_invoker=true) as
 select o.business_id,
 case when o.pos_order_id like 'toast:%' then 'toast' else 'app' end::text,
 'order:'||o.id::text,
 case when o.toast_excluded is true or o.superseded_by is not null
 then 'needs_match' else 'actual' end::text,
 o.business_date,o.id::text,o.dining_option::text,o.source_channel::text,
 o.guest_count::integer,
 jsonb_build_object('order_ref',o.id,'dining_option',o.dining_option,
 'source_channel',o.source_channel,'guest_count',o.guest_count,
 'toast_excluded',o.toast_excluded,'superseded',o.superseded_by is not null,
 'recorded_net_sales_cents',o.net_sales_cents),
 case when o.toast_excluded is true or o.superseded_by is not null
 then null::bigint else o.net_sales_cents::bigint end
 from public.orders o;
revoke all on public.cv_orders from public,anon;
grant select on public.cv_orders to authenticated,service_role;
