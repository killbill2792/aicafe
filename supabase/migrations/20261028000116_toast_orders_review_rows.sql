-- Migration 116: retain even excluded/superseded order evidence for owner queries.
-- Canonical business sales/count totals still rely on the filtered shared metrics
-- pipeline; this detail view labels review-only rows rather than hiding them.
create or replace view public.cv_orders
 (business_id,source,source_ref,status,business_date,order_ref,dining_option,source_channel,guest_count,data)
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
  'toast_excluded',o.toast_excluded,'superseded',o.superseded_by is not null)
 from public.orders o;

revoke all on public.cv_orders from public,anon;
grant select on public.cv_orders to authenticated,service_role;
