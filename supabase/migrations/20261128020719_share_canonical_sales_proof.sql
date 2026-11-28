set lock_timeout = '5s';
set statement_timeout = '60s';

-- Preserve the independent exact-count check while sharing the same source
-- and exclusion rules as the screen totals and daily rollup.
create or replace function public.initiative_daily_order_sales_proof(p_business_id uuid,p_date date)
returns table(order_count bigint,net_sales_cents bigint,synthetic_count bigint)
language sql stable security invoker set search_path=pg_catalog,public as $$
 select count(*),coalesce(sum(o.net_sales_cents),0)::bigint,
 count(*) filter(where o.pos_order_id is null
  or o.pos_order_id like 'csv-%' or o.pos_order_id like 'csv:%')
 from public.cv_orders o where o.business_id=p_business_id and o.business_date=p_date and o.status='actual'
$$;
revoke all on function public.initiative_daily_order_sales_proof(uuid,date) from public,anon,authenticated;
grant execute on function public.initiative_daily_order_sales_proof(uuid,date) to service_role;
